import { prisma } from '@/lib/db';
import { dec, money, type Decimal } from '@/lib/money';
import { Prisma, TicketStatus } from '@/generated/prisma/client';
import { inboxWhere } from './tickets';

/**
 * Dashboard metrics.
 *
 * Every figure below is a database aggregate. There are no sample numbers and
 * no placeholders: if a metric cannot be computed it is reported as zero, not
 * invented.
 */

export interface DashboardRange {
  from: Date;
  to: Date;
}

/** Day boundaries in the configured display timezone, expressed in UTC. */
export function todayRange(timeZone: string): DashboardRange {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone }));
  const offsetMs = now.getTime() - local.getTime();
  const startLocal = new Date(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
  );
  const from = new Date(startLocal.getTime() + offsetMs);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

export function monthRange(timeZone: string): DashboardRange {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone }));
  const offsetMs = now.getTime() - local.getTime();
  const startLocal = new Date(local.getFullYear(), local.getMonth(), 1);
  const endLocal = new Date(local.getFullYear(), local.getMonth() + 1, 1);
  return {
    from: new Date(startLocal.getTime() + offsetMs),
    to: new Date(endLocal.getTime() + offsetMs),
  };
}

export interface DashboardMetrics {
  tickets: {
    total: number;
    newUnassigned: number;
    open: number;
    awaitingCustomer: number;
    awaitingInternal: number;
    overdue: number;
    orderPending: number;
  };
  sales: {
    ordersAwaitingConfirmation: number;
    ordersAwaitingFulfilment: number;
    todayTotal: Decimal;
    todayCount: number;
    monthTotal: Decimal;
    monthCount: number;
    outstandingReceivables: Decimal;
    overdueInvoices: number;
  };
  inventory: {
    lowStockCount: number;
    totalSkus: number;
  };
  purchasing: {
    pendingOrders: number;
  };
  drafts: {
    awaitingReview: number;
  };
}

async function sumGrandTotal(
  where: Prisma.SalesInvoiceWhereInput,
): Promise<{ total: Decimal; count: number }> {
  const result = await prisma.salesInvoice.aggregate({
    where,
    _sum: { grandTotal: true },
    _count: true,
  });
  return {
    total: money(result._sum.grandTotal ?? 0),
    count: result._count,
  };
}

