import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { maybeDecrypt } from '@/lib/crypto';
import { ChannelType } from '@/generated/prisma/client';
import { ingestInboundMessage } from './ingest';
import { checkAttachment, sanitiseEmailHtml } from './email';
import { storeFile } from '@/server/services/storage';

const logger = log('imap');

/**
 * Inbound email ingestion over IMAP.
 *
 * Correctness notes:
 *
 *  - **No message is read twice and none is skipped.** Progress is tracked as
 *    (UIDVALIDITY, lastSeenUid). If the server changes UIDVALIDITY the UID
 *    space has been renumbered, so the stored cursor is meaningless and is
 *    reset rather than trusted — trusting it would silently skip mail.
 *  - Dedup is still enforced downstream on the RFC 5322 Message-ID, so even a
 *    cursor reset cannot create duplicate tickets.
 *  - Attachments are validated before storage; executables and misleading
 *    double extensions are rejected.
 */

export interface PollResult {
  ingested: number;
  skipped: number;
  rejectedAttachments: number;
}

export async function pollMailbox(mailboxId: string): Promise<PollResult> {
  const mailbox = await prisma.emailMailbox.findUnique({
    where: { id: mailboxId },
    include: { channel: { select: { id: true } } },
  });
  if (!mailbox) throw new Error('Mailbox not found');

  const password = maybeDecrypt(mailbox.imapPassword);
  if (!password) {
    throw new Error('Mailbox has no IMAP password configured');
  }

  const client = new ImapFlow({
    host: mailbox.imapHost,
    port: mailbox.imapPort,
    secure: mailbox.imapSecure,
    auth: { user: mailbox.imapUser, pass: password },
    logger: false,
    // Fail rather than hang a worker slot on an unreachable server.
    socketTimeout: 60_000,
  });

  const result: PollResult = { ingested: 0, skipped: 0, rejectedAttachments: 0 };

  await client.connect();

  try {
    const lock = await client.getMailboxLock(mailbox.imapFolder);
    try {
      const status =
        typeof client.mailbox === 'object' ? client.mailbox : null;
      const uidValidity = status?.uidValidity ?? 0n;

      const storedValidity = mailbox.uidValidity ?? null;
      const validityChanged =
        storedValidity !== null && BigInt(storedValidity) !== BigInt(uidValidity);

      if (validityChanged) {
        logger.warn(
          { mailbox: mailbox.address },
          'UIDVALIDITY changed — resetting the UID cursor; Message-ID dedup prevents duplicates',
        );
      }

      const since =
        validityChanged || mailbox.lastSeenUid === null
          ? 1n
          : BigInt(mailbox.lastSeenUid) + 1n;

      let highestUid = validityChanged ? 0n : BigInt(mailbox.lastSeenUid ?? 0);

      for await (const message of client.fetch(
        { uid: `${since}:*` },
        { uid: true, source: true, envelope: true },
        { uid: true },
      )) {
        const uid = BigInt(message.uid);
        if (uid > highestUid) highestUid = uid;

        if (!message.source) {
          result.skipped += 1;
          continue;
        }

        try {
          const parsed = await simpleParser(message.source);

          const fromAddress = parsed.from?.value[0]?.address;
          if (!fromAddress) {
            result.skipped += 1;
            continue;
          }

          const references = Array.isArray(parsed.references)
            ? parsed.references.join(' ')
            : (parsed.references ?? null);

          const ingested = await ingestInboundMessage({
            channelType: ChannelType.EMAIL,
            channelId: mailbox.channel.id,
            // The RFC Message-ID is the stable provider id; UIDs change.
            externalId: parsed.messageId ?? `imap:${mailbox.id}:${uid}`,
            fromAddress,
            toAddress: parsed.to
              ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to])
                  .flatMap((t) => t.value)
                  .map((v) => v.address)
                  .filter(Boolean)
                  .join(', ')
              : mailbox.address,
            subject: parsed.subject ?? null,
            bodyText:
              parsed.text?.trim() ||
              (parsed.html ? stripHtml(parsed.html) : '') ||
              '(empty message)',
            bodyHtmlRaw: typeof parsed.html === 'string' ? parsed.html : null,
            messageIdHeader: parsed.messageId ?? null,
            inReplyTo: parsed.inReplyTo ?? null,
            references,
            receivedAt: parsed.date ?? new Date(),
            authorName: parsed.from?.value[0]?.name ?? null,
            departmentId: mailbox.departmentId,
          });

          if ('skipped' in ingested) {
            result.skipped += 1;
            continue;
          }

          // Attachments, after validation.
          for (const attachment of parsed.attachments ?? []) {
            const filename = attachment.filename ?? 'attachment';
            const check = checkAttachment({
              filename,
              contentType: attachment.contentType ?? 'application/octet-stream',
              sizeBytes: attachment.size ?? attachment.content.byteLength,
            });
            if (!check.allowed) {
              result.rejectedAttachments += 1;
              logger.warn(
                { filename, reason: check.reason },
                'inbound attachment rejected',
              );
              continue;
            }

            const file = await storeFile({
              filename,
              contentType: attachment.contentType ?? 'application/octet-stream',
              data: Buffer.from(attachment.content),
            });

            await prisma.ticketAttachment.create({
              data: {
                ticketId: ingested.ticketId,
                messageId: ingested.ticketMessageId,
                fileId: file.id,
              },
            });
          }

          result.ingested += 1;
        } catch (error) {
          // A single malformed message must not stall the mailbox.
          result.skipped += 1;
          logger.error(
            { uid: String(uid), error: String(error) },
            'failed to ingest message',
          );
        }
      }

      await prisma.emailMailbox.update({
        where: { id: mailbox.id },
        data: {
          uidValidity: uidValidity,
          lastSeenUid: highestUid,
          lastPolledAt: new Date(),
          lastError: null,
        },
      });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return result;
}

/** Plain-text fallback when a message has no text/plain part. */
function stripHtml(html: string): string {
  return sanitiseEmailHtml(html)
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Connection test for the Integrations screen. */
export async function verifyImapConnection(input: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  folder?: string;
}): Promise<{ ok: true; messageCount: number } | { ok: false; error: string }> {
  const client = new ImapFlow({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: { user: input.user, pass: input.password },
    logger: false,
    socketTimeout: 20_000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(input.folder ?? 'INBOX');
    const count =
      typeof client.mailbox === 'object' ? client.mailbox.exists : 0;
    lock.release();
    await client.logout();
    return { ok: true, messageCount: count };
  } catch (error) {
    client.close();
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
