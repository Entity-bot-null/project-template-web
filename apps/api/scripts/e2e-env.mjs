// What the end-to-end suite runs against, shared by the API it starts
// (e2e-server.mjs) and the specs (e2e/*.e2e.ts): the database, derived from
// DATABASE_URL, and the Mailpit email goes to.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const API_DIR = new URL('../', import.meta.url);
const API_ENV_FILE = new URL('../.env', import.meta.url);
const ROOT_ENV_FILE = new URL('../../../.env', import.meta.url);
const SUFFIX = '_e2e';

/**
 * @param {URL} file
 * @param {string} name
 * @returns {string | undefined}
 */
function fromFile(file, name) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8'))[name] : undefined;
}

/**
 * `<db>_e2e` on the server DATABASE_URL (CI) or the local apps/api/.env points
 * to. No default: guessing a server could point the suite at an unrelated
 * database.
 * @returns {URL}
 */
export function e2eDatabaseUrl() {
  const base = process.env.DATABASE_URL ?? fromFile(API_ENV_FILE, 'DATABASE_URL');
  if (base === undefined) {
    throw new Error(
      'DATABASE_URL is not set: copy apps/api/.env.example to apps/api/.env (or set DATABASE_URL).',
    );
  }
  const url = new URL(base);
  if (!url.pathname.endsWith(SUFFIX)) url.pathname = `${url.pathname}${SUFFIX}`;
  return url;
}

/**
 * The Mailpit the suite's email goes to: MAIL_TEST_SMTP_URL and
 * MAILPIT_TEST_URL (CI starts a throwaway one), else the local one `pnpm dev`
 * starts (MAIL_SMTP_URL in apps/api/.env, its web API on MAILPIT_UI_PORT).
 * Undefined without one: email is off, and the specs that need it skip
 * locally (in CI they fail instead).
 * @returns {{ smtpUrl: string; apiUrl: string } | undefined}
 */
export function e2eMailpit() {
  const smtpUrl = process.env.MAIL_TEST_SMTP_URL ?? fromFile(API_ENV_FILE, 'MAIL_SMTP_URL');
  if (smtpUrl === undefined || smtpUrl === '') return undefined;
  const apiUrl =
    process.env.MAILPIT_TEST_URL ??
    `http://localhost:${fromFile(ROOT_ENV_FILE, 'MAILPIT_UI_PORT') ?? '8035'}`;
  return { smtpUrl, apiUrl };
}
