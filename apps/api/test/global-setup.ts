import { execSync } from 'node:child_process';
import pg from 'pg';
import { testDatabaseUrl } from './db-url.js';

// Runs once before the integration suites: creates `<db>_test` when missing
// and brings it to the current schema with the committed migrations, the
// same way a deployment does (`prisma migrate deploy`).
export default async function setup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const database = decodeURIComponent(url.pathname.slice(1));

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach PostgreSQL at ${url.host} (${reason}). Start it with \`pnpm db:up\`, or point DATABASE_URL at a server.`,
      { cause: error },
    );
  }
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end();
  }

  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'inherit',
  });
}
