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
import {
  checkMigrations,
  checkStaged,
  contractSteps,
  domainsOf,
  splitStatements,
  TIGHTENING_FROM,
} from './check-migrations.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The kinds of the contract steps of a migration, in order. */
const kinds = (/** @type {string} */ sql) => contractSteps(sql).map((step) => step.kind);
const UNYIELDING = 'adds a foreign key that does not give way to an existing table';

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
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'team';
DROP INDEX "sessions_expires_at_idx";
CREATE TABLE "teams" ("id" UUID NOT NULL, "name" TEXT NOT NULL);
CREATE UNIQUE INDEX "teams_name_key" ON "teams"("name");
ALTER TABLE "teams" ADD CONSTRAINT "teams_name_check" CHECK ("name" <> '');
ALTER TABLE "public"."teams" ADD CONSTRAINT "teams_owner_fkey" FOREIGN KEY ("id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DELETE FROM "sessions" WHERE "expires_at" < now();
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

  test('finds what tightens a table an earlier migration created', () => {
    assert.deepEqual(kinds('CREATE UNIQUE INDEX "users_name_key" ON "users"("name");'), [
      'adds a unique index to an existing table',
    ]);
    assert.deepEqual(
      kinds(
        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_name_key ON ONLY public.users (name);',
      ),
      ['adds a unique index to an existing table'],
    );
    assert.deepEqual(
      kinds(
        'ALTER TABLE "users" ADD CONSTRAINT "users_name_check" CHECK ("name" <> \'\') NOT VALID,\nADD UNIQUE ("email"),\nADD FOREIGN KEY ("team_id") REFERENCES "teams"("id"),\nADD PRIMARY KEY ("id");',
      ),
      [
        'adds a constraint to an existing table',
        'adds a constraint to an existing table',
        'adds a constraint to an existing table',
        'adds a constraint to an existing table',
      ],
    );
    assert.deepEqual(kinds('ALTER TABLE "users" SET SCHEMA "archive";'), [
      'moves a table to another schema',
    ]);
    assert.deepEqual(kinds('DROP INDEX "users_email_key";'), ['drops a unique index']);
    assert.deepEqual(kinds('DELETE FROM "sessions";'), ['empties a table']);
    assert.deepEqual(kinds('ALTER TYPE "MailKind" ADD VALUE \'digest\';'), [
      'adds an enum value without IF NOT EXISTS',
    ]);
  });

  test('leaves alone what only covers columns the same migration added (a new optional relation)', () => {
    const relation = (
      /** @type {boolean} */ unique,
    ) => `ALTER TABLE "users" ADD COLUMN "team_id" UUID;
${unique ? 'CREATE UNIQUE INDEX "users_team_id_key"' : 'CREATE INDEX "users_team_id_idx"'} ON "users"("team_id");
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;`;
    assert.deepEqual(kinds(relation(true)), []);
    assert.deepEqual(kinds(relation(false)), []);
    assert.deepEqual(
      kinds('ALTER TABLE users ADD COLUMN code TEXT, ADD CONSTRAINT users_code_key UNIQUE (code);'),
      [],
    );
    // An existing column among them, or an expression: tightening.
    assert.deepEqual(
      kinds(
        'ALTER TABLE "users" ADD COLUMN "team_id" UUID;\nCREATE UNIQUE INDEX "u" ON "users"("team_id", "email");',
      ),
      ['adds a unique index to an existing table'],
    );
    assert.deepEqual(
      kinds(
        'ALTER TABLE "users" ADD COLUMN "nick" TEXT;\nCREATE UNIQUE INDEX "u" ON "users"(lower("nick"));',
      ),
      ['adds a unique index to an existing table'],
    );
    // A CHECK reads an expression: what it covers is not told.
    assert.deepEqual(
      kinds(
        'ALTER TABLE "users" ADD COLUMN "age" INTEGER, ADD CONSTRAINT "users_age_check" CHECK ("age" >= 0);',
      ),
      ['adds a constraint to an existing table'],
    );
  });

  test('counts a new column as empty only when nothing fills it: no default, no generated value, no write', () => {
    const unique = 'CREATE UNIQUE INDEX "users_code_key" ON "users"("code");';
    for (const filled of [
      `ALTER TABLE "users" ADD COLUMN "code" TEXT NOT NULL DEFAULT 'x';`,
      `ALTER TABLE "users" ADD COLUMN "code" TEXT GENERATED ALWAYS AS (lower("email")) STORED;`,
      'ALTER TABLE "users" ADD COLUMN "code" INTEGER GENERATED BY DEFAULT AS IDENTITY;',
      'ALTER TABLE "users" ADD COLUMN "code" SERIAL;',
      // A backfill, before or after the index: the same rows, filled.
      `ALTER TABLE "users" ADD COLUMN "code" TEXT;\nUPDATE "users" SET "code" = lower("email");`,
      `ALTER TABLE "users" ADD COLUMN "code" TEXT;\n${unique}\nUPDATE ONLY users SET code = email;`,
      `ALTER TABLE "users" ADD COLUMN "code" TEXT;\nINSERT INTO public.users (code) VALUES ('a');`,
    ]) {
      assert.deepEqual(kinds(filled.includes(unique) ? filled : `${filled}\n${unique}`), [
        'adds a unique index to an existing table',
      ]);
    }
    assert.deepEqual(
      kinds(`ALTER TABLE "users" ADD COLUMN "code" TEXT DEFAULT NULL;\n${unique}`),
      [],
    );
    // NULLS NOT DISTINCT: the new column's NULLs collide.
    assert.deepEqual(
      kinds(
        'ALTER TABLE "users" ADD COLUMN "code" TEXT;\nCREATE UNIQUE INDEX "users_code_key" ON "users"("code") NULLS NOT DISTINCT;',
      ),
      ['adds a unique index to an existing table'],
    );
    // A primary key makes its columns required: never safe on an existing table.
    assert.deepEqual(kinds('ALTER TABLE "users" ADD COLUMN "id2" UUID, ADD PRIMARY KEY ("id2");'), [
      'adds a constraint to an existing table',
    ]);
  });

  test("reads a constraint written in a column's definition like one of its own", () => {
    assert.deepEqual(kinds('ALTER TABLE "users" ADD COLUMN "code" TEXT UNIQUE;'), []);
    assert.deepEqual(
      kinds(
        'ALTER TABLE "users" ADD COLUMN "team_id" UUID REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
      ),
      [],
    );
    assert.deepEqual(
      kinds(`ALTER TABLE "users" ADD COLUMN "code" TEXT NOT NULL DEFAULT 'x' UNIQUE;`),
      ['adds a constraint to an existing table'],
    );
    assert.deepEqual(kinds('ALTER TABLE "users" ADD COLUMN "id2" UUID PRIMARY KEY;'), [
      'adds a constraint to an existing table',
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" ADD COLUMN "unique_code" TEXT;'), []);
    assert.deepEqual(
      kinds(
        `CREATE TABLE "teams" ("id" UUID NOT NULL);\nALTER TABLE "teams" ADD COLUMN "c" TEXT NOT NULL DEFAULT 'x' UNIQUE;`,
      ),
      [],
    );
  });

  // A new optional relation, written in the column's definition.
  const OPTIONAL_TEAM =
    'ALTER TABLE "users" ADD COLUMN "team_id" UUID REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;';

  test("flags a constraint in a column's definition unless the column holds nothing yet, as UNIQUE or a foreign key", () => {
    for (const sql of [
      // A backfill fills the new column.
      `ALTER TABLE "users" ADD COLUMN "code" TEXT UNIQUE;\nUPDATE "users" SET "code" = lower("email");`,
      `${OPTIONAL_TEAM}\nUPDATE "users" SET "team_id" = gen_random_uuid();`,
      // Its NULLs collide.
      'ALTER TABLE "users" ADD COLUMN "code" TEXT UNIQUE NULLS NOT DISTINCT;',
      // A CHECK may read other columns, whatever it names.
      'ALTER TABLE "users" ADD COLUMN "age" INTEGER CHECK ("security_version" >= 1);',
      'ALTER TABLE "users" ADD COLUMN "age" INTEGER CHECK ("age" >= 0);',
      'ALTER TABLE "users" ADD COLUMN "code" TEXT UNIQUE CHECK (length("code") > 2);',
      // At table level too.
      'ALTER TABLE "users" ADD COLUMN "code" TEXT, ADD CONSTRAINT "users_code_key" UNIQUE NULLS NOT DISTINCT ("code");',
    ]) {
      assert.deepEqual(kinds(sql), ['adds a constraint to an existing table'], sql);
    }
    // The same foreign key without the backfill: nothing to refuse.
    assert.deepEqual(kinds(OPTIONAL_TEAM), []);
  });

  test('counts a new column filled by a default given later, or by a write inside WITH or a COPY of a query', () => {
    const unique = 'CREATE UNIQUE INDEX "users_code_key" ON "users"("code");';
    for (const sql of [
      `ALTER TABLE "users" ADD COLUMN "code" TEXT;\nALTER TABLE "users" ALTER COLUMN "code" SET DEFAULT 'x';\n${unique}`,
      `ALTER TABLE "users" ADD COLUMN "code" TEXT, ALTER COLUMN "code" SET DEFAULT 'x';\n${unique}`,
      `ALTER TABLE "users" ADD COLUMN "code" TEXT;\nWITH s AS (SELECT 1) UPDATE "users" SET "code" = "email";\n${unique}`,
      `ALTER TABLE "users" ADD COLUMN "code" TEXT;\nWITH s AS (INSERT INTO public.users ("code") VALUES ('a') RETURNING 1) SELECT * FROM s;\n${unique}`,
    ]) {
      assert.deepEqual(kinds(sql), ['adds a unique index to an existing table'], sql);
    }
    // A COPY of a query that writes.
    assert.deepEqual(
      kinds(
        `ALTER TABLE "users" ADD COLUMN "code" TEXT;\nCOPY (UPDATE "users" SET "code" = "email" RETURNING 1) TO STDOUT;\n${unique}`,
      ),
      ['adds a unique index to an existing table'],
    );
    // A default of NULL, and COPY ... TO, fill nothing.
    assert.deepEqual(
      kinds(
        `ALTER TABLE "users" ADD COLUMN "code" TEXT, ALTER COLUMN "code" SET DEFAULT NULL;\nCOPY "users" TO STDOUT;\n${unique}`,
      ),
      [],
    );
  });

  test('reads keywords in a column definition, not in quoted names or a foreign key action', () => {
    for (const sql of [
      'ALTER TABLE "users" ADD COLUMN "x" UUID REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      'ALTER TABLE "users" ADD COLUMN "team_id" UUID REFERENCES "teams"("id") ON DELETE SET DEFAULT ON UPDATE SET DEFAULT;',
      'ALTER TABLE "users" ADD COLUMN "h" TEXT COLLATE "default";\nCREATE UNIQUE INDEX "users_h_key" ON "users"("h");',
      'ALTER TABLE "users" ADD COLUMN "h" TEXT DEFAULT (NULL);\nCREATE UNIQUE INDEX "users_h_key" ON "users"("h");',
    ]) {
      assert.deepEqual(kinds(sql), [], sql);
    }
  });

  // RESTRICT, NO ACTION, or no action said (NO ACTION): the previous
  // release's deletes of rows the new release references are refused.
  const UNYIELDING_ACTIONS = [
    'ON DELETE RESTRICT ON UPDATE CASCADE',
    'ON DELETE NO ACTION ON UPDATE CASCADE',
    'ON DELETE SET NULL',
    '',
  ];

  test('exempts a foreign key on a new column only when it gives way to the referenced rows', () => {
    for (const actions of UNYIELDING_ACTIONS) {
      assert.deepEqual(
        kinds(
          `ALTER TABLE "users" ADD COLUMN "avatar_id" UUID;\nALTER TABLE "users" ADD CONSTRAINT "users_avatar_id_fkey" FOREIGN KEY ("avatar_id") REFERENCES "files"("id") ${actions};`,
        ),
        [UNYIELDING],
        actions,
      );
      assert.deepEqual(
        kinds(
          `ALTER TABLE "users" ADD COLUMN "avatar_id" UUID REFERENCES "files"("id") ${actions};`,
        ),
        [UNYIELDING],
        actions,
      );
    }
    // A UNIQUE whose NULLs stay distinct, said or not, is safe on a new column.
    assert.deepEqual(
      kinds(
        'ALTER TABLE "users" ADD COLUMN "code" TEXT, ADD CONSTRAINT "users_code_key" UNIQUE NULLS DISTINCT ("code");',
      ),
      [],
    );
  });

  test('judges a foreign key by the table it references too: new tables included', () => {
    // A new table (Prisma's CREATE TABLE, then its keys) with a required
    // relation to an existing one: that one's deletes are refused.
    for (const actions of UNYIELDING_ACTIONS) {
      assert.deepEqual(
        kinds(
          `CREATE TABLE "posts" ("id" UUID NOT NULL, "author_id" UUID NOT NULL, CONSTRAINT "posts_pkey" PRIMARY KEY ("id"));\nALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ${actions};`,
        ),
        [UNYIELDING],
        actions,
      );
      // Declared in the new table itself, in a column or as a constraint.
      assert.deepEqual(
        kinds(
          `CREATE TABLE posts (id uuid PRIMARY KEY, author_id uuid NOT NULL REFERENCES public.users (id) ${actions}, editor_id uuid, CONSTRAINT posts_editor_fkey FOREIGN KEY (editor_id) REFERENCES "users" ("id") ${actions});`,
        ),
        [UNYIELDING, UNYIELDING],
        actions,
      );
      // A column added to a new table.
      assert.deepEqual(
        kinds(
          `CREATE TABLE "posts" ("id" UUID NOT NULL);\nALTER TABLE "posts" ADD COLUMN "author_id" UUID REFERENCES "users"("id") ${actions};`,
        ),
        [UNYIELDING],
        actions,
      );
      // A table this migration created, or the new table itself: the previous
      // release never deletes from it.
      assert.deepEqual(
        kinds(
          `CREATE TABLE "teams" ("id" UUID NOT NULL);\nALTER TABLE "users" ADD COLUMN "team_id" UUID;\nALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ${actions};`,
        ),
        [],
        actions,
      );
      assert.deepEqual(
        kinds(
          `CREATE TABLE "teams" ("id" UUID NOT NULL);\nCREATE TABLE "members" ("team_id" UUID REFERENCES "teams" ${actions}, "mentor_id" UUID REFERENCES "members" ${actions});`,
        ),
        [],
        actions,
      );
    }
    // Giving way on both, as Prisma writes an optional relation or onDelete: Cascade.
    assert.deepEqual(
      kinds(
        'CREATE TABLE "posts" ("id" UUID NOT NULL, "author_id" UUID NOT NULL);\nALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      ),
      [],
    );
    // A quoted name that reads like the keyword is a name.
    assert.deepEqual(
      kinds(
        'CREATE TABLE "posts" ("references users" TEXT, "author_id" UUID REFERENCES "users" ON DELETE SET NULL ON UPDATE CASCADE);',
      ),
      [],
    );
  });

  test('counts a column as holding data when IF NOT EXISTS may find it, or a domain types it', () => {
    const unique = 'CREATE UNIQUE INDEX "users_code_key" ON "users"("code");';
    assert.deepEqual(
      kinds(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "code" TEXT;\n${unique}`),
      ['adds a unique index to an existing table'],
    );
    // Whatever the domain's default says: one it has, one a later statement
    // drops (the rows got it already) or sets, one of the domain it is based
    // on, one of a domain renamed since.
    for (const domain of [
      `CREATE DOMAIN code_t AS text DEFAULT 'x';`,
      `CREATE DOMAIN code_t AS text CHECK (VALUE <> '');`,
      `CREATE DOMAIN a_t AS text DEFAULT 'x';\nCREATE DOMAIN code_t AS a_t;`,
      `CREATE DOMAIN old_t AS text DEFAULT 'x';\nALTER DOMAIN old_t RENAME TO code_t;`,
    ]) {
      assert.deepEqual(
        kinds(`${domain}\nALTER TABLE "users" ADD COLUMN "code" code_t;\n${unique}`),
        ['adds a unique index to an existing table'],
        domain,
      );
    }
    assert.deepEqual(
      kinds(
        `CREATE DOMAIN code_t AS text DEFAULT 'x';\nALTER TABLE "users" ADD COLUMN "code" code_t;\nALTER DOMAIN code_t DROP DEFAULT;\n${unique}`,
      ),
      ['adds a unique index to an existing table'],
    );
    // One an earlier migration created (checkMigrations passes them on).
    assert.deepEqual(
      contractSteps(`ALTER TABLE "users" ADD COLUMN "code" public.code_t;\n${unique}`, {
        domains: new Set(['code_t']),
      }).map((step) => step.kind),
      ['adds a unique index to an existing table'],
    );
    // An array of a domain takes no default from it.
    for (const array of ['code_t[]', 'code_t ARRAY', 'public.code_t [3]']) {
      assert.deepEqual(
        kinds(
          `CREATE DOMAIN code_t AS text DEFAULT 'x';\nALTER TABLE "users" ADD COLUMN "code" ${array};\n${unique}`,
        ),
        [],
        array,
      );
    }
    assert.deepEqual(
      [
        ...domainsOf(
          'CREATE DOMAIN a AS int DEFAULT 1; CREATE DOMAIN "B" AS a; ALTER DOMAIN "B" RENAME TO c; ALTER DOMAIN a RENAME CONSTRAINT x TO y;',
        ),
      ],
      ['a', 'B', 'c'],
    );
  });

  test('sees writes led by EXPLAIN, PREPARE or a rule', () => {
    const unique = 'CREATE UNIQUE INDEX "users_code_key" ON "users"("code");';
    for (const write of [
      'EXPLAIN ANALYZE UPDATE "users" SET "code" = "email";',
      'PREPARE fill AS UPDATE "users" SET "code" = "email";\nEXECUTE fill;',
      `CREATE RULE r AS ON INSERT TO "audit" DO ALSO UPDATE "users" SET "code" = 'x';`,
    ]) {
      assert.deepEqual(
        kinds(`ALTER TABLE "users" ADD COLUMN "code" TEXT;\n${write}\n${unique}`),
        ['adds a unique index to an existing table'],
        write,
      );
    }
  });

  test('finds a tightening step whatever comments or strings come before it in the statement', () => {
    for (const sql of [
      'ALTER TABLE "users"\n  -- the new rule\n  ADD CONSTRAINT "users_name_check" CHECK (length("name") > 0);',
      'ALTER TABLE "users" /* why */ ADD CONSTRAINT "users_name_check" CHECK (true);',
      `ALTER TABLE "users" ADD COLUMN "x" INTEGER, -- the team's id\n  ADD CONSTRAINT "users_email_key" UNIQUE ("email");`,
      `ALTER TABLE "users" ADD COLUMN "x" TEXT DEFAULT E'it\\'s', ADD CONSTRAINT "c" CHECK (true);`,
      `ALTER TABLE "users" ADD COLUMN "x" TEXT DEFAULT $$it's$$, ADD CONSTRAINT "c" CHECK (true);`,
    ]) {
      assert.deepEqual(kinds(sql), ['adds a constraint to an existing table'], sql);
    }
    assert.deepEqual(kinds('ALTER TABLE "users" -- move\n  SET SCHEMA archive;'), [
      'moves a table to another schema',
    ]);
    assert.deepEqual(kinds('DROP INDEX /* replaced */ "users_email_key";'), [
      'drops a unique index',
    ]);
  });

  test('finds dropped unique constraints and primary keys, and every name of a DROP INDEX', () => {
    assert.deepEqual(kinds('ALTER TABLE "users" DROP CONSTRAINT "users_email_key";'), [
      'drops a unique constraint',
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_pkey";'), [
      'drops a primary key',
    ]);
    assert.deepEqual(kinds('ALTER TABLE "users" DROP CONSTRAINT "users_team_id_fkey";'), []);
    assert.deepEqual(kinds('DROP INDEX IF EXISTS "users_email_key", "users_name_idx";'), [
      'drops a unique index',
    ]);
    assert.deepEqual(kinds('DROP INDEX "users_name_idx" CASCADE;'), []);
  });

  test('reads names as written: a quoted index name holding " on " names no table', () => {
    assert.deepEqual(
      kinds('CREATE TABLE "t" ("id" INTEGER);\nCREATE UNIQUE INDEX "idx on x" ON "t"("id");'),
      [],
    );
  });

  test('applies those rules only from TIGHTENING_FROM on: earlier migrations shipped before them', () => {
    const sql = 'ALTER TABLE "users" ADD CONSTRAINT "users_check" CHECK (true);';
    assert.deepEqual(
      contractSteps(sql, { tightening: false }).map((step) => step.kind),
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

  test("applies the tightening rules by the migration's name, and says how to fix an enum value", () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    try {
      const enumValue = 'ALTER TYPE "MailKind" ADD VALUE \'digest\';\n';
      mkdirSync(join(dir, '20261013000000_before_the_rules'));
      writeFileSync(join(dir, '20261013000000_before_the_rules', 'migration.sql'), enumValue);
      mkdirSync(join(dir, `${TIGHTENING_FROM}_after_the_rules`));
      writeFileSync(join(dir, `${TIGHTENING_FROM}_after_the_rules`, 'migration.sql'), enumValue);
      const { problems } = checkMigrations(dir);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', new RegExp(`^${TIGHTENING_FROM}_after_the_rules/`));
      assert.match(problems[0] ?? '', /Write ADD VALUE IF NOT EXISTS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('knows the domains an earlier migration created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    try {
      mkdirSync(join(dir, '20261013000000_domain'));
      writeFileSync(
        join(dir, '20261013000000_domain', 'migration.sql'),
        "CREATE DOMAIN code_t AS text CHECK (VALUE <> '');\n",
      );
      mkdirSync(join(dir, `${TIGHTENING_FROM}_code`));
      writeFileSync(
        join(dir, `${TIGHTENING_FROM}_code`, 'migration.sql'),
        'ALTER TABLE "users" ADD COLUMN "code" code_t;\nCREATE UNIQUE INDEX "users_code_key" ON "users"("code");\n',
      );
      const { problems } = checkMigrations(dir);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /adds a unique index to an existing table/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checks staged migrations knowing the domains the migrations before them created (the commit hook)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    const write = (/** @type {string} */ name, /** @type {string} */ sql) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'migration.sql'), sql);
      return join(dir, name, 'migration.sql');
    };
    try {
      const staged = write(
        `${TIGHTENING_FROM}_code`,
        'ALTER TABLE "users" ADD COLUMN "code" code_t;\nCREATE UNIQUE INDEX "users_code_key" ON "users"("code");\n',
      );
      // A domain only a later migration creates is not known yet.
      write('29991231000000_later', 'CREATE DOMAIN code_t AS text;\n');
      assert.deepEqual(checkStaged([staged], dir).problems, []);
      write('20261013000000_domain', 'CREATE DOMAIN code_t AS text;\n');
      const { problems } = checkStaged([staged], dir);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /:2: adds a unique index to an existing table/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
