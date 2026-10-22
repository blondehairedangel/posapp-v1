import { readFileSync } from 'node:fs';

/**
 * PostgreSQL configuration — the single place a database target is resolved.
 *
 * SERVER-ONLY. Deliberately NOT guarded with `import 'server-only'`: that
 * package throws unconditionally outside the Next.js bundler, which would
 * break the Prisma CLI (prisma.config.ts imports this), the operational
 * scripts, and the test runner. The browser is kept out by construction
 * instead — this module imports `node:fs`, so any attempt to trace it into a
 * client bundle fails to resolve, and no database variable is prefixed
 * NEXT_PUBLIC_ so none is inlined client-side.
 *
 * Deliberately standalone: it reads `process.env` directly and does NOT import
 * `./env`. The Prisma CLI loads `prisma.config.ts`, which needs a database URL
 * but has no business requiring SESSION_SECRET or APP_ENCRYPTION_KEY. Keeping
 * this module dependency-free means migrations and the application resolve the
 * *same* target through the *same* code.
 *
 * Nothing here is hardcoded. There is no localhost fallback: an unconfigured
 * environment fails loudly, because silently connecting to an unintended
 * database is worse than not starting.
 */

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type SslMode =
  | 'disable'
  | 'allow'
  | 'prefer'
  | 'require'
  | 'verify-ca'
  | 'verify-full';

const SSL_MODES: readonly SslMode[] = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
];

