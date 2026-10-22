#!/usr/bin/env tsx
/**
 * Refuses destructive database commands against anything that is not an
 * obviously local, disposable database.
 *
 *   tsx scripts/db-guard.mts <label> -- <command> [args...]
 *
 * `prisma migrate reset` DROPS DATA. Running one against staging or production
 * — because a stale DATABASE_URL was exported in the shell — destroys it. This
 * wrapper makes that a deliberate, auditable opt-in rather than a typo.
 *
 * Allowed when BOTH hold:
 *   - the host is loopback (localhost / 127.0.0.1 / ::1), and
 *   - NODE_ENV is not "production"
 *
 * Override for a genuinely disposable remote (an ephemeral CI database):
 *   DB_ALLOW_DESTRUCTIVE=i-understand-this-deletes-data
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import {
  DatabaseConfigError,
  describeTarget,
  resolveDatabaseConfig,
  type DatabaseConfig,
} from '../src/lib/db-config.ts';

const OVERRIDE = 'i-understand-this-deletes-data';

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
if (separator === -1 || separator === argv.length - 1) {
  console.error('usage: db-guard.mts <label> -- <command> [args...]');
  process.exit(2);
}

const label = argv.slice(0, separator).join(' ') || 'destructive operation';
const [command, ...commandArgs] = argv.slice(separator + 1);
if (!command) {
  console.error('usage: db-guard.mts <label> -- <command> [args...]');
  process.exit(2);
}

let config: DatabaseConfig;
try {
  config = resolveDatabaseConfig();
} catch (error) {
  console.error(
    error instanceof DatabaseConfigError ? error.message : String(error),
  );
  process.exit(1);
}

const override = (process.env.DB_ALLOW_DESTRUCTIVE ?? '').trim();
const isProduction = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
const allowed = config.isLocalHost && !isProduction;

console.error(`\n${label}`);
console.error(`  target: ${describeTarget(config)}`);

if (!allowed && override !== OVERRIDE) {
  console.error(
    [
      '',
      `REFUSED: this would destroy data in "${config.database}" on host "${config.host}".`,
      '',
      config.isLocalHost
        ? '  Reason: NODE_ENV=production.'
        : '  Reason: the host is not loopback, so this is not an obviously disposable database.',
      '',
      '  If the target really is disposable, re-run with:',
      `    DB_ALLOW_DESTRUCTIVE=${OVERRIDE} <your command>`,
      '',
      '  To change schema WITHOUT destroying data, use the forward-only path:',
      '    pnpm prisma:deploy',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.error(
  override === OVERRIDE && !allowed
    ? '  override accepted: DB_ALLOW_DESTRUCTIVE is set\n'
    : '  target is local and non-production: proceeding\n',
);

const result = spawnSync(command, commandArgs, {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
