// The API for the end-to-end suite, started by Playwright (playwright.config.ts):
// prepares `<db>_e2e` on the server DATABASE_URL points to (created when
// missing, migrated, emptied, seeded with the development accounts), then runs
// the BUILT API on it in production mode. Run `pnpm build` first.
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';

const API_DIR = new URL('../', import.meta.url);
const ENV_FILE = new URL('../.env', import.meta.url);
const SUFFIX = '_e2e';

// DATABASE_URL (CI) or the local .env. No default: guessing a server could
// point the suite at an unrelated database.
function baseDatabaseUrl() {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL;
  if (existsSync(ENV_FILE)) {
    const fromFile = parseEnv(readFileSync(ENV_FILE, 'utf8')).DATABASE_URL;
    if (fromFile !== undefined) return fromFile;
  }
  console.error(
    'DATABASE_URL is not set: copy apps/api/.env.example to apps/api/.env (or set DATABASE_URL).',
  );
  process.exit(1);
}

const url = new URL(baseDatabaseUrl());
if (!url.pathname.endsWith(SUFFIX)) url.pathname = `${url.pathname}${SUFFIX}`;
const database = decodeURIComponent(url.pathname.slice(1));

// Create the database when missing.
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
adminUrl.search = '';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
await admin.end();

// The seed and the API both validate their environment, and CI has no .env:
// everything they need is set here. The signing secret is throwaway, one per run.
// Email is off, as in CI, whatever apps/api/.env says (the API loads it outside
// tests, and its development values, an http APP_ORIGIN among them, are not
// valid in production): an empty value is unset, and the file never overrides
// a variable that is set.
const runEnv = {
  ...process.env,
  DATABASE_URL: url.toString(),
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  MAIL_SMTP_URL: '',
  MAIL_FROM: '',
  APP_ORIGIN: '',
};
execSync('pnpm exec prisma migrate deploy', { cwd: API_DIR, env: runEnv, stdio: 'inherit' });

// Every run starts from the seed alone.
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
const tables = await db.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
);
const names = tables.rows.map((row) => `"${String(row.tablename).replaceAll('"', '""')}"`);
if (names.length > 0) await db.query(`TRUNCATE TABLE ${names.join(', ')} CASCADE`);
await db.end();

execSync('node dist/seed/run.js', {
  cwd: API_DIR,
  env: { ...runEnv, NODE_ENV: 'development' },
  stdio: 'inherit',
});

// Production settings: Secure cookies, JSON logs, no Swagger UI. On loopback,
// behind the preview server's proxy on this machine.
const api = spawn(process.execPath, ['dist/main.js'], {
  cwd: API_DIR,
  env: {
    ...runEnv,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    TRUST_PROXY: 'loopback',
    PORT: process.env.PORT ?? '3100',
  },
  stdio: 'inherit',
});
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => api.kill(signal));
}
api.on('exit', (code) => process.exit(code ?? 0));
