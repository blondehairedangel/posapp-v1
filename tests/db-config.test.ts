import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DatabaseConfigError,
  buildPoolConfig,
  describeTarget,
  redactConnectionString,
  resolveDatabaseConfig,
} from '@/lib/db-config';

/**
 * The database configuration layer.
 *
 * These tests manipulate process.env directly (not via .env), because the
 * precedence rules are the thing under test and dotenv would mask them.
 */

const DB_KEYS = [
  'DATABASE_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'DB_SCHEMA',
  'DB_SSLMODE',
  'DB_SSL_ROOT_CERT',
  'DB_POOL_MAX',
  'DB_CONNECT_TIMEOUT_MS',
  'DB_IDLE_TIMEOUT_MS',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of DB_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of DB_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('database configuration', () => {
  describe('precedence', () => {
    it('uses DATABASE_URL when it is set', () => {
      process.env.DATABASE_URL =
        'postgresql://alice:secret@db.example.com:6543/shop?schema=public';

      const config = resolveDatabaseConfig();

      expect(config.source).toBe('DATABASE_URL');
      expect(config.host).toBe('db.example.com');
      expect(config.port).toBe(6543);
      expect(config.database).toBe('shop');
      expect(config.user).toBe('alice');
    });

    it('composes a URL from the DB_* parts when DATABASE_URL is absent', () => {
      process.env.DB_HOST = 'postgres';
      process.env.DB_PORT = '5432';
      process.env.DB_NAME = 'sparepart_erp';
      process.env.DB_USER = 'erp';
      process.env.DB_PASSWORD = 'plain';

      const config = resolveDatabaseConfig();

      expect(config.source).toBe('DB_PARTS');
      expect(config.host).toBe('postgres');
      expect(config.database).toBe('sparepart_erp');
      expect(config.url).toContain('postgresql://erp:plain@postgres:5432/sparepart_erp');
    });

    it('ignores the DB_* parts entirely when DATABASE_URL is also set', () => {
      // Merging the two would make a connection failure impossible to reason
      // about, so DATABASE_URL wins outright.
      process.env.DATABASE_URL =
        'postgresql://winner:pw@chosen.example.com:5432/chosen?schema=public';
      process.env.DB_HOST = 'ignored.example.com';
      process.env.DB_NAME = 'ignored';
      process.env.DB_USER = 'ignored';

      const config = resolveDatabaseConfig();

      expect(config.source).toBe('DATABASE_URL');
      expect(config.host).toBe('chosen.example.com');
      expect(config.database).toBe('chosen');
      expect(config.url).not.toContain('ignored');
    });

    it('defaults the port to 5432 when DB_PORT is omitted', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';

      expect(resolveDatabaseConfig().port).toBe(5432);
    });

    it('allows an empty password for trust/peer authentication', () => {
      process.env.DB_HOST = '127.0.0.1';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'postgres';
      process.env.DB_PASSWORD = '';

      const config = resolveDatabaseConfig();
      expect(config.url).toContain('postgresql://postgres@127.0.0.1');
    });
  });

  describe('no silent fallback', () => {
    it('throws rather than defaulting to localhost when nothing is configured', () => {
      expect(() => resolveDatabaseConfig()).toThrow(DatabaseConfigError);
      expect(() => resolveDatabaseConfig()).toThrow(/No database configuration/i);
    });

    it('names exactly which parts are missing', () => {
      process.env.DB_HOST = 'db';
      // DB_NAME and DB_USER deliberately absent.
      expect(() => resolveDatabaseConfig()).toThrow(/DB_NAME, DB_USER/);
    });

    it('rejects a non-postgres scheme', () => {
      process.env.DATABASE_URL = 'mysql://user:pw@host:3306/db';
      expect(() => resolveDatabaseConfig()).toThrow(/postgresql:\/\/ scheme/);
    });

    it('rejects an invalid port', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';
      process.env.DB_PORT = 'not-a-port';
      expect(() => resolveDatabaseConfig()).toThrow(/DB_PORT/);
    });
  });

  describe('credential encoding', () => {
    it('percent-encodes a password containing URL-significant characters', () => {
      // Unencoded, "p@ss" would make the parser read "ss" as the host.
      process.env.DB_HOST = 'db.internal';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'app@corp';
      process.env.DB_PASSWORD = 'p@ss:w/rd?x#y';

      const config = resolveDatabaseConfig();

      expect(config.host).toBe('db.internal');
      expect(config.user).toBe('app@corp');
      expect(config.url).toContain('app%40corp');
      expect(config.url).toContain('p%40ss%3Aw%2Frd%3Fx%23y');
    });

    it('round-trips an encoded password back to the original value', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'u';
      process.env.DB_PASSWORD = 'a@b:c/d';

      const { url } = resolveDatabaseConfig();
      expect(decodeURIComponent(new URL(url).password)).toBe('a@b:c/d');
    });

    it('brackets an IPv6 host', () => {
      process.env.DB_HOST = '2001:db8::1';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';

      expect(resolveDatabaseConfig().url).toContain('[2001:db8::1]');
    });
  });

  describe('redaction', () => {
    it('removes the password from a connection string', () => {
      const redacted = redactConnectionString(
        'postgresql://alice:sup3rs3cret@db.example.com:5432/shop',
      );
      expect(redacted).not.toContain('sup3rs3cret');
      expect(redacted).toContain('***');
      expect(redacted).toContain('db.example.com');
    });

    it('redacts even a malformed connection string', () => {
      const redacted = redactConnectionString('postgresql://bob:hunter2@@@broken');
      expect(redacted).not.toContain('hunter2');
    });

    it('exposes safeUrl without the password', () => {
      process.env.DATABASE_URL =
        'postgresql://alice:topsecret@db.example.com:5432/shop?schema=public';

      const config = resolveDatabaseConfig();
      expect(config.safeUrl).not.toContain('topsecret');
      expect(config.url).toContain('topsecret'); // the real one still works
    });

    it('never includes the password in the target description', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';
      process.env.DB_PASSWORD = 'leakme';

      const summary = describeTarget(resolveDatabaseConfig());
      expect(summary).not.toContain('leakme');
      expect(summary).toContain('host=db');
    });

    it('keeps credentials out of configuration error messages', () => {
      process.env.DATABASE_URL = 'mysql://alice:topsecret@host:3306/db';
      try {
        resolveDatabaseConfig();
        throw new Error('should have thrown');
      } catch (error) {
        expect(String(error)).not.toContain('topsecret');
      }
    });
  });

  describe('TLS', () => {
    it('disables ssl by default', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';

      expect(buildPoolConfig(resolveDatabaseConfig()).ssl).toBe(false);
    });

    it('reads sslmode from the URL', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@remote.example.com:5432/erp?sslmode=require';
      expect(resolveDatabaseConfig().sslMode).toBe('require');
    });

    it('encrypts without verifying for sslmode=require', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@remote.example.com:5432/erp?sslmode=require';

      const ssl = buildPoolConfig(resolveDatabaseConfig()).ssl;
      expect(ssl).toMatchObject({ rejectUnauthorized: false });
    });

    it('verifies the server certificate for sslmode=verify-full', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@remote.example.com:5432/erp?sslmode=verify-full';

      const ssl = buildPoolConfig(resolveDatabaseConfig()).ssl;
      // The distinction that matters: verify-full must actually authenticate
      // the server, otherwise TLS only protects against passive eavesdropping.
      expect(ssl).toMatchObject({ rejectUnauthorized: true });
    });

    it('applies DB_SSLMODE when the URL does not specify one', () => {
      process.env.DATABASE_URL = 'postgresql://u:p@remote.example.com:5432/erp';
      process.env.DB_SSLMODE = 'require';

      const config = resolveDatabaseConfig();
      expect(config.sslMode).toBe('require');
      expect(config.url).toContain('sslmode=require');
    });

    it('lets the URL win over DB_SSLMODE', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@remote.example.com:5432/erp?sslmode=verify-full';
      process.env.DB_SSLMODE = 'disable';

      expect(resolveDatabaseConfig().sslMode).toBe('verify-full');
    });

    it('rejects an unknown sslmode', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';
      process.env.DB_SSLMODE = 'sort-of';
      expect(() => resolveDatabaseConfig()).toThrow(/DB_SSLMODE/);
    });

    it('fails clearly when the CA bundle is unreadable', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@remote.example.com:5432/erp?sslmode=verify-full';
      process.env.DB_SSL_ROOT_CERT = '/nonexistent/ca.crt';
      expect(() => resolveDatabaseConfig()).toThrow(/could not be read/);
    });
  });

  describe('pooling and locality', () => {
    it('defaults the pool size and honours an override', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';
      expect(resolveDatabaseConfig().poolMax).toBe(10);

      process.env.DB_POOL_MAX = '25';
      expect(resolveDatabaseConfig().poolMax).toBe(25);
    });

    it('rejects a nonsensical pool size', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';
      process.env.DB_POOL_MAX = '0';
      expect(() => resolveDatabaseConfig()).toThrow(/DB_POOL_MAX/);
    });

    it('identifies loopback hosts, which gates destructive commands', () => {
      for (const host of ['localhost', '127.0.0.1', '::1']) {
        process.env.DB_HOST = host;
        process.env.DB_NAME = 'erp';
        process.env.DB_USER = 'erp';
        expect(resolveDatabaseConfig().isLocalHost).toBe(true);
      }

      process.env.DB_HOST = 'db.production.example.com';
      expect(resolveDatabaseConfig().isLocalHost).toBe(false);
    });

    it('sets an application_name so connections are identifiable in pg_stat_activity', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';
      expect(buildPoolConfig(resolveDatabaseConfig())).toMatchObject({
        application_name: 'sparepart-erp',
      });
    });
  });

  describe('schema', () => {
    it('defaults to public', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_NAME = 'erp';
      process.env.DB_USER = 'erp';
      expect(resolveDatabaseConfig().schema).toBe('public');
    });

    it('reads the schema from the URL', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@db:5432/erp?schema=tenant_a';
      expect(resolveDatabaseConfig().schema).toBe('tenant_a');
    });

    it('applies DB_SCHEMA when the URL omits it', () => {
      process.env.DATABASE_URL = 'postgresql://u:p@db:5432/erp';
      process.env.DB_SCHEMA = 'tenant_b';

      const config = resolveDatabaseConfig();
      expect(config.schema).toBe('tenant_b');
      expect(config.url).toContain('schema=tenant_b');
    });
  });
});
