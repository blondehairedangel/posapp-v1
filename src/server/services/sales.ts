import { prisma, type Tx } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { dec, qty } from '@/lib/money';
import {
  reserveStock,
  releaseReservationsForOrder,
  type Availability,
} from './inventory';
import { nextNumber } from './numbering';
import { computeDocumentTotals, resolvePrice } from './pricing';
import {
  DiscountKind,
  DocumentKind,
  ExtractionStatus,
  QuotationStatus,
  SalesOrderStatus,
  TicketStatus,
  type Prisma,
} from '@/generated/prisma/client';

const logger = log('sales');

/**
 * Sales workflow: Quotation -> Sales Order -> (picking/packing/shipment) ->
 * Invoice -> Payment.
 *
 * Two rules drive the design here:
 *
 *  - Stock is only ever reserved by `confirmSalesOrder`. A ticket mentioning a
 *    part, or a draft proposing one, changes nothing in inventory.
 *  - Converting the same draft or quotation twice is impossible. The guard is
 *    a UNIQUE constraint on SalesOrder.orderDraftId plus a status check inside
 *    the transaction, so a double-clicked button or a retried background job
 *    cannot produce two orders.
 */

export class DuplicateConversionError extends Error {
  readonly existingId: string;
  readonly existingNumber: string;
  constructor(kind: string, id: string, number: string) {
    super(`This ${kind} has already been converted (${number})`);
    this.name = 'DuplicateConversionError';
    this.existingId = id;
    this.existingNumber = number;
  }
}

export interface SalesLineInput {
  productId?: string | null;
  description: string;
  quantity: string | number;
  unitPrice?: string | number | null;
  discountPct?: string | number | null;
  taxRatePct?: string | number | null;
  notes?: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Quotations                                                                */
/* -------------------------------------------------------------------------- */

export interface CreateQuotationInput {
  customerId: string;
  lines: SalesLineInput[];
  ticketId?: string | null;
  orderDraftId?: string | null;
  addressId?: string | null;
  validUntil?: Date | null;
  discountKind?: DiscountKind;
  discountValue?: string | number | null;
  shippingFee?: string | number | null;
  terms?: string | null;
  notes?: string | null;
  createdById?: string | null;
}

/**
 * Builds the priced lines for a document.
 *
 * Any line without an explicit unit price is priced through the pricing
 * service, so a quotation can never be created at a price the pricing rules
 * would not produce. Client-supplied totals are ignored entirely.
 */
async function buildLines(
  tx: Tx,
  customerId: string,
  lines: SalesLineInput[],
) {
  if (lines.length === 0) {
    throw new Error('At least one line is required');
  }

  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { id: true, priceLevelId: true, currency: true, status: true },
  });
  if (!customer) throw new Error('Customer not found');
  if (customer.status === 'BLOCKED') {
    throw new Error('This customer is blocked and cannot be sold to');
  }

  const resolved = [];
  for (const line of lines) {
    const quantity = qty(line.quantity);
    if (!quantity.greaterThan(0)) {
      throw new Error(`Quantity must be greater than zero for "${line.description}"`);
    }

    let unitPrice = line.unitPrice;
    let taxRatePct = line.taxRatePct;

    if (line.productId && (unitPrice === null || unitPrice === undefined)) {
      const price = await resolvePrice(
        line.productId,
        { priceLevelId: customer.priceLevelId, quantity },
        tx,
      );
      unitPrice = price.unitPrice.toFixed();
      taxRatePct ??= price.taxRatePct.toFixed();
    }

    if (unitPrice === null || unitPrice === undefined) {
      throw new Error(
        `A unit price is required for the non-catalogue line "${line.description}"`,
      );
    }

    resolved.push({
      productId: line.productId ?? null,
      description: line.description,
      quantity,
      unitPrice: dec(unitPrice),
      discountPct: dec(line.discountPct ?? 0),
      taxRatePct: dec(taxRatePct ?? 0),
      notes: line.notes ?? null,
    });
  }

  return { customer, resolved };
}

