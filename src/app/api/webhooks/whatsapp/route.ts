import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import {
  ChannelType,
  DeliveryStatus,
  WebhookEventStatus,
} from '@/generated/prisma/client';
import {
  claimWebhookEvent,
  ingestInboundMessage,
  markEventProcessed,
} from '@/server/channels/ingest';
import {
  mapDeliveryStatus,
  parseWebhookBody,
  verifySubscription,
  verifyWebhookSignature,
  type InboundWhatsAppMessage,
} from '@/server/channels/whatsapp';
import { runExtraction } from '@/server/extraction/pipeline';

const logger = log('webhook.whatsapp');

/**
 * WhatsApp Business Cloud API webhook.
 *
 * GET  — Meta's subscription handshake (echoes hub.challenge).
 * POST — message and status events.
 *
 * Properties that matter for correctness:
 *
 *  - The RAW request body is read before any JSON parsing, because the
 *    X-Hub-Signature-256 HMAC is computed over the exact bytes Meta sent.
 *  - Every event is claimed through a UNIQUE insert first, so Meta's
 *    at-least-once retries cannot create duplicate tickets or messages.
 *  - We always answer 200 once the payload is authenticated and recorded.
 *    Returning 5xx on a downstream error would make Meta retry a payload we
 *    have already stored, and repeated failures can disable the subscription.
 */

// Signature verification needs the unbuffered body.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const result = verifySubscription({
    mode: params.get('hub.mode'),
    token: params.get('hub.verify_token'),
    challenge: params.get('hub.challenge'),
  });

  if (!result.ok) {
    logger.warn({ reason: result.reason }, 'webhook verification rejected');
    return new NextResponse(result.reason, { status: 403 });
  }

  // Meta requires the bare challenge string as the body.
  return new NextResponse(result.challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  const limit = rateLimit(
    `webhook:whatsapp:${ip}`,
    env().RATE_LIMIT_WEBHOOK_PER_MINUTE,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'rate limited' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  // Must be the raw bytes: re-serialising parsed JSON changes the HMAC.
  const rawBody = await request.text();

  const signature = verifyWebhookSignature(
    rawBody,
    request.headers.get('x-hub-signature-256'),
  );
  if (!signature.ok) {
    logger.warn({ reason: signature.reason, ip }, 'webhook signature rejected');
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'malformed json' }, { status: 400 });
  }

  const channel = await prisma.communicationChannel
    .findUnique({ where: { key: 'WHATSAPP_MAIN' }, select: { id: true, departmentId: true } })
    .catch(() => null);

  const parsed = parseWebhookBody(body);

  let processed = 0;
  let duplicates = 0;
  const errors: string[] = [];

  for (const event of parsed.events) {
    const gate = await claimWebhookEvent({
      channelType: ChannelType.WHATSAPP,
      eventId: event.eventId,
      eventType: event.kind,
      rawBody,
      payload: event.kind === 'message' ? event.message : event.status,
      channelId: channel?.id ?? null,
    });

    if (!gate.fresh) {
      duplicates += 1;
      continue;
    }

    try {
      if (event.kind === 'message') {
        await handleInboundMessage(event.message, channel);
      } else {
        await handleStatusUpdate(event.status);
      }
      await markEventProcessed(gate.recordId, WebhookEventStatus.PROCESSED);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      logger.error(
        { eventId: event.eventId, error: message },
        'failed to process webhook event',
      );
      await markEventProcessed(
        gate.recordId,
        WebhookEventStatus.FAILED,
        message,
      );
    }
  }

  // 200 even with downstream errors: the event is recorded as FAILED and can
  // be replayed from the admin UI. Asking Meta to retry risks duplicate work
  // and, after repeated 5xx, subscription suspension.
  return NextResponse.json({
    received: parsed.events.length,
    processed,
    duplicates,
    failed: errors.length,
  });
}

async function handleInboundMessage(
  message: InboundWhatsAppMessage,
  channel: { id: string; departmentId: string | null } | null,
) {
  // Unsupported payload types still produce a ticket entry so nothing is lost;
  // the agent sees a placeholder rather than silence.
  const bodyText =
    message.text ??
    (message.mediaId
      ? `[${message.type} attachment${message.mediaFilename ? `: ${message.mediaFilename}` : ''}]`
      : `[unsupported message type: ${message.type}]`);

  const result = await ingestInboundMessage({
    channelType: ChannelType.WHATSAPP,
    channelId: channel?.id ?? null,
    externalId: message.messageId,
    conversationId: message.phoneNumberId || null,
    fromAddress: message.from,
    bodyText,
    authorName: message.profileName,
    receivedAt: message.timestamp,
    rawPayload: message,
    contextMessageId: message.contextMessageId,
    departmentId: channel?.departmentId ?? null,
  });

  if ('skipped' in result) return;

  // Extraction runs on text content only, and always produces an inert draft
  // that a human must review before anything is quoted or ordered.
  if (message.text && message.text.trim().length > 0) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: result.ticketId },
      select: { customerId: true },
    });
    await runExtraction({
      text: message.text,
      ticketId: result.ticketId,
      ticketMessageId: result.ticketMessageId,
      externalMessageId: result.externalMessageId,
      customerId: ticket?.customerId ?? null,
    }).catch((error: unknown) => {
      // Extraction is best-effort: the message is already safely stored.
      logger.warn(
        { ticketId: result.ticketId, error: String(error) },
        'extraction failed for inbound whatsapp message',
      );
    });
  }
}

async function handleStatusUpdate(status: {
  messageId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  timestamp: Date;
}) {
  const mapped = mapDeliveryStatus(status.status);
  if (!mapped) return;

  const message = await prisma.ticketMessage.findFirst({
    where: { externalMessageId: status.messageId },
    select: { id: true, deliveryStatus: true },
  });
  if (!message) return;

  // Never regress a delivery state: an out-of-order 'sent' after 'read'
  // would otherwise make the UI look like the message un-delivered itself.
  const rank: Record<string, number> = {
    PENDING: 0,
    QUEUED: 1,
    SENT: 2,
    DELIVERED: 3,
    READ: 4,
    FAILED: 5,
  };
  if ((rank[mapped] ?? 0) < (rank[message.deliveryStatus] ?? 0)) return;

  await prisma.ticketMessage.update({
    where: { id: message.id },
    data: {
      deliveryStatus: mapped as DeliveryStatus,
      readAt: mapped === 'READ' ? status.timestamp : undefined,
    },
  });

  if (mapped === 'FAILED') {
    await prisma.outboundMessageAttempt.updateMany({
      where: { ticketMessageId: message.id },
      data: {
        status: DeliveryStatus.FAILED,
        errorCode: status.errorCode,
        errorMessage: status.errorMessage,
      },
    });
  }
}
