import 'dotenv/config';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { pruneExpiredSessions } from '@/server/auth/session';
import { dispatchOutboundMessage } from '@/server/channels/dispatch';
import { pollMailbox } from '@/server/channels/imap';
import { runExtraction } from '@/server/extraction/pipeline';
import {
  QUEUES,
  getQueue,
  recordJob,
  schedule,
  stopQueue,
  type Job,
} from './queue';

const logger = log('worker');

/**
 * Background worker entry point (`pnpm worker`).
 *
 * Runs as a separate process/container from the web app so that a long IMAP
 * poll or a slow provider cannot occupy a request handler. All work is
 * idempotent and retried with backoff by pg-boss.
 */

interface DispatchPayload {
  ticketMessageId: string;
}
interface ExtractionPayload {
  text: string;
  ticketId?: string | null;
  ticketMessageId?: string | null;
  externalMessageId?: string | null;
  customerId?: string | null;
}

async function main() {
  if (!env().JOB_WORKER_ENABLED) {
    logger.warn('JOB_WORKER_ENABLED is false — worker will idle and exit');
    return;
  }

  const boss = await getQueue();

  /* ---------------------------- outbound dispatch ----------------------- */
  await boss.work<DispatchPayload>(
    QUEUES.messageDispatch,
    { batchSize: 5 },
    async (jobs: Job<DispatchPayload>[]) => {
      for (const job of jobs) {
        await recordJob({
          jobId: job.id,
          queue: QUEUES.messageDispatch,
          state: 'ACTIVE',
          payload: job.data,
        });
        try {
          const result = await dispatchOutboundMessage(job.data.ticketMessageId);
          await recordJob({
            jobId: job.id,
            queue: QUEUES.messageDispatch,
            state: result.delivered ? 'COMPLETED' : 'FAILED',
            error: result.delivered ? null : result.reason,
          });
          // A permanent configuration failure must not be retried forever;
          // the attempt is already recorded against the message.
          if (!result.delivered && /not configured/i.test(result.reason)) {
            logger.warn(
              { messageId: job.data.ticketMessageId },
              'channel not configured; not retrying',
            );
            continue;
          }
          if (!result.delivered) throw new Error(result.reason);
        } catch (error) {
          await recordJob({
            jobId: job.id,
            queue: QUEUES.messageDispatch,
            state: 'FAILED',
            error: String(error),
          });
          throw error;
        }
      }
    },
  );

  /* ------------------------------- extraction --------------------------- */
  await boss.work<ExtractionPayload>(
    QUEUES.extractionRun,
    { batchSize: 3 },
    async (jobs: Job<ExtractionPayload>[]) => {
      for (const job of jobs) {
        await runExtraction(job.data);
        await recordJob({
          jobId: job.id,
          queue: QUEUES.extractionRun,
          state: 'COMPLETED',
        });
      }
    },
  );

  /* ------------------------------ email poll ---------------------------- */
  await boss.work(QUEUES.emailPoll, { batchSize: 1 }, async () => {
    const mailboxes = await prisma.emailMailbox.findMany({
      where: { status: 'ACTIVE' },
    });

    if (mailboxes.length === 0) {
      logger.debug('no active mailboxes configured; nothing to poll');
      return;
    }

    for (const mailbox of mailboxes) {
      try {
        const result = await pollMailbox(mailbox.id);
        logger.info(
          { mailbox: mailbox.address, ingested: result.ingested, skipped: result.skipped },
          'mailbox polled',
        );
      } catch (error) {
        // One broken mailbox must not stop the others.
        logger.error(
          { mailbox: mailbox.address, error: String(error) },
          'mailbox poll failed',
        );
        await prisma.emailMailbox.update({
          where: { id: mailbox.id },
          data: { lastError: String(error).slice(0, 1000) },
        });
      }
    }
  });

  /* ------------------------------ housekeeping -------------------------- */
  await boss.work(QUEUES.housekeeping, { batchSize: 1 }, async () => {
    const sessions = await pruneExpiredSessions();

    // Release reservations that were given an expiry and have passed it, so
    // abandoned orders do not hold stock out of circulation indefinitely.
    const expired = await prisma.stockReservation.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
      select: { id: true },
    });
    if (expired.length > 0) {
      const { releaseReservation } = await import('@/server/services/inventory');
      for (const reservation of expired) {
        await prisma.$transaction((tx) => releaseReservation(tx, reservation.id));
      }
    }

    logger.info(
      { prunedSessions: sessions, releasedReservations: expired.length },
      'housekeeping complete',
    );
  });

  /* -------------------------------- schedules --------------------------- */
  const pollSeconds = env().EMAIL_POLL_INTERVAL_SECONDS;
  // pg-boss schedules use cron, whose finest granularity is one minute.
  const pollMinutes = Math.max(1, Math.round(pollSeconds / 60));
  await schedule(
    QUEUES.emailPoll,
    pollMinutes === 1 ? '* * * * *' : `*/${pollMinutes} * * * *`,
  );
  await schedule(QUEUES.housekeeping, '15 2 * * *');

  logger.info('worker ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker');
    await stopQueue();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({ error: String(error) }, 'worker failed to start');
  process.exit(1);
});
