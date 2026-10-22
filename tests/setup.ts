import 'dotenv/config';

/**
 * Test environment defaults.
 *
 * Integration tests run against a REAL PostgreSQL database (started by
 * scripts/dev-postgres.sh), not a mock. Mocked database responses would prove
 * nothing about the transactional stock invariants these tests exist to check.
 */

// NODE_ENV is already 'test' under Vitest and is typed read-only, so it is
// deliberately not reassigned here.
process.env.DATABASE_URL ??=
  'postgresql://postgres@127.0.0.1:5433/sparepart_erp?schema=public';
process.env.SESSION_SECRET ??=
  'test-only-session-secret-at-least-32-characters-long';
// 32 zero bytes, base64 — test fixture only.
process.env.APP_ENCRYPTION_KEY ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.LOG_LEVEL ??= 'error';
process.env.AI_EXTRACTION_ENABLED ??= 'false';
process.env.AI_PROVIDER ??= 'none';
process.env.WHATSAPP_ENABLED ??= 'false';
process.env.SMTP_ENABLED ??= 'false';