export async function createQuotation(input: CreateQuotationInput) {
  return prisma.$transaction(async (tx) => {
    const { customer, resolved } = await buildLines(
      tx,
      input.customerId,
      input.lines,
    );

    const totals = computeDocumentTotals({
      lines: resolved.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        taxRatePct: l.taxRatePct,
      })),
      discountKind: input.discountKind,
      discountValue: input.discountValue,
      shippingFee: input.shippingFee,
    });

    const number = await nextNumber(DocumentKind.QUOTATION, tx);

    const quotation = await tx.quotation.create({
      data: {
        number,
        customerId: input.customerId,
        ticketId: input.ticketId ?? null,
        orderDraftId: input.orderDraftId ?? null,
        addressId: input.addressId ?? null,
        status: QuotationStatus.DRAFT,
        currency: customer.currency,
        priceLevelId: customer.priceLevelId,
        validUntil: input.validUntil ?? null,
        subtotal: totals.subtotal.toFixed(),
        discountKind: input.discountKind ?? DiscountKind.NONE,
        discountValue: dec(input.discountValue ?? 0).toFixed(),
        discountTotal: totals.discountTotal.toFixed(),
        taxTotal: totals.taxTotal.toFixed(),
        shippingFee: totals.shippingFee.toFixed(),
        grandTotal: totals.grandTotal.toFixed(),
        terms: input.terms ?? null,
        notes: input.notes ?? null,
        createdById: input.createdById ?? null,
        items: {
          create: resolved.map((l, index) => {
            const t = totals.lines[index];
            return {
              productId: l.productId,
              description: l.description,
              quantity: l.quantity.toFixed(),
              unitPrice: l.unitPrice.toFixed(),
              discountPct: l.discountPct.toFixed(),
              taxRatePct: l.taxRatePct.toFixed(),
              lineSubtotal: (t?.lineSubtotal ?? dec(0)).toFixed(),
              lineTax: (t?.lineTax ?? dec(0)).toFixed(),
              lineTotal: (t?.lineTotal ?? dec(0)).toFixed(),
              sortOrder: index,
              notes: l.notes,
            };
          }),
        },
      },
      include: { items: true },
    });

    if (input.ticketId) {
      await tx.ticketEvent.create({
        data: {
          ticketId: input.ticketId,
          type: 'quotation.created',
          summary: `Quotation ${number} created`,
          actorId: input.createdById ?? null,
          payload: { quotationId: quotation.id } as never,
        },
      });
    }

    return quotation;
  });
}

/**
 * Creates a quotation from an APPROVED draft.
 *
 * Prices are re-resolved from the database at this point rather than reusing
 * the draft's snapshot, because a snapshot taken at extraction time may be
 * hours or days old.
 */
