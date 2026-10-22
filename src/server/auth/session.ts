import { cookies } from 'next/headers';
import { cache } from 'react';
import { prisma } from '@/lib/db';
import { generateToken, hashToken, verifyPassword } from '@/lib/crypto';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import type { Permission } from '@/lib/rbac';

const logger = log('auth');

export const SESSION_COOKIE = 'sp_session';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  departmentId: string | null;
  departmentName: string | null;
  roleKeys: string[];
  permissions: Set<Permission>;
}

/* -------------------------------------------------------------------------- */
/*  Session lifecycle                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Issues an opaque session token. Only its SHA-256 digest is persisted, so a
 * leaked database backup yields no usable sessions.
 */
export async function createSession(
  userId: string,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken(32);
  const expiresAt = new Date(
    Date.now() + env().SESSION_TTL_HOURS * 60 * 60 * 1000,
  );
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function revokeSession(token: string) {
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Invalidates every session for a user (password change, deactivation). */
export async function revokeAllSessions(userId: string) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/* -------------------------------------------------------------------------- */
/*  Current user                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the caller from the session cookie.
 *
 * Permissions are loaded from the database on every request rather than baked
 * into a token, so revoking a role takes effect immediately. `cache()`
 * deduplicates the query within a single render pass.
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        include: {
          department: { select: { id: true, name: true } },
          roles: {
            include: {
              role: {
                include: { permissions: { include: { permission: true } } },
              },
            },
          },
        },
      },
    },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    return null;
  }
  if (session.user.status !== 'ACTIVE' || session.user.deletedAt) {
    return null;
  }

  const permissions = new Set<Permission>();
  for (const ur of session.user.roles) {
    for (const rp of ur.role.permissions) {
      permissions.add(rp.permission.key as Permission);
    }
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    isSuperAdmin: session.user.isSuperAdmin,
    departmentId: session.user.departmentId,
    departmentName: session.user.department?.name ?? null,
    roleKeys: session.user.roles.map((r) => r.role.key),
    permissions,
  };
});

/** Fire-and-forget activity timestamp; never blocks the request. */
export async function touchSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return;
  await prisma.session
    .updateMany({
      where: { tokenHash: hashToken(token) },
      data: { lastSeenAt: new Date() },
    })
    .catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/*  Login                                                                     */
/* -------------------------------------------------------------------------- */

export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid_credentials' | 'inactive' };

/**
 * Verifies credentials. Returns the same `invalid_credentials` reason for an
 * unknown email and a wrong password, and still runs a hash comparison against
 * a dummy digest when the user does not exist, so response timing does not
 * reveal which emails are registered.
 */
export async function authenticate(
  email: string,
  password: string,
): Promise<LoginResult> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: {
      id: true,
      passwordHash: true,
      status: true,
      deletedAt: true,
    },
  });

  if (!user) {
    // Dummy verification to equalise timing with the found-user path.
    await verifyPassword(
      password,
      'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==',
    );
    return { ok: false, reason: 'invalid_credentials' };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    logger.warn({ email }, 'failed login attempt');
    return { ok: false, reason: 'invalid_credentials' };
  }
  if (user.status !== 'ACTIVE' || user.deletedAt) {
    return { ok: false, reason: 'inactive' };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return { ok: true, userId: user.id };
}

/** Housekeeping, invoked by a scheduled job. */
export async function pruneExpiredSessions(): Promise<number> {
  const res = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}
