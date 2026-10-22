import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from './env';

/**
 * Prisma 7 requires a driver adapter; the connection string is no longer read
 * from schema.prisma. One pool per process, cached on globalThis so Next.js
 * dev-mode hot reload does not exhaust PostgreSQL connections.
 */
function create(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env().DATABASE_URL });
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
