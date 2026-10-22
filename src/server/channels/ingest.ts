import { prisma, type Tx } from '@/lib/db';
import { log } from '@/lib/logger';
import { sha256Hex } from '@/lib/crypto';
import {
  ChannelType,
  MessageDirection,
  MessageVisibility,
  Prisma,
  WebhookEventStatus,
} from '@/generated/prisma/client';
import { addMessage, createTicket } from '@/server/services/tickets';
import { toE164 } from './whatsapp';

const logger = log('ingest');

/**
 * Inbound message ingestion: identity resolution, thread matching and
 * deduplication.
 *
 * Three rules shape this module:
 *
 *  1. **Idempotency is a database constraint, not a check.** The unique index
 *     on (channelType, eventId) is what makes at-least-once webhook delivery
 *     safe; a duplicate insert loses the race and is skipped. A read-then-write
 *     guard would still double-insert under concurrent retries.
 *  2. **Threading is explicit.** A reply joins a ticket via a recorded
 *     TicketExternalReference (RFC 5322 Message-ID chain, or the WhatsApp
 *     message/conversation id) — never by sender address alone, which would
 *     merge unrelated enquiries from the same person.
 *  3. **Customer identity is only inferred from verified identifiers.** An
 *     unverified match is left for a human; nothing is auto-merged on a
 *     similar name.
 */

/* -------------------------------------------------------------------------- */
/*  Idempotency                                                               */
/* -------------------------------------------------------------------------- */

export type EventGate =
  | { fresh: true; recordId: string }
  | { fresh: false; reason: 'duplicate'; recordId: string | null };

/**
 * Claims an event id. Returns `fresh: false` when this event was already
 * received, which is the signal to skip processing entirely.
 */
export async function claimWebhookEvent(input: {
  channelType: ChannelType;
  eventId: string;
  eventType?: string | null;
  rawBody?: string | null;
  payload?: unknown;
  channelId?: string | null;
}): Promise<EventGate> {
  try {
    const record = await prisma.processedWebhookEvent.create({
      data: {
        channelType: input.channelType,
        eventId: input.eventId,
        eventType: input.eventType ?? null,
        channelId: input.channelId ?? null,
        status: WebhookEventStatus.RECEIVED,
        payloadHash: input.rawBody ? sha256Hex(input.rawBody) : null,
        payload: (input.payload ?? undefined) as never,
      },
    });
    return { fresh: true, recordId: record.id };
  } catch (error) {
    // P2002 = unique violation on (channelType, eventId): already seen.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prisma.processedWebhookEvent.findUnique({
        where: {
          channelType_eventId: {
            channelType: input.channelType,
            eventId: input.eventId,
          },
        },
        select: { id: true },
      });
      logger.info(
        { eventId: input.eventId, channel: input.channelType },
        'duplicate webhook event skipped',
      );
      return { fresh: false, reason: 'duplicate', recordId: existing?.id ?? null };
    }
    throw error;
  }
}

export async function markEventProcessed(
  recordId: string,
  status: WebhookEventStatus,
  error?: string | null,
) {
  await prisma.processedWebhookEvent.update({
    where: { id: recordId },
    data: { status, processedAt: new Date(), error: error ?? null },
  });
}

/* -------------------------------------------------------------------------- */
/*  Identity resolution                                                       */
/* -------------------------------------------------------------------------- */

export interface ResolvedIdentity {
  customerId: string | null;
  contactId: string | null;
  /** True when the identifier used was marked verified by a human. */
  verified: boolean;
}

/**
 * Resolves a sender by email address.
 *
 * Only a verified contact email, or the customer's own primary email, is
 * trusted. An unverified contact match is returned but flagged, so the ticket
 * can be created while still prompting a human to confirm the link.
 */
