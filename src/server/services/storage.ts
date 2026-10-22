import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { checkAttachment } from '@/server/channels/email';

const logger = log('storage');

/**
 * File storage behind a provider-agnostic interface.
 *
 * Only the `local` driver is implemented. `s3` is accepted in configuration
 * and validated, but calling it throws a clear "not implemented" error rather
 * than silently writing nowhere — a storage backend that appears to work but
 * loses attachments is worse than one that refuses.
 */

export interface StorageDriver {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Resolves a key inside the storage root and refuses anything that escapes
   * it, so a crafted key cannot traverse to arbitrary paths.
   */
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error('Invalid storage key: path traversal rejected');
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch(() => undefined);
  }
}

class S3Driver implements StorageDriver {
  readonly name = 's3';
  async put(): Promise<void> {
    throw new Error(
      'The S3 storage driver is not implemented yet. Set STORAGE_DRIVER=local, or add @aws-sdk/client-s3 and implement S3Driver.',
    );
  }
  async get(): Promise<Buffer> {
    throw new Error('The S3 storage driver is not implemented yet.');
  }
  async delete(): Promise<void> {
    throw new Error('The S3 storage driver is not implemented yet.');
  }
}

let driver: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  if (driver) return driver;
  driver =
    env().STORAGE_DRIVER === 's3'
      ? new S3Driver()
      : new LocalDriver(env().STORAGE_LOCAL_PATH);
  return driver;
}

export interface StoreFileInput {
  filename: string;
  contentType: string;
  data: Buffer;
  uploadedById?: string | null;
}

/**
 * Validates and stores a file.
 *
 * The storage key is randomised and never derived from the user-supplied
 * filename: an attacker-controlled name must not influence the path on disk or
 * in the bucket. The original name is kept in the database for display only.
 */
export async function storeFile(input: StoreFileInput) {
  const check = checkAttachment({
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.data.byteLength,
  });
  if (!check.allowed) {
    throw new Error(check.reason ?? 'Attachment rejected');
  }

  const checksum = createHash('sha256').update(input.data).digest('hex');
  const now = new Date();
  const key = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    `${randomBytes(16).toString('hex')}${path.extname(input.filename).slice(0, 10)}`,
  ].join('/');

  await getStorageDriver().put(key, input.data, input.contentType);

  const record = await prisma.storedFile.create({
    data: {
      storageKey: key,
      provider: getStorageDriver().name,
      filename: input.filename.slice(0, 255),
      contentType: input.contentType,
      sizeBytes: input.data.byteLength,
      checksum,
      uploadedById: input.uploadedById ?? null,
    },
  });

  logger.info({ fileId: record.id, bytes: record.sizeBytes }, 'file stored');
  return record;
}

export async function readStoredFile(fileId: string) {
  const record = await prisma.storedFile.findUnique({ where: { id: fileId } });
  if (!record) return null;
  const data = await getStorageDriver().get(record.storageKey);
  return { record, data };
}
