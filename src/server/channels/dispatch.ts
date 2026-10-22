import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import {
  ChannelType,
  DeliveryStatus,
  MessageVisibility,
} from '@/generated/prisma/client';
import { sendTextMessage } from './whatsapp';
import { replySubject, sendEmail, subjectWithTicket } from './email';

const logger = log('dispatch');

/**
 * Outbound dispatcher.
 *
 * Two guarantees:
 *
 *  1. **An internal note is never dispatched.** The visibility check here is
 *     the last line of defence behind the ticket service; dispatching a note
 *     would leak internal commentary to a customer, so it throws rather than
 *     silently skipping.
 *  2. **Delivery is never faked.** Every attempt is recorded on
 *     OutboundMessageAttempt with the provider's response, and an unconfigured
 *     channel produces an explicit FAILED attempt with the missing
 *     configuration named — the reply stays on the ticket, flagged undelivered.
 */

export interface DispatchResult {
  delivered: boolean;
  reason: string;
  providerMessageId?: string;
  attemptNo: number;
}

export async function dispatchOutboundMessage(
  ticketMessageId: string,
): Promise<DispatchResult> {
  const message = await prisma.ticketMessage.findUnique({
    where: { id: ticketMessageId },
    include: {
      ticket: {
        include: {
          customer: { select: { primaryEmail: true, primaryPhone: true } },
          contact: {
            select: { email: true, phoneE164: true, whatsappE164: true },
          },
        },
      },
    },
  });

  if (!message) throw new Error('Ticket message not found');

  if (message.visibility === MessageVisibility.INTERNAL) {
    // Refuse loudly: this would be a privacy breach.
    throw new Error('Internal notes must never be dispatched to a customer');
  }

  const attemptNo =
    (await prisma.outboundMessageAttempt.count({
      where: { ticketMessageId },
    })) + 1;

  const recipient = resolveRecipient(message.channel, message.ticket);

  if (!recipient) {
    return finishAttempt({
      ticketMessageId,
      attemptNo,
      channelType: message.channel,
      status: DeliveryStatus.FAILED,
      errorCode: 'NO_RECIPIENT',
      errorMessage:
        'No destination address on the ticket. Add a verified email or WhatsApp number to the customer contact.',
    });
  }

  if (message.channel === ChannelType.MANUAL) {
    // A manual ticket has no outbound transport; the reply is a record of a
    // conversation that happened by phone or in person.
    return finishAttempt({
      ticketMessageId,
      attemptNo,
      channelType: message.channel,
      status: DeliveryStatus.SENT,
      errorMessage: null,
      note: 'Manual channel — recorded without electronic delivery',
    });
  }

  if (message.channel === ChannelType.WHATSAPP) {
    const result = await sendTextMessage({
      to: recipient,
      body: message.bodyText,
    });

    return result.ok
      ? finishAttempt({
          ticketMessageId,
          attemptNo,
          channelType: message.channel,
          status: DeliveryStatus.SENT,
          providerMessageId: result.providerMessageId,
          responsePayload: result.raw,
        })
      : finishAttempt({
          ticketMessageId,
          attemptNo,
          channelType: message.channel,
          status: DeliveryStatus.FAILED,
          errorCode: result.code,
          errorMessage: result.error,
          responsePayload: result.raw,
        });
  }

  if (message.channel === ChannelType.EMAIL) {
    // Preserve the inbound chain so the customer's client threads the reply.
    const refs = await prisma.ticketExternalReference.findMany({
      where: {
        ticketId: message.ticketId,
        channel: ChannelType.EMAIL,
        refType: 'email_message_id',
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { refValue: true },
    });

    const subject = subjectWithTicket(
      replySubject(message.ticket.subject),
      message.ticket.number,
    );

    const result = await sendEmail({
      to: recipient,
      subject,
      text: message.bodyText,
      html: message.bodyHtml,
      inReplyTo: refs[0]?.refValue ?? null,
      references: refs.map((r) => r.refValue).reverse(),
    });

    return result.ok
      ? finishAttempt({
          ticketMessageId,
          attemptNo,
          channelType: message.channel,
          status: DeliveryStatus.SENT,
          providerMessageId: result.providerMessageId,
          responsePayload: result.raw,
        })
      : finishAttempt({
          ticketMessageId,
          attemptNo,
          channelType: message.channel,
          status: DeliveryStatus.FAILED,
          errorCode: result.code,
          errorMessage: result.error,
        });
  }

  return finishAttempt({
    ticketMessageId,
    attemptNo,
    channelType: message.channel,
    status: DeliveryStatus.FAILED,
    errorCode: 'UNSUPPORTED_CHANNEL',
    errorMessage: `No transport for channel ${message.channel}`,
  });
}

function resolveRecipient(
  channel: ChannelType,
  ticket: {
    requesterEmail: string | null;
    requesterPhone: string | null;
    customer: { primaryEmail: string | null; primaryPhone: string | null } | null;
    contact: {
      email: string | null;
      phoneE164: string | null;
      whatsappE164: string | null;
    } | null;
  },
): string | null {
  if (channel === ChannelType.EMAIL) {
    return (
      ticket.contact?.email ??
      ticket.customer?.primaryEmail ??
      ticket.requesterEmail ??
      null
    );
  }
  if (channel === ChannelType.WHATSAPP) {
    return (
      ticket.contact?.whatsappE164 ??
      ticket.contact?.phoneE164 ??
      ticket.customer?.primaryPhone ??
      ticket.requesterPhone ??
      null
    );
  }
  // Manual tickets need no transport; return a sentinel so the caller
  // distinguishes "no transport needed" from "no address known".
  return 'manual';
}

async function finishAttempt(input: {
  ticketMessageId: string;
  attemptNo: number;
  channelType: ChannelType;
  status: DeliveryStatus;
  providerMessageId?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  responsePayload?: unknown;
  note?: string;
}): Promise<DispatchResult> {
  await prisma.$transaction(async (tx) => {
    await tx.outboundMessageAttempt.create({
      data: {
        ticketMessageId: input.ticketMessageId,
        channelType: input.channelType,
        attemptNo: input.attemptNo,
        status: input.status,
        providerMessageId: input.providerMessageId ?? null,
        responsePayload: (input.responsePayload ?? undefined) as never,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        completedAt: new Date(),
      },
    });

    await tx.ticketMessage.update({
      where: { id: input.ticketMessageId },
      data: {
        deliveryStatus: input.status,
        externalMessageId: input.providerMessageId ?? undefined,
        sentAt: input.status === DeliveryStatus.SENT ? new Date() : undefined,
      },
    });
  });

  const delivered = input.status === DeliveryStatus.SENT;
  if (!delivered) {
    logger.warn(
      {
        ticketMessageId: input.ticketMessageId,
        code: input.errorCode,
        error: input.errorMessage,
      },
      'outbound dispatch failed',
    );
  }

  return {
    delivered,
    reason: input.note ?? input.errorMessage ?? 'Sent',
    providerMessageId: input.providerMessageId,
    attemptNo: input.attemptNo,
  };
}