export async function resolveByEmail(
  email: string,
  db: Tx | typeof prisma = prisma,
): Promise<ResolvedIdentity> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return { customerId: null, contactId: null, verified: false };

  const verifiedContact = await db.customerContact.findFirst({
    where: {
      email: { equals: normalised, mode: 'insensitive' },
      emailVerified: true,
      status: 'ACTIVE',
    },
    select: { id: true, customerId: true },
  });
  if (verifiedContact) {
    return {
      customerId: verifiedContact.customerId,
      contactId: verifiedContact.id,
      verified: true,
    };
  }

  const customer = await db.customer.findFirst({
    where: {
      primaryEmail: { equals: normalised, mode: 'insensitive' },
      deletedAt: null,
    },
    select: { id: true },
  });
  if (customer) {
    return { customerId: customer.id, contactId: null, verified: true };
  }

  const unverifiedContact = await db.customerContact.findFirst({
    where: {
      email: { equals: normalised, mode: 'insensitive' },
      status: 'ACTIVE',
    },
    select: { id: true, customerId: true },
  });
  if (unverifiedContact) {
    return {
      customerId: unverifiedContact.customerId,
      contactId: unverifiedContact.id,
      verified: false,
    };
  }

  return { customerId: null, contactId: null, verified: false };
}

/** Resolves a sender by phone number, normalising to E.164 first. */
export async function resolveByPhone(
  phone: string,
  db: Tx | typeof prisma = prisma,
): Promise<ResolvedIdentity> {
  const e164 = toE164(phone);
  if (!e164) return { customerId: null, contactId: null, verified: false };

  const verified = await db.customerContact.findFirst({
    where: {
      OR: [{ whatsappE164: e164 }, { phoneE164: e164 }],
      whatsappVerified: true,
      status: 'ACTIVE',
    },
    select: { id: true, customerId: true },
  });
  if (verified) {
    return { customerId: verified.customerId, contactId: verified.id, verified: true };
  }

  const customer = await db.customer.findFirst({
    where: { primaryPhone: e164, deletedAt: null },
    select: { id: true },
  });
  if (customer) {
    return { customerId: customer.id, contactId: null, verified: true };
  }

  const unverified = await db.customerContact.findFirst({
    where: {
      OR: [{ whatsappE164: e164 }, { phoneE164: e164 }],
      status: 'ACTIVE',
    },
    select: { id: true, customerId: true },
  });
  if (unverified) {
    return {
      customerId: unverified.customerId,
      contactId: unverified.id,
      verified: false,
    };
  }

  return { customerId: null, contactId: null, verified: false };
}

/* -------------------------------------------------------------------------- */
/*  Thread matching                                                           */
/* -------------------------------------------------------------------------- */

/** Looks up a ticket by a recorded external reference. */
export async function findTicketByRef(
  channel: ChannelType,
  refType: string,
  refValue: string,
  db: Tx | typeof prisma = prisma,
): Promise<string | null> {
  if (!refValue) return null;
  const ref = await db.ticketExternalReference.findUnique({
    where: { channel_refType_refValue: { channel, refType, refValue } },
    select: { ticketId: true },
  });
  return ref?.ticketId ?? null;
}

/** Splits an RFC 5322 References header into individual message ids. */
export function parseReferences(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('<') && s.endsWith('>'));
}

export interface EmailThreadKeys {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string | null;
}

export type ThreadMatch =
  | { ticketId: string; via: string }
  | { ticketId: null; via: 'none' };

/**
 * Resolves which ticket an inbound email belongs to.
 *
 * Resolution order follows the strength of the evidence:
 *   1. In-Reply-To -> a message id we previously recorded
 *   2. References chain -> any recorded message id (nearest ancestor last)
 *   3. our ticket number appearing in the subject (e.g. "[TKT-202610-00007]")
 *
 * Sender address is deliberately NOT a fallback: two unrelated enquiries from
 * the same buyer must not collapse into one ticket.
 */
export async function matchEmailThread(
  keys: EmailThreadKeys,
  db: Tx | typeof prisma = prisma,
): Promise<ThreadMatch> {
  if (keys.inReplyTo) {
    const ticketId = await findTicketByRef(
      ChannelType.EMAIL,
      'email_message_id',
      keys.inReplyTo,
      db,
    );
    if (ticketId) return { ticketId, via: 'in-reply-to' };
  }

  // Walk the chain from nearest ancestor backwards.
  const refs = parseReferences(keys.references).reverse();
  for (const ref of refs) {
    const ticketId = await findTicketByRef(
      ChannelType.EMAIL,
      'email_message_id',
      ref,
      db,
    );
    if (ticketId) return { ticketId, via: 'references' };
  }

  if (keys.subject) {
    const match = /\b((?:TKT|TICKET)-[A-Z0-9-]+)\b/i.exec(keys.subject);
    const number = match?.[1];
    if (number) {
      const ticket = await db.ticket.findUnique({
        where: { number: number.toUpperCase() },
        select: { id: true },
      });
      if (ticket) return { ticketId: ticket.id, via: 'subject-token' };
    }
  }

  return { ticketId: null, via: 'none' };
}

