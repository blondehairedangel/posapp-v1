import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { verifyHmacSha256 } from '@/lib/crypto';

const logger = log('whatsapp');

/**
 * WhatsApp Business Platform Cloud API client (official Graph API only).
 *
 * This module never pretends to work. When credentials are absent, every send
 * returns `configured: false` with the list of missing variables, and the UI
 * surfaces that to the operator instead of showing a delivered reply.
 */

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  apiVersion: string;
  appSecret?: string;
  verifyToken?: string;
}

export type ConfigResult =
  | { configured: true; config: WhatsAppConfig }
  | { configured: false; missing: string[] };

export function getWhatsAppConfig(): ConfigResult {
  const e = env();
  const missing: string[] = [];
  if (!e.WHATSAPP_ACCESS_TOKEN) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!e.WHATSAPP_PHONE_NUMBER_ID) missing.push('WHATSAPP_PHONE_NUMBER_ID');

  if (missing.length > 0 || !e.WHATSAPP_ENABLED) {
    return {
      configured: false,
      missing: e.WHATSAPP_ENABLED ? missing : ['WHATSAPP_ENABLED=true', ...missing],
    };
  }

  return {
    configured: true,
    config: {
      accessToken: e.WHATSAPP_ACCESS_TOKEN as string,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID as string,
      businessAccountId: e.WHATSAPP_BUSINESS_ACCOUNT_ID,
      apiVersion: e.WHATSAPP_API_VERSION,
      appSecret: e.WHATSAPP_APP_SECRET,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Phone normalisation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Normalises an Indonesian or international number to E.164.
 *
 * WhatsApp reports `wa_id` without a leading '+', and customers write their
 * numbers as 08xx, 628xx, or +628xx. Matching on the raw string would miss
 * obvious matches, so one canonical form is used everywhere.
 */
export function toE164(raw: string, defaultCountry = '62'): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;

  let national = digits.startsWith('+') ? digits.slice(1) : digits;

  // Indonesian local form: 08xx -> 628xx
  if (national.startsWith('0')) {
    national = `${defaultCountry}${national.slice(1)}`;
  }
  // Bare mobile prefix without country code: 8xx -> 628xx
  else if (defaultCountry === '62' && national.startsWith('8')) {
    national = `${defaultCountry}${national}`;
  }

  if (national.length < 8 || national.length > 15) return null;
  return `+${national}`;
}

/* -------------------------------------------------------------------------- */
/*  Webhook verification                                                      */
/* -------------------------------------------------------------------------- */

/** Meta's GET handshake: echo hub.challenge when the verify token matches. */
export function verifySubscription(params: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}): { ok: true; challenge: string } | { ok: false; reason: string } {
  const config = getWhatsAppConfig();
  const verifyToken = config.configured
    ? config.config.verifyToken
    : env().WHATSAPP_VERIFY_TOKEN;

  if (!verifyToken) {
    return { ok: false, reason: 'WHATSAPP_VERIFY_TOKEN is not configured' };
  }
  if (params.mode !== 'subscribe') {
    return { ok: false, reason: 'Unexpected hub.mode' };
  }
  if (params.token !== verifyToken) {
    return { ok: false, reason: 'Verify token mismatch' };
  }
  if (!params.challenge) {
    return { ok: false, reason: 'Missing hub.challenge' };
  }
  return { ok: true, challenge: params.challenge };
}

/**
 * Validates `X-Hub-Signature-256` against the RAW body.
 *
 * In production an unset app secret is a hard failure: accepting unsigned
 * webhooks would let anyone inject messages into the ticket system. In
 * development it is allowed through with a loud warning so the pipeline can be
 * exercised locally.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): { ok: boolean; reason?: string } {
  const appSecret = env().WHATSAPP_APP_SECRET;

  if (!appSecret) {
    if (env().NODE_ENV === 'production') {
      return {
        ok: false,
        reason:
          'WHATSAPP_APP_SECRET is not configured; refusing unsigned webhook in production',
      };
    }
    logger.warn(
      'WHATSAPP_APP_SECRET not set — webhook signature NOT verified (development only)',
    );
    return { ok: true, reason: 'unverified-development' };
  }

  if (!signatureHeader) {
    return { ok: false, reason: 'Missing X-Hub-Signature-256 header' };
  }
  if (!verifyHmacSha256(rawBody, signatureHeader, appSecret)) {
    return { ok: false, reason: 'Signature mismatch' };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Inbound payload parsing                                                   */
