/**
 * Fixed-window rate limiter.
 *
 * Scope: this counter lives in the process, so with multiple web replicas each
 * replica enforces the limit independently (N replicas => N x the limit). That
 * is an acceptable trade-off for brute-force slowing on login and for shedding
 * webhook floods, and it adds no infrastructure. If strict global limits are
 * ever required, swap the Map for a Redis INCR or a PostgreSQL counter table —
 * the call sites do not need to change.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Sweep expired windows so the Map cannot grow without bound. */
function sweep(now: number) {
  if (windows.size < 5_000) return;
  for (const [key, w] of windows) {
    if (w.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs = 60_000,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    windows.set(key, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: limit - 1,
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

/** Test seam. */
export function resetRateLimits() {
  windows.clear();
}
