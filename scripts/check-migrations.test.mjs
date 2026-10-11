// Tests of scripts/check-migrations.mjs: which migration statements are
// contract steps (the release before still uses what they remove or
// tighten), how a reason acknowledges one, and this repository's own
// migrations. Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMigrations, contractSteps, splitStatements } from './check-migrations.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The kinds of the contract steps of a migration, in order. */
const kinds = (/** @type {string} */ sql) => contractSteps(sql).map((step) => step.kind);

describe('splitStatements', () => {
  test('splits on semicolons outside comments, strings, identifiers and dollar quotes', () => {
    const statements = splitStatements(
      [
        '-- AlterTable; not a statement',
        `UPDATE "users" SET "name" = 'a;b' WHERE "id" = '1';`,
        '/* a block; /* nested; */ still a comment */',
        'CREATE TABLE "x;y" ("id" INTEGER);',
        `DO $body$ BEGIN PERFORM 1; END $body$;`,
        'SELECT 1',
      ].join('\n'),
    );
    assert.deepEqual(
      statements.map((statement) => [statement.line, statement.code.split(' ')[0]]),
      [
        [2, 'UPDATE'],
        [4, 'CREATE'],
        [5, 'DO'],
        [6, 'SELECT'],
      ],
    );
    assert.match(statements[0]?.comments ?? '', /AlterTable/);
    assert.match(statements[1]?.comments ?? '', /nested/);
  });
});

describe('contractSteps', () => {
  test('finds what the previous release may still read or write', () => {
    assert.deepEqual(kinds('DROP TABLE "notes";'), ['drops a table']);
    assert.deepEqual(kinds('ALTER TABLE "users" DROP COLUMN "name";'), ['drops a column']);
    assert.deepEqual(kinds('ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";'), [
      'renames a column or a table',
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" RENAME TO "people";'), [
      'renames a column or a table',
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" ALTER COLUMN "name" SET DATA TYPE VARCHAR(80);'), [
      "changes a column's type",
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" ALTER COLUMN "name" TYPE TEXT;'), [
      "changes a column's type",
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL;'), [
      'makes a column required',
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;'), [
      "removes a column's default",
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" ADD COLUMN "plan" TEXT NOT NULL;'), [
      'adds a required column without a default',
    ]);
    assert.deepEqual(kinds("ALTER TYPE \"Role\" RENAME VALUE 'member' TO 'user';"), [
      'renames a type or one of its values',
    ]);
    assert.deepEqual(kinds('DROP TYPE "Role_old";'), ['drops a type']);
    assert.deepEqual(kinds('TRUNCATE "sessions";'), ['empties a table']);
  });

  test('reads every action of a statement, and Prisma enum changes step by step', () => {
    assert.deepEqual(
      kinds(
        'ALTER TABLE "users" DROP COLUMN "name",\nADD COLUMN "plan" DECIMAL(10,2) NOT NULL,\nADD COLUMN "note" TEXT;',
      ),
      ['drops a column', 'adds a required column without a default'],
    );
    // What prisma migrate dev writes when a value leaves an enum.
    assert.deepEqual(
      kinds(`BEGIN;
CREATE TYPE "Role_new" AS ENUM ('admin');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "public"."Role_old";
COMMIT;`),
      [
        "changes a column's type",
        'renames a type or one of its values',
        'renames a type or one of its values',
        'drops a type',
      ],
    );
  });

  test('leaves expand steps alone', () => {
    const expand = `
CREATE TYPE "Plan" AS ENUM ('free', 'paid');
CREATE TABLE "notes" ("id" UUID NOT NULL, "title" TEXT NOT NULL, CONSTRAINT "notes_pkey" PRIMARY KEY ("id"));
ALTER TABLE "users" ADD COLUMN "nickname" TEXT;
ALTER TABLE "users" ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'free';
ALTER TABLE "users" ADD COLUMN "seen" INTEGER GENERATED ALWAYS AS (1) STORED NOT NULL;
ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "plan" SET DEFAULT 'paid';
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_fkey";
ALTER TABLE "users" RENAME CONSTRAINT "users_pkey" TO "users_primary";
ALTER TYPE "Plan" ADD VALUE 'team';
DROP INDEX "sessions_expires_at_idx";
CREATE INDEX CONCURRENTLY "notes_title_idx" ON "notes"("title");
UPDATE "users" SET "nickname" = 'drop column' WHERE "nickname" IS NULL;
SET lock_timeout = '5s';`;
    assert.deepEqual(kinds(expand), []);
    // Words inside identifiers, strings and comments are not statements.
    assert.deepEqual(
      kinds('-- DROP TABLE "users";\nCREATE TABLE "drop_table" ("drop column" TEXT);'),
      [],
    );
  });

  test('a reason above the statement acknowledges it; an empty one does not', () => {
    const sql = `/*
  Warnings:
  - You are about to drop the column \`name\` on the \`users\` table.
*/
-- AlterTable
-- contract: release 1.4.0 stopped reading users.name; 1.5.0 runs everywhere
ALTER TABLE "users" DROP COLUMN "name";

-- contract:
DROP TABLE "notes";

-- DropTable
DROP TABLE "drafts";
`;
    assert.deepEqual(
      contractSteps(sql).map(({ kind, line, reason }) => ({ kind, line, reason })),
      [
        {
          kind: 'drops a column',
          line: 7,
          reason: 'release 1.4.0 stopped reading users.name; 1.5.0 runs everywhere',
        },
        { kind: 'drops a table', line: 10, reason: undefined },
        { kind: 'drops a table', line: 13, reason: undefined },
      ],
    );
  });
});

describe('checkMigrations', () => {
  test('passes this repository', () => {
    const { problems, acknowledged } = checkMigrations(
      join(ROOT, 'apps', 'api', 'prisma', 'migrations'),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(acknowledged, []);
  });

  test('reports each contract step without a reason, with its file and line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    try {
      mkdirSync(join(dir, '20261011000000_drop_name'));
      writeFileSync(
        join(dir, '20261011000000_drop_name', 'migration.sql'),
        '-- AlterTable\nALTER TABLE "users" DROP COLUMN "name";\n',
      );
      mkdirSync(join(dir, '20261012000000_drop_notes'));
      writeFileSync(
        join(dir, '20261012000000_drop_notes', 'migration.sql'),
        '-- contract: nothing reads notes since 1.3.0\nDROP TABLE "notes";\n',
      );
      writeFileSync(join(dir, 'migration_lock.toml'), 'provider = "postgresql"\n');
      const { problems, acknowledged } = checkMigrations(dir);
      assert.equal(problems.length, 1);
      assert.match(
        problems[0] ?? '',
        /^20261011000000_drop_name\/migration\.sql:2: drops a column: ALTER TABLE "users" DROP COLUMN "name";/,
      );
      assert.match(problems[0] ?? '', /-- contract: <why/);
      assert.deepEqual(acknowledged, [
        '20261012000000_drop_notes/migration.sql:2: drops a table (contract: nothing reads notes since 1.3.0)',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
