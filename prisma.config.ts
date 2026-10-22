import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the datasource URL out of schema.prisma. This file is used by
 * the Prisma CLI (migrate / db / studio); the application runtime supplies the
 * same URL to PrismaClient through the pg driver adapter in src/lib/db.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.mts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
