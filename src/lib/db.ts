import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import {
  buildPoolConfig,
  databaseConfig,
  describeTarget,
} from './db-config';
import { env } from './env';

/**
 * Prisma 7 requires a driver adapter; the connection string is no longer read
 * from schema.prisma. The target is resolved by ./db-config, which is also
 * what the Prisma CLI uses — so the application and migrations can never
 * disagree about which database they mean.
 *
 * One pool per process, cached on globalThis so Next.js dev-mode hot reload
 * does not exhaust PostgreSQL connections by creating a pool per recompile.
 */
function create(): PrismaClient {
  const config = databaseConfig();

  const adapter = new PrismaPg(buildPoolConfig(config), {
    schema: config.schema,
  });

  const nodeEnv = env().NODE_ENV;
  return new PrismaClient({
    adapter,
    // Silent under test: several suites deliberately trigger constraint
    // violations (duplicate-webhook detection), and printing those as errors
    // makes a passing run look broken.
    log:
      nodeEnv === 'test'
        ? []
        : nodeEnv === 'development'
          ? [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }]
          : [{ emit: 'stdout', level: 'error' }],
  });
}

const globalForPrisma = globalThis as unknown as {
  __prisma?: PrismaClient;
};

export const prisma: PrismaClient = globalForPrisma.__prisma ?? create();

if (env().NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

/* -------------------------------------------------------------------------- */
/*  Startup readiness                                                        */
/* -------------------------------------------------------------------------- */

export interface WaitOptions {
  /** Total time to keep trying before giving up. */
  timeoutMs?: number;
  /** Delay before the first retry; doubles up to 5s. */
  initialDelayMs?: number;
  onAttempt?: (attempt: number, error: string) => void;
}

/**
 * Blocks until the database answers a trivial query.
 *
 * Needed because a container orchestrator will often start the app before an
 * external PostgreSQL is accepting connections, and because `depends_on`
 * cannot express a health condition for a database in a *different* Compose
 * project or on another host. Prisma connects lazily, so the web server would
 * otherwise come up and fail per-request instead of waiting.
 *
 * Errors are reported credential-free: the raw driver error can contain the
 * whole connection string.
 */
export async function waitForDatabase(
  options: WaitOptions = {},
): Promise<{ ok: true; attempts: number } | { ok: false; attempts: number; error: string }> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let delay = options.initialDelayMs ?? 500;
  let attempt = 0;
  let lastError = 'unknown error';

  for (;;) {
    attempt += 1;
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = sanitiseDbError(error);
      options.onAttempt?.(attempt, lastError);

      if (Date.now() + delay >= deadline) {
        return { ok: false, attempts: attempt, error: lastError };
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5_000);
    }
  }
}

/**
 * Strips any connection string out of a driver error before it is logged.
 *
 * node-postgres and Prisma both include the target (and therefore sometimes
 * the password) in connection failures.
 */
export function sanitiseDbError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"')]+/gi, '[connection string redacted]')
    .replace(/password=\S+/gi, 'password=[redacted]');
}

/** Credential-free target description, for startup logs and diagnostics. */
export function databaseTargetSummary(): string {
  return describeTarget();
}

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Transaction client type — what a service receives when it participates in a
 * caller-provided transaction. Services accept this so that, for example,
 * "persist inbound message + enqueue extraction job" is one atomic unit.
 */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/** A service may be handed either the root client or an open transaction. */
export type Db = PrismaClient | Tx;