/* -------------------------------------------------------------------------- */

export interface InboundWhatsAppMessage {
  messageId: string;
  from: string;
  fromE164: string | null;
  profileName: string | null;
  timestamp: Date;
  type: string;
  text: string | null;
  /** Media id, when the message carries a document/image. */
  mediaId: string | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  /** Provider conversation key used for thread matching. */
  phoneNumberId: string;
  /** Set when the customer replied to a specific earlier message. */
  contextMessageId: string | null;
}

export interface InboundStatusUpdate {
  messageId: string;
  status: string;
  recipientId: string;
  timestamp: Date;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ParsedWebhook {
  /** Stable per-change key used for the idempotency gate. */
  events: Array<
    | { kind: 'message'; eventId: string; message: InboundWhatsAppMessage }
    | { kind: 'status'; eventId: string; status: InboundStatusUpdate }
  >;
}

interface GraphWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<Record<string, unknown>>;
        statuses?: Array<Record<string, unknown>>;
      };
    }>;
  }>;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Parses a Cloud API webhook body into discrete events.
 *
 * The event id is the provider's own message id (plus the status for status
 * events), which is what makes retried deliveries idempotent — Meta retries
 * the same payload, so the same ids recur.
 */
export function parseWebhookBody(body: unknown): ParsedWebhook {
  const parsed = body as GraphWebhookBody;
  const events: ParsedWebhook['events'] = [];

  for (const entry of parsed?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id ?? '';

      for (const raw of value.messages ?? []) {
        const id = asString(raw.id);
        const from = asString(raw.from);
        if (!id || !from) continue;

        const type = asString(raw.type) ?? 'unknown';
        const contact = value.contacts?.find((c) => c.wa_id === from);

        let text: string | null = null;
        let mediaId: string | null = null;
        let mediaMime: string | null = null;
        let mediaName: string | null = null;

        if (type === 'text') {
          text = asString((raw.text as Record<string, unknown>)?.caption) ??
            asString((raw.text as Record<string, unknown>)?.body);
        } else if (type === 'document' || type === 'image' || type === 'video' || type === 'audio') {
          const media = raw[type] as Record<string, unknown> | undefined;
          mediaId = asString(media?.id);
          mediaMime = asString(media?.mime_type);
          mediaName = asString(media?.filename);
          text = asString(media?.caption);
        } else if (type === 'button') {
          text = asString((raw.button as Record<string, unknown>)?.text);
        } else if (type === 'interactive') {
          const interactive = raw.interactive as Record<string, unknown> | undefined;
          const reply =
            (interactive?.button_reply as Record<string, unknown>) ??
            (interactive?.list_reply as Record<string, unknown>);
          text = asString(reply?.title);
        }

        const tsSeconds = Number(asString(raw.timestamp) ?? '0');
        const context = raw.context as Record<string, unknown> | undefined;

        events.push({
          kind: 'message',
          eventId: id,
          message: {
            messageId: id,
            from,
            fromE164: toE164(from),
            profileName: contact?.profile?.name ?? null,
            timestamp: tsSeconds > 0 ? new Date(tsSeconds * 1000) : new Date(),
            type,
            text,
            mediaId,
            mediaMimeType: mediaMime,
            mediaFilename: mediaName,
            phoneNumberId,
            contextMessageId: asString(context?.id),
          },
        });
      }

      for (const raw of value.statuses ?? []) {
        const id = asString(raw.id);
        const status = asString(raw.status);
        if (!id || !status) continue;
        const errors = raw.errors as Array<Record<string, unknown>> | undefined;
        const tsSeconds = Number(asString(raw.timestamp) ?? '0');

        events.push({
          kind: 'status',
          // Status events for the same message recur per state, so the status
          // must be part of the key or legitimate updates would be dropped.
          eventId: `${id}:${status}`,
          status: {
            messageId: id,
            status,
            recipientId: asString(raw.recipient_id) ?? '',
            timestamp: tsSeconds > 0 ? new Date(tsSeconds * 1000) : new Date(),
            errorCode: errors?.[0]?.code ? String(errors[0].code) : null,
            errorMessage: asString(errors?.[0]?.title),
          },
        });
      }
    }
  }

  return { events };
}

