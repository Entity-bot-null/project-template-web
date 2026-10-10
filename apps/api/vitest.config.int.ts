import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from './test/db-url.js';

// Integration specs (*.int.spec.ts): the real Nest application over HTTP
// against a real PostgreSQL database, `<db>_test`, created and migrated by
// the global setup. Needs the database running: `pnpm db:up`.
export default defineConfig({
  test: {
    include: ['src/**/*.int.spec.ts'],
    // The suites share one database, so they run one file at a time.
    fileParallelism: false,
    restoreMocks: true,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      JWT_ACCESS_SECRET: 'integration-only-secret-not-for-real-use-'.padEnd(64, '0'),
      // Suites send many requests from one address; the limiter itself is
      // covered by its own spec with the route limits.
      RATE_LIMIT_MAX: '100000',
      // The public origin the app is served from, behind a proxy that does
      // not pass the client's Host (src/common/guards/fetch-metadata.int.spec.ts).
      APP_ORIGIN: 'https://app.example.com',
      LOG_LEVEL: 'warn',
    },
    globalSetup: ['./test/global-setup.ts'],
  },
});
