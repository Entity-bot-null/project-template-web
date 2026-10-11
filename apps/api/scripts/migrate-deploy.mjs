// The api-migrate image's command (apps/api/Dockerfile, docs/database.md#migrations):
// `prisma migrate deploy`, after one check Prisma's deploy does not make.
//
// Prisma records each applied migration with the SHA-256 of its file
// (`_prisma_migrations.checksum`), but `migrate deploy` never compares it: a
// migration edited after it was applied counts as "already applied", so the
// databases that ran the old text and the ones that run the new text (CI, a
// new environment, a restore into an empty database) silently differ. Here a
// database whose applied migrations do not match the files of this image is
// refused before anything runs. Attempts marked rolled back
// (`prisma migrate resolve --rolled-back`) and failed ones are left to Prisma.
//
// The comparison runs inside PostgreSQL (`prisma db execute`): the image has
// no database driver of its own, and the check needs no extra dependency.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = fileURLToPath(new URL('..', import.meta.url));
const PRISMA = join(API, 'node_modules', 'prisma', 'build', 'index.js');
const MIGRATIONS = join(API, 'prisma', 'migrations');
// Prisma's directory names: a timestamp and the name given to migrate dev.
const NAME = /^[A-Za-z0-9_-]+$/;

/** @returns {{ name: string; checksum: string }[]} */
function shippedMigrations() {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(MIGRATIONS, entry.name, 'migration.sql')),
    )
    .map(({ name }) => {
      if (!NAME.test(name)) throw new Error(`Unexpected migration directory name: ${name}`);
      const sql = readFileSync(join(MIGRATIONS, name, 'migration.sql'));
      return { name, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * One PL/pgSQL block: nothing to compare on a database never migrated;
 * otherwise an error naming every applied migration whose checksum is not the
 * shipped file's.
 * @param {{ name: string; checksum: string }[]} migrations
 */
function guard(migrations) {
  const shipped = migrations
    .map(({ name, checksum }) => `('${name}', '${checksum}')`)
    .join(',\n      ');
  return `DO $guard$
DECLARE
  edited text;
BEGIN
  IF to_regclass('_prisma_migrations') IS NULL THEN
    RETURN;
  END IF;
  SELECT string_agg(applied.migration_name, ', ' ORDER BY applied.migration_name) INTO edited
  FROM _prisma_migrations AS applied
  JOIN (VALUES
      ${shipped}
  ) AS shipped (name, checksum) ON shipped.name = applied.migration_name
  WHERE applied.finished_at IS NOT NULL
    AND applied.rolled_back_at IS NULL
    AND applied.checksum <> shipped.checksum;
  IF edited IS NOT NULL THEN
    RAISE EXCEPTION 'Migrations changed after they were applied to this database: %', edited
      USING HINT = 'Never edit an applied migration: restore the file as it was applied and ship the change as a new migration (docs/incident-response.md#10-failed-database-migration).';
  END IF;
END
$guard$;`;
}

/**
 * Runs the Prisma CLI of this package, with `input` on its standard input.
 * @param {string[]} args
 * @param {string} [input]
 */
function prisma(args, input) {
  return spawnSync(process.execPath, [PRISMA, ...args], {
    cwd: API,
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
}

const migrations = shippedMigrations();
if (migrations.length > 0) {
  const checked = prisma(['db', 'execute', '--stdin'], guard(migrations));
  if (checked.status !== 0) process.exit(checked.status ?? 1);
}
process.exit(prisma(['migrate', 'deploy']).status ?? 1);
