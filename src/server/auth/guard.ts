import { redirect } from 'next/navigation';
import type { Permission } from '@/lib/rbac';
import { getCurrentUser, type AuthUser } from './session';

/**
 * Server-side authorisation.
 *
 * Every Server Action and Route Handler that mutates or reads protected data
 * calls one of these. Hiding a button in the UI is treated as cosmetic only —
 * the check that actually matters happens here, before any query runs.
 */

export class AuthError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends Error {
  readonly permission: Permission | undefined;
  constructor(permission?: Permission) {
    super(
      permission
        ? `Missing required permission: ${permission}`
        : 'You do not have permission to perform this action',
    );
    this.name = 'ForbiddenError';
    this.permission = permission;
  }
}

export function hasPermission(
  user: AuthUser | null,
  permission: Permission,
): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return user.permissions.has(permission);
}

export function hasAnyPermission(
  user: AuthUser | null,
  permissions: Permission[],
): boolean {
  return permissions.some((p) => hasPermission(user, p));
}

/** Throws when unauthenticated. Use inside actions and handlers. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError();
  return user;
}

/** Throws when the caller lacks `permission`. */
export async function requirePermission(
  permission: Permission,
): Promise<AuthUser> {
  const user = await requireUser();
  if (!hasPermission(user, permission)) {
    throw new ForbiddenError(permission);
  }
  return user;
}

/** Throws unless the caller holds at least one of `permissions`. */
export async function requireAnyPermission(
  permissions: Permission[],
): Promise<AuthUser> {
  const user = await requireUser();
  if (!hasAnyPermission(user, permissions)) {
    throw new ForbiddenError(permissions[0]);
  }
  return user;
}

/**
 * Page-level guard: redirects instead of throwing, so an expired session lands
 * the user on the login form rather than an error boundary.
 */
export async function requirePageUser(returnTo?: string): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    const target = returnTo
      ? `/login?next=${encodeURIComponent(returnTo)}`
      : '/login';
    redirect(target);
  }
  return user;
}

export async function requirePagePermission(
  permission: Permission,
  returnTo?: string,
): Promise<AuthUser> {
  const user = await requirePageUser(returnTo);
  if (!hasPermission(user, permission)) {
    redirect('/forbidden');
  }
  return user;
}