/**
 * Resolves which ticket an inbound WhatsApp message belongs to.
 *
 * A quoted reply (`context.id`) is the strongest signal. Otherwise the sender's
 * wa_id is used — but only to find a ticket that is still OPEN, so a new
 * enquiry weeks later starts a fresh ticket rather than reopening a closed one.
 */
export async function matchWhatsAppThread(
  input: { waId: string; contextMessageId?: string | null },
  db: Tx | typeof prisma = prisma,
): Promise<ThreadMatch> {
  if (input.contextMessageId) {
    const viaContext = await db.ticketMessage.findFirst({
      where: { externalMessageId: input.contextMessageId },
      select: { ticketId: true },
    });
    if (viaContext) return { ticketId: viaContext.ticketId, via: 'quoted-message' };
  }

  const ref = await db.ticketExternalReference.findUnique({
    where: {
      channel_refType_refValue: {
        channel: ChannelType.WHATSAPP,
        refType: 'whatsapp_wa_id',
        refValue: input.waId,
      },
    },
    select: { ticketId: true, ticket: { select: { status: true } } },
  });

  if (ref) {
    const open = !['RESOLVED', 'CLOSED', 'CONVERTED_TO_SALES_ORDER'].includes(
      ref.ticket.status,
    );
    if (open) return { ticketId: ref.ticketId, via: 'wa-id-open-thread' };
  }

  return { ticketId: null, via: 'none' };
}

/* -------------------------------------------------------------------------- */
/*  Ingestion                                                                 */
/* -------------------------------------------------------------------------- */

export interface IngestResult {
  ticketId: string;
  ticketMessageId: string;
  externalMessageId: string;
  created: boolean;
  needsManualReview: boolean;
  threadVia: string;
}

export interface IngestInboundInput {
  channelType: ChannelType;
  channelId?: string | null;
  /** Provider's own message id — the dedup key for this message. */
  externalId: string;
  conversationId?: string | null;
  fromAddress: string;
  toAddress?: string | null;
  subject?: string | null;
  bodyText: string;
  bodyHtmlRaw?: string | null;
  receivedAt?: Date;
  rawPayload?: unknown;
  authorName?: string | null;
  /** Email threading headers. */
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  /** WhatsApp quoted-message id. */
  contextMessageId?: string | null;
  departmentId?: string | null;
}

/**
 * Persists an inbound message and attaches it to the right ticket.
 *
 * The whole operation is one transaction: the verbatim ExternalMessage, the
 * TicketMessage, and the ticket's reply-tracking state commit together, so a
 * crash mid-way cannot leave a message recorded but unthreaded.
 */
