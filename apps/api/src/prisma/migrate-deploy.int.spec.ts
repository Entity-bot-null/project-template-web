import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testDatabaseUrl, withDatabaseSuffix } from '../../test/db-url.js';

// The api-migrate image's command (scripts/migrate-deploy.mjs) against a
// database of its own: `prisma migrate deploy`, after refusing a database
// whose applied migrations differ from the files the image ships. Prisma's
// deploy does not compare them: a migration edited after it was applied is
// skipped as "already applied", and environments that applied the old text
// silently differ from new ones that apply the new text.

const API = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = 'scripts/migrate-deploy.mjs';
const INIT = '20261003050918_init';
const url = withDatabaseSuffix(testDatabaseUrl(), '_migrate_guard');
const database = decodeURIComponent(new URL(url).pathname.slice(1));

function admin(): pg.Client {
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  return new pg.Client({ connectionString: adminUrl.toString() });
}

async function query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<Row>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query<Row>(sql, values);
  } finally {
    await client.end();
  }
}

// The child inherits this process's environment, DATABASE_URL pointed at the
// database of this file (beforeAll).
function migrateDeploy(): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd: API,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

// Each run starts the Prisma CLI and its schema engine: seconds, not milliseconds.
describe('migrate-deploy.mjs (the api-migrate command)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', url);
    const client = admin();
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await client.query(`CREATE DATABASE "${database}"`);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const client = admin();
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  });

  it('migrates an empty database, then finds nothing to do', () => {
    const first = migrateDeploy();
    expect(first.status, first.output).toBe(0);
    expect(first.output).toContain(`Applying migration \`${INIT}\``);
    const again = migrateDeploy();
    expect(again.status, again.output).toBe(0);
    expect(again.output).toContain('No pending migrations to apply.');
  });

  it('refuses a database whose applied migration differs from the shipped file, and migrates nothing', async () => {
    const { rows } = await query<{ checksum: string }>(
      'SELECT checksum FROM _prisma_migrations WHERE migration_name = $1',
      [INIT],
    );
    const shipped = rows[0]?.checksum ?? '';
    // What a database that applied an earlier text of the file holds.
    await query('UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2', [
      '0'.repeat(64),
      INIT,
    ]);
    try {
      const run = migrateDeploy();
      expect(run.status).toBe(1);
      expect(run.output).toContain(`changed after they were applied to this database: ${INIT}`);
      // Stopped before prisma migrate deploy started.
      expect(run.output).not.toContain('migrations found in prisma/migrations');
    } finally {
      await query('UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2', [
        shipped,
        INIT,
      ]);
    }
  });

  it('ignores attempts rolled back with prisma migrate resolve', async () => {
    // A failed attempt of an earlier text, marked rolled back
    // (docs/incident-response.md#10-failed-database-migration), stays in the
    // table next to the applied one.
    await query(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, rolled_back_at, applied_steps_count)
       VALUES ($1, $2, $3, now(), now(), 0)`,
      ['rolled-back-attempt', '1'.repeat(64), INIT],
    );
    const run = migrateDeploy();
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('No pending migrations to apply.');
  });
});
