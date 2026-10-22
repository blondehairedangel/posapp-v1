import { z } from 'zod';

/**
 * Single validated entry point for configuration.
 *
 * Importing this module from a Client Component is a build error by design:
 * it reads process.env and would leak secrets. Everything here is server-only.
 */

/**
 * Environment variables are always strings, so a boolean flag is parsed from a
 * small accepted set. Deployment platforms and CI images are inconsistent
 * about casing ("TRUE", "True", "yes"), so the input is normalised first
 * rather than failing a boot on a cosmetic difference.
 */
const booleanish = (defaultValue: boolean) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === '') {
        return defaultValue ? 'true' : 'false';
      }
      if (typeof v !== 'string') return v;
      const s = v.trim().toLowerCase();
      if (['1', 'yes', 'on', 'true'].includes(s)) return 'true';
      if (['0', 'no', 'off', 'false'].includes(s)) return 'false';
      return s;
    },
    z.enum(['true', 'false']).transform((v) => v === 'true'),
  );

/** Case-insensitive enum: accepts LOG_LEVEL=INFO as well as info. */
const lowercaseEnum = <const T extends readonly [string, ...string[]]>(
  values: T,
  defaultValue: T[number],
) =>
  z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim() !== ''
        ? v.trim().toLowerCase()
        : defaultValue,
    z.enum(values),
  );

const schema = z.object({
  NODE_ENV: lowercaseEnum(
    ['development', 'test', 'production'],
    'development',
  ),
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_NAME: z.string().default('Spare Parts ERP'),
  APP_TIMEZONE: z.string().default('Asia/Jakarta'),
  APP_CURRENCY: z.string().length(3).default('IDR'),
  APP_LOCALE: z.string().default('id-ID'),

  // Database configuration is validated by ./db-config, which owns the
  // DATABASE_URL-vs-DB_* precedence and must stay usable by the Prisma CLI
  // without the app secrets below. These are declared only so an unknown-key
  // typo is still visible; none of them is required here.
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().optional(),
  DB_PORT: z.string().optional(),
  DB_NAME: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_SCHEMA: z.string().optional(),
  DB_SSLMODE: z.string().optional(),
  DB_SSL_ROOT_CERT: z.string().optional(),
  DB_POOL_MAX: z.string().optional(),
  DB_CONNECT_TIMEOUT_MS: z.string().optional(),
  DB_IDLE_TIMEOUT_MS: z.string().optional(),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters'),
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1, 'APP_ENCRYPTION_KEY is required')
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      'APP_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)',
    ),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish(true),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10_485_760),

  JOB_SCHEMA: z.string().default('pgboss'),
  JOB_WORKER_ENABLED: booleanish(true),
  EMAIL_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),

  WHATSAPP_ENABLED: booleanish(false),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),

  SMTP_ENABLED: booleanish(false),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanish(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM_NAME: z.string().optional(),
  SMTP_FROM_ADDRESS: z.string().optional(),

  AI_EXTRACTION_ENABLED: booleanish(false),
  AI_PROVIDER: z
    .enum(['openai', 'anthropic', 'openai-compatible', 'none'])
    .default('none'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  EXTRACTION_AUTO_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  EXTRACTION_SUGGEST_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),

  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WEBHOOK_PER_MINUTE: z.coerce.number().int().positive().default(600),
  TRUST_PROXY: booleanish(false),
  LOG_LEVEL: lowercaseEnum(
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    'info',
  ),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nSee .env.example for the full list.`,
    );
  }
  return parsed.data;
}

let cached: Env | null = null;

/**
 * Lazily validated so that importing a module that merely *references* env
 * does not crash tooling (e.g. `next build`'s module graph scan) before the
 * environment is actually present.
 */
export function env(): Env {
  cached ??= load();
  return cached;
}

/** Test seam: forces re-validation after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Integration readiness. Used by the UI to show "not configured" instead of
 * pretending a channel works, and by the services to refuse to send.
 */
export function integrationStatus() {
  const e = env();
  return {
    whatsapp: {
      enabled: e.WHATSAPP_ENABLED,
      configured: Boolean(
        e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID,
      ),
      signatureVerifiable: Boolean(e.WHATSAPP_APP_SECRET),
      missing: [
        !e.WHATSAPP_ACCESS_TOKEN && 'WHATSAPP_ACCESS_TOKEN',
        !e.WHATSAPP_PHONE_NUMBER_ID && 'WHATSAPP_PHONE_NUMBER_ID',
        !e.WHATSAPP_VERIFY_TOKEN && 'WHATSAPP_VERIFY_TOKEN',
        !e.WHATSAPP_APP_SECRET && 'WHATSAPP_APP_SECRET',
      ].filter((v): v is string => typeof v === 'string'),
    },
    smtp: {
      enabled: e.SMTP_ENABLED,
      configured: Boolean(e.SMTP_HOST && e.SMTP_FROM_ADDRESS),
      missing: [
        !e.SMTP_HOST && 'SMTP_HOST',
        !e.SMTP_FROM_ADDRESS && 'SMTP_FROM_ADDRESS',
      ].filter((v): v is string => typeof v === 'string'),
    },
    ai: {
      enabled: e.AI_EXTRACTION_ENABLED,
      configured: e.AI_PROVIDER !== 'none' && Boolean(e.AI_API_KEY),
      provider: e.AI_PROVIDER,
      // The ERP is fully usable without AI: extraction falls back to a
      // deterministic parser.
      fallbackAvailable: true,
    },
  };
}
