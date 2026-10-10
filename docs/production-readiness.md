# Production readiness

The checklist before the first production release, and again before any release that changes the
infrastructure. Copy it into the release issue and tick each line with a link to the evidence (a CI
run, a drill record, a dashboard).

Each line says what kind of item it is:

- **CORE**: in the template and on by default; the check is that it still holds.
- **OPTIONAL**: in the template, off until a project needs it; decide, then tick or strike out.
- **REQUIRES CONFIGURATION** (written REQUIERE CONFIGURACIÓN in some pages): prepared or
  documented, but it only exists once the project configures it on its platform. Never tick one of
  these because the template documents it.

## Code

| Done | Item              | Class | Verified by                                                                  |
| ---- | ----------------- | ----- | ---------------------------------------------------------------------------- |
| [ ]  | Format            | CORE  | `pnpm format:check` (`pnpm verify`, CI)                                      |
| [ ]  | Lint              | CORE  | `pnpm lint`, zero warnings                                                   |
| [ ]  | Typecheck         | CORE  | `pnpm typecheck`, contract types included                                    |
| [ ]  | Unit tests        | CORE  | `pnpm test`                                                                  |
| [ ]  | Integration tests | CORE  | `pnpm test:integration` (CI: PostgreSQL and Redis services)                  |
| [ ]  | Component tests   | CORE  | `pnpm test` (web: Vitest and Testing Library)                                |
| [ ]  | E2E               | CORE  | `pnpm test:e2e` (CI)                                                         |
| [ ]  | Coverage          | CORE  | `pnpm test:coverage`; thresholds only ever raised (docs/testing.md#coverage) |
| [ ]  | Build             | CORE  | `pnpm build`, performance budget (`pnpm perf:check`)                         |

All of them run in **CI passed**, a required check on `main` (docs/ci-cd.md); the release commit
must have it green.

## Security

| Done | Item                      | Class                                                 | Verified by                                                                                                 |
| ---- | ------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [ ]  | Dependency audit          | CORE                                                  | `pnpm security` (high and critical fail), Dependabot alerts on (REQUIRES CONFIGURATION: repository setting) |
| [ ]  | Dependency policy         | CORE                                                  | `pnpm deps:check`: sources, licenses, release delay and trust policy kept                                   |
| [ ]  | Secret scanning           | CORE                                                  | secretlint (pre-commit, `pnpm verify`, CI), gitleaks over the history (CI)                                  |
| [ ]  | Semgrep                   | CORE                                                  | CI job "Static analysis (Semgrep)", `pnpm sast`                                                             |
| [ ]  | CodeQL                    | OPTIONAL                                              | `ENABLE_CODEQL=true` where the GitHub plan allows (public repository or Advanced Security)                  |
| [ ]  | Trivy                     | CORE                                                  | CI images job: no fixable HIGH or CRITICAL advisory in `api`, `api-migrate`, `web`                          |
| [ ]  | DAST                      | CORE (local stack) / REQUIRES CONFIGURATION (staging) | `dast.yml` weekly on the production images; `DAST_STAGING_URL` for the passive scan of staging              |
| [ ]  | Security headers and CSP  | CORE                                                  | helmet (API), nginx (web); `pnpm smoke` checks they are served; ZAP baseline                                |
| [ ]  | CSRF                      | CORE                                                  | Fetch Metadata guard on every route; integration specs                                                      |
| [ ]  | RBAC and ownership        | CORE                                                  | `@Auth(...)` on every non-public route, ownership in services; one spec per role and per foreign record     |
| [ ]  | Env and secret validation | CORE                                                  | the env schema stops the boot on a bad value; `TRUST_PROXY` set for the real topology                       |
| [ ]  | Secrets per environment   | REQUIRES CONFIGURATION                                | in the platform's secret store or GitHub environments; who can read them; rotation (docs/security.md)       |
| [ ]  | Repository protection     | REQUIRES CONFIGURATION                                | rulesets imported, `CODEOWNERS` filled in, environments deploy from `main` only (docs/ci-cd.md)             |

## Infrastructure

| Done | Item              | Class                                                         | Verified by                                                                                                                         |
| ---- | ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [ ]  | Database backups  | REQUIRES CONFIGURATION                                        | full backups and PITR configured, encrypted, protected from deletion ([disaster-recovery.md](disaster-recovery.md#backup-strategy)) |
| [ ]  | Restore test      | REQUIRES CONFIGURATION                                        | a drill record from the last quarter ([checklist](disaster-recovery.md#checklist))                                                  |
| [ ]  | Database access   | REQUIRES CONFIGURATION                                        | separate migrator and runtime roles, connection limit, TLS (`sslmode`) outside a private network                                    |
| [ ]  | Connection budget | REQUIRES CONFIGURATION                                        | instances × `DB_POOL_MAX` within the database's limit (docs/database.md#connections)                                                |
| [ ]  | Redis             | OPTIONAL (REQUIRES CONFIGURATION with more than one instance) | `RATE_LIMIT_STORE=redis` on a private Redis with TLS and an ACL user (docs/security.md#redis)                                       |
| [ ]  | Health endpoint   | CORE                                                          | `GET /api/health/live` (container `HEALTHCHECK`), `GET /healthz` (web)                                                              |
| [ ]  | Readiness         | CORE / REQUIRES CONFIGURATION (wiring)                        | `GET /api/health/ready` used by the orchestrator, on the API's private address                                                      |
| [ ]  | Graceful shutdown | CORE / REQUIRES CONFIGURATION (grace period)                  | termination grace period above 15 seconds on the platform                                                                           |
| [ ]  | Resource limits   | REQUIRES CONFIGURATION                                        | CPU and memory limits per container, sized from a load test or from production metrics                                              |
| [ ]  | TLS               | REQUIRES CONFIGURATION                                        | TLS and HSTS at the edge, certificate renewal monitored; `rediss://` for Redis                                                      |
| [ ]  | Edge protection   | REQUIRES CONFIGURATION                                        | CDN or WAF, DDoS protection                                                                                                         |

## Observability

| Done | Item            | Class                                       | Verified by                                                                                                                                                               |
| ---- | --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ]  | Structured logs | CORE / REQUIRES CONFIGURATION (collection)  | JSON lines on stdout; the platform collects them, with retention and access set                                                                                           |
| [ ]  | Request ID      | CORE                                        | `X-Request-Id` on every response, on every log line and error report                                                                                                      |
| [ ]  | Trace ID        | OPTIONAL                                    | `traceId`/`spanId` on log lines once OpenTelemetry is on                                                                                                                  |
| [ ]  | Metrics         | OPTIONAL / REQUIRES CONFIGURATION (backend) | `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector or provider; metrics visible (docs/observability.md)                                                                         |
| [ ]  | Sentry          | OPTIONAL / REQUIRES CONFIGURATION           | `SENTRY_DSN`, `WEB_SENTRY_DSN`; a test event per environment                                                                                                              |
| [ ]  | Dashboards      | REQUIRES CONFIGURATION (import)             | the dashboards of `observability/grafana` imported into the production Grafana (docs/observability.md#use-them-with-your-backend)                                         |
| [ ]  | Uptime          | REQUIRES CONFIGURATION                      | external checks from several locations (docs/observability.md#uptime-monitoring)                                                                                          |
| [ ]  | Alerts          | REQUIRES CONFIGURATION (load, route)        | the rules of `observability/prometheus/rules` loaded in the backend, routed by severity and tested; the rest of the catalog of [alerting.md](alerting.md) in its services |
| [ ]  | SLOs            | REQUIRES CONFIGURATION                      | targets agreed, error budget policy agreed ([alerting.md](alerting.md#slis-and-slos))                                                                                     |

## Deployment

| Done | Item               | Class                                              | Verified by                                                                                       |
| ---- | ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [ ]  | Immutable artifact | CORE                                               | images built once per commit, tagged with the SHA, SBOM and provenance attached when pushed       |
| [ ]  | Image digest       | REQUIRES CONFIGURATION                             | the release job deploys `<image>@<digest>` and records it (docs/ci-cd.md#deployment)              |
| [ ]  | Migration strategy | CORE                                               | expand and contract (docs/database.md#expand-and-contract); `api-migrate` runs before the rollout |
| [ ]  | Smoke tests        | CORE / REQUIRES CONFIGURATION (in the release job) | `pnpm smoke --url ... --api ... --release <sha>` after every rollout                              |
| [ ]  | Rollback plan      | CORE / REQUIRES CONFIGURATION (digest record)      | previous digests recorded; rollback rehearsed once in staging (docs/ci-cd.md#rollback)            |
| [ ]  | Deploy workflow    | REQUIRES CONFIGURATION                             | the release job of `deploy.yml` implemented; staging and production environments with reviewers   |

## Operations

| Done | Item               | Class                                     | Verified by                                                                                         |
| ---- | ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [ ]  | Incident response  | CORE (runbooks)                           | [incident-response.md](incident-response.md) read by the on-call people                             |
| [ ]  | Disaster recovery  | CORE (procedure) / REQUIRES CONFIGURATION | [disaster-recovery.md](disaster-recovery.md) with this project's backups                            |
| [ ]  | RPO / RTO          | REQUIRES CONFIGURATION                    | targets written in [disaster-recovery.md](disaster-recovery.md#rpo-and-rto) and met in a drill      |
| [ ]  | Restore procedure  | CORE / REQUIRES CONFIGURATION (provider)  | the provider's restore steps added to step 3 of the procedure; rehearsed                            |
| [ ]  | Owner and contacts | REQUIRES CONFIGURATION                    | the contacts table of incident-response.md, `SECURITY.md`, `CODEOWNERS`                             |
| [ ]  | Load test          | OPTIONAL                                  | a recorded run at the expected peak when the product needs one ([load-testing.md](load-testing.md)) |

## Sign-off

```
Release / commit:
Environment:
Checked by (name, date):
Open items, accepted with a reason and an owner:
```
