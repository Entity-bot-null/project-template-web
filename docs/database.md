# Database

PostgreSQL through Prisma (`apps/api/prisma/schema.prisma`), driver adapter `@prisma/adapter-pg`,
client generated into `apps/api/src/prisma/generated` (ignored by git, generated on install and
build).

## Conventions

- **Names:** models `PascalCase` singular, fields `camelCase`; tables and columns `snake_case`
  through `@@map("users")` / `@map("created_at")`.
- **Keys:** `id String @id @default(uuid(7)) @db.Uuid` (time-ordered UUIDv7, good index locality,
  not guessable). Foreign keys `@db.Uuid` too, always indexed (`@@index([userId])`).
- **Time:** `DateTime @db.Timestamptz(3)`, stored in UTC. Every table has `createdAt`; tables
  edited in place have `updatedAt @updatedAt`.
- **Enums** for closed sets the code switches on (`Role`). Keep the TypeScript list in sync (a
  spec checks `ROLES`).
- **Uniqueness and normalization:** unique columns hold normalized values (emails trimmed and
  lowercased before every write and lookup).
- **Deletes:** choose `onDelete` deliberately for every relation: `Cascade` for owned rows
  (sessions), `Restrict` for referenced records, `SetNull` for optional pointers.
- **Constraints Prisma cannot express** (CHECK, partial unique indexes) go as raw SQL in the
  migration, with a comment in the schema.
- **Money** as integer minor units (`amountCents Int`) or `Decimal`, never `Float`.
- **Personal data:** know which columns hold it; select it only where needed (`USER_SELECT`), never
  log it.

## Migrations

```
pnpm db:up                         start the local database
pnpm db:migrate --name <name>      create a migration from the schema changes, apply every pending
                                   one, regenerate the Prisma client (asks for a name if omitted)
pnpm db:seed                       development accounts (admin@example.com / admin-password,
                                   member@example.com / member-password)
pnpm --filter api db:deploy        prisma migrate deploy: apply pending migrations (what releases run)
```

