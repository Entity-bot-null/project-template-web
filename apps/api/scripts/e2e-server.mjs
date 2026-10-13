// The API for the end-to-end suite, started by Playwright (playwright.config.ts):
// prepares `<db>_e2e` on the server DATABASE_URL points to (created when
// missing, migrated, emptied, seeded with the development accounts), then runs
// the BUILT API on it in production mode. Run `pnpm build` first.
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { API_DIR, e2eDatabaseUrl, e2eMailpit } from './e2e-env.mjs';

/** @type {URL} */
let url;
try {
  url = e2eDatabaseUrl();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const database = decodeURIComponent(url.pathname.slice(1));

// Email goes to Mailpit, as in development (e2e-env.mjs). Without one it is
// off and the specs that need it skip, except in CI, where that would hide a
// broken feature.
const mailpit = e2eMailpit();
if (mailpit === undefined && process.env.CI === 'true') {
  console.error(
    'No Mailpit for the end-to-end suite: set MAIL_TEST_SMTP_URL and MAILPIT_TEST_URL.',
  );
  process.exit(1);
}

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
// everything they need is set here, whatever apps/api/.env says (the API loads
// it outside tests; the file never overrides a variable that is set, and an
// empty value is unset). The signing secret is throwaway, one per run. Links
// in messages point to the web app the suite opens (APP_ORIGIN, from
// playwright.config.ts): http on loopback, which production accepts there
// only, like Mailpit's SMTP without TLS (docs/security.md#email).
const runEnv = {
  ...process.env,
  DATABASE_URL: url.toString(),
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  MAIL_SMTP_URL: mailpit?.smtpUrl ?? '',
  MAIL_FROM: mailpit === undefined ? '' : 'App <no-reply@example.test>',
  APP_ORIGIN: process.env.APP_ORIGIN ?? '',
  // Public sign-up needs email: open whenever Mailpit is there.
  SIGN_UP_ENABLED: mailpit === undefined ? 'false' : 'true',
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