export async function ingestInboundMessage(
  input: IngestInboundInput,
): Promise<IngestResult | { skipped: 'duplicate'; ticketId: string | null }> {
  // Message-level dedup, independent of the webhook-event gate: IMAP re-reads
  // and Meta retries can both resurface the same provider message id.
  const existing = await prisma.externalMessage.findUnique({
    where: {
      channelType_externalId: {
        channelType: input.channelType,
        externalId: input.externalId,
      },
    },
    select: { ticketId: true },
  });
  if (existing) {
    logger.info(
      { externalId: input.externalId },
      'inbound message already ingested; skipping',
    );
    return { skipped: 'duplicate', ticketId: existing.ticketId };
  }

  return prisma.$transaction(async (tx) => {
    const identity =
      input.channelType === ChannelType.WHATSAPP
        ? await resolveByPhone(input.fromAddress, tx)
        : await resolveByEmail(input.fromAddress, tx);

    const thread =
      input.channelType === ChannelType.WHATSAPP
        ? await matchWhatsAppThread(
            {
              waId: input.fromAddress,
              contextMessageId: input.contextMessageId,
            },
            tx,
          )
        : await matchEmailThread(
            {
              messageId: input.messageIdHeader ?? null,
              inReplyTo: input.inReplyTo ?? null,
              references: input.references ?? null,
              subject: input.subject ?? null,
            },
            tx,
          );

    // A sender we cannot tie to a customer needs a human to triage.
    const needsManualReview = !identity.customerId || !identity.verified;

    let ticketId = thread.ticketId;
    let created = false;
    let ticketMessageId: string;

    if (ticketId) {
      const message = await addMessage(tx, {
        ticketId,
        direction: MessageDirection.INBOUND,
        visibility: MessageVisibility.PUBLIC,
        channel: input.channelType,
        body: input.bodyText,
        authorName: input.authorName ?? input.fromAddress,
        externalMessageId: input.externalId,
      });
      ticketMessageId = message.id;
    } else {
      const subject =
        input.subject?.trim() ||
        `${input.channelType === ChannelType.WHATSAPP ? 'WhatsApp' : 'Email'} from ${input.authorName ?? input.fromAddress}`;

      const result = await createTicket(
        {
          subject,
          source: input.channelType,
          customerId: identity.customerId,
          contactId: identity.contactId,
          departmentId: input.departmentId ?? null,
          channelId: input.channelId ?? null,
          requesterName: input.authorName ?? null,
          requesterEmail:
            input.channelType === ChannelType.EMAIL ? input.fromAddress : null,
          requesterPhone:
            input.channelType === ChannelType.WHATSAPP
              ? (toE164(input.fromAddress) ?? input.fromAddress)
              : null,
          message: {
            body: input.bodyText,
            direction: MessageDirection.INBOUND,
            authorName: input.authorName ?? input.fromAddress,
            externalMessageId: input.externalId,
          },
          externalRefs:
            input.channelType === ChannelType.WHATSAPP
              ? [{ refType: 'whatsapp_wa_id', refValue: input.fromAddress }]
              : [],
        },
        tx,
      );
      ticketId = result.ticket.id;
      created = true;
      if (!result.message) {
        throw new Error('Ticket created without its opening message');
      }
      ticketMessageId = result.message.id;
    }

    // Record this message's own id so later replies can thread onto it.
    if (input.channelType === ChannelType.EMAIL && input.messageIdHeader) {
      await tx.ticketExternalReference.upsert({
        where: {
          channel_refType_refValue: {
            channel: ChannelType.EMAIL,
            refType: 'email_message_id',
            refValue: input.messageIdHeader,
          },
        },
        create: {
          ticketId,
          channel: ChannelType.EMAIL,
          refType: 'email_message_id',
          refValue: input.messageIdHeader,
        },
        update: {},
      });
    }

    const external = await tx.externalMessage.create({
      data: {
        channelId: input.channelId ?? null,
        channelType: input.channelType,
        direction: MessageDirection.INBOUND,
        externalId: input.externalId,
        conversationId: input.conversationId ?? null,
        messageIdHeader: input.messageIdHeader ?? null,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ?? null,
        fromAddress: input.fromAddress,
        toAddress: input.toAddress ?? null,
        subject: input.subject ?? null,
        bodyText: input.bodyText,
        bodyHtmlRaw: input.bodyHtmlRaw ?? null,
        rawPayload: (input.rawPayload ?? undefined) as never,
        receivedAt: input.receivedAt ?? new Date(),
        processedAt: new Date(),
        needsManualReview,
        ticketId,
        ticketMessageId,
        customerId: identity.customerId,
        contactId: identity.contactId,
      },
    });

    if (needsManualReview) {
      await tx.ticketEvent.create({
        data: {
          ticketId,
          type: 'ticket.needs_identity_review',
          summary: identity.customerId
            ? 'Sender matched an UNVERIFIED contact — confirm the customer link'
            : 'Sender could not be matched to a customer',
          payload: { fromAddress: input.fromAddress } as never,
        },
      });
    }

    return {
      ticketId,
      ticketMessageId,
      externalMessageId: external.id,
      created,
      needsManualReview,
      threadVia: thread.via,
    };
  });
}
