import pino from 'pino';
import { env } from './env';

/**
 * Structured JSON logging. Redaction is defined centrally rather than at each
 * call site, so a careless `logger.info({ body })` cannot leak a token or a
 * mailbox password into the log stream.
 */
export const logger = pino({
  level: env().LOG_LEVEL,
  redact: {
    paths: [
      'password',
      'passwordHash',
      'token',
      'accessToken',
      'access_token',
      'apiKey',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.accessToken',
      '*.imapPassword',
      '*.smtpPassword',
      'WHATSAPP_ACCESS_TOKEN',
      'AI_API_KEY',
      'SESSION_SECRET',
      'APP_ENCRYPTION_KEY',
      // A connection string carries the database password. Log
      // `databaseTargetSummary()` or `config.safeUrl` instead.
      'DATABASE_URL',
      'databaseUrl',
      'connectionString',
      '*.connectionString',
      'DB_PASSWORD',
      'dbPassword',
      // Deliberately NOT redacting a bare `url` key: webhook callbacks and
      // APP_URL are logged legitimately and over-redaction makes incident
      // diagnosis harder. Connection strings are covered by the keys above.
    ],
    censor: '[redacted]',
  },
  base: { service: 'sparepart-erp' },
});

export type Logger = typeof logger;

/** Child logger scoped to a subsystem, e.g. log('whatsapp'). */
export function log(subsystem: string) {
  return logger.child({ subsystem });
}
