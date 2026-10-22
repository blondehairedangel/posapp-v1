import { PgBoss } from 'pg-boss';
import type { Job } from 'pg-boss';
import { buildPoolConfig, databaseConfig } from '@/lib/db-config';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';

const logger = log('jobs');

/**
 * Persistent job queue, backed by the application's own PostgreSQL instance.
 *
 * pg-boss was chosen over a Redis-based queue so the deployment needs no extra
 * service to run, back up and secure, and because jobs are rows — they survive
 * a restart with no further configuration.
 *
 * API note for pg-boss 12: retry policy is a property of the QUEUE
 * (`createQueue`), not of an individual `send()`. Queues are therefore
 * declared up front in `ensureQueues()` with their retry and retention
 * settings, and each has a dead-letter queue so a job that exhausts its
 * retries is retained for inspection rather than lost.
 */

export const QUEUES = {
  /** Poll each configured IMAP mailbox for new mail. */
  emailPoll: 'email.poll',
  /** Deliver one outbound ticket message (email or WhatsApp). */
  messageDispatch: 'message.dispatch',
  /** Run the extraction pipeline over a stored inbound message. */
  extractionRun: 'extraction.run',
  /** Nightly housekeeping: expired sessions, stale reservations. */
  housekeeping: 'housekeeping',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const DEAD_LETTER = 'dead.letter' as const;

export type { Job };

/** Per-queue policy. Exponential backoff so a provider outage is not hammered. */
const QUEUE_CONFIG: Record<
  QueueName,
  {
    retryLimit: number;
    retryDelaySeconds: number;
    retryBackoff: boolean;
    expireInSeconds: number;
  }
> = {
  [QUEUES.messageDispatch]: {
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 120,
  },
  [QUEUES.extractionRun]: {
    retryLimit: 3,
    retryDelaySeconds: 20,
    retryBackoff: true,
    expireInSeconds: 180,
  },
  [QUEUES.emailPoll]: {
    // A missed poll is picked up by the next tick, so retries are minimal.
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 600,
  },
  [QUEUES.housekeeping]: {
    retryLimit: 1,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 900,
  },
};

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export async function getQueue(): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;

  starting = (async () => {
    // pg-boss owns its own schema in the same database, so it resolves the
    // target through the shared config rather than reading the environment
    // itself. It needs CREATE SCHEMA on first start.
    const config = databaseConfig();
    const instance = new PgBoss({
      connectionString: config.url,
      schema: env().JOB_SCHEMA,
      max: Math.max(2, Math.ceil(config.poolMax / 2)),
      ...(config.sslMode && config.sslMode !== 'disable'
        ? { ssl: buildPoolConfig(config).ssl }
        : {}),
    });

    instance.on('error', (error: unknown) => {
      logger.error({ error: String(error) }, 'pg-boss error');
    });

    await instance.start();
    await ensureQueues(instance);

    boss = instance;
    logger.info({ schema: env().JOB_SCHEMA }, 'job queue started');
    return instance;
  })();

  return starting;
}

/** Declares every queue with its retry and retention policy. Idempotent. */
async function ensureQueues(instance: PgBoss) {
  await instance.createQueue(DEAD_LETTER, {
    // Keep failed jobs for two weeks so an operator can inspect them.
    retentionSeconds: 60 * 60 * 24 * 14,
    deleteAfterSeconds: 60 * 60 * 24 * 14,
  });

  for (const [name, config] of Object.entries(QUEUE_CONFIG)) {
    await instance.createQueue(name, {
      retryLimit: config.retryLimit,
      retryDelay: config.retryDelaySeconds,
      retryBackoff: config.retryBackoff,
      expireInSeconds: config.expireInSeconds,
      deleteAfterSeconds: 60 * 60 * 24,
      deadLetter: DEAD_LETTER,
    });
  }
}

export async function stopQueue() {
  if (!boss) return;
  await boss.stop({ graceful: true });
  boss = null;
  starting = null;
}

/**
 * Enqueues a job.
 *
 * `singletonKey` collapses duplicate work — one pending dispatch per ticket
 * message — which is what stops a double-clicked Send from queueing two
 * deliveries.
 */
export async function enqueue<T extends object>(
  queue: QueueName,
  data: T,
  options: { singletonKey?: string; startAfterSeconds?: number } = {},
): Promise<string | null> {
  const q = await getQueue();
  return q.send(queue, data, {
    singletonKey: options.singletonKey,
    startAfter: options.startAfterSeconds,
  });
}

/** Registers a recurring schedule (cron). Idempotent. */
export async function schedule(
  queue: QueueName,
  cron: string,
  data: object = {},
) {
  const q = await getQueue();
  await q.schedule(queue, cron, data);
  logger.info({ queue, cron }, 'schedule registered');
}

/**
 * Mirrors a job into BackgroundJobRecord for the admin UI.
 *
 * pg-boss owns its own tables in a separate schema; this denormalised copy is
 * what the Integrations screen reads, so operators do not need database access
 * to see why something is stuck.
 */
export async function recordJob(input: {
  jobId: string | null;
  queue: string;
  state: 'CREATED' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RETRY';
  payload?: object | null;
  error?: string | null;
  attemptCount?: number;
}) {
  if (!input.jobId) return;
  const { prisma } = await import('@/lib/db');
  try {
    await prisma.backgroundJobRecord.upsert({
      where: { jobId: input.jobId },
      create: {
        jobId: input.jobId,
        queue: input.queue,
        state: input.state,
        payload: (input.payload ?? undefined) as never,
        lastError: input.error ?? null,
        attemptCount: input.attemptCount ?? 0,
        startedAt: input.state === 'ACTIVE' ? new Date() : null,
        completedAt:
          input.state === 'COMPLETED' || input.state === 'FAILED'
            ? new Date()
            : null,
      },
      update: {
        state: input.state,
        lastError: input.error ?? null,
        attemptCount: input.attemptCount ?? undefined,
        completedAt:
          input.state === 'COMPLETED' || input.state === 'FAILED'
            ? new Date()
            : null,
      },
    });
  } catch (error) {
    // Operational mirror only — never fail the job because of it.
    logger.warn({ error: String(error) }, 'failed to mirror job record');
  }
}
