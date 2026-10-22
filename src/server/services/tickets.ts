import { prisma, type Db, type Tx } from '@/lib/db';
import { log } from '@/lib/logger';
import { nextNumber } from './numbering';
import {
  ChannelType,
  DeliveryStatus,
  DocumentKind,
  MessageDirection,
  MessageVisibility,
  TicketPriority,
  TicketStatus,
  type Prisma,
} from '@/generated/prisma/client';

const logger = log('tickets');

/**
 * Ticket service.
 *
 * Privacy invariant: a message with `visibility = INTERNAL` is an internal
 * note. It is never dispatched to a channel and never included in a
 * customer-facing projection. `customerVisibleMessages` is the only function
 * that should feed any outbound rendering, and it filters on the database side
 * rather than in the UI, so a forgetful template cannot leak a note.
 */

/* -------------------------------------------------------------------------- */
/*  Status workflow                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Default transitions, used when the TicketStatusTransition table is empty.
 * Administrators can override by populating that table.
 */
const DEFAULT_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  NEW: ['OPEN', 'IN_PROGRESS', 'AWAITING_CUSTOMER', 'AWAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  OPEN: ['IN_PROGRESS', 'AWAITING_CUSTOMER', 'AWAITING_INTERNAL', 'ORDER_PENDING_CONFIRMATION', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['OPEN', 'AWAITING_CUSTOMER', 'AWAITING_INTERNAL', 'ORDER_PENDING_CONFIRMATION', 'RESOLVED', 'CLOSED'],
  AWAITING_CUSTOMER: ['OPEN', 'IN_PROGRESS', 'ORDER_PENDING_CONFIRMATION', 'RESOLVED', 'CLOSED'],
  AWAITING_INTERNAL: ['OPEN', 'IN_PROGRESS', 'AWAITING_CUSTOMER', 'ORDER_PENDING_CONFIRMATION', 'RESOLVED', 'CLOSED'],
  ORDER_PENDING_CONFIRMATION: ['IN_PROGRESS', 'AWAITING_CUSTOMER', 'CONVERTED_TO_SALES_ORDER', 'RESOLVED', 'CLOSED'],
  CONVERTED_TO_SALES_ORDER: ['IN_PROGRESS', 'AWAITING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
  CLOSED: ['OPEN'],
};

export class InvalidTransitionError extends Error {
  constructor(from: TicketStatus, to: TicketStatus) {
    super(`Cannot move a ticket from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export async function allowedTransitions(
  from: TicketStatus,
  db: Db = prisma,
): Promise<TicketStatus[]> {
  const configured = await db.ticketStatusTransition.findMany({
    where: { fromStatus: from },
    select: { toStatus: true },
  });
  if (configured.length > 0) return configured.map((c) => c.toStatus);
  return DEFAULT_TRANSITIONS[from] ?? [];
}

export async function canTransition(
  from: TicketStatus,
  to: TicketStatus,
  db: Db = prisma,
): Promise<boolean> {
  if (from === to) return true;
  return (await allowedTransitions(from, db)).includes(to);
}

/* -------------------------------------------------------------------------- */
/*  SLA                                                                       */
/* -------------------------------------------------------------------------- */

interface BusinessHours {
  [day: string]: [string, string] | undefined;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Adds `minutes` of *business* time to a start instant.
 *
 * Walks forward in one-minute granularity over the configured windows. A naive
 * wall-clock deadline would mark a Friday-evening ticket overdue by Monday
 * morning without anyone having been at work.
 */
export function addBusinessMinutes(
  start: Date,
  minutes: number,
  hours: BusinessHours | null,
  timezoneOffsetMinutes = 0,
): Date {
  if (!hours || Object.keys(hours).length === 0) {
    return new Date(start.getTime() + minutes * 60_000);
  }

  let remaining = minutes;
  // Work in "local" ms by shifting the instant, then shift back at the end.
  let cursor = new Date(start.getTime() + timezoneOffsetMinutes * 60_000);
  let guard = 0;

  while (remaining > 0 && guard < 60 * 24 * 400) {
    guard += 1;
    const dayKey = DAY_KEYS[cursor.getUTCDay()];
    const window = dayKey ? hours[dayKey] : undefined;

    if (!window) {
      // Skip to the start of the next day.
      cursor = new Date(
        Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth(),
          cursor.getUTCDate() + 1,
          0,
          0,
          0,
        ),
      );
      continue;
    }

    const [openStr, closeStr] = window;
    const [openH = 0, openM = 0] = openStr.split(':').map(Number);
    const [closeH = 23, closeM = 59] = closeStr.split(':').map(Number);

    const dayOpen = Date.UTC(
      cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), openH, openM,
    );
    const dayClose = Date.UTC(
      cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), closeH, closeM,
    );

    if (cursor.getTime() < dayOpen) cursor = new Date(dayOpen);
    if (cursor.getTime() >= dayClose) {
      cursor = new Date(
        Date.UTC(
          cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1, 0, 0, 0,
        ),
      );
      continue;
    }

    const availableMinutes = Math.floor((dayClose - cursor.getTime()) / 60_000);
    if (availableMinutes >= remaining) {
      cursor = new Date(cursor.getTime() + remaining * 60_000);
      remaining = 0;
    } else {
      remaining -= availableMinutes;
      cursor = new Date(
        Date.UTC(
          cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1, 0, 0, 0,
        ),
      );
    }
  }

  return new Date(cursor.getTime() - timezoneOffsetMinutes * 60_000);
}

async function resolveSla(
  db: Db,
  departmentId: string | null | undefined,
) {
  if (departmentId) {
    const dept = await db.department.findUnique({
      where: { id: departmentId },
      select: { sla: true },
    });
    if (dept?.sla) return dept.sla;
  }
  return db.ticketSla.findFirst({ where: { isDefault: true } });
}

/* -------------------------------------------------------------------------- */
/*  Creation                                                                  */
/* -------------------------------------------------------------------------- */

export interface CreateTicketInput {
  subject: string;
  source: ChannelType;
  customerId?: string | null;
  contactId?: string | null;
  departmentId?: string | null;
  assigneeId?: string | null;
  channelId?: string | null;
  priority?: TicketPriority;
  requesterName?: string | null;
  requesterEmail?: string | null;
  requesterPhone?: string | null;
  createdById?: string | null;
  /** Optional opening message. */
  message?: {
    body: string;
    bodyHtml?: string | null;
    direction: MessageDirection;
    visibility?: MessageVisibility;
    authorId?: string | null;
    authorName?: string | null;
    externalMessageId?: string | null;
  };
  /** External thread keys, so replies can be matched back to this ticket. */
  externalRefs?: Array<{ refType: string; refValue: string }>;
}

export async function createTicket(input: CreateTicketInput, tx?: Tx) {
  const run = async (db: Tx) => {
    const number = await nextNumber(DocumentKind.TICKET, db);
    const sla = await resolveSla(db, input.departmentId);
    const now = new Date();

    const businessHours = (sla?.businessHours ?? null) as BusinessHours | null;

    const ticket = await db.ticket.create({
      data: {
        number,
        subject: input.subject.slice(0, 500),
        source: input.source,
        status: TicketStatus.NEW,
        priority: input.priority ?? TicketPriority.NORMAL,
        customerId: input.customerId ?? null,
        contactId: input.contactId ?? null,
        departmentId: input.departmentId ?? null,
        assigneeId: input.assigneeId ?? null,
        channelId: input.channelId ?? null,
        slaId: sla?.id ?? null,
        requesterName: input.requesterName ?? null,
        requesterEmail: input.requesterEmail ?? null,
        requesterPhone: input.requesterPhone ?? null,
        createdById: input.createdById ?? null,
        lastActivityAt: now,
        firstResponseDueAt: sla
          ? addBusinessMinutes(now, sla.firstResponseMins, businessHours)
          : null,
        resolutionDueAt: sla
          ? addBusinessMinutes(now, sla.resolutionMins, businessHours)
          : null,
      },
    });

    await db.ticketEvent.create({
      data: {
        ticketId: ticket.id,
        type: 'ticket.created',
        summary: `Ticket ${number} created via ${input.source}`,
        actorId: input.createdById ?? null,
      },
    });

    await db.ticketStatusHistory.create({
      data: {
        ticketId: ticket.id,
        fromStatus: null,
        toStatus: TicketStatus.NEW,
        changedById: input.createdById ?? null,
        reason: 'Ticket created',
      },
    });

    if (input.assigneeId) {
      await db.ticketAssignment.create({
        data: {
          ticketId: ticket.id,
          assigneeId: input.assigneeId,
          departmentId: input.departmentId ?? null,
          assignedById: input.createdById ?? null,
          note: 'Assigned at creation',
        },
      });
    }

    for (const ref of input.externalRefs ?? []) {
      await db.ticketExternalReference.upsert({
        where: {
          channel_refType_refValue: {
            channel: input.source,
            refType: ref.refType,
            refValue: ref.refValue,
          },
        },
        create: {
          ticketId: ticket.id,
          channel: input.source,
          refType: ref.refType,
          refValue: ref.refValue,
        },
        update: {},
      });
    }

    let message = null;
    if (input.message) {
      message = await addMessage(
        db,
        {
          ticketId: ticket.id,
          direction: input.message.direction,
          visibility: input.message.visibility ?? MessageVisibility.PUBLIC,
          channel: input.source,
          body: input.message.body,
          bodyHtml: input.message.bodyHtml ?? null,
          authorId: input.message.authorId ?? null,
          authorName: input.message.authorName ?? null,
          externalMessageId: input.message.externalMessageId ?? null,
        },
      );
    }

    return { ticket, message };
  };

  return tx ? run(tx) : prisma.$transaction(run);
}

/* -------------------------------------------------------------------------- */
/*  Messages                                                                  */
/* -------------------------------------------------------------------------- */

export interface AddMessageInput {
  ticketId: string;
  direction: MessageDirection;
  visibility?: MessageVisibility;
  channel: ChannelType;
  body: string;
  bodyHtml?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  externalMessageId?: string | null;
  deliveryStatus?: DeliveryStatus;
}

/**
 * Appends a message and maintains the ticket's reply-tracking columns.
 *
 * Internal notes deliberately do NOT advance `firstResponseAt`: writing a note
 * to yourself is not a response to the customer, and counting it would make
 * the SLA report flattering but wrong.
 */
export async function addMessage(db: Tx, input: AddMessageInput) {
  const visibility = input.visibility ?? MessageVisibility.PUBLIC;
  const isInternal = visibility === MessageVisibility.INTERNAL;
  const now = new Date();

  const message = await db.ticketMessage.create({
    data: {
      ticketId: input.ticketId,
      direction: input.direction,
      visibility,
      channel: input.channel,
      authorId: input.authorId ?? null,
      authorName: input.authorName ?? null,
      bodyText: input.body,
      bodyHtml: input.bodyHtml ?? null,
      externalMessageId: input.externalMessageId ?? null,
      deliveryStatus:
        input.deliveryStatus ??
        (input.direction === MessageDirection.INBOUND
          ? DeliveryStatus.DELIVERED
          : DeliveryStatus.PENDING),
      sentAt: input.direction === MessageDirection.OUTBOUND ? null : now,
    },
  });

  const ticket = await db.ticket.findUnique({
    where: { id: input.ticketId },
    select: { firstResponseAt: true, unreadForStaff: true, status: true },
  });

  const data: Prisma.TicketUpdateInput = { lastActivityAt: now };

  if (input.direction === MessageDirection.INBOUND) {
    data.lastCustomerAt = now;
    data.unreadForStaff = (ticket?.unreadForStaff ?? 0) + 1;
    // A customer reply moves the ball back to the team.
    if (
      ticket?.status === TicketStatus.AWAITING_CUSTOMER ||
      ticket?.status === TicketStatus.RESOLVED ||
      ticket?.status === TicketStatus.CLOSED
    ) {
      data.status = TicketStatus.OPEN;
    }
  } else if (!isInternal) {
    data.lastStaffAt = now;
    data.unreadForStaff = 0;
    if (!ticket?.firstResponseAt) data.firstResponseAt = now;
  }

  await db.ticket.update({ where: { id: input.ticketId }, data });

  return message;
}

/** Customer-visible reply. Refuses to be used for an internal note. */
export async function replyToCustomer(input: {
  ticketId: string;
  body: string;
  bodyHtml?: string | null;
  authorId: string;
  channel?: ChannelType;
}) {
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: input.ticketId },
      select: { id: true, source: true, status: true },
    });
    if (!ticket) throw new Error('Ticket not found');

    const message = await addMessage(tx, {
      ticketId: input.ticketId,
      direction: MessageDirection.OUTBOUND,
      visibility: MessageVisibility.PUBLIC,
      channel: input.channel ?? ticket.source,
      body: input.body,
      bodyHtml: input.bodyHtml ?? null,
      authorId: input.authorId,
      deliveryStatus: DeliveryStatus.QUEUED,
    });

    await tx.ticketEvent.create({
      data: {
        ticketId: input.ticketId,
        type: 'ticket.replied',
        summary: 'Reply sent to the customer',
        actorId: input.authorId,
        payload: { messageId: message.id } as never,
      },
    });

    return message;
  });
}

/** Internal note. Never leaves the application. */
export async function addInternalNote(input: {
  ticketId: string;
  body: string;
  authorId: string;
  mentionUserIds?: string[];
}) {
  return prisma.$transaction(async (tx) => {
    const message = await addMessage(tx, {
      ticketId: input.ticketId,
      direction: MessageDirection.OUTBOUND,
      visibility: MessageVisibility.INTERNAL,
      channel: ChannelType.MANUAL,
      body: input.body,
      authorId: input.authorId,
      // An internal note is never dispatched, so it is not "pending delivery".
      deliveryStatus: DeliveryStatus.SENT,
    });

    for (const userId of input.mentionUserIds ?? []) {
      await tx.ticketMention.create({
        data: {
          ticketId: input.ticketId,
          messageId: message.id,
          userId,
          authorId: input.authorId,
        },
      });
    }

    await tx.ticketEvent.create({
      data: {
        ticketId: input.ticketId,
        type: 'ticket.note_added',
        summary: 'Internal note added',
        actorId: input.authorId,
      },
    });

    return message;
  });
}

/**
 * The ONLY projection that may be used to build anything a customer sees.
 * Filtering happens in SQL so an internal note cannot reach a template.
 */
export async function customerVisibleMessages(
  ticketId: string,
  db: Db = prisma,
) {
  return db.ticketMessage.findMany({
    where: { ticketId, visibility: MessageVisibility.PUBLIC },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      direction: true,
      channel: true,
      bodyText: true,
      bodyHtml: true,
      authorName: true,
      createdAt: true,
      sentAt: true,
      deliveryStatus: true,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

export async function changeStatus(input: {
  ticketId: string;
  toStatus: TicketStatus;
  actorId: string | null;
  reason?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: input.ticketId },
      select: { id: true, status: true, number: true },
    });
    if (!ticket) throw new Error('Ticket not found');
    if (ticket.status === input.toStatus) return ticket;

    if (!(await canTransition(ticket.status, input.toStatus, tx))) {
      throw new InvalidTransitionError(ticket.status, input.toStatus);
    }

    const now = new Date();
    const updated = await tx.ticket.update({
      where: { id: input.ticketId },
      data: {
        status: input.toStatus,
        lastActivityAt: now,
        resolvedAt: input.toStatus === TicketStatus.RESOLVED ? now : undefined,
        closedAt: input.toStatus === TicketStatus.CLOSED ? now : undefined,
      },
    });

    await tx.ticketStatusHistory.create({
      data: {
        ticketId: input.ticketId,
        fromStatus: ticket.status,
        toStatus: input.toStatus,
        changedById: input.actorId,
        reason: input.reason ?? null,
      },
    });

    await tx.ticketEvent.create({
      data: {
        ticketId: input.ticketId,
        type: 'ticket.status_changed',
        summary: `Status changed from ${ticket.status} to ${input.toStatus}`,
        actorId: input.actorId,
        payload: { from: ticket.status, to: input.toStatus } as never,
      },
    });

    return updated;
  });
}

export async function assignTicket(input: {
  ticketId: string;
  assigneeId?: string | null;
  departmentId?: string | null;
  actorId: string | null;
  note?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: input.ticketId },
      select: { assigneeId: true, departmentId: true, status: true },
    });
    if (!ticket) throw new Error('Ticket not found');

    const updated = await tx.ticket.update({
      where: { id: input.ticketId },
      data: {
        assigneeId:
          input.assigneeId === undefined ? undefined : input.assigneeId,
        departmentId:
          input.departmentId === undefined ? undefined : input.departmentId,
        // Picking up a brand-new ticket implicitly opens it.
        status:
          ticket.status === TicketStatus.NEW && input.assigneeId
            ? TicketStatus.IN_PROGRESS
            : undefined,
        lastActivityAt: new Date(),
      },
    });

    await tx.ticketAssignment.create({
      data: {
        ticketId: input.ticketId,
        assigneeId: input.assigneeId ?? null,
        departmentId: input.departmentId ?? null,
        assignedById: input.actorId,
        note: input.note ?? null,
      },
    });

    const assignee = input.assigneeId
      ? await tx.user.findUnique({
          where: { id: input.assigneeId },
          select: { name: true },
        })
      : null;

    await tx.ticketEvent.create({
      data: {
        ticketId: input.ticketId,
        type: 'ticket.assigned',
        summary: assignee
          ? `Assigned to ${assignee.name}`
          : 'Assignment cleared',
        actorId: input.actorId,
      },
    });

    return updated;
  });
}

export async function changePriority(input: {
  ticketId: string;
  priority: TicketPriority;
  actorId: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: input.ticketId },
      select: { priority: true },
    });
    if (!ticket) throw new Error('Ticket not found');

    const updated = await tx.ticket.update({
      where: { id: input.ticketId },
      data: { priority: input.priority, lastActivityAt: new Date() },
    });

    await tx.ticketEvent.create({
      data: {
        ticketId: input.ticketId,
        type: 'ticket.priority_changed',
        summary: `Priority changed from ${ticket.priority} to ${input.priority}`,
        actorId: input.actorId,
      },
    });

    return updated;
  });
}

export async function markRead(ticketId: string) {
  await prisma.ticket.update({
    where: { id: ticketId },
    data: { unreadForStaff: 0 },
  });
}

/* -------------------------------------------------------------------------- */
/*  Inbox queries                                                             */
/* -------------------------------------------------------------------------- */

export type InboxFilter =
  | 'all'
  | 'new'
  | 'open'
  | 'in_progress'
  | 'awaiting_customer'
  | 'awaiting_internal'
  | 'order_pending'
  | 'converted'
  | 'resolved'
  | 'closed'
  | 'overdue'
  | 'unassigned'
  | 'mine'
  | 'whatsapp'
  | 'email'
  | 'manual';

export function inboxWhere(
  filter: InboxFilter,
  userId?: string | null,
): Prisma.TicketWhereInput {
  const now = new Date();
  const OPEN_STATES: TicketStatus[] = [
    TicketStatus.NEW,
    TicketStatus.OPEN,
    TicketStatus.IN_PROGRESS,
    TicketStatus.AWAITING_CUSTOMER,
    TicketStatus.AWAITING_INTERNAL,
    TicketStatus.ORDER_PENDING_CONFIRMATION,
  ];

  switch (filter) {
    case 'new':
      return { status: TicketStatus.NEW };
    case 'open':
      return { status: { in: OPEN_STATES } };
    case 'in_progress':
      return { status: TicketStatus.IN_PROGRESS };
    case 'awaiting_customer':
      return { status: TicketStatus.AWAITING_CUSTOMER };
    case 'awaiting_internal':
      return { status: TicketStatus.AWAITING_INTERNAL };
    case 'order_pending':
      return { status: TicketStatus.ORDER_PENDING_CONFIRMATION };
    case 'converted':
      return { status: TicketStatus.CONVERTED_TO_SALES_ORDER };
    case 'resolved':
      return { status: TicketStatus.RESOLVED };
    case 'closed':
      return { status: TicketStatus.CLOSED };
    case 'overdue':
      // Overdue = a deadline has passed and the obligation is still ours.
      return {
        status: { in: OPEN_STATES },
        OR: [
          { firstResponseAt: null, firstResponseDueAt: { lt: now } },
          { resolvedAt: null, resolutionDueAt: { lt: now } },
        ],
      };
    case 'unassigned':
      return { assigneeId: null, status: { in: OPEN_STATES } };
    case 'mine':
      return { assigneeId: userId ?? '__none__', status: { in: OPEN_STATES } };
    case 'whatsapp':
      return { source: ChannelType.WHATSAPP };
    case 'email':
      return { source: ChannelType.EMAIL };
    case 'manual':
      return { source: ChannelType.MANUAL };
    case 'all':
    default:
      return {};
  }
}

export interface ListTicketsOptions {
  filter?: InboxFilter;
  search?: string;
  assigneeId?: string | null;
  departmentId?: string | null;
  userId?: string | null;
  page?: number;
  pageSize?: number;
  sort?: 'recent' | 'oldest' | 'priority' | 'due';
}

export async function listTickets(options: ListTicketsOptions = {}) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, options.pageSize ?? 25));

  const where: Prisma.TicketWhereInput = {
    ...inboxWhere(options.filter ?? 'all', options.userId),
  };

  if (options.assigneeId) where.assigneeId = options.assigneeId;
  if (options.departmentId) where.departmentId = options.departmentId;

  if (options.search?.trim()) {
    const q = options.search.trim();
    where.OR = [
      { number: { contains: q, mode: 'insensitive' } },
      { subject: { contains: q, mode: 'insensitive' } },
      { requesterEmail: { contains: q, mode: 'insensitive' } },
      { requesterPhone: { contains: q, mode: 'insensitive' } },
      { customer: { name: { contains: q, mode: 'insensitive' } } },
      { customer: { code: { contains: q, mode: 'insensitive' } } },
      { messages: { some: { bodyText: { contains: q, mode: 'insensitive' } } } },
    ];
  }

  const orderBy: Prisma.TicketOrderByWithRelationInput[] =
    options.sort === 'oldest'
      ? [{ createdAt: 'asc' }]
      : options.sort === 'priority'
        ? [{ priority: 'desc' }, { lastActivityAt: 'desc' }]
        : options.sort === 'due'
          ? [{ firstResponseDueAt: 'asc' }]
          : [{ lastActivityAt: 'desc' }];

  const [items, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        customer: { select: { id: true, code: true, name: true } },
        contact: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        salesOrders: { select: { id: true, number: true }, take: 1 },
        _count: { select: { messages: true } },
      },
    }),
    prisma.ticket.count({ where }),
  ]);

  return { items, total, page, pageSize, pages: Math.ceil(total / pageSize) };
}

/** Counts for the inbox sidebar badges. */
export async function inboxCounts(userId?: string | null) {
  const filters: InboxFilter[] = [
    'all', 'new', 'open', 'awaiting_customer', 'awaiting_internal',
    'order_pending', 'overdue', 'unassigned', 'mine', 'resolved', 'closed',
    'whatsapp', 'email', 'manual',
  ];
  const entries = await Promise.all(
    filters.map(async (f) => {
      const count = await prisma.ticket.count({ where: inboxWhere(f, userId) });
      return [f, count] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<InboxFilter, number>;
}

export async function getTicketDetail(ticketId: string) {
  return prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      customer: {
        include: {
          priceLevel: { select: { id: true, name: true } },
          addresses: true,
        },
      },
      contact: true,
      assignee: { select: { id: true, name: true, email: true } },
      department: { select: { id: true, name: true } },
      sla: true,
      // Includes internal notes: this is the STAFF view. Anything
      // customer-facing must use customerVisibleMessages().
      messages: {
        orderBy: { createdAt: 'asc' },
        include: {
          author: { select: { id: true, name: true } },
          attachments: { include: { file: true } },
          outboundAttempts: { orderBy: { attemptNo: 'desc' }, take: 1 },
        },
      },
      events: { orderBy: { createdAt: 'desc' }, take: 50,
        include: { actor: { select: { name: true } } } },
      statusHistory: {
        orderBy: { createdAt: 'desc' },
        include: { changedBy: { select: { name: true } } },
      },
      tags: { include: { tag: true } },
      orderDrafts: {
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            orderBy: { sortOrder: 'asc' },
            include: {
              product: { select: { id: true, sku: true, name: true } },
              candidates: {
                orderBy: { rank: 'asc' },
                include: { product: { select: { id: true, sku: true, name: true } } },
              },
            },
          },
        },
      },
      quotations: { orderBy: { createdAt: 'desc' } },
      salesOrders: { orderBy: { createdAt: 'desc' } },
    },
  });
}

/** True when the ticket has breached either SLA clock. */
export function isOverdue(ticket: {
  firstResponseAt: Date | null;
  firstResponseDueAt: Date | null;
  resolvedAt: Date | null;
  resolutionDueAt: Date | null;
}, now = new Date()): boolean {
  if (
    !ticket.firstResponseAt &&
    ticket.firstResponseDueAt &&
    ticket.firstResponseDueAt < now
  ) {
    return true;
  }
  if (
    !ticket.resolvedAt &&
    ticket.resolutionDueAt &&
    ticket.resolutionDueAt < now
  ) {
    return true;
  }
  return false;
}

export { logger as ticketLogger };
