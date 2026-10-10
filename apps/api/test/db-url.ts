import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// The database server comes from DATABASE_URL (set by CI), else from the
// local .env, read without loading it into process.env so no other local
// setting reaches the specs. No default: guessing a server could point the
// suites at an unrelated database.
function baseDatabaseUrl(): string {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL;
  if (existsSync('.env')) {
    const fromFile = parseEnv(readFileSync('.env', 'utf8')).DATABASE_URL;
    if (fromFile !== undefined) return fromFile;
  }
  throw new Error(
    'DATABASE_URL is not set: copy apps/api/.env.example to apps/api/.env (or set DATABASE_URL).',
  );
}

/** The same server, another database: `<name><suffix>`, wiped freely. */
export function withDatabaseSuffix(url: string, suffix: string): string {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith(suffix)) parsed.pathname = `${parsed.pathname}${suffix}`;
  return parsed.toString();
}

/** Integration specs run against `<db>_test`, never the development database. */
export function testDatabaseUrl(): string {
  return withDatabaseSuffix(baseDatabaseUrl(), '_test');
}