export async function getDashboardMetrics(
  timeZone: string,
  userId?: string | null,
): Promise<DashboardMetrics> {
  const today = todayRange(timeZone);
  const month = monthRange(timeZone);

  const OPEN_STATES: TicketStatus[] = [
    TicketStatus.NEW,
    TicketStatus.OPEN,
    TicketStatus.IN_PROGRESS,
    TicketStatus.AWAITING_CUSTOMER,
    TicketStatus.AWAITING_INTERNAL,
    TicketStatus.ORDER_PENDING_CONFIRMATION,
  ];

  const [
    ticketTotal,
    ticketNewUnassigned,
    ticketOpen,
    ticketAwaitingCustomer,
    ticketAwaitingInternal,
    ticketOverdue,
    ticketOrderPending,
    ordersAwaitingConfirmation,
    ordersAwaitingFulfilment,
    todayInvoices,
    monthInvoices,
    receivables,
    overdueInvoices,
    lowStock,
    totalSkus,
    pendingPurchaseOrders,
    draftsAwaiting,
  ] = await Promise.all([
    prisma.ticket.count(),
    prisma.ticket.count({
      where: { status: TicketStatus.NEW, assigneeId: null },
    }),
    prisma.ticket.count({ where: { status: { in: OPEN_STATES } } }),
    prisma.ticket.count({ where: { status: TicketStatus.AWAITING_CUSTOMER } }),
    prisma.ticket.count({ where: { status: TicketStatus.AWAITING_INTERNAL } }),
    prisma.ticket.count({ where: inboxWhere('overdue', userId) }),
    prisma.ticket.count({
      where: { status: TicketStatus.ORDER_PENDING_CONFIRMATION },
    }),
    prisma.salesOrder.count({ where: { status: 'DRAFT' } }),
    prisma.salesOrder.count({
      where: { status: { in: ['CONFIRMED', 'PARTIALLY_FULFILLED'] } },
    }),
    sumGrandTotal({
      status: { notIn: ['DRAFT', 'CANCELLED'] },
      issueDate: { gte: today.from, lt: today.to },
    }),
    sumGrandTotal({
      status: { notIn: ['DRAFT', 'CANCELLED'] },
      issueDate: { gte: month.from, lt: month.to },
    }),
    // Receivables = issued invoice value not yet settled.
    prisma.$queryRaw<Array<{ total: string | null }>>(Prisma.sql`
      SELECT COALESCE(SUM("grandTotal" - "paidTotal"), 0)::text AS total
      FROM "sales_invoices"
      WHERE "status" IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
    `),
    prisma.salesInvoice.count({
      where: {
        status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
        dueDate: { lt: new Date() },
      },
    }),
    prisma.$queryRaw<Array<{ count: string }>>(Prisma.sql`
      SELECT COUNT(*)::text AS count FROM (
        SELECT p."id"
        FROM "products" p
        LEFT JOIN "inventory_balances" b ON b."productId" = p."id"
        WHERE p."status" = 'ACTIVE' AND p."deletedAt" IS NULL AND p."minStockLevel" > 0
        GROUP BY p."id", p."minStockLevel"
        HAVING COALESCE(SUM(b."onHand"), 0) <= p."minStockLevel"
      ) low
    `),
    prisma.product.count({ where: { status: 'ACTIVE', deletedAt: null } }),
    prisma.purchaseOrder.count({
      where: { status: { in: ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_RECEIVED'] } },
    }),
    prisma.orderDraft.count({
      where: { status: { in: ['PENDING_REVIEW', 'IN_REVIEW'] } },
    }),
  ]);

  return {
    tickets: {
      total: ticketTotal,
      newUnassigned: ticketNewUnassigned,
      open: ticketOpen,
      awaitingCustomer: ticketAwaitingCustomer,
      awaitingInternal: ticketAwaitingInternal,
      overdue: ticketOverdue,
      orderPending: ticketOrderPending,
    },
    sales: {
      ordersAwaitingConfirmation,
      ordersAwaitingFulfilment,
      todayTotal: todayInvoices.total,
      todayCount: todayInvoices.count,
      monthTotal: monthInvoices.total,
      monthCount: monthInvoices.count,
      outstandingReceivables: money(receivables[0]?.total ?? 0),
      overdueInvoices,
    },
    inventory: {
      lowStockCount: Number(lowStock[0]?.count ?? 0),
      totalSkus,
    },
    purchasing: { pendingOrders: pendingPurchaseOrders },
    drafts: { awaitingReview: draftsAwaiting },
  };
}

/** Recent activity feed for the dashboard. */
export async function getRecentTickets(limit = 8) {
  return prisma.ticket.findMany({
    orderBy: { lastActivityAt: 'desc' },
    take: limit,
    include: {
      customer: { select: { name: true, code: true } },
      assignee: { select: { name: true } },
    },
  });
}

export async function getSalesByDay(timeZone: string, days = 14) {
  const rows = await prisma.$queryRaw<
    Array<{ day: string; total: string; count: string }>
  >(Prisma.sql`
    SELECT to_char(("issueDate" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS day,
           COALESCE(SUM("grandTotal"), 0)::text AS total,
           COUNT(*)::text AS count
    FROM "sales_invoices"
    WHERE "status" NOT IN ('DRAFT', 'CANCELLED')
      AND "issueDate" >= now() - (${days} || ' days')::interval
    GROUP BY day
    ORDER BY day ASC
  `);
  return rows.map((r) => ({
    day: r.day,
    total: dec(r.total),
    count: Number(r.count),
  }));
}
