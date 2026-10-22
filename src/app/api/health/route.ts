import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Liveness/readiness probe for Docker, Compose and Coolify.
 *
 * Deliberately checks the database with a trivial query rather than returning
 * a static 200: a container that is listening but cannot reach PostgreSQL is
 * not ready to serve, and a probe that ignores that will happily route traffic
 * into errors.
 *
 * No authentication, and no internal detail in the body — an unauthenticated
 * endpoint must not leak version numbers, connection strings or schema names.
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: 'ok', database: 'up', latencyMs: Date.now() - startedAt },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'degraded', database: 'down' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
