import { prisma, type Tx } from '@/lib/db';
import { add, dec, gt, lte, money, sub, type Decimal } from '@/lib/money';
import { nextNumber } from './numbering';
import { computeDocumentTotals } from './pricing';
import {
  DocumentKind,
  InvoiceStatus,
  PaymentDirection,
  PaymentMethod,
  SalesOrderStatus,
} from '@/generated/prisma/client';

/**
 * Invoicing and payment application.
 *
 * `SalesInvoice.paidTotal` is derived from PaymentAllocation rows and is only
 * ever recalculated from them — never incremented in place — so a retried
 * payment cannot inflate the settled amount. Status follows from the numbers
 * rather than being set independently, which keeps "PAID" from disagreeing
 * with the balance.
 */

export class OverAllocationError extends Error {
  constructor(invoiceNumber: string, outstanding: Decimal, attempted: Decimal) {
    super(
      `Cannot allocate ${attempted.toFixed()} to invoice ${invoiceNumber}: only ${outstanding.toFixed()} is outstanding`,
    );
    this.name = 'OverAllocationError';
  }
}

/** Issues an invoice for a confirmed sales order. */
export async function createInvoiceFromSalesOrder(
  salesOrderId: string,
  options: { dueDate?: Date | null; issue?: boolean } = {},
) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { items: true, customer: { select: { paymentTermDays: true } } },
    });
    if (!order) throw new Error('Sales order not found');
    if (order.status === SalesOrderStatus.DRAFT) {
      throw new Error('Confirm the sales order before invoicing it');
    }
    if (order.status === SalesOrderStatus.CANCELLED) {
      throw new Error('A cancelled order cannot be invoiced');
    }

    const totals = computeDocumentTotals({
      lines: order.items.map((i) => ({
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        discountPct: i.discountPct,
        taxRatePct: i.taxRatePct,
      })),
      discountKind: order.discountKind,
      discountValue: order.discountValue,
      shippingFee: order.shippingFee,
    });

    const number = await nextNumber(DocumentKind.SALES_INVOICE, tx);
    const issue = options.issue ?? true;

    const dueDate =
      options.dueDate ??
      (order.customer.paymentTermDays > 0
        ? new Date(
            Date.now() + order.customer.paymentTermDays * 24 * 60 * 60 * 1000,
          )
        : null);

    const invoice = await tx.salesInvoice.create({
      data: {
        number,
        customerId: order.customerId,
        salesOrderId: order.id,
        status: issue ? InvoiceStatus.ISSUED : InvoiceStatus.DRAFT,
        currency: order.currency,
        dueDate,
        issuedAt: issue ? new Date() : null,
        subtotal: totals.subtotal.toFixed(),
        discountTotal: totals.discountTotal.toFixed(),
        taxTotal: totals.taxTotal.toFixed(),
        shippingFee: totals.shippingFee.toFixed(),
        grandTotal: totals.grandTotal.toFixed(),
        items: {
          create: order.items.map((item, index) => {
            const t = totals.lines[index];
            return {
              productId: item.productId,
              salesOrderItemId: item.id,
              description: item.description,
              quantity: item.quantity.toFixed(),
              unitPrice: item.unitPrice.toFixed(),
              discountPct: item.discountPct.toFixed(),
              taxRatePct: item.taxRatePct.toFixed(),
              lineSubtotal: (t?.lineSubtotal ?? dec(0)).toFixed(),
              lineTax: (t?.lineTax ?? dec(0)).toFixed(),
              lineTotal: (t?.lineTotal ?? dec(0)).toFixed(),
              sortOrder: index,
            };
          }),
        },
      },
      include: { items: true },
    });

    await tx.salesOrder.update({
      where: { id: order.id },
      data: { status: SalesOrderStatus.INVOICED },
    });

    return invoice;
  });
}

export interface PaymentAllocationInput {
  invoiceId: string;
  amount: string | number;
}

/**
 * Records a customer payment and applies it to invoices.
 *
 * Over-allocating beyond an invoice's outstanding balance is rejected rather
 * than silently capped: it almost always means a data-entry error, and
 * swallowing it would hide the discrepancy.
 */
