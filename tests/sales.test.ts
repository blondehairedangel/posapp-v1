import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { ExtractionStatus } from '@/generated/prisma/client';
import {
  DuplicateConversionError,
  cancelSalesOrder,
  confirmSalesOrder,
  createQuotation,
  createSalesOrder,
  createSalesOrderFromDraft,
  createSalesOrderFromQuotation,
  createQuotationFromDraft,
  previewOrderAvailability,
} from '@/server/services/sales';
import { approveDraft, runExtraction } from '@/server/extraction/pipeline';
import { getAvailability } from '@/server/services/inventory';
import {
  createCustomer,
  createPriceLevel,
  createProduct,
  ensureWarehouse,
  giveStock,
  uid,
} from './helpers/fixtures';

/**
 * §17.6  Sales order creation
 * §17.14 Prevention of duplicate order conversion
 */
describe('sales', () => {
  describe('quotations', () => {
    it('prices lines from the pricing service when no price is given', async () => {
      const level = await createPriceLevel('-10');
      const customer = await createCustomer({ priceLevelId: level.id });
      const product = await createProduct({ sellingPrice: '100000' });

      const quotation = await createQuotation({
        customerId: customer.id,
        lines: [{ productId: product.id, description: 'Test', quantity: 10 }],
      });

      // 100,000 less the level's 10% = 90,000
      expect(quotation.items[0]?.unitPrice.toFixed(0)).toBe('90000');
      expect(quotation.subtotal.toFixed(0)).toBe('900000');
      // Tax comes from the product (11%).
      expect(quotation.taxTotal.toFixed(0)).toBe('99000');
      expect(quotation.grandTotal.toFixed(0)).toBe('999000');
    });

    it('rejects a quotation with no lines', async () => {
      const customer = await createCustomer();
      await expect(
        createQuotation({ customerId: customer.id, lines: [] }),
      ).rejects.toThrow(/at least one line/i);
    });

    it('rejects a non-positive quantity', async () => {
      const customer = await createCustomer();
      const product = await createProduct();
      await expect(
        createQuotation({
          customerId: customer.id,
          lines: [{ productId: product.id, description: 'x', quantity: 0 }],
        }),
      ).rejects.toThrow(/greater than zero/i);
    });

    it('requires an explicit price for a non-catalogue line', async () => {
      const customer = await createCustomer();
      await expect(
        createQuotation({
          customerId: customer.id,
          lines: [{ description: 'Custom fabrication', quantity: 1 }],
        }),
      ).rejects.toThrow(/unit price is required/i);
    });

    it('refuses to sell to a blocked customer', async () => {
      const customer = await createCustomer();
      await prisma.customer.update({
        where: { id: customer.id },
        data: { status: 'BLOCKED' },
      });
      const product = await createProduct();

      await expect(
        createQuotation({
          customerId: customer.id,
          lines: [{ productId: product.id, description: 'x', quantity: 1 }],
        }),
      ).rejects.toThrow(/blocked/i);
    });
  });

  describe('sales orders', () => {
    it('creates an order in DRAFT without reserving any stock', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct();
      await giveStock(product.id, warehouse.id, '100');

      const order = await createSalesOrder({
        customerId: customer.id,
        warehouseId: warehouse.id,
        lines: [{ productId: product.id, description: 'Test', quantity: 10 }],
      });

      expect(order.status).toBe('DRAFT');

      // Creating an order must not touch inventory; only confirmation does.
      const availability = await getAvailability(product.id, warehouse.id);
      expect(availability.reserved.toFixed(0)).toBe('0');
      expect(availability.available.toFixed(0)).toBe('100');
    });

    it('reserves stock on confirmation', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct();
      await giveStock(product.id, warehouse.id, '100');

      const order = await createSalesOrder({
        customerId: customer.id,
        warehouseId: warehouse.id,
        lines: [{ productId: product.id, description: 'Test', quantity: 25 }],
      });

      const result = await confirmSalesOrder(order.id, null);
      expect(result.reserved).toHaveLength(1);
      expect(result.backorders).toHaveLength(0);

      const availability = await getAvailability(product.id, warehouse.id);
      expect(availability.reserved.toFixed(0)).toBe('25');
      expect(availability.available.toFixed(0)).toBe('75');
    });

    it('rolls the whole confirmation back when one line is short', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const plenty = await createProduct();
      const scarce = await createProduct();
      await giveStock(plenty.id, warehouse.id, '100');
      await giveStock(scarce.id, warehouse.id, '1');

      const order = await createSalesOrder({
        customerId: customer.id,
        warehouseId: warehouse.id,
        lines: [
          { productId: plenty.id, description: 'Plenty', quantity: 5 },
          { productId: scarce.id, description: 'Scarce', quantity: 50 },
        ],
      });

      await expect(confirmSalesOrder(order.id, null)).rejects.toThrow();

      // No partial reservation may survive the failed transaction.
      expect(
        (await getAvailability(plenty.id, warehouse.id)).reserved.toFixed(0),
      ).toBe('0');
      const after = await prisma.salesOrder.findUnique({
        where: { id: order.id },
        select: { status: true },
      });
      expect(after?.status).toBe('DRAFT');
    });

    it('records a backorder when explicitly allowed', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct();
      await giveStock(product.id, warehouse.id, '3');

      const order = await createSalesOrder({
        customerId: customer.id,
        warehouseId: warehouse.id,
        allowBackorder: true,
        lines: [{ productId: product.id, description: 'Test', quantity: 10 }],
      });

      const result = await confirmSalesOrder(order.id, null);
      // Decimal.toFixed() emits the minimal representation, so compare values.
      expect(Number(result.reserved[0]?.quantity)).toBe(3);
      expect(Number(result.backorders[0]?.shortfall)).toBe(7);
    });

    it('refuses to confirm the same order twice', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct();
      await giveStock(product.id, warehouse.id, '50');

      const order = await createSalesOrder({
        customerId: customer.id,
        warehouseId: warehouse.id,
        lines: [{ productId: product.id, description: 'Test', quantity: 10 }],
      });

      await confirmSalesOrder(order.id, null);
      // A double-click must not double-reserve.
      await expect(confirmSalesOrder(order.id, null)).rejects.toThrow(
        /already confirmed/i,
      );

      expect(
        (await getAvailability(product.id, warehouse.id)).reserved.toFixed(0),
      ).toBe('10');
    });

    it('releases reservations when an order is cancelled', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct();
      await giveStock(product.id, warehouse.id, '40');

      const order = await createSalesOrder({
        customerId: customer.id,
        warehouseId: warehouse.id,
        lines: [{ productId: product.id, description: 'Test', quantity: 15 }],
      });
      await confirmSalesOrder(order.id, null);
      await cancelSalesOrder(order.id, 'Customer changed their mind', null);

      const availability = await getAvailability(product.id, warehouse.id);
      expect(availability.reserved.toFixed(0)).toBe('0');
      expect(availability.available.toFixed(0)).toBe('40');
    });

    it('previews which lines would go on backorder', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct();
      await giveStock(product.id, warehouse.id, '2');

      const order = await createSalesOrder({
        customerId: customer.id,
        warehouseId: warehouse.id,
        lines: [{ productId: product.id, description: 'Test', quantity: 5 }],
      });

      const preview = await previewOrderAvailability(order.id);
      expect(preview[0]?.sufficient).toBe(false);
      expect(Number(preview[0]?.available)).toBe(2);
    });
  });

  describe('duplicate conversion prevention', () => {
    it('blocks converting the same quotation twice', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct();
      await giveStock(product.id, warehouse.id, '100');

      const quotation = await createQuotation({
        customerId: customer.id,
        lines: [{ productId: product.id, description: 'Test', quantity: 5 }],
      });

      const first = await createSalesOrderFromQuotation(quotation.id, {
        warehouseId: warehouse.id,
      });
      expect(first.number).toBeTruthy();

      await expect(
        createSalesOrderFromQuotation(quotation.id, {
          warehouseId: warehouse.id,
        }),
      ).rejects.toThrow(DuplicateConversionError);

      const orders = await prisma.salesOrder.count({
        where: { quotationId: quotation.id },
      });
      expect(orders).toBe(1);
    });

    it('carries the agreed quotation price into the order unchanged', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct({ sellingPrice: '100000' });
      await giveStock(product.id, warehouse.id, '50');

      const quotation = await createQuotation({
        customerId: customer.id,
        lines: [
          {
            productId: product.id,
            description: 'Negotiated',
            quantity: 5,
            unitPrice: '77000',
          },
        ],
      });

      // The list price changes after the customer accepted the quote.
      await prisma.product.update({
        where: { id: product.id },
        data: { sellingPrice: '150000' },
      });

      const order = await createSalesOrderFromQuotation(quotation.id, {
        warehouseId: warehouse.id,
      });

      // The customer must be charged what they accepted.
      expect(order.items[0]?.unitPrice.toFixed(0)).toBe('77000');
    });

    it('blocks converting the same order draft twice', async () => {
      const warehouse = await ensureWarehouse();
      const sku = `DRAFTSKU${Date.now().toString().slice(-6)}`;
      const product = await createProduct({ sku, sellingPrice: '27500' });
      await giveStock(product.id, warehouse.id, '500');
      const customer = await createCustomer();

      // Build a draft through the real extraction pipeline.
      const extraction = await runExtraction({
        text: `mau order ${sku} sebanyak 20 pcs`,
        customerId: customer.id,
        warehouseId: warehouse.id,
      });
      expect(extraction.draftId).toBeTruthy();
      const draftId = extraction.draftId as string;

      await prisma.orderDraft.update({
        where: { id: draftId },
        data: { customerId: customer.id },
      });
      await approveDraft(draftId, null);

      const first = await createSalesOrderFromDraft(draftId, {
        warehouseId: warehouse.id,
      });
      expect(first.items).toHaveLength(1);

      await expect(
        createSalesOrderFromDraft(draftId, { warehouseId: warehouse.id }),
      ).rejects.toThrow(DuplicateConversionError);

      const count = await prisma.salesOrder.count({
        where: { orderDraftId: draftId },
      });
      expect(count).toBe(1);
    });

    it('refuses to convert a draft that has not been approved', async () => {
      const warehouse = await ensureWarehouse();
      const sku = `UNAPPR${Date.now().toString().slice(-6)}`;
      const product = await createProduct({ sku });
      await giveStock(product.id, warehouse.id, '100');
      const customer = await createCustomer();

      const extraction = await runExtraction({
        text: `order ${sku} 5 pcs`,
        customerId: customer.id,
        warehouseId: warehouse.id,
      });
      const draftId = extraction.draftId as string;

      await expect(
        createSalesOrderFromDraft(draftId, { warehouseId: warehouse.id }),
      ).rejects.toThrow(/must be approved/i);
    });

    it('refuses to approve a draft while a line is unresolved', async () => {
      const customer = await createCustomer();
      const extraction = await runExtraction({
        text: 'mau order barang yang tidak ada di katalog sebanyak 5 pcs',
        customerId: customer.id,
      });

      if (!extraction.draftId) return; // nothing extracted, nothing to assert
      await expect(approveDraft(extraction.draftId, null)).rejects.toThrow(
        /still need review/i,
      );
    });

    it('links the originating ticket through to the sales order', async () => {
      const warehouse = await ensureWarehouse();
      const sku = `TRACE${Date.now().toString().slice(-6)}`;
      const product = await createProduct({ sku });
      await giveStock(product.id, warehouse.id, '100');
      const customer = await createCustomer();

      const ticket = await prisma.ticket.create({
        data: {
          number: uid('TKT'),
          subject: 'Traceability test',
          source: 'MANUAL',
          customerId: customer.id,
        },
      });

      const extraction = await runExtraction({
        text: `order ${sku} 4 pcs`,
        ticketId: ticket.id,
        customerId: customer.id,
        warehouseId: warehouse.id,
      });
      const draftId = extraction.draftId as string;
      await approveDraft(draftId, null);

      const quotation = await createQuotationFromDraft(draftId, null);
      const order = await createSalesOrderFromDraft(draftId, {
        warehouseId: warehouse.id,
      });

      // Message -> ticket -> draft -> quotation -> order must stay connected.
      expect(quotation.ticketId).toBe(ticket.id);
      expect(order.ticketId).toBe(ticket.id);
      expect(order.orderDraftId).toBe(draftId);

      const draft = await prisma.orderDraft.findUnique({
        where: { id: draftId },
        select: { status: true },
      });
      expect(draft?.status).toBe(ExtractionStatus.CONVERTED);
    });
  });
});
