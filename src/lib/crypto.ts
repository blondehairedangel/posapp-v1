import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';
import { env } from './env';

/**
 * promisify picks the 3-argument scrypt overload, which drops the options
 * object we need for the cost parameters, so the signature is restated here.
 */
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/* -------------------------------------------------------------------------- */
/*  Password hashing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * scrypt from node:crypto. Chosen over argon2/bcrypt because both of those
 * pull native addons that must be compiled per platform and bloat the runtime
 * image; scrypt is memory-hard, OWASP-sanctioned, and built in.
 *
 * Parameters are embedded in the stored string so they can be raised later
 * without invalidating existing hashes.
 */
const SCRYPT_N = 2 ** 16; // CPU/memory cost (~64 MiB with r=8)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = randomBytes(SALT_LEN);
  const key = (await scrypt(password.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // Node's default maxmem (32 MiB) is below what N=2^16 needs.
    maxmem: 256 * 1024 * 1024,
  })) as Buffer;
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  })) as Buffer;

  // Constant-time comparison: a length-dependent early return would leak
  // information about the stored hash.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/* -------------------------------------------------------------------------- */
/*  Tokens                                                                    */
/* -------------------------------------------------------------------------- */

/** 256 bits of entropy, URL-safe. Used for session tokens. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Session tokens are stored only as a SHA-256 digest, so a database dump does
 * not hand an attacker usable sessions. SHA-256 (not scrypt) is correct here
 * because the input already has full entropy and lookup must be fast.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time string comparison for secrets of unknown provenance. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/* -------------------------------------------------------------------------- */
/*  Secret encryption at rest                                                 */
/* -------------------------------------------------------------------------- */

const ENC_PREFIX = 'enc.v1';

function key(): Buffer {
  return Buffer.from(env().APP_ENCRYPTION_KEY, 'base64');
}

/**
 * AES-256-GCM for values that must be stored and later read back in plaintext
 * — WhatsApp access tokens, IMAP/SMTP passwords. Authenticated encryption
 * means a tampered ciphertext fails loudly instead of decrypting to garbage.
 *
 * Format: enc.v1.<iv b64url>.<authTag b64url>.<ciphertext b64url>
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    ENC_PREFIX,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string): string {
  if (!isEncrypted(payload)) {
    throw new Error('Value is not an encrypted secret');
  }
  const [, ivB64, tagB64, ctB64] = payload.split('.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(ivB64 ?? '', 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64 ?? '', 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64 ?? '', 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${ENC_PREFIX}.`);
}

/** Decrypts when encrypted, passes through otherwise (eases key migration). */
export function maybeDecrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  return isEncrypted(value) ? decryptSecret(value) : value;
}

/* -------------------------------------------------------------------------- */
/*  Webhook signatures                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Verifies Meta's `X-Hub-Signature-256` header: HMAC-SHA256 of the RAW request
 * body keyed with the app secret. The raw bytes matter — re-serialising the
 * parsed JSON changes the digest.
 */
export function verifyHmacSha256(
  rawBody: string | Buffer,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  const expected = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