/* -------------------------------------------------------------------------- */
/*  Outbound                                                                  */
/* -------------------------------------------------------------------------- */

export type SendResult =
  | { ok: true; providerMessageId: string; raw: unknown }
  | { ok: false; error: string; code?: string; raw?: unknown };

function graphUrl(config: WhatsAppConfig, path: string): string {
  return `https://graph.facebook.com/${config.apiVersion}/${path}`;
}

/**
 * Sends a free-form text message.
 *
 * NOTE ON PLATFORM POLICY: free-form messages are only permitted inside the
 * 24-hour customer service window opened by a customer message. Outside it,
 * WhatsApp requires an approved template — use `sendTemplate`. This client does
 * not attempt to bypass that rule; if Meta rejects the send, the error is
 * surfaced to the operator and recorded on the delivery attempt.
 */
export async function sendTextMessage(input: {
  to: string;
  body: string;
  replyToMessageId?: string | null;
}): Promise<SendResult> {
  const result = getWhatsAppConfig();
  if (!result.configured) {
    return {
      ok: false,
      error: `WhatsApp is not configured (missing: ${result.missing.join(', ')})`,
      code: 'NOT_CONFIGURED',
    };
  }

  const to = toE164(input.to);
  if (!to) {
    return { ok: false, error: `Invalid recipient number: ${input.to}`, code: 'BAD_RECIPIENT' };
  }

  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // Graph expects the number without the leading '+'.
    to: to.replace(/^\+/, ''),
    type: 'text',
    text: { preview_url: false, body: input.body.slice(0, 4096) },
  };
  if (input.replyToMessageId) {
    payload.context = { message_id: input.replyToMessageId };
  }

  return postToGraph(result.config, payload);
}

/** Sends an approved template message (required outside the 24h window). */
export async function sendTemplateMessage(input: {
  to: string;
  templateName: string;
  languageCode?: string;
  bodyParameters?: string[];
}): Promise<SendResult> {
  const result = getWhatsAppConfig();
  if (!result.configured) {
    return {
      ok: false,
      error: `WhatsApp is not configured (missing: ${result.missing.join(', ')})`,
      code: 'NOT_CONFIGURED',
    };
  }

  const to = toE164(input.to);
  if (!to) {
    return { ok: false, error: `Invalid recipient number: ${input.to}`, code: 'BAD_RECIPIENT' };
  }

  const components =
    input.bodyParameters && input.bodyParameters.length > 0
      ? [
          {
            type: 'body',
            parameters: input.bodyParameters.map((text) => ({
              type: 'text',
              text,
            })),
          },
        ]
      : undefined;

  return postToGraph(result.config, {
    messaging_product: 'whatsapp',
    to: to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: input.templateName,
      language: { code: input.languageCode ?? 'id' },
      ...(components ? { components } : {}),
    },
  });
}

async function postToGraph(
  config: WhatsAppConfig,
  payload: Record<string, unknown>,
): Promise<SendResult> {
  try {
    const res = await fetch(graphUrl(config, `${config.phoneNumberId}/messages`), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    const raw = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string; code?: number; error_subcode?: number };
    };

    if (!res.ok || raw.error) {
      const message = raw.error?.message ?? `HTTP ${res.status}`;
      logger.error({ status: res.status, error: raw.error }, 'whatsapp send failed');
      return {
        ok: false,
        error: message,
        code: raw.error?.code ? String(raw.error.code) : String(res.status),
        raw,
      };
    }

    const providerMessageId = raw.messages?.[0]?.id;
    if (!providerMessageId) {
      return { ok: false, error: 'Provider did not return a message id', raw };
    }

    return { ok: true, providerMessageId, raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'whatsapp request error');
    return { ok: false, error: message, code: 'NETWORK' };
  }
}

/** Maps a Cloud API status string onto our DeliveryStatus enum. */
export function mapDeliveryStatus(
  status: string,
): 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | null {
  switch (status) {
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
      return 'FAILED';
    default:
      return null;
  }
}
