import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // Integration tests share one PostgreSQL database, so they must not run
    // concurrently: parallel suites would see each other's rows and the
    // stock-reservation tests in particular depend on exact balances.
    fileParallelism: false,
    sequence: { concurrent: false },
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