`pnpm db:migrate` regenerates the client on purpose: Prisma 7's `migrate dev` no longer does, and
the code would keep compiling against the old models. `pnpm dev`, `pnpm lint`, `pnpm typecheck`
and the test commands also regenerate it before running. Step by step, with an example:
[how-to.md](how-to.md#add-a-table-or-a-column).

- Every schema change ships as a **committed migration** in the same pull request as the code.
- Never edit a migration that reached `main`; fix forward with a new one. Prisma's
  `migrate deploy` compares migrations by name only: it would skip an edited migration as already
  applied, and that database would keep a schema every new one (CI, a new environment, a restore
  into an empty database) does not have. So the `api-migrate` image's command
  (`apps/api/scripts/migrate-deploy.mjs`) first compares the checksum Prisma recorded for each
  applied migration with the file it ships, and stops before migrating anything when one differs:
  `Migrations changed after they were applied to this database: <names>`
  ([what to do](incident-response.md#10-failed-database-migration)).
- Review the generated SQL: locks on large tables, defaults, data loss warnings.
- Releases run `prisma migrate deploy` from the `api-migrate` image **before** the new API version
  takes traffic (docs/ci-cd.md#deployment). `migrate dev` and `migrate reset` are for development only.
- **One migration run at a time.** `prisma migrate deploy` holds a PostgreSQL advisory lock while
  it runs (Prisma 7's schema engine, `pg_advisory_lock(72707369)`): a second run against the same
  database waits up to 10 seconds, then fails with `P1002`
  (`Timed out trying to acquire a postgres advisory lock`) without applying anything; checked with
  two runs at once on PostgreSQL 18. The lock belongs to the database session, so the migration
  job connects to the database directly, never through a pooler in transaction mode (PgBouncer, a
  provider's connection pool), which would share the session with others. The guide's
  `migrate.env` and the Terraform outputs connect directly.
- **The engine and its network.** The schema engine connects to the database itself: with
  `sslmode=require`, over TLS without checking the certificate, as libpq's `require` does (checked
  against a PostgreSQL that accepts TLS only, its certificate from a private CA). The `api-migrate`
  image installs Debian's `libssl3`, so Prisma chooses the engine built for OpenSSL 3, which links
  that library: patched with the image, seen by its scan. Without it Prisma guesses OpenSSL 1.1,
  says so at every run (`Prisma failed to detect the libssl/openssl version`), and uses an engine
  with its own copy of OpenSSL; the image build stops instead. The CLI's update check and usage data
  are off in the image, its builds and CI (`CHECKPOINT_DISABLE=1`); set the same in your shell to
  keep it quiet locally.

### Expand and contract

Old and new API versions run side by side during a rollout, and a rollback runs the old version on
the new schema. So every migration must be compatible with the version before it:

1. **Expand:** add nullable columns or new tables; backfill; write to both old and new.
2. Deploy the code that reads the new shape.
3. **Contract:** in a later release, drop the old column or constraint.

Renames are add + copy + drop across releases, never a single `RENAME`.

Nothing at run time notices a contract step that came too early: readiness asks the database for
`SELECT 1`, and the smoke test reads no table. Checked on Docker: after a release whose migration
dropped `users.name`, and again after `rollback.sh`, readiness and the smoke test passed while every
sign-in answered 500 (the column `users.name` does not exist in the current database). So a
contract step must say why it is safe, in a comment right above the statement:

```sql
-- contract: release 1.4.0 stopped reading users.name, and every server runs it
ALTER TABLE "users" DROP COLUMN "name";
```

`scripts/check-migrations.mjs` refuses a contract step without that reason; it runs in
`pnpm test:scripts` (so in CI) and on the migrations staged at each commit. Contract steps:
dropping a table, column, type or view; renaming a table, column, type or enum value; changing a
column's type; making a column required, adding a required column without a default, or removing a
default; emptying a table. In the migrations from `TIGHTENING_FROM` on (the ones before it shipped
before these rules, and a committed migration is never edited), also: a unique index or a
constraint (`CHECK`, `UNIQUE`, `PRIMARY KEY`, `FOREIGN KEY`, `EXCLUDE`, in the table or in a
column's definition) added to a table an earlier migration created (the previous release may write
what it refuses, and existing rows can make it fail), unless it is a unique index, a `UNIQUE` or a
foreign key that only covers columns the same migration added empty: nullable, with no default, no
generated or identity value, and no `UPDATE`, `INSERT` or `COPY` of that table anywhere in the
migration (a new optional relation; `NULLS NOT DISTINCT` and a primary key never count, their
NULLs collide or are refused); a dropped unique index (every name of a `DROP INDEX`), unique
constraint or primary key; a table moved to another schema; a `DELETE` without `WHERE`; and an
enum value added without `IF NOT EXISTS` (see below). Comments and strings anywhere in a
statement do not hide a step. Prisma writes `ADD VALUE` without it, and
`pnpm db:migrate` applies what it creates: create such a migration with
`pnpm db:migrate --name <name> --create-only`, write `ADD VALUE IF NOT EXISTS` in its SQL, then run
`pnpm db:migrate` to apply it (editing a migration already applied to your database makes
`migrate dev` ask to reset it). A Prisma change that removes an enum value writes several of
them (retype the column, rename the types, drop the old one), each with its reason. Expand steps
(new tables and what they get in the same migration, nullable columns, columns with a default,
indexes, looser constraints) need nothing. The check reads plain statements, not SQL inside a `DO`
block or a function body.

### Safe migrations

- **Small:** one change per migration, so a failure leaves at most a known part applied.
- **Bounded locks:** start a migration that alters a busy table with `SET lock_timeout = '5s';`:
  it fails fast instead of queueing every request behind its lock.
- **Large tables:** build indexes with `CREATE INDEX CONCURRENTLY` in a migration of their own (it
  cannot run inside a transaction); backfill in batches, not in one statement.
- **Rehearse** anything that rewrites data or locks a large table against a restored copy of
  production (docs/disaster-recovery.md#rehearsal-on-a-development-machine shows the commands).

### When a migration fails

Prisma runs a migration's SQL **without a transaction** on PostgreSQL: when a statement fails, the
ones before it stay applied (checked with Prisma 7 and PostgreSQL 18). The migration is recorded as
failed (`P3018`), and every later `migrate deploy` refuses to run (`P3009`) until it is resolved.
Because the release runs the migration before the rollout, the running version keeps serving.

1. Find what took effect: `prisma migrate status` (in an environment: the `api-migrate` image with
   that command, docs/incident-response.md#10-failed-database-migration), the error in the job's
   output, and the tables the migration touches.
2. Undo those statements (or, as a last resort, apply the rest by hand). An enum value cannot be
   undone (PostgreSQL has no `DROP VALUE`): it stays, which the migration's rerun survives only when
   it adds it with `ADD VALUE IF NOT EXISTS` (the check above asks for it). The migrations committed
   before that rule add theirs without it: if one of them fails after its `ADD VALUE` statements,
   finish it by hand and record it `--applied`.
3. Record the outcome: `prisma migrate resolve --rolled-back <migration>` (undone) or
   `--applied <migration>` (completed by hand). Never edit `_prisma_migrations` directly.
4. Fix the data or the migration and deploy again.

Wrapping a migration in `BEGIN;` ... `COMMIT;` makes it atomic (nothing is applied on failure),
at a cost: Prisma then reports `current transaction is aborted` instead of the failing statement,
which has to be found in the database's log. Statements that cannot run in a transaction
(`CREATE INDEX CONCURRENTLY`) cannot be wrapped.

## Test databases

`<db>_test` (integration suite) and `<db>_e2e` (end-to-end suite) on the same server as
`DATABASE_URL`, created and migrated automatically, emptied by the suites. The development database
is never touched by tests. Before the integration suite, its setup also replays every migration on
an empty `<db>_shadow`, as `prisma migrate dev` does on its shadow database, and compares the
result with `schema.prisma` (`prisma migrate diff --exit-code`): a migration that only runs where
a deployment created something first (`_prisma_migrations`, a role), or a schema change without its
migration, fails there instead of on a developer's machine.

## Seeds

`apps/api/src/seed/seed.ts` is idempotent (upserts keyed on unique columns). Its accounts have
public passwords, so `pnpm db:seed` refuses `NODE_ENV=production` and any database whose host is
not this machine (`localhost`, `127.0.0.1`, `::1`), the URL's `host` and `hostaddr` parameters
included; for a disposable remote database, pass
`pnpm db:seed --allow-remote-database`. Production data comes from the product's own flows or an
audited script, never from the seed.

## Sessions

The `sessions` table holds one row per refresh token, only its SHA-256, grouped in families: a
sign-in starts a family (`family_id`, `family_expires_at`, 90 days), every rotation adds the
successor. Rows are revoked, never updated otherwise, and deleted by the hourly sweep once past
their own expiry. The rules live in `auth/sessions.service.ts` (docs/security.md#authentication-and-tokens).

## Connections

Each API instance holds a pool of at most `DB_POOL_MAX` connections (default 10), and a request
waits at most 5 seconds for one (`prisma/prisma.service.ts`; the driver's default is to wait
forever, which would hang requests and health checks instead of failing them). Size them together
(REQUIERE CONFIGURACIÓN):

- every instance at its maximum, plus the migration job and the operators, must fit in the
  database's connection limit: `instances × DB_POOL_MAX + a few < max_connections` (or the limit of
  the API's database role); count the instances autoscaling may add;
- waiting for a connection shows as `db.client.connection.pending_requests` above zero
  (docs/observability.md#database); raise `DB_POOL_MAX` only when the database has room for it;
- many instances against one small database need a connection pooler (PgBouncer, or the
  provider's) between them.

No wait on the database is unbounded: the server cancels a statement that runs longer than
`DB_STATEMENT_TIMEOUT_MS` (30 s by default: a lock wait, a runaway query), the driver gives up on a
query 5 seconds after that (a server that stopped answering cannot cancel anything) and drops the
connection, and TCP keep-alive on idle connections notices a peer that vanished. Raise the
statement timeout for a project whose requests legitimately run long queries, or move that work out
of the request path.

TLS to the database when it is not on a private network (`?sslmode=require` in `DATABASE_URL`).
The API runs with a role that can read and write the application's tables and nothing else; the
migration job uses its own role (docs/disaster-recovery.md#backup-strategy).

## Backups and recovery (REQUIERE CONFIGURACIÓN)

Automated backups, point-in-time recovery for production, tested restores, RPO and RTO:
[disaster-recovery.md](disaster-recovery.md).
