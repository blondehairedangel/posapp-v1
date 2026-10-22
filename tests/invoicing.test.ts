import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import {
  OverAllocationError,
  createInvoiceFromSalesOrder,
  recordPayment,
} from '@/server/services/invoicing';
import {
  confirmSalesOrder,
  createSalesOrder,
} from '@/server/services/sales';
import {
  createCustomer,
  createProduct,
  ensureWarehouse,
  giveStock,
} from './helpers/fixtures';

/** §17.15 Invoice and payment calculations */
describe('invoicing and payments', () => {
  async function confirmedOrder(options: {
    quantity?: number;
    unitPrice?: string;
    paymentTermDays?: number;
  } = {}) {
    const customer = await createCustomer({
      paymentTermDays: options.paymentTermDays ?? 14,
    });
    const warehouse = await ensureWarehouse();
    const product = await createProduct({ sellingPrice: options.unitPrice ?? '100000' });
    await giveStock(product.id, warehouse.id, '1000');

    const order = await createSalesOrder({
      customerId: customer.id,
      warehouseId: warehouse.id,
      lines: [
        {
          productId: product.id,
          description: 'Invoice test line',
          quantity: options.quantity ?? 10,
        },
      ],
    });
    await confirmSalesOrder(order.id, null);
    return { customer, order, warehouse, product };
  }

  describe('invoice creation', () => {
    it('copies the order totals onto the invoice', async () => {
      const { order } = await confirmedOrder({ quantity: 10, unitPrice: '100000' });
      const invoice = await createInvoiceFromSalesOrder(order.id);

      expect(invoice.subtotal.toFixed(0)).toBe('1000000');
      expect(invoice.taxTotal.toFixed(0)).toBe('110000');
      expect(invoice.grandTotal.toFixed(0)).toBe('1110000');
      expect(invoice.status).toBe('ISSUED');
      expect(invoice.paidTotal.toFixed(0)).toBe('0');
    });

    it('derives the due date from the customer payment terms', async () => {
      const { order } = await confirmedOrder({ paymentTermDays: 30 });
      const invoice = await createInvoiceFromSalesOrder(order.id);

      expect(invoice.dueDate).not.toBeNull();
      const days = Math.round(
        ((invoice.dueDate as Date).getTime() - Date.now()) / 86_400_000,
      );
      expect(days).toBe(30);
    });

    it('refuses to invoice an unconfirmed order', async () => {
      const customer = await createCustomer();
      const warehouse = await ensureWarehouse();
      const product = await createProduct();

      const order = await createSalesOrder({
        customerId: customer.id,
        warehouseId: warehouse.id,
        lines: [{ productId: product.id, description: 'x', quantity: 1 }],
      });

      await expect(createInvoiceFromSalesOrder(order.id)).rejects.toThrow(
        /confirm the sales order/i,
      );
    });

    it('marks the order as invoiced', async () => {
      const { order } = await confirmedOrder();
      await createInvoiceFromSalesOrder(order.id);

      const fresh = await prisma.salesOrder.findUnique({
        where: { id: order.id },
        select: { status: true },
      });
      expect(fresh?.status).toBe('INVOICED');
    });
  });

  describe('payment application', () => {
    it('settles an invoice in full', async () => {
      const { customer, order } = await confirmedOrder();
      const invoice = await createInvoiceFromSalesOrder(order.id);

      await recordPayment({
        customerId: customer.id,
        amount: invoice.grandTotal.toFixed(),
        allocations: [
          { invoiceId: invoice.id, amount: invoice.grandTotal.toFixed() },
        ],
      });

      const settled = await prisma.salesInvoice.findUnique({
        where: { id: invoice.id },
        select: { paidTotal: true, status: true },
      });
      expect(settled?.status).toBe('PAID');
      expect(settled?.paidTotal.toFixed(0)).toBe(invoice.grandTotal.toFixed(0));
    });

    it('marks an invoice partially paid and keeps the balance exact', async () => {
      const { customer, order } = await confirmedOrder({
        quantity: 10,
        unitPrice: '100000',
      });
      const invoice = await createInvoiceFromSalesOrder(order.id);

      await recordPayment({
        customerId: customer.id,
        amount: '500000',
        allocations: [{ invoiceId: invoice.id, amount: '500000' }],
      });

      const settled = await prisma.salesInvoice.findUnique({
        where: { id: invoice.id },
        select: { paidTotal: true, grandTotal: true, status: true },
      });
      expect(settled?.status).toBe('PARTIALLY_PAID');
      expect(settled?.paidTotal.toFixed(0)).toBe('500000');
      // 1,110,000 - 500,000 = 610,000 outstanding
      expect(
        settled?.grandTotal.minus(settled.paidTotal).toFixed(0),
      ).toBe('610000');
    });

    it('accumulates two part payments into a settled invoice', async () => {
      const { customer, order } = await confirmedOrder({
        quantity: 10,
        unitPrice: '100000',
      });
      const invoice = await createInvoiceFromSalesOrder(order.id);

      await recordPayment({
        customerId: customer.id,
        amount: '600000',
        allocations: [{ invoiceId: invoice.id, amount: '600000' }],
      });
      await recordPayment({
        customerId: customer.id,
        amount: '510000',
        allocations: [{ invoiceId: invoice.id, amount: '510000' }],
      });

      const settled = await prisma.salesInvoice.findUnique({
        where: { id: invoice.id },
        select: { paidTotal: true, status: true },
      });
      expect(settled?.paidTotal.toFixed(0)).toBe('1110000');
      expect(settled?.status).toBe('PAID');
    });

    it('rejects an allocation larger than the outstanding balance', async () => {
      const { customer, order } = await confirmedOrder();
      const invoice = await createInvoiceFromSalesOrder(order.id);

      await expect(
        recordPayment({
          customerId: customer.id,
          amount: '99999999',
          allocations: [{ invoiceId: invoice.id, amount: '99999999' }],
        }),
      ).rejects.toThrow(OverAllocationError);

      // The rejected payment must leave nothing behind.
      const fresh = await prisma.salesInvoice.findUnique({
        where: { id: invoice.id },
        select: { paidTotal: true, status: true },
      });
      expect(fresh?.paidTotal.toFixed(0)).toBe('0');
      expect(fresh?.status).toBe('ISSUED');
    });

    it('rejects allocations exceeding the payment itself', async () => {
      const { customer, order } = await confirmedOrder();
      const invoice = await createInvoiceFromSalesOrder(order.id);

      await expect(
        recordPayment({
          customerId: customer.id,
          amount: '100000',
          allocations: [{ invoiceId: invoice.id, amount: '200000' }],
        }),
      ).rejects.toThrow(/exceed the payment amount/i);
    });

    it('rejects a zero payment', async () => {
      const customer = await createCustomer();
      await expect(
        recordPayment({ customerId: customer.id, amount: '0' }),
      ).rejects.toThrow(/greater than zero/i);
    });

    it('refuses to apply a payment to another customer invoice', async () => {
      const { order } = await confirmedOrder();
      const invoice = await createInvoiceFromSalesOrder(order.id);
      const stranger = await createCustomer();

      await expect(
        recordPayment({
          customerId: stranger.id,
          amount: '100000',
          allocations: [{ invoiceId: invoice.id, amount: '100000' }],
        }),
      ).rejects.toThrow(/different customer/i);
    });

    it('tracks unapplied credit when a payment is not fully allocated', async () => {
      const { customer, order } = await confirmedOrder();
      const invoice = await createInvoiceFromSalesOrder(order.id);

      const payment = await recordPayment({
        customerId: customer.id,
        amount: '2000000',
        allocations: [{ invoiceId: invoice.id, amount: '1110000' }],
      });

      // 2,000,000 - 1,110,000 = 890,000 left on account.
      expect(payment.unappliedAmount.toFixed(0)).toBe('890000');
    });

    it('splits one payment across two invoices', async () => {
      const customer = await createCustomer({ paymentTermDays: 14 });
      const warehouse = await ensureWarehouse();
      const product = await createProduct({ sellingPrice: '100000' });
      await giveStock(product.id, warehouse.id, '1000');

      const invoices = [];
      for (const quantity of [5, 3]) {
        const order = await createSalesOrder({
          customerId: customer.id,
          warehouseId: warehouse.id,
          lines: [{ productId: product.id, description: 'Line', quantity }],
        });
        await confirmSalesOrder(order.id, null);
        invoices.push(await createInvoiceFromSalesOrder(order.id));
      }

      const total = invoices
        .reduce((acc, i) => acc.plus(i.grandTotal), invoices[0]!.grandTotal.minus(invoices[0]!.grandTotal))
        .toFixed();

      await recordPayment({
        customerId: customer.id,
        amount: total,
        allocations: invoices.map((i) => ({
          invoiceId: i.id,
          amount: i.grandTotal.toFixed(),
        })),
      });

      for (const invoice of invoices) {
        const settled = await prisma.salesInvoice.findUnique({
          where: { id: invoice.id },
          select: { status: true },
        });
        expect(settled?.status).toBe('PAID');
      }
    });
  });
});
