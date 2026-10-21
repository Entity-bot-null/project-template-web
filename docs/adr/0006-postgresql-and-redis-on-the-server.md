# 0006. Run PostgreSQL and Redis on the reference server, and Redis in development

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** template maintainers

## Context

The reference deployment target (`deploy/vps`) ran the application on one server and expected a
managed PostgreSQL, and nothing used Redis unless a project turned it on (the development profile
`redis`, off by default). The API already has Redis-backed adapters with in-process fallbacks:
shared rate limits, cache, locks and idempotency
([ADR 0002](0002-observability-and-optional-infrastructure.md)). Three problems followed. A project
starting on one server needed a second paid service, the managed database, before its first
deployment. The Redis paths ran only in CI, so development and the reference deployment exercised
the in-process fallbacks, not what production with several instances runs. And a project moving to
several instances would turn Redis on for the first time in production.

The constraints: least privilege for every component, nothing published beyond the server, images
pinned by digest and updated by Dependabot, the same images in development, CI and on the server,
backups that are restored and checked, not only taken, and a managed database still possible
(Terraform builds one on DigitalOcean).

## Options

1. **Keep the managed database required and Redis optional:** the least to run on the server; but a
   second paid service from the first day, and the Redis paths untested outside CI.
2. **PostgreSQL and Redis on the server as compose services, the managed database still possible:**
   one server is enough to start, with pinned images, roles and an ACL the template creates, and a
   nightly logical backup on the server; but the data lives on the server, the copy off it is the
   project's to set up, and a nightly dump means up to a day of data lost.
3. **PostgreSQL on the server with base backups and WAL archiving** (pgBackRest, WAL-G): minutes of
   data lost at most; but another moving part, an object store with its credentials and monitoring,
   that the template would have to ship and test for every project.
4. **Redis in production only:** the same paths in production and in CI; but development never runs
   them, and a developer meets a Redis problem first on a server.

## Decision

Option 2, with Redis on wherever the template runs the infrastructure:

- **Development:** `pnpm services:up` starts Redis with the database and Mailpit, on loopback port
  6389 (not Redis's 6379, which a local Redis may hold) with the password `app`;
  `apps/api/.env.example` points the API at it, with the shared stores and `REDIS_REQUIRED=true`.
  The end-to-end server keeps the in-process stores, as in CI's end-to-end job.
- **The server:** Redis always, with an ACL user limited to the API's key prefix and the commands
  its adapters run, the default user off. PostgreSQL 18 behind the `db` profile, on by default in
  `server.env.example`: the database and three roles (`app_migrator`, `app_runtime`, `app_backup`)
  created by `db-init.sh` at the first start, and a nightly `pg_dump` kept 7 days, with a health
  check. All of it on an internal network, every container hardened. Without the profile, the
  managed database: the path Terraform builds.
- **Deployments:** `deploy.sh` starts the data services before the migration, and stops a
  deployment, the running release unchanged, when they do not become healthy. `pnpm iac:check` runs
  `db-init.sh` on PostgreSQL in CI.

## Consequences

- Easier: one server is a complete deployment; development, CI and the server run the same Redis
  paths; the restore on the server is written down and rehearsed
  ([disaster-recovery.md](../disaster-recovery.md#the-servers-own-database)).
- Harder: the server holds the data, so losing it loses up to a day, and everything if the copy off
  the server was not set up (REQUIERE CONFIGURACIÓN, [deploy-vps.md](../deploy-vps.md#backups)). A
  PostgreSQL major on the server is a dump and restore
  ([ci-cd.md](../ci-cd.md#postgresql-and-redis)). The database's passwords live in files on the
  server, and a change there must be made in PostgreSQL too.
- Done with it: the compose files, `db-init.sh`, `backup.sh`, `deploy.sh` and its tests, the CI
  check, and the guides (deploy-vps.md, disaster-recovery.md, environment.md, security.md, both
  manuals and both step-by-step guides).
- Wrong if: projects need minutes of recovery point from the first day (then option 3, or the
  managed database by default), the server cannot hold the database next to the API, or a second
  server comes early (then a managed PostgreSQL and a Redis over TLS, which the managed path and
  `rediss://` already support).
