#!/usr/bin/env node
/**
 * Resets the test database to a known state, then re-seeds reference data.
 *
 * Integration tests run against a real PostgreSQL database, so the suite must
 * start deterministically: rows left by a previous run turn a unique SKU into
 * a constraint violation and make assertions order-dependent.
 *
 * Invoked by `pnpm test` before Vitest starts.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/sparepart_erp?schema=public';

const client = new pg.Client({ connectionString });

try {
  await client.connect();
} catch (error) {
  console.error(
    `Cannot reach the test database at ${connectionString.replace(/:[^:@/]*@/, ':***@')}\n` +
      'Start it with `pnpm db:start` (or point DATABASE_URL at your own instance).',
  );
  console.error(error.message);
  process.exit(1);
}

const { rows } = await client.query(
  `SELECT tablename FROM pg_tables
   WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
);

if (rows.length === 0) {
  console.error(
    'No tables found. Apply migrations first: pnpm prisma migrate deploy',
  );
  await client.end();
  process.exit(1);
}

const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
// Single statement with CASCADE: avoids ordering 86 tables by dependency.
await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
await client.end();

console.log(`✔ Truncated ${rows.length} tables`);

// Reference data the suites depend on: the permission catalogue (RBAC tests),
// the default SLA (ticket creation), units and warehouses.
//
// Run through the local tsx binary rather than `node --import tsx/esm`: the
// generated Prisma client is ESM with explicit .ts extensions, which the CJS
// loader cannot resolve.
const tsx = resolve('node_modules', '.bin', 'tsx');
execFileSync(tsx, ['prisma/seed.mts'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: process.env,
});

console.log('✔ Reference data seeded');
