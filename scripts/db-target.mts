#!/usr/bin/env tsx
/**
 * Prints the resolved database target, without credentials.
 *
 * Run this before a migration to confirm which database you are about to
 * change: `pnpm db:target`
 *
 * Note it loads `.env` the same way the application does, so what it prints is
 * genuinely what the app would connect to.
 */
import 'dotenv/config';
import {
  DatabaseConfigError,
  describeTarget,
  resolveDatabaseConfig,
} from '../src/lib/db-config.ts';

try {
  const config = resolveDatabaseConfig();
  console.log(describeTarget(config));
  console.log(`url=${config.safeUrl}`);
  console.log(`local=${config.isLocalHost}`);
} catch (error) {
  if (error instanceof DatabaseConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