export async function createQuotationFromDraft(
  draftId: string,
  actorId: string | null,
  options: { validUntil?: Date | null } = {},
) {
  const draft = await prisma.orderDraft.findUnique({
    where: { id: draftId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!draft) throw new Error('Draft not found');
  if (draft.status !== ExtractionStatus.APPROVED) {
    throw new Error(
      'The draft must be approved by a reviewer before a quotation can be generated',
    );
  }
  if (!draft.customerId) {
    throw new Error('Assign a customer to the draft before quoting');
  }

  const lines: SalesLineInput[] = draft.items.map((item) => {
    if (!item.productId || item.quantity === null) {
      throw new Error(
        `Draft line "${item.productName ?? item.originalText}" is missing a product or quantity`,
      );
    }
    return {
      productId: item.productId,
      description: item.productName ?? item.originalText,
      quantity: item.quantity.toFixed(),
    };
  });

  const quotation = await createQuotation({
    customerId: draft.customerId,
    lines,
    ticketId: draft.ticketId,
    orderDraftId: draft.id,
    validUntil: options.validUntil ?? null,
    createdById: actorId,
    notes: draft.customerNotes,
  });

  logger.info(
    { draftId, quotationId: quotation.id },
    'quotation created from draft',
  );
  return quotation;
}

export async function sendQuotation(quotationId: string, actorId: string | null) {
  return prisma.$transaction(async (tx) => {
    const quotation = await tx.quotation.findUnique({
      where: { id: quotationId },
      select: { id: true, status: true, number: true, ticketId: true },
    });
    if (!quotation) throw new Error('Quotation not found');
    if (quotation.status === QuotationStatus.CONVERTED) {
      throw new Error('This quotation has already been converted to an order');
    }

    const updated = await tx.quotation.update({
      where: { id: quotationId },
      data: { status: QuotationStatus.SENT, sentAt: new Date() },
    });

    if (quotation.ticketId) {
      await tx.ticket.update({
        where: { id: quotation.ticketId },
        data: {
          status: TicketStatus.AWAITING_CUSTOMER,
          lastActivityAt: new Date(),
        },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId: quotation.ticketId,
          type: 'quotation.sent',
          summary: `Quotation ${quotation.number} sent to the customer`,
          actorId,
        },
      });
    }

    return updated;
  });
}

export async function acceptQuotation(quotationId: string) {
  return prisma.quotation.update({
    where: { id: quotationId },
    data: { status: QuotationStatus.ACCEPTED, acceptedAt: new Date() },
  });
}

/* -------------------------------------------------------------------------- */
/*  Sales orders                                                              */
/* -------------------------------------------------------------------------- */

export interface CreateSalesOrderInput {
  customerId: string;
  warehouseId: string;
  lines: SalesLineInput[];
  quotationId?: string | null;
  ticketId?: string | null;
  orderDraftId?: string | null;
  billingAddressId?: string | null;
  shippingAddressId?: string | null;
  requestedDeliveryDate?: Date | null;
  discountKind?: DiscountKind;
  discountValue?: string | number | null;
  shippingFee?: string | number | null;
  allowBackorder?: boolean;
  notes?: string | null;
  createdById?: string | null;
}

export async function createSalesOrder(input: CreateSalesOrderInput) {
  return prisma.$transaction(async (tx) => {
    // Duplicate-conversion guards, inside the transaction so two concurrent
    // callers cannot both pass the check.
    if (input.orderDraftId) {
      const existing = await tx.salesOrder.findUnique({
        where: { orderDraftId: input.orderDraftId },
        select: { id: true, number: true },
      });
      if (existing) {
        throw new DuplicateConversionError(
          'draft',
          existing.id,
          existing.number,
        );
      }
    }
    if (input.quotationId) {
      const quotation = await tx.quotation.findUnique({
        where: { id: input.quotationId },
        select: { id: true, status: true, number: true },
      });
      if (!quotation) throw new Error('Quotation not found');
      if (quotation.status === QuotationStatus.CONVERTED) {
        const already = await tx.salesOrder.findFirst({
          where: { quotationId: input.quotationId },
          select: { id: true, number: true },
        });
        throw new DuplicateConversionError(
          'quotation',
          already?.id ?? quotation.id,
          already?.number ?? quotation.number,
        );
      }
    }

    const { customer, resolved } = await buildLines(
      tx,
      input.customerId,
      input.lines,
    );

    const totals = computeDocumentTotals({
      lines: resolved.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        taxRatePct: l.taxRatePct,
      })),
      discountKind: input.discountKind,
      discountValue: input.discountValue,
      shippingFee: input.shippingFee,
    });

    const number = await nextNumber(DocumentKind.SALES_ORDER, tx);

    const order = await tx.salesOrder.create({
      data: {
        number,
        customerId: input.customerId,
        warehouseId: input.warehouseId,
        quotationId: input.quotationId ?? null,
        ticketId: input.ticketId ?? null,
        orderDraftId: input.orderDraftId ?? null,
        billingAddressId: input.billingAddressId ?? null,
        shippingAddressId: input.shippingAddressId ?? null,
        status: SalesOrderStatus.DRAFT,
        currency: customer.currency,
        priceLevelId: customer.priceLevelId,
        requestedDeliveryDate: input.requestedDeliveryDate ?? null,
        subtotal: totals.subtotal.toFixed(),
        discountKind: input.discountKind ?? DiscountKind.NONE,
        discountValue: dec(input.discountValue ?? 0).toFixed(),
        discountTotal: totals.discountTotal.toFixed(),
        taxTotal: totals.taxTotal.toFixed(),
        shippingFee: totals.shippingFee.toFixed(),
        grandTotal: totals.grandTotal.toFixed(),
        allowBackorder: input.allowBackorder ?? false,
        notes: input.notes ?? null,
        createdById: input.createdById ?? null,
        items: {
          create: resolved.map((l, index) => {
            const t = totals.lines[index];
            return {
              productId: l.productId,
              description: l.description,
              quantity: l.quantity.toFixed(),
              unitPrice: l.unitPrice.toFixed(),
              discountPct: l.discountPct.toFixed(),
              taxRatePct: l.taxRatePct.toFixed(),
              lineSubtotal: (t?.lineSubtotal ?? dec(0)).toFixed(),
              lineTax: (t?.lineTax ?? dec(0)).toFixed(),
              lineTotal: (t?.lineTotal ?? dec(0)).toFixed(),
              sortOrder: index,
              notes: l.notes,
            };
          }),
        },
      },
      include: { items: true },
    });

    // Mark the sources converted so a second attempt is rejected.
    if (input.quotationId) {
      await tx.quotation.update({
        where: { id: input.quotationId },
        data: { status: QuotationStatus.CONVERTED },
      });
    }
    if (input.orderDraftId) {
      await tx.orderDraft.update({
        where: { id: input.orderDraftId },
        data: { status: ExtractionStatus.CONVERTED },
      });
    }
    if (input.ticketId) {
      await tx.ticket.update({
        where: { id: input.ticketId },
        data: {
          status: TicketStatus.CONVERTED_TO_SALES_ORDER,
          lastActivityAt: new Date(),
        },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId: input.ticketId,
          type: 'sales_order.created',
          summary: `Sales order ${number} created`,
          actorId: input.createdById ?? null,
          payload: { salesOrderId: order.id } as never,
        },
      });
    }

    return order;
  });
}

