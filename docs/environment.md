# Environment variables and secrets

## Rules

- Each app validates its configuration once, at boot (`apps/api/src/env/env.schema.ts`). A missing
  or malformed value stops the process and names the variable; values are never printed.
- Code imports `env` from `apps/api/src/env/env.ts`; reading `process.env` elsewhere is a lint
  error. A new variable goes into the schema, the `.env.example` next to it, its unit spec and the
  table below, in the same pull request.
- `.env` files hold local development values only and are never committed (`.gitignore`, the
  pre-commit hook and the secret scans enforce it). Only `.env.example` files are committed.
- Variables already set in the environment win over `.env` (containers and CI set them directly).

## Files

| File                    | Read by                                                  | Committed |
| ----------------------- | -------------------------------------------------------- | --------- |
| `apps/api/.env`         | the API and the Prisma CLI, development                  | no        |
| `apps/api/.env.example` | documentation of every API variable                      | yes       |
| `.env` (root)           | `docker compose` (ports, stack secret, `REDIS_PASSWORD`) | no        |
| `.env.example` (root)   | documentation of the compose variables                   | yes       |
| `apps/web/.env.example` | the web app's optional settings                          | yes       |

## API variables

| Variable                                         | Required   | Default                                    | Purpose                                                                                                                                                                                                                  |
| ------------------------------------------------ | ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                       | yes        |                                            | `development`, `test` or `production`. No default: an unset value stops the boot instead of running production with development settings. Production: Secure cookies, JSON logs, no Swagger UI.                          |
| `HOST`                                           | no         | `127.0.0.1`; every interface in production | Interface to listen on. Loopback outside production: a development API with public seed accounts never reaches the network. Unset in production: every interface, IPv4 and IPv6.                                         |
| `PORT`                                           | no         | `3000`                                     | HTTP port.                                                                                                                                                                                                               |
| `DATABASE_URL`                                   | yes        |                                            | PostgreSQL connection string. Tests derive `<db>_test` and `<db>_e2e` from it.                                                                                                                                           |
| `JWT_ACCESS_SECRET`                              | yes        |                                            | Signs access tokens: 64+ characters (`openssl rand -hex 32`), one per environment. Shorter values stop the boot: a human-chosen secret can be brute-forced offline from any token.                                       |
| `JWT_ACCESS_SECRET_PREVIOUS`                     | no         |                                            | During a planned rotation only: the other secret still accepted when verifying (never used to sign). Must differ from `JWT_ACCESS_SECRET` ([security.md](security.md#secret-rotation)).                                  |
| `CORS_ORIGINS`                                   | no         | empty                                      | Comma-separated origins allowed cross-origin with credentials. Empty: same-origin only.                                                                                                                                  |
| `TRUST_PROXY`                                    | production | `loopback` outside production              | Proxy hops allowed to set `X-Forwarded-For`: a hop count (`1` behind the web image) or addresses/subnets. Required in production, where a wrong value lets clients pick their own IP ([security.md](security.md#https)). |
| `AUTH_COOKIE_SAMESITE`                           | no         | `strict`                                   | Refresh cookie SameSite: `strict`, `lax`, or `none` (production only).                                                                                                                                                   |
| `RATE_LIMIT_MAX`                                 | no         | `100`                                      | Requests per window, per client IP and route.                                                                                                                                                                            |
| `RATE_LIMIT_WINDOW_SEC`                          | no         | `60`                                       | Rate limit window.                                                                                                                                                                                                       |
| `LOG_LEVEL`                                      | no         | `log`                                      | `fatal`, `error`, `warn`, `log`, `debug`, `verbose`.                                                                                                                                                                     |
| `LOG_FORMAT`                                     | no         | `json` in production, else `text`          | Log line format.                                                                                                                                                                                                         |
| `APP_ENVIRONMENT`                                | no         | `NODE_ENV`                                 | Deployment name on every log line, error report and span: `staging`, `production`... (both run `NODE_ENV=production`).                                                                                                   |
| `APP_RELEASE`                                    | no         | set by the image build; else `unversioned` | The build (commit SHA) on every log line, error report and span.                                                                                                                                                         |
| `DB_SLOW_QUERY_MS`                               | no         | `500`                                      | Queries slower than this are logged (statement only, never values); `0` turns the log off.                                                                                                                               |
| `DB_POOL_MAX`                                    | no         | `10`                                       | Database connections one API instance may hold (1 to 100). Instances × this must fit in the database's connection limit ([database.md](database.md#connections)).                                                        |
| `DB_STATEMENT_TIMEOUT_MS`                        | no         | `30000`                                    | The database cancels a statement that runs longer (1000 to 600000); the driver gives up 5 s later ([database.md](database.md#connections)).                                                                              |
| `SENTRY_DSN`                                     | no         | unset: error tracking off                  | OPTIONAL. The API's Sentry DSN; checked at boot (shape; https in production).                                                                                                                                            |
| `SENTRY_SAMPLE_RATE`                             | no         | `1`                                        | Share of error events sent, 0 to 1.                                                                                                                                                                                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                    | no         | unset: telemetry off, SDK not loaded       | OPTIONAL. OTLP/HTTP base URL of a collector or provider; traces and metrics go to `/v1/traces` and `/v1/metrics` below it.                                                                                               |
| `OTEL_EXPORTER_OTLP_HEADERS`                     | no         |                                            | Provider credentials (`key=value,...`), read by the exporters only. A secret: secret store, never logged.                                                                                                                |
| `OTEL_SDK_DISABLED`                              | no         | `false`                                    | `true` turns telemetry off whatever the endpoint (incident kill switch).                                                                                                                                                 |
| `OTEL_SERVICE_NAME`                              | no         | `api`                                      | Service name in telemetry and logs.                                                                                                                                                                                      |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | no         | every trace                                | Standard sampler settings, validated at boot; production: `parentbased_traceidratio` with a ratio (docs/observability.md#opentelemetry).                                                                                 |
| `OTEL_METRIC_EXPORT_INTERVAL`                    | no         | `60000`                                    | Metric push interval, ms.                                                                                                                                                                                                |
| `REDIS_URL`                                      | no         | unset: Redis off                           | OPTIONAL. `redis://` or `rediss://` (TLS), with the password; a secret. Warns at boot in production when unencrypted or without a password.                                                                              |
| `REDIS_KEY_PREFIX`                               | no         | `app:`                                     | Prefix of every key; one per application and environment sharing a Redis.                                                                                                                                                |
| `REDIS_REQUIRED`                                 | no         | `false`                                    | `true`: readiness fails while Redis is down. Requires `REDIS_URL`.                                                                                                                                                       |
| `REDIS_COMMAND_TIMEOUT_MS`                       | no         | `500`                                      | Longest wait for one Redis command.                                                                                                                                                                                      |
| `RATE_LIMIT_STORE`                               | no         | `memory`                                   | `memory` (one instance) or `redis` (shared; requires `REDIS_URL`).                                                                                                                                                       |
| `CACHE_STORE`                                    | no         | `memory`                                   | `memory` or `redis` (shared; requires `REDIS_URL`).                                                                                                                                                                      |

A configuration error stops the boot and names the variable: a missing required value, a malformed
one, or an optional feature asked for without what it needs (`RATE_LIMIT_STORE=redis` without
`REDIS_URL`). An optional integration that is simply not configured never stops anything.

## Web variables

The web app calls `/api` on its own origin and reads deployment settings at runtime from
`/app-config.json`, which the web server writes from its environment at start (one image for every
environment). All optional. The ones written into `/app-config.json` and the CSP are checked by
`apps/web/nginx/18-validate-runtime-config.sh` before nginx starts (a bad value stops the
container and names the variable); a malformed `API_UPSTREAM` fails nginx's own configuration test.

| Variable                 | Default                   | Purpose                                                                                                                                    |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `API_UPSTREAM`           | `http://api:3000`         | Where the web server forwards `/api`.                                                                                                      |
| `APP_ENVIRONMENT`        | `production`              | Deployment name on browser error reports.                                                                                                  |
| `APP_RELEASE`            | set by the image build    | The build on browser error reports.                                                                                                        |
| `WEB_SENTRY_DSN`         | empty: error tracking off | OPTIONAL. Sentry DSN of the browser project (public by design); https only. Also widens the CSP's `connect-src` by Sentry's ingest origin. |
| `WEB_SENTRY_SAMPLE_RATE` | `1`                       | Share of browser error events sent, 0 to 1.                                                                                                |

In development the Vite dev and preview servers serve `/app-config.json` from their own
environment (same names). `API_PROXY_TARGET` (development only) moves the dev and preview proxy.
Anything named `VITE_*` is compiled into the public bundle: never a secret.

## Per environment

| Setting                        | development                  | test / CI                                                     | staging                      | production                     |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| `NODE_ENV`                     | `development`                | `test`                                                        | `production`                 | `production`                   |
| `APP_ENVIRONMENT`              | default                      | default                                                       | `staging`                    | `production`                   |
| `APP_RELEASE`                  | `unversioned`                | `unversioned`                                                 | from the image               | from the image                 |
| Logs                           | text                         | text, `warn` (integration)                                    | JSON                         | JSON                           |
| `SENTRY_DSN`, `WEB_SENTRY_DSN` | unset (or a dev project)     | unset                                                         | the projects' DSNs           | the same DSNs                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | unset, or the local backend  | unset                                                         | collector or provider        | collector or provider, sampled |
| `REDIS_URL`                    | unset, or the compose Redis  | the throwaway Redis of the integration job (`REDIS_TEST_URL`) | private Redis, `rediss://`   | private Redis, `rediss://`     |
| `RATE_LIMIT_STORE`             | `memory`                     | `memory` (Redis specs override)                               | `redis` if several instances | `redis` if several instances   |
| Secrets                        | `apps/api/.env`, root `.env` | generated per run                                             | platform secret store        | platform secret store          |

Every default is the safe one: optional integrations off, nothing exposed beyond loopback outside
production, no credential in a committed file.

## Local, staging and production

- **Local:** `cp apps/api/.env.example apps/api/.env`, fill `JWT_ACCESS_SECRET`; the database comes
  from `docker-compose.yml` (`pnpm db:up`). If port 5432 is taken, set `DB_PORT` in a root `.env`
  and the same port in `DATABASE_URL`.
- **Staging and production** are separate GitHub environments (`staging`, `production`) and separate
  infrastructure: separate databases, separate secrets, never shared. Production should require a
  reviewer in the environment's protection rules. Staging mirrors production settings
  (`NODE_ENV=production`) with its own data, never a copy of production personal data.

## Secrets

- Production and staging values live in the platform's secret manager or in the GitHub
  environment secrets used by `.github/workflows/deploy.yml`; REQUIERE CONFIGURACIÓN per provider.
- Least privilege: the API gets only what it reads; the migration job gets only `DATABASE_URL`.
- Rotation: generate, deploy, verify, then revoke the old value. `JWT_ACCESS_SECRET` has its own
  procedure, with or without a grace period ([security.md](security.md#secret-rotation)); it never
  signs anyone out, since refresh sessions do not depend on it.
- A secret that reached git, a log or a ticket is compromised: rotate it.