export async function recordPayment(input: {
  customerId: string;
  amount: string | number;
  method?: PaymentMethod;
  reference?: string | null;
  paidAt?: Date;
  allocations?: PaymentAllocationInput[];
  notes?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const amount = money(input.amount);
    if (!gt(amount, 0)) {
      throw new Error('Payment amount must be greater than zero');
    }

    const allocations = input.allocations ?? [];
    const allocationTotal = allocations.reduce<Decimal>(
      (acc, a) => add(acc, money(a.amount)),
      dec(0),
    );
    if (gt(allocationTotal, amount)) {
      throw new Error(
        `Allocations (${allocationTotal.toFixed()}) exceed the payment amount (${amount.toFixed()})`,
      );
    }

    const number = await nextNumber(DocumentKind.PAYMENT, tx);

    const payment = await tx.payment.create({
      data: {
        number,
        customerId: input.customerId,
        direction: PaymentDirection.INBOUND,
        method: input.method ?? PaymentMethod.BANK_TRANSFER,
        amount: amount.toFixed(),
        unappliedAmount: sub(amount, allocationTotal).toFixed(),
        paidAt: input.paidAt ?? new Date(),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
    });

    for (const allocation of allocations) {
      const invoice = await tx.salesInvoice.findUnique({
        where: { id: allocation.invoiceId },
        select: {
          id: true,
          number: true,
          grandTotal: true,
          paidTotal: true,
          status: true,
          customerId: true,
        },
      });
      if (!invoice) throw new Error('Invoice not found');
      if (invoice.customerId !== input.customerId) {
        throw new Error(
          `Invoice ${invoice.number} belongs to a different customer`,
        );
      }

      const allocAmount = money(allocation.amount);
      const outstanding = sub(invoice.grandTotal, invoice.paidTotal);
      if (gt(allocAmount, outstanding)) {
        throw new OverAllocationError(invoice.number, outstanding, allocAmount);
      }

      await tx.paymentAllocation.create({
        data: {
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: allocAmount.toFixed(),
        },
      });

      await recalculateInvoiceSettlement(tx, invoice.id);
    }

    return payment;
  });
}

/**
 * Recomputes paidTotal and status from the allocation rows.
 *
 * Deriving rather than incrementing is what makes payment recording idempotent
 * at the invoice level: running this twice produces the same answer.
 */
export async function recalculateInvoiceSettlement(
  tx: Tx,
  invoiceId: string,
): Promise<{ paidTotal: Decimal; outstanding: Decimal; status: InvoiceStatus }> {
  const invoice = await tx.salesInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, grandTotal: true, dueDate: true, status: true },
  });
  if (!invoice) throw new Error('Invoice not found');

  const aggregate = await tx.paymentAllocation.aggregate({
    where: { invoiceId },
    _sum: { amount: true },
  });

  const paidTotal = money(aggregate._sum.amount ?? 0);
  const outstanding = sub(invoice.grandTotal, paidTotal);

  // Explicit comparisons rather than Decimal.isPositive(): in decimal.js a
  // zero carries a positive sign, so `isPositive()` is true for 0 and a
  // fully-settled invoice would be misreported as PARTIALLY_PAID.
  let status: InvoiceStatus;
  if (invoice.status === InvoiceStatus.CANCELLED || invoice.status === InvoiceStatus.CREDITED) {
    status = invoice.status;
  } else if (lte(outstanding, 0)) {
    status = InvoiceStatus.PAID;
  } else if (gt(paidTotal, 0)) {
    status = InvoiceStatus.PARTIALLY_PAID;
  } else if (invoice.dueDate && invoice.dueDate < new Date()) {
    status = InvoiceStatus.OVERDUE;
  } else {
    status = InvoiceStatus.ISSUED;
  }

  await tx.salesInvoice.update({
    where: { id: invoiceId },
    data: { paidTotal: paidTotal.toFixed(), status },
  });

  return { paidTotal, outstanding, status };
}

/** Outstanding receivables per customer, for the finance screens. */
export async function getOutstandingByCustomer() {
  const rows = await prisma.salesInvoice.groupBy({
    by: ['customerId'],
    where: {
      status: {
        in: [
          InvoiceStatus.ISSUED,
          InvoiceStatus.PARTIALLY_PAID,
          InvoiceStatus.OVERDUE,
        ],
      },
    },
    _sum: { grandTotal: true, paidTotal: true },
  });

  return rows.map((r) => ({
    customerId: r.customerId,
    outstanding: money(
      sub(r._sum.grandTotal ?? 0, r._sum.paidTotal ?? 0),
    ),
  }));
}