export async function createSalesOrderFromQuotation(
  quotationId: string,
  input: {
    warehouseId: string;
    actorId?: string | null;
    allowBackorder?: boolean;
    requestedDeliveryDate?: Date | null;
  },
) {
  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!quotation) throw new Error('Quotation not found');
  if (quotation.status === QuotationStatus.CANCELLED) {
    throw new Error('A cancelled quotation cannot be converted');
  }

  return createSalesOrder({
    customerId: quotation.customerId,
    warehouseId: input.warehouseId,
    quotationId: quotation.id,
    ticketId: quotation.ticketId,
    orderDraftId: quotation.orderDraftId,
    requestedDeliveryDate: input.requestedDeliveryDate ?? null,
    allowBackorder: input.allowBackorder ?? false,
    discountKind: quotation.discountKind,
    discountValue: quotation.discountValue.toFixed(),
    shippingFee: quotation.shippingFee.toFixed(),
    createdById: input.actorId ?? null,
    // Carry the agreed prices across verbatim: the customer accepted these
    // figures, so they must not be re-resolved at today's price list.
    lines: quotation.items.map((item) => ({
      productId: item.productId,
      description: item.description,
      quantity: item.quantity.toFixed(),
      unitPrice: item.unitPrice.toFixed(),
      discountPct: item.discountPct.toFixed(),
      taxRatePct: item.taxRatePct.toFixed(),
      notes: item.notes,
    })),
  });
}

