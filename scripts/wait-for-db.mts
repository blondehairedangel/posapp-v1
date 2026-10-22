#!/usr/bin/env tsx
/**
 * Blocks until the configured database accepts queries, then exits 0.
 *
 * Used as a Compose preflight before `prisma migrate deploy`. `depends_on`
 * cannot express a health condition for a database in a *different* Compose
 * project or on another host, so the migration step waits here instead of
 * failing and restarting.
 *
 *   tsx scripts/wait-for-db.mts [timeoutSeconds]
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import {
  DatabaseConfigError,
  buildPoolConfig,
  describeTarget,
  resolveDatabaseConfig,
} from '../src/lib/db-config.ts';

const timeoutSeconds = Number(process.argv[2] ?? 120);

function sanitise(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"')]+/gi, '[connection string redacted]')
    .replace(/password=\S+/gi, 'password=[redacted]');
}

async function main() {
  let config;
  try {
    config = resolveDatabaseConfig();
  } catch (error) {
    console.error(
      error instanceof DatabaseConfigError ? error.message : String(error),
    );
    process.exit(1);
  }

  console.error(`waiting for database: ${describeTarget(config)}`);

  const prisma = new PrismaClient({
    adapter: new PrismaPg(buildPoolConfig(config), { schema: config.schema }),
    log: [],
  });

  const deadline = Date.now() + timeoutSeconds * 1000;
  let delay = 500;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.error(`database ready after ${attempt} attempt(s)`);
      await prisma.$disconnect();
      process.exit(0);
    } catch (error) {
      const message = sanitise(error);
      if (Date.now() + delay >= deadline) {
        console.error(
          `database unreachable after ${attempt} attempt(s): ${message}`,
        );
        await prisma.$disconnect().catch(() => undefined);
        process.exit(1);
      }
      console.error(`attempt ${attempt} failed (${message}); retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Exponential backoff, capped so a long outage still polls regularly.
      delay = Math.min(delay * 2, 5_000);
    }
  }
}

void main();