export interface DatabaseConfig {
  /** Full connection string. CONTAINS THE PASSWORD — never log this. */
  readonly url: string;
  /** Password replaced with `***`. Safe for logs and error messages. */
  readonly safeUrl: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly schema: string;
  readonly sslMode: SslMode | null;
  /** Path to a CA bundle for verify-ca / verify-full, when supplied. */
  readonly sslRootCertPath: string | null;
  /** Which input produced this config — surfaced in diagnostics. */
  readonly source: 'DATABASE_URL' | 'DB_PARTS';
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  /** True when the host is loopback. Used to gate destructive operations. */
  readonly isLocalHost: boolean;
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

/* -------------------------------------------------------------------------- */
/*  Redaction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Removes the password from a connection string.
 *
 * Used for every log line and error message that mentions a database target.
 * Falls back to a coarse regex when the string will not parse, so a malformed
 * URL in an error message still cannot leak the password.
 */
export function redactConnectionString(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    // Not parseable: blank out anything between "://user:" and "@".
    return value.replace(/(:\/\/[^:/@]*:)[^@]*(@)/, '$1***$2');
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function readString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = readString(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new DatabaseConfigError(
      `${name} must be an integer between ${min} and ${max} (received "${raw}")`,
    );
  }
  return parsed;
}

function readSslMode(): SslMode | undefined {
  const raw = readString('DB_SSLMODE');
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase() as SslMode;
  if (!SSL_MODES.includes(lower)) {
    throw new DatabaseConfigError(
      `DB_SSLMODE must be one of ${SSL_MODES.join(', ')} (received "${raw}")`,
    );
  }
  return lower;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Precedence, documented and deterministic:
 *
 *   1. `DATABASE_URL`, when set, is the source of truth. The `DB_*` parts are
 *      then ignored entirely — not merged — because a half-applied override is
 *      impossible to reason about when debugging a connection failure.
 *   2. Otherwise the URL is composed from `DB_HOST`, `DB_PORT`, `DB_NAME`,
 *      `DB_USER`, `DB_PASSWORD`.
 *   3. Otherwise it throws. There is no implicit localhost default.
 */
export function resolveDatabaseConfig(): DatabaseConfig {
  const explicitUrl = readString('DATABASE_URL');
  const parts = {
    host: readString('DB_HOST'),
    port: readString('DB_PORT'),
    name: readString('DB_NAME'),
    user: readString('DB_USER'),
    password: process.env.DB_PASSWORD, // may legitimately be empty
  };
  const hasAnyPart = Boolean(
    parts.host ?? parts.port ?? parts.name ?? parts.user ?? parts.password,
  );

  const sslMode = readSslMode();
  const sslRootCertPath = readString('DB_SSL_ROOT_CERT') ?? null;
  const schemaOverride = readString('DB_SCHEMA');

  const poolMax = readInt('DB_POOL_MAX', 10, 1, 1000);
  const connectionTimeoutMs = readInt('DB_CONNECT_TIMEOUT_MS', 10_000, 100, 120_000);
  const idleTimeoutMs = readInt('DB_IDLE_TIMEOUT_MS', 30_000, 1_000, 600_000);

  let url: string;
  let source: DatabaseConfig['source'];

  if (explicitUrl) {
    url = explicitUrl;
    source = 'DATABASE_URL';
  } else if (hasAnyPart) {
    url = composeFromParts(parts, { sslMode, schema: schemaOverride });
    source = 'DB_PARTS';
  } else {
    throw new DatabaseConfigError(
      [
        'No database configuration found.',
        '',
        'Set either:',
        '  DATABASE_URL=postgresql://user:password@host:5432/dbname?schema=public',
        'or the individual parts:',
        '  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD',
        '',
        'See .env.example and docs/DATABASE.md. There is deliberately no',
        'localhost default: connecting to an unintended database silently is',
        'worse than failing to start.',
      ].join('\n'),
    );
  }

  const parsed = parseUrl(url, source);

  // Apply DB_SCHEMA / DB_SSLMODE to an explicit DATABASE_URL only when the URL
  // does not already say otherwise — the URL stays authoritative.
  const schema = parsed.schema ?? schemaOverride ?? 'public';
  const effectiveSslMode = parsed.sslMode ?? sslMode ?? null;

  if (source === 'DATABASE_URL' && !parsed.schema && schemaOverride) {
    url = withSearchParam(url, 'schema', schemaOverride);
  }
  if (source === 'DATABASE_URL' && !parsed.sslMode && sslMode) {
    url = withSearchParam(url, 'sslmode', sslMode);
  }

  if (
    sslRootCertPath &&
    (effectiveSslMode === 'verify-ca' || effectiveSslMode === 'verify-full')
  ) {
    assertReadable(sslRootCertPath);
  }

  return {
    url,
    safeUrl: redactConnectionString(url),
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    schema,
    sslMode: effectiveSslMode,
    sslRootCertPath,
    source,
    poolMax,
    connectionTimeoutMs,
    idleTimeoutMs,
    isLocalHost: LOOPBACK.has(parsed.host.toLowerCase()),
  };
}

function composeFromParts(
  parts: {
    host?: string;
    port?: string;
    name?: string;
    user?: string;
    password?: string;
  },
  extras: { sslMode?: SslMode; schema?: string },
): string {
  const missing: string[] = [];
  if (!parts.host) missing.push('DB_HOST');
  if (!parts.name) missing.push('DB_NAME');
  if (!parts.user) missing.push('DB_USER');
  if (missing.length > 0) {
    throw new DatabaseConfigError(
      [
        `Incomplete database configuration: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
        '',
        'When DATABASE_URL is not set, all of DB_HOST, DB_NAME and DB_USER are',
        'required (DB_PORT defaults to 5432, DB_PASSWORD may be empty for',
        'trust/peer authentication).',
      ].join('\n'),
    );
  }

  const port = parts.port ?? '5432';
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new DatabaseConfigError(
      `DB_PORT must be a valid port number (received "${port}")`,
    );
  }

  // Percent-encode credentials: a password containing @ : / ? # would
  // otherwise make the URL parse to the wrong host, which surfaces as a
  // baffling "host not found" rather than a credential problem.
  const user = encodeURIComponent(parts.user as string);
  const password =
    parts.password === undefined || parts.password === ''
      ? ''
      : `:${encodeURIComponent(parts.password)}`;

  const query = new URLSearchParams({ schema: extras.schema ?? 'public' });
  if (extras.sslMode) query.set('sslmode', extras.sslMode);

  // Bracket IPv6 literals.
  const host = parts.host!.includes(':') && !parts.host!.startsWith('[')
    ? `[${parts.host}]`
    : parts.host;

  return `postgresql://${user}${password}@${host}:${portNumber}/${encodeURIComponent(parts.name as string)}?${query.toString()}`;
}

interface ParsedUrl {
  host: string;
  port: number;
  database: string;
  user: string;
  schema: string | null;
  sslMode: SslMode | null;
}

function parseUrl(url: string, source: DatabaseConfig['source']): ParsedUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseConfigError(
      `${source === 'DATABASE_URL' ? 'DATABASE_URL' : 'The composed database URL'} is not a valid URL. ` +
        'If the password contains @ : / ? # or %, percent-encode it ' +
        '(@ -> %40, : -> %3A, / -> %2F, ? -> %3F, # -> %23, % -> %25).',
    );
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new DatabaseConfigError(
      `Database URL must use the postgresql:// scheme (received "${parsed.protocol}//"). ` +
        `Target: ${redactConnectionString(url)}`,
    );
  }

  // WHATWG URL keeps the brackets around an IPv6 literal in `hostname`
  // ("[::1]"). Strip them so the value compares equal to a plain address —
  // otherwise an IPv6 loopback is misclassified as remote and the destructive
  // command guard refuses a legitimate local reset.
  const host = parsed.hostname.replace(/^\[(.+)\]$/, '$1');
  if (!host) {
    throw new DatabaseConfigError(
      `Database URL has no host. Target: ${redactConnectionString(url)}`,
    );
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) {
    throw new DatabaseConfigError(
      `Database URL has no database name. Target: ${redactConnectionString(url)}`,
    );
  }

  const rawSslMode = parsed.searchParams.get('sslmode');
  let sslMode: SslMode | null = null;
  if (rawSslMode) {
    const lower = rawSslMode.toLowerCase() as SslMode;
    if (!SSL_MODES.includes(lower)) {
      throw new DatabaseConfigError(
        `sslmode in the database URL must be one of ${SSL_MODES.join(', ')} (received "${rawSslMode}")`,
      );
    }
    sslMode = lower;
  }

  return {
    host,
    port: parsed.port ? Number(parsed.port) : 5432,
    database,
    user: decodeURIComponent(parsed.username),
    schema: parsed.searchParams.get('schema'),
    sslMode,
  };
}

function withSearchParam(url: string, key: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function assertReadable(path: string) {
  try {
    readFileSync(path);
  } catch {
    throw new DatabaseConfigError(
      `DB_SSL_ROOT_CERT points at "${path}", which could not be read. ` +
        'Mount the CA bundle into the container and make it readable by the app user.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Consumers                                                                 */
/* -------------------------------------------------------------------------- */

let cached: DatabaseConfig | null = null;

/** Memoised accessor. Throws a sanitised error when misconfigured. */
export function databaseConfig(): DatabaseConfig {
  cached ??= resolveDatabaseConfig();
  return cached;
}

/** Test seam: forces re-resolution after mutating process.env. */
export function resetDatabaseConfigCache(): void {
  cached = null;
}

/**
 * node-postgres pool options.
 *
 * TLS is configured explicitly rather than left to the connection string so
 * that `verify-full` genuinely verifies: node-postgres defaults to
 * `rejectUnauthorized: false` for `sslmode=require`, which encrypts but does
 * NOT authenticate the server, leaving the connection open to a
 * man-in-the-middle. Callers asking to verify get verification.
 */
export function buildPoolConfig(config: DatabaseConfig = databaseConfig()) {
  const base = {
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    application_name: 'sparepart-erp',
  };

  if (!config.sslMode || config.sslMode === 'disable') {
    return { ...base, ssl: false as const };
  }

  const ca = config.sslRootCertPath
    ? readFileSync(config.sslRootCertPath, 'utf8')
    : undefined;

  const verify =
    config.sslMode === 'verify-ca' || config.sslMode === 'verify-full';

  return {
    ...base,
    ssl: {
      // require/prefer/allow encrypt without proving identity; verify-* do both.
      rejectUnauthorized: verify,
      ...(ca ? { ca } : {}),
    },
  };
}

/** One-line, credential-free description for startup logs. */
export function describeTarget(config: DatabaseConfig = databaseConfig()): string {
  return [
    `host=${config.host}`,
    `port=${config.port}`,
    `database=${config.database}`,
    `user=${config.user}`,
    `schema=${config.schema}`,
    `sslmode=${config.sslMode ?? 'disable'}`,
    `pool=${config.poolMax}`,
    `source=${config.source}`,
  ].join(' ');
}
