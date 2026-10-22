import { headers } from 'next/headers';
import { prisma, type Db } from '@/lib/db';
import { log } from '@/lib/logger';

const logger = log('audit');

export interface AuditInput {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Appends an audit entry.
 *
 * Accepts an optional transaction client so that the audit row commits or
 * rolls back together with the change it describes — an audit log that can
 * disagree with the data is worse than none.
 */
export async function recordAudit(input: AuditInput, db: Db = prisma) {
  try {
    await db.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        changes: (input.changes ?? undefined) as never,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    // Never let audit failure break the business operation; surface loudly.
    logger.error({ error, input }, 'failed to write audit log');
  }
}

/** Best-effort request metadata; returns nulls outside a request scope. */
export async function requestMeta(): Promise<{
  ipAddress: string | null;
  userAgent: string | null;
}> {
  try {
    const h = await headers();
    const forwarded = h.get('x-forwarded-for');
    return {
      ipAddress: forwarded?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
    };
  } catch {
    return { ipAddress: null, userAgent: null };
  }
}

/**
 * Field-level diff of only the keys present in `after`, so an audit entry
 * records what the actor actually changed rather than the whole row.
 */
export function diff<T extends Record<string, unknown>>(
  before: T | null,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(after)) {
    const prev = before?.[key];
    const prevComparable = prev instanceof Date ? prev.toISOString() : prev;
    const nextComparable = next instanceof Date ? next.toISOString() : next;
    if (String(prevComparable) !== String(nextComparable)) {
      changes[key] = { from: prevComparable ?? null, to: nextComparable ?? null };
    }
  }
  return changes;
}