export async function createSalesOrderFromDraft(
  draftId: string,
  input: { warehouseId: string; actorId?: string | null; allowBackorder?: boolean },
) {
  const draft = await prisma.orderDraft.findUnique({
    where: { id: draftId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!draft) throw new Error('Draft not found');
  if (draft.status === ExtractionStatus.CONVERTED) {
    const existing = await prisma.salesOrder.findUnique({
      where: { orderDraftId: draftId },
      select: { id: true, number: true },
    });
    throw new DuplicateConversionError(
      'draft',
      existing?.id ?? draftId,
      existing?.number ?? '',
    );
  }
  if (draft.status !== ExtractionStatus.APPROVED) {
    throw new Error(
      'The draft must be approved by a reviewer before an order can be created',
    );
  }
  if (!draft.customerId) {
    throw new Error('Assign a customer to the draft before creating an order');
  }

  // If a quotation was already generated from this draft, link it so the
  // chain message -> ticket -> draft -> quotation -> order is directly
  // navigable, and so that quotation is marked CONVERTED rather than left
  // looking open.
  const existingQuotation = await prisma.quotation.findFirst({
    where: {
      orderDraftId: draft.id,
      status: { notIn: [QuotationStatus.CANCELLED, QuotationStatus.CONVERTED] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  return createSalesOrder({
    customerId: draft.customerId,
    warehouseId: input.warehouseId,
    ticketId: draft.ticketId,
    orderDraftId: draft.id,
    quotationId: existingQuotation?.id ?? null,
    allowBackorder: input.allowBackorder ?? false,
    createdById: input.actorId ?? null,
    notes: draft.customerNotes,
    lines: draft.items.map((item) => {
      if (!item.productId || item.quantity === null) {
        throw new Error(
          `Draft line "${item.productName ?? item.originalText}" is missing a product or quantity`,
        );
      }
      return {
        productId: item.productId,
        description: item.productName ?? item.originalText,
        quantity: item.quantity.toFixed(),
      };
    }),
  });
}

/* -------------------------------------------------------------------------- */
/*  Confirmation and cancellation                                             */
/* -------------------------------------------------------------------------- */

export interface ConfirmResult {
  orderId: string;
  reserved: Array<{ productId: string; quantity: string }>;
  backorders: Array<{ productId: string; shortfall: string }>;
}

/**
 * Confirms an order and reserves stock.
 *
 * This is the ONLY place stock becomes reserved. Everything happens in one
 * transaction: if any line cannot be satisfied and backorders are not allowed,
 * the whole confirmation rolls back and no partial reservation is left behind.
 */
export async function confirmSalesOrder(
  orderId: string,
  actorId: string | null,
): Promise<ConfirmResult> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new Error('Sales order not found');
    if (order.status === SalesOrderStatus.CANCELLED) {
      throw new Error('A cancelled order cannot be confirmed');
    }
    if (order.status !== SalesOrderStatus.DRAFT) {
      // Idempotent: confirming twice must not double-reserve.
      throw new Error(`Order ${order.number} is already confirmed`);
    }

    const reserved: Array<{ productId: string; quantity: string }> = [];
    const backorders: Array<{ productId: string; shortfall: string }> = [];

    for (const item of order.items) {
      if (!item.productId) continue; // non-catalogue line, nothing to reserve
      const result = await reserveStock(tx, {
        productId: item.productId,
        warehouseId: order.warehouseId,
        quantity: item.quantity,
        salesOrderId: order.id,
        salesOrderItemId: item.id,
        allowBackorder: order.allowBackorder,
      });
      if (result.reserved.greaterThan(0)) {
        reserved.push({
          productId: item.productId,
          quantity: result.reserved.toFixed(),
        });
      }
      if (result.shortfall.greaterThan(0)) {
        backorders.push({
          productId: item.productId,
          shortfall: result.shortfall.toFixed(),
        });
      }
    }

    await tx.salesOrder.update({
      where: { id: orderId },
      data: {
        status: SalesOrderStatus.CONFIRMED,
        confirmedAt: new Date(),
      },
    });

    if (order.ticketId) {
      await tx.ticketEvent.create({
        data: {
          ticketId: order.ticketId,
          type: 'sales_order.confirmed',
          summary: `Sales order ${order.number} confirmed`,
          actorId,
        },
      });
    }

    return { orderId, reserved, backorders };
  });
}

export async function cancelSalesOrder(
  orderId: string,
  reason: string,
  actorId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, number: true, ticketId: true },
    });
    if (!order) throw new Error('Sales order not found');
    if (order.status === SalesOrderStatus.CANCELLED) return order;
    if (
      order.status === SalesOrderStatus.FULFILLED ||
      order.status === SalesOrderStatus.COMPLETED
    ) {
      throw new Error(
        'A fulfilled order cannot be cancelled; raise a sales return instead',
      );
    }

    // Free the stock so it becomes sellable again.
    await releaseReservationsForOrder(tx, orderId);

    const updated = await tx.salesOrder.update({
      where: { id: orderId },
      data: {
        status: SalesOrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: reason,
      },
    });

    if (order.ticketId) {
      await tx.ticketEvent.create({
        data: {
          ticketId: order.ticketId,
          type: 'sales_order.cancelled',
          summary: `Sales order ${order.number} cancelled: ${reason}`,
          actorId,
        },
      });
    }

    return updated;
  });
}

/* -------------------------------------------------------------------------- */
/*  Availability preview                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pre-flight check shown before confirmation, so the salesperson sees which
 * lines would go on backorder instead of discovering it from an error.
 */
export async function previewOrderAvailability(
  orderId: string,
): Promise<Array<{ itemId: string; productId: string; requested: string; available: string; sufficient: boolean }>> {
  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw new Error('Sales order not found');

  const { getAvailabilityMany } = await import('./inventory');
  const productIds = order.items
    .map((i) => i.productId)
    .filter((id): id is string => Boolean(id));
  const availability: Map<string, Availability> = await getAvailabilityMany(
    productIds,
    order.warehouseId,
  );

  return order.items
    .filter((i) => i.productId)
    .map((item) => {
      const avail = availability.get(item.productId as string);
      const available = avail?.available ?? dec(0);
      return {
        itemId: item.id,
        productId: item.productId as string,
        requested: dec(item.quantity).toFixed(),
        available: available.toFixed(),
        sufficient: available.greaterThanOrEqualTo(dec(item.quantity)),
      };
    });
}

/** Default warehouse used when a caller does not specify one. */
export async function getDefaultWarehouseId(): Promise<string> {
  const warehouse = await prisma.warehouse.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
    select: { id: true },
  });
  if (!warehouse) {
    throw new Error('No active warehouse is configured');
  }
  return warehouse.id;
}

export type QuotationWithItems = Prisma.QuotationGetPayload<{
  include: { items: true; customer: true };
}>;

export const DEFAULT_CURRENCY = () => env().APP_CURRENCY;
