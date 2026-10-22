import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { getCurrentUser } from '@/server/auth/session';
import { hasPermission } from '@/server/auth/guard';
import { readStoredFile } from '@/server/services/storage';

const logger = log('files');

export const runtime = 'nodejs';

/**
 * Streams a stored attachment.
 *
 * Authorisation is checked per file, not just per session: a file attached to a
 * ticket requires `ticket:read`. Serving by opaque id alone would make every
 * attachment readable by anyone who guessed an id.
 *
 * Content is always sent as an attachment with `nosniff`, so an uploaded HTML
 * or SVG file cannot execute script in the application's origin.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await params;

  const attachment = await prisma.ticketAttachment.findFirst({
    where: { fileId: id },
    select: { ticketId: true },
  });

  if (attachment && !hasPermission(user, 'ticket:read')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const result = await readStoredFile(id);
    if (!result) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(result.data), {
      status: 200,
      headers: {
        'content-type': result.record.contentType,
        'content-length': String(result.record.sizeBytes),
        // Forced download + nosniff: never render untrusted uploads inline.
        'content-disposition': `attachment; filename="${encodeURIComponent(
          result.record.filename,
        )}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=0, no-store',
      },
    });
  } catch (error) {
    logger.error({ fileId: id, error: String(error) }, 'failed to read file');
    return NextResponse.json({ error: 'unavailable' }, { status: 500 });
  }
}
