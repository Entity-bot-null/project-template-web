# Disaster recovery

What the application can lose, how it comes back, and how to know that it can. The template ships
the procedure, the checks and a rehearsal that runs on any machine. The backups themselves are made
by the platform the project chooses (**REQUIERE CONFIGURACIÓN**: managed PostgreSQL, a cloud
provider, a self-hosted server), with one exception: the reference server target, with its database
on the server, ships a nightly backup kept on that server ([deploy-vps.md](deploy-vps.md#backups));
copying it off the server is still the project's to set up. Nothing else here assumes a platform.

## What to protect

| Asset                                                                             | Where it lives                                                                                  | Backed up?                                                                                                     | How it comes back                                                                                                                                     |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL: users, sessions, the product's data, `_prisma_migrations`             | the database server; on the VPS target with the `db` profile, the server's volume `app_db_data` | **yes**: full backups and point-in-time recovery (PITR); on the VPS target's own database, a nightly `pg_dump` | [Restore procedure](#restore-procedure)                                                                                                               |
| Redis: rate limit counters, cache, leases, idempotency claims                     | Redis (OPTIONAL); on the VPS target, on the server (`app_redis_data`)                           | no: every key is derived or short-lived, with a TTL                                                            | starts empty; the application treats a missing or empty Redis as normal (docs/architecture.md#degradation)                                            |
| Container images (`api`, `api-migrate`, `web`)                                    | the registry                                                                                    | the registry's retention (REQUIERE CONFIGURACIÓN)                                                              | redeploy by digest; keep every digest that ran in production for at least the last few releases: they are the rollback targets                        |
| Code, migrations, workflows, docs                                                 | Git (GitHub)                                                                                    | the hosting's redundancy; a mirror if the organization requires one                                            | the repository; release tags are immutable (`.github/rulesets/tags.json`)                                                                             |
| Secrets (`JWT_ACCESS_SECRET`, database and Redis credentials, DSNs, OTLP headers) | the platform's secret store; on the VPS target, the `*.env` files of the server                 | the store's versioning; on the VPS target, only the server's backups                                           | re-create; a new `JWT_ACCESS_SECRET` signs nobody out (docs/security.md#secret-rotation); on the VPS target, docs/deploy-vps.md#recover-a-lost-server |
| Environment configuration (non-secret variables)                                  | the platform, or infrastructure code; on the VPS target, the same files                         | with that code                                                                                                 | re-apply (docs/environment.md lists every variable)                                                                                                   |
| Logs, error reports, traces, metrics                                              | the observability backends                                                                      | no (retention per data policy)                                                                                 | not restored; export what an investigation needs before it expires                                                                                    |
| Uploaded files (none in the template)                                             | object storage, when a project adds it                                                          | with the same RPO as the database                                                                              | restored to the same point as the database, so rows and files agree                                                                                   |

Losing Redis loses no data, with one consequence: idempotency claims and locks are gone, so a
duplicate delivery inside the claim's TTL can run again. Work that must happen exactly once keeps
its key in the database (docs/architecture.md#locks-and-idempotency).

## Backup strategy

**REQUIERE CONFIGURACIÓN**: what follows is the policy to configure on the chosen platform.

| Concern                  | Production                                                                                                                                                               | Staging             | Development      | VPS target, its own database (shipped)                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| Type                     | Continuous archiving of the write-ahead log (PITR) **and** periodic full backups                                                                                         | daily full backup   | none (seed data) | nightly `pg_dump` (logical, custom format); no PITR                                       |
| Frequency                | WAL shipped continuously (seconds to minutes behind); a full backup daily                                                                                                | daily               |                  | daily at `BACKUP_AT` (03:00 UTC), and at start when the newest is over a day old          |
| Retention                | PITR window long enough to notice corruption late (starting point: 7 to 14 days); daily backups 30 days; monthly ones as long as the data policy requires, and no longer | 7 days              |                  | `BACKUP_KEEP_DAYS` (7) on the server                                                      |
| Encryption               | at rest (the provider's keys or a key service) and in transit; keys stored apart from the backups                                                                        | same                |                  | the server's disk; the copy off the server: REQUIERE CONFIGURACIÓN                        |
| Protection from deletion | backups in another account or project, write-once (object lock) where available; deletion protection on the database; deleting the database must not delete its backups  | deletion protection |                  | none on the server: the copy off the server, write-once (REQUIERE CONFIGURACIÓN)          |
| Location                 | a copy in another region (or provider) for a regional disaster                                                                                                           | same region         |                  | the server (`app_db_backups`); elsewhere: REQUIERE CONFIGURACIÓN                          |
| Monitoring               | alert when PITR lags beyond the RPO or a backup fails ([alerting.md](alerting.md#critical-page-the-on-call-person))                                                      | alert on failure    |                  | the backup's health check: unhealthy past 26 hours; alerting on it REQUIERE CONFIGURACIÓN |

**Full, incremental and PITR.** A full backup is a complete copy at one moment: physical (the
data files: fast to restore, same PostgreSQL major version) or logical (`pg_dump`: portable,
slower for large databases, good for rehearsals and long-term archives). PITR replays the archived
WAL on top of a full backup up to any second inside the window: it is what turns a daily backup
into minutes of possible loss. Managed PostgreSQL services provide both; a self-hosted server needs
a backup tool that does base backups and WAL archiving (pgBackRest, WAL-G or Barman, for example).
The VPS target's own database ships the logical half only, a `pg_dump` a night: up to a day of data
lost. For minutes, add one of those tools, or move to a managed PostgreSQL.

**Credentials and least privilege.** Separate identities, none of them a superuser:

| Identity     | Can                                                               | Used by                               |
| ------------ | ----------------------------------------------------------------- | ------------------------------------- |
| migrator     | owns the schema: creates and alters tables                        | the `api-migrate` job only            |
| runtime      | reads and writes the application's tables, nothing else           | the API (`DATABASE_URL` of the API)   |
| backup       | reads everything (logical backups), or the provider's backup role | the backup job                        |
| backup store | writes new backups, cannot delete them                            | the backup job; never the application |
| restore      | creates databases and restores into them; break-glass, audited    | the person running a restore          |

The runtime role, created once by the migrator (PostgreSQL):

```sql
CREATE ROLE app_runtime LOGIN PASSWORD '<from the secret store>' CONNECTION LIMIT 50;
GRANT CONNECT ON DATABASE app TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
-- Tables and sequences the migrator creates later get the same rights.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
```

Never on the migration history (`_prisma_migrations`): a migration takes the runtime role's rights
back from it at the first deployment, and a restore does the same (below).

`CONNECTION LIMIT` caps what all API instances together may open (instances × `DB_POOL_MAX`,
docs/database.md#connections). The application never holds backup or restore credentials.

On the VPS target's own database, `db-init.sh` creates these identities at the first start:
`app_migrator`, `app_runtime` and `app_backup` (`pg_read_all_data`, 2 connections), each with its
password in the file of the one container that uses it. The backup store is the server's volume,
which the server can also delete from: hence the copy off the server. Restore is the superuser,
`postgres`, through the database container only ([deploy-vps.md](deploy-vps.md#on-this-server)).

## RPO and RTO

- **RPO (recovery point objective):** the most data the product accepts to lose, measured in
  time: how far before the incident the restored data may end. It is set by how backups are made
  (PITR: minutes; daily backups only: up to a day).
- **RTO (recovery time objective):** the longest the product accepts to be down, from the moment
  the incident is declared to traffic served again with the smoke test passing. It is set by the
  database size, the restore method and how practiced the procedure is.

| Environment | RPO target                                                    | RTO target                                                     |
| ----------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Production  | **REQUIERE CONFIGURACIÓN** (with PITR, minutes are reachable) | **REQUIERE CONFIGURACIÓN** (measured in drills, never guessed) |
| Staging     | **REQUIERE CONFIGURACIÓN** (a day is usual)                   | **REQUIERE CONFIGURACIÓN**                                     |

The product owner sets them from the cost of lost data and of downtime; engineering says what the
backup setup can reach. Write the agreed numbers in this table.

**Verifying them:**

- **RPO, continuously:** the provider's latest restorable time (or the last archived WAL segment)
  must stay within the RPO of now: that is the "Backups behind the RPO" alert.
- **RPO, in every drill:** compare the newest row in the restored copy (for example
  `SELECT max(created_at) FROM sessions`) with the recovery point asked for.
- **RTO, in every drill:** time each step of the [Restore procedure](#restore-procedure) and add
  them up; the sum plus the time to detect must fit in the RTO. Measure again when the database
  grows a lot or the setup changes: restore time grows with size.

## Restore procedure

Run it from the incident record (docs/incident-response.md), writing down the time of each step.

1. **Detect the incident.** A database that is gone or damaged (readiness `Database unreachable`
   that the provider cannot fix), data corruption or loss
   (docs/incident-response.md#14-data-corruption-or-suspected-data-loss), a failed migration that
   destroyed data. Declare a SEV1, name an incident commander, freeze deployments and scheduled
   jobs.
2. **Choose the recovery point.** The whole database lost: the latest restorable time. Bad writes
   (a bug, a migration, a manual query): the moment just before the first one, found in the logs
   (the release, the route, the request ids) and in `created_at`/`updated_at` of the damaged rows.
   Decide with the product owner between a full restore to that point (everything written since is
   lost) and a targeted repair (restore a copy, copy back only the damaged rows). Write the decision
   down.
3. **Restore into a new database**, never over the damaged one: it is the evidence, and it holds
   whatever was written after the recovery point. Managed service: point-in-time restore to a new
   instance (REQUIERE CONFIGURACIÓN: the provider's procedure); it brings the roles and their rights
   back with the data. The VPS target's own database:
   [The server's own database](#the-servers-own-database). Logical backup: a new database owned by
   the migrator (`CREATE DATABASE <new database> OWNER app_migrator`, as the administrator), then,
   as the migrator, `pg_restore --no-owner --exit-on-error -d <new database> <dump>`, then the
   runtime role's rights again, connected as the migrator to the new database: the four `GRANT` and
   `ALTER DEFAULT PRIVILEGES` statements of [deploy-vps.md](deploy-vps.md#5-the-database) with the
   new database's name. Without them the API connects and its readiness answers ok (it reads no
   table) while every request that does fails with `permission denied for table ...`: checked with a
   restore made with `--no-privileges`, or from a dump taken with it. See the
   [rehearsal](#rehearsal-on-a-development-machine).
4. **Validate integrity.**
   - The restore itself finished without errors (`--exit-on-error`, or the provider's status).
   - No migration is pending: run `migrate status` with the `api-migrate` image of the release
     that will run,
     `docker run --rm -e DATABASE_URL=<restored database URL> <api-migrate image>@<digest> node node_modules/prisma/build/index.js migrate status`.
     `Database schema is up to date!` (exit 0) is the expected answer. If it lists migrations
     not applied, the recovery point predates them: apply them (`migrate deploy`, the same image's
     default command; they are backward compatible) or run the release that matches the schema.
   - The schema is the release's. `migrate status` compares migration names only: it answers "up
     to date" for a database with a column, table or index the release does not describe
     (checked). Compare the schema itself with the same image:
     `docker run --rm -e DATABASE_URL=<restored database URL> <api-migrate image>@<digest> node node_modules/prisma/build/index.js migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`.
     `No difference detected.` (exit 0) is the expected answer; exit 2 lists each difference (a
     table, column or index too many or missing). What Prisma's schema cannot describe stays
     invisible to it: a `CHECK` constraint or a partial index that a migration adds in raw SQL is
     not compared (checked with Prisma 7.10), so look at those with `\d <table>` in `psql`.
   - Row counts and the newest rows of the critical tables are what the recovery point implies
     ([Verify critical data](#restore-testing)). Optionally, `pg_amcheck` verifies indexes and
     tables where the `amcheck` extension is available.
5. **Start the application against it.**
   - Point `DATABASE_URL` (secret store) at the restored database and deploy the same image
     digests that ran before (no rebuild).
   - **Empty Redis of this application's keys** (everything under `REDIS_KEY_PREFIX`, all of it
     disposable): cache entries may hold data newer than the recovery point, and idempotency claims
     may cover work the restore undid. Use an operator account; the application's own ACL user
     cannot list keys (on the VPS target, remove Redis's volume instead:
     [The server's own database](#the-servers-own-database)). In-process caches empty themselves
     when the instances restart.
   - **End every session when the recovery point is in the past:** logouts, password changes and
     theft revocations made after it are undone by the restore, so old refresh tokens would work
     again.
     `BEGIN; LOCK TABLE users IN EXCLUSIVE MODE; UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL; COMMIT;`
     signs everyone out (their next refresh answers 401, without false theft alerts). The lock
     waits for the sign-ins and refreshes in flight and holds new ones until the commit, so none
     mints a token the update misses. Access tokens expire within 15 minutes, or at once if
     `JWT_ACCESS_SECRET` is rotated too.
6. **Health and readiness:** `GET /api/health/ready` on every instance answers 200 with
   `database: "ok"`.
7. **Smoke test:** `pnpm smoke --url <public URL> --api <API URL> --release <sha>`.
8. **Verify critical data:** the project's checklist (REQUIERE CONFIGURACIÓN: which tables,
   which records, which owners confirm). Sign in with a test account and walk through a critical
   flow.
9. **Resume traffic:** re-enable scheduled jobs and deployments, watch the 5xx rate and latency
   for an hour, tell users what happened and what, if anything, was lost (the window between the
   recovery point and the incident).
10. **Document:** the timeline, the recovery point and why, the data lost (actual RPO), the time to
    recover (actual RTO), every manual change, and a postmortem
    (docs/incident-response.md#after-the-incident). If the data policy requires it, re-apply
    deletions requested after the recovery point (a restore brings deleted personal data back).

### The server's own database

The procedure on the VPS target's own database (the `db` profile,
[deploy-vps.md](deploy-vps.md#backups)), as the deploy user in `/srv/app` on the server. The
administrator is the superuser `postgres`, through the database container (its own socket, no
password). The database the restore replaces stays, renamed `app_replaced`, until the restore is
confirmed. Each step names the step above it carries out. First, a shorthand for this shell:

```
dc() { docker compose --env-file server.env --env-file release.env "$@"; }
```

1. **The backup** (step 2): the newest one before the damage, from the backup volume, or a copy
   brought back to the server (`scp app-latest.dump deploy@app.example.com:/srv/app/`).

   ```
   dc exec backup ls -lt /var/lib/postgresql/backups
   ```

2. **Restore it into a new database** owned by the migrator (step 3), as the migrator, so it owns
   every table:

   ```
   dc exec -T db createdb -U postgres -O app_migrator app_restore
   dc exec -T backup cat /var/lib/postgresql/backups/app-20261019T030000Z.dump |
     dc exec -T db pg_restore -U postgres --role=app_migrator --no-owner --no-privileges --exit-on-error -d app_restore
   ```

   From a copy on the server's disk, the second command is:

   ```
   dc exec -T db pg_restore -U postgres --role=app_migrator --no-owner --no-privileges --exit-on-error -d app_restore < app-latest.dump
   ```

3. **The other roles' rights** in it, as `db-init.sh` gives them:

   ```
   dc exec -T db psql -U postgres -d app_restore -v ON_ERROR_STOP=1 <<'SQL'
   GRANT CONNECT ON DATABASE app_restore TO app_runtime, app_backup;
   SET ROLE app_migrator;
   GRANT USAGE ON SCHEMA public TO app_runtime;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
   -- The migration history stays the migrator's alone.
   REVOKE ALL ON TABLE _prisma_migrations FROM app_runtime;
   SQL
   ```

4. **Counts and newest rows** (step 4):

   ```
   dc exec -T db psql -U postgres -d app_restore -c 'SELECT count(*) FROM users' -c 'SELECT max(created_at) FROM sessions'
   ```

5. **Swap it in**, with the API and the backup stopped (the API answers nothing meanwhile):

   ```
   dc stop api backup
   dc exec -T db psql -U postgres -v ON_ERROR_STOP=1 -c 'ALTER DATABASE app RENAME TO app_replaced' -c 'ALTER DATABASE app_restore RENAME TO app'
   ```

6. **The schema** against the release (step 4), with the release's migration image:
   `Database schema is up to date!`, then `No difference detected.`

   ```
   dc --profile migrate run --rm migrate node node_modules/prisma/build/index.js migrate status
   dc --profile migrate run --rm migrate node node_modules/prisma/build/index.js migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
   ```

7. **Redis emptied** (step 5): it holds this application's keys only, so its volume goes:

   ```
   dc rm --stop --force redis
   docker volume rm app_redis_data
   ```

8. **Every session ended**, when the recovery point is in the past (step 5):

   ```
   dc exec -T db psql -U postgres -d app -v ON_ERROR_STOP=1 -c 'BEGIN; LOCK TABLE users IN EXCLUSIVE MODE; UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL; COMMIT;'
   ```

9. **Start again**: the API (Redis with it) and the web image, then the backup; then steps 6 to 10
   above.

   ```
   dc up --detach --wait api web
   dc up --detach backup
   ```

Once the restore is confirmed: `dc exec -T db dropdb -U postgres app_replaced`. Rehearsed on the
reference server: data damaged after a backup and restored this way, from the backup volume and from
a copy on disk; the restored tables owned by `app_migrator`, sign-in working as `app_runtime`, the
next backup taken as `app_backup`.

## Restore testing

**A backup is not valid because it exists.** It counts once it has been restored and checked, by
the people who would do it in an incident, with the procedure above. Test:

- at least once a quarter, from a real production backup, into an isolated environment with
  production-level access control (it holds production data), destroyed afterwards;
- after any change of the backup setup, a PostgreSQL major upgrade, a provider move, or a large
  growth of the data;
- the point-in-time restore too, not only full backups: pick a timestamp and check the newest row.

### Checklist

Copy it into the drill record:

```
Restore drill — date, environment, people
[ ] Backup chosen: type (full / PITR), source, timestamp asked for
[ ] Restore started (time) into a new, isolated database
[ ] Restore finished (time) without errors
[ ] Logical restore: the runtime role's rights given again (step 3)
[ ] migrate status with the release's api-migrate image: "Database schema is up to date!"
[ ] migrate diff with the same image: "No difference detected."; raw-SQL objects checked by hand
[ ] Row counts of the critical tables match the expectation for that point
[ ] Newest row (e.g. max(created_at)) within the RPO of the point asked for
[ ] Application started against it; readiness 200 with database "ok"
[ ] pnpm smoke passed (--api included)
[ ] A test account signed in; a critical flow worked
[ ] Total time measured, compared with the RTO
[ ] Restored copy destroyed; access to it revoked
[ ] Findings: what was slow, unclear or wrong in this page (fix it now)
```

### Rehearsal on a development machine

The same steps against the local database (`pnpm db:up`), with PostgreSQL's own tools inside its
container (on Windows with Git Bash, prefix the commands with `MSYS_NO_PATHCONV=1`):

```
# 1. Backup (custom format: compressed, restorable table by table)
docker compose exec -T db pg_dump -U app -d app --format=custom --no-owner --no-privileges --file=/tmp/app.dump

# 2. Restore into a new database
docker compose exec -T db createdb -U app app_restore_check
docker compose exec -T db pg_restore -U app -d app_restore_check --no-owner --no-privileges --exit-on-error /tmp/app.dump

# 3. Integrity: no pending migration, the schema itself ("No difference detected."), then counts
DATABASE_URL=postgresql://app:app@localhost:5442/app_restore_check pnpm --filter api exec prisma migrate status
DATABASE_URL=postgresql://app:app@localhost:5442/app_restore_check pnpm --filter api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
docker compose exec -T db psql -U app -d app_restore_check -c "SELECT count(*) FROM users" -c "SELECT max(created_at) FROM sessions"

# 4. The API on the restored copy (after pnpm build; a variable set on the command line wins
#    over apps/api/.env), then the API side of the smoke test from another terminal
DATABASE_URL=postgresql://app:app@localhost:5442/app_restore_check pnpm --filter api start
pnpm smoke --api http://127.0.0.1:3000

# 5. Clean up
docker compose exec -T db dropdb -U app app_restore_check
docker compose exec -T db rm /tmp/app.dump
```

Use the port of `DB_PORT` if it is not 5442.
