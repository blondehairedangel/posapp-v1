import nodemailer, { type Transporter } from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';

const logger = log('email');

/**
 * Email channel: SMTP out, IMAP in (the IMAP poller lives in the worker).
 *
 * As with WhatsApp, nothing here fakes success: an unconfigured transport
 * returns a structured failure that the ticket UI shows to the operator.
 */

export type SmtpConfigResult =
  | {
      configured: true;
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
      fromName: string;
      fromAddress: string;
    }
  | { configured: false; missing: string[] };

export function getSmtpConfig(): SmtpConfigResult {
  const e = env();
  const missing: string[] = [];
  if (!e.SMTP_ENABLED) missing.push('SMTP_ENABLED=true');
  if (!e.SMTP_HOST) missing.push('SMTP_HOST');
  if (!e.SMTP_FROM_ADDRESS) missing.push('SMTP_FROM_ADDRESS');
  if (missing.length > 0) return { configured: false, missing };

  return {
    configured: true,
    host: e.SMTP_HOST as string,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    user: e.SMTP_USER,
    password: e.SMTP_PASSWORD,
    fromName: e.SMTP_FROM_NAME ?? e.APP_NAME,
    fromAddress: e.SMTP_FROM_ADDRESS as string,
  };
}

let cachedTransport: Transporter | null = null;

function transport(): Transporter | null {
  const config = getSmtpConfig();
  if (!config.configured) return null;
  cachedTransport ??= nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.user && config.password
        ? { user: config.user, pass: config.password }
        : undefined,
    // Fail fast rather than holding a ticket reply open for minutes.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return cachedTransport;
}

/** Verifies the SMTP connection — used by the Integrations test button. */
export async function verifySmtpConnection(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const t = transport();
  if (!t) {
    const config = getSmtpConfig();
    return {
      ok: false,
      error: `SMTP is not configured (missing: ${
        config.configured ? '' : config.missing.join(', ')
      })`,
    };
  }
  try {
    await t.verify();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type SendEmailResult =
  | { ok: true; providerMessageId: string; raw: unknown }
  | { ok: false; error: string; code?: string };

/**
 * Sends a reply, preserving RFC 5322 threading headers so the customer's mail
 * client groups it with their original message — and so our own inbound
 * matcher can thread their next reply back onto the same ticket.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  replyTo?: string | null;
}): Promise<SendEmailResult> {
  const config = getSmtpConfig();
  if (!config.configured) {
    return {
      ok: false,
      error: `Email is not configured (missing: ${config.missing.join(', ')})`,
      code: 'NOT_CONFIGURED',
    };
  }
  const t = transport();
  if (!t) {
    return { ok: false, error: 'SMTP transport unavailable', code: 'NO_TRANSPORT' };
  }

  try {
    const info = await t.sendMail({
      from: `"${config.fromName}" <${config.fromAddress}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? undefined,
      replyTo: input.replyTo ?? undefined,
      inReplyTo: input.inReplyTo ?? undefined,
      references: input.references?.length ? input.references : undefined,
    });

    return {
      ok: true,
      providerMessageId: info.messageId,
      raw: {
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'smtp send failed');
    return { ok: false, error: message, code: 'SMTP_ERROR' };
  }
}

/* -------------------------------------------------------------------------- */
/*  Inbound safety                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Sanitises inbound HTML before it is ever rendered in the agent UI.
 *
 * Email bodies are hostile input. Scripts, event handlers, styles, iframes,
 * forms and remote content are all removed; links are forced to open in a new
 * context with `noopener` so a malicious link cannot script the opener.
 * Remote images are dropped rather than proxied, because loading them leaks
 * the agent's IP and confirms the address to a spammer.
 */
export function sanitiseEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'a', 'hr',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    // http(s) and mailto only: blocks javascript: and data: URLs.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
      }),
    },
    disallowedTagsMode: 'discard',
    // Strip anything that could fetch or execute.
    exclusiveFilter: (frame) =>
      ['script', 'style', 'iframe', 'object', 'embed', 'form'].includes(
        frame.tag,
      ),
  });
}

/** Attachment policy for inbound mail and manual uploads. */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'cpl', 'msi', 'msp', 'hta',
  'jar', 'js', 'jse', 'vb', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'reg', 'lnk', 'dll', 'apk', 'app', 'sh',
]);

const ALLOWED_MIME_PREFIXES = [
  'image/',
  'text/plain',
  'text/csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-excel',
  'application/msword',
  'application/zip',
];

export interface AttachmentCheck {
  allowed: boolean;
  reason?: string;
}

export function checkAttachment(input: {
  filename: string;
  contentType: string;
  sizeBytes: number;
}): AttachmentCheck {
  const max = env().MAX_UPLOAD_BYTES;
  if (input.sizeBytes > max) {
    return {
      allowed: false,
      reason: `File exceeds the ${Math.floor(max / 1_048_576)} MiB limit`,
    };
  }

  const ext = input.filename.split('.').pop()?.toLowerCase() ?? '';
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { allowed: false, reason: `Executable attachments (.${ext}) are not accepted` };
  }

  // Double extensions such as "invoice.pdf.exe" are a classic disguise.
  const parts = input.filename.toLowerCase().split('.');
  if (parts.length > 2) {
    for (const part of parts.slice(1, -1)) {
      if (BLOCKED_EXTENSIONS.has(part)) {
        return {
          allowed: false,
          reason: 'Attachment uses a misleading double extension',
        };
      }
    }
  }

  const mime = input.contentType.toLowerCase();
  if (!ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))) {
    return { allowed: false, reason: `Content type ${input.contentType} is not accepted` };
  }

  return { allowed: true };
}

/** Builds a reply subject without stacking "Re: Re: Re:". */
export function replySubject(original: string | null | undefined): string {
  const base = (original ?? '(no subject)').trim();
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/**
 * Appends the ticket number so a reply can still be threaded even when the
 * customer's mail client drops the References chain.
 */
export function subjectWithTicket(subject: string, ticketNumber: string): string {
  return subject.includes(ticketNumber)
    ? subject
    : `${subject} [${ticketNumber}]`;
}
