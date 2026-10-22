import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// The Prisma CLI does not read .env by itself. Variables already set in the
// environment (CI, containers) win over the file.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
    // Only the integration setup sets it (test/global-setup.ts): `migrate dev`
    // makes a temporary shadow database of its own otherwise.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
