import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { resolveDatabaseConfig } from './src/lib/db-config.ts';

/**
 * Prisma CLI configuration (migrate / db / studio).
 *
 * The URL is resolved through the same module the application uses, so
 * `prisma migrate deploy` and the running app can never disagree about which
 * database they mean — including when the target is supplied as DB_HOST,
 * DB_PORT, DB_NAME, DB_USER, DB_PASSWORD rather than DATABASE_URL.
 *
 * Resolution is lazy (inside the getter) so that commands which do not touch
 * a database, such as `prisma generate` and `prisma validate`, still work in
 * an environment with no database configured — a Docker build, for instance.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.mts',
  },
  datasource: {
    get url() {
      return resolveDatabaseConfig().url;
    },
  },
});
