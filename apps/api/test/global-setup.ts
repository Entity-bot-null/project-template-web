import { execSync } from 'node:child_process';
import pg from 'pg';
import { shadowDatabaseUrl, testDatabaseUrl } from './db-url.js';

// Runs once before the integration suites:
//   1. replays every committed migration on an empty database, `<db>_shadow`,
//      as `prisma migrate dev` does on its shadow database, and compares the
//      result with prisma/schema.prisma: a migration that cannot run from
//      nothing (it assumes something only a deployment has) or a schema change
//      without its migration fails here, not on a developer's machine;
//   2. brings `<db>_test` to the current schema with the committed
//      migrations, the same way a deployment does (`prisma migrate deploy`).
// Both databases are created when missing.
export default async function setup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const shadow = new URL(shadowDatabaseUrl());
  await createWhenMissing([url, shadow]);

  try {
    execSync(
      'pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code',
      {
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          SHADOW_DATABASE_URL: shadow.toString(),
        },
        stdio: 'inherit',
      },
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    throw new Error(
      status === 2
        ? 'prisma/schema.prisma has changes no migration makes: create one with `pnpm db:migrate --name <name>` (docs/database.md).'
        : 'The migrations do not replay on an empty database (what `prisma migrate dev` does on its shadow database): see the error above.',
      { cause: error },
    );
  }

  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'inherit',
  });
}

async function createWhenMissing(urls: URL[]): Promise<void> {
  const [first] = urls;
  if (first === undefined) return;
  const adminUrl = new URL(first);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach PostgreSQL at ${first.host} (${reason}). Start it with \`pnpm db:up\`, or point DATABASE_URL at a server.`,
      { cause: error },
    );
  }
  try {
    for (const url of urls) {
      const database = decodeURIComponent(url.pathname.slice(1));
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
      }
    }
  } finally {
    await admin.end();
  }
}
