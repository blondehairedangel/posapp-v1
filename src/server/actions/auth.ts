'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { rateLimit } from '@/lib/rate-limit';
import { recordAudit } from '@/server/services/audit';
import {
  SESSION_COOKIE,
  authenticate,
  clearSessionCookie,
  createSession,
  getCurrentUser,
  revokeSession,
  setSessionCookie,
} from '@/server/auth/session';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
  next: z.string().optional(),
});

export type LoginState = { error?: string; fieldErrors?: Record<string, string> };

/**
 * Login.
 *
 * Rate limited per IP to slow credential stuffing. The response is identical
 * for an unknown email and a wrong password, so the form cannot be used to
 * enumerate which addresses are registered.
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return { fieldErrors };
  }

  const h = await headers();
  const ip =
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    'unknown';

  const limit = rateLimit(`login:${ip}`, env().RATE_LIMIT_AUTH_PER_MINUTE);
  if (!limit.allowed) {
    return {
      error: `Too many sign-in attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
    };
  }

  const result = await authenticate(parsed.data.email, parsed.data.password);

  if (!result.ok) {
    await recordAudit({
      action: 'auth.login_failed',
      entityType: 'User',
      actorEmail: parsed.data.email,
      ipAddress: ip,
      userAgent: h.get('user-agent'),
      changes: { reason: result.reason },
    });
    return {
      error:
        result.reason === 'inactive'
          ? 'This account is not active. Contact an administrator.'
          : 'Incorrect email or password.',
    };
  }

  const session = await createSession(result.userId, {
    ipAddress: ip,
    userAgent: h.get('user-agent'),
  });
  await setSessionCookie(session.token, session.expiresAt);

  await recordAudit({
    action: 'auth.login',
    entityType: 'User',
    entityId: result.userId,
    actorId: result.userId,
    actorEmail: parsed.data.email,
    ipAddress: ip,
    userAgent: h.get('user-agent'),
  });

  // Only allow same-site relative redirects, so `?next=` cannot be used as an
  // open redirect to an attacker's host.
  const target =
    parsed.data.next && /^\/(?!\/)/.test(parsed.data.next)
      ? parsed.data.next
      : '/dashboard';
  redirect(target);
}

export async function logoutAction() {
  const user = await getCurrentUser();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) await revokeSession(token);
  await clearSessionCookie();

  if (user) {
    await recordAudit({
      action: 'auth.logout',
      entityType: 'User',
      entityId: user.id,
      actorId: user.id,
      actorEmail: user.email,
    });
  }

  redirect('/login');
}
