# Incident response

How to run an incident with what the template already emits: health probes, structured logs with
request ids, the 5xx origin (`error.origin`), metrics and traces (OpenTelemetry, OPTIONAL), error
reports (Sentry, OPTIONAL). No incident-management platform is assumed; the alerts that start an
incident are in [alerting.md](alerting.md), restores in [disaster-recovery.md](disaster-recovery.md).

## Roles and contacts

REQUIERE CONFIGURACIÓN: fill this table in for the project and keep it current; an incident is the wrong time to look for
a phone number.

| Role                        | Who                                        | How to reach               |
| --------------------------- | ------------------------------------------ | -------------------------- |
| Service owner               | _team or person_                           | _channel_                  |
| Primary / secondary on-call | _rotation_                                 | _paging tool or phone_     |
| Incident commander (SEV1)   | _rotation or engineering lead_             | _channel_                  |
| Security contact            | the private contact of `SECURITY.md`       | _restricted channel_       |
| Database and platform owner | _team or provider_                         | _channel, provider ticket_ |
| External providers' support | _one line per provider (Sentry, cloud...)_ | _support URL, contract id_ |

**Severity:** SEV1 = outage, data loss or a security breach (CRITICAL alerts); SEV2 = a feature or
a share of users degraded (CRITICAL or persistent WARNING); SEV3 = minor, no user impact yet
(WARNING). The incident commander of a SEV1 coordinates and communicates; others fix.

## The first five minutes

1. **Acknowledge** the alert and open an incident record: time, who, the alert, the link to the
   dashboard. Every later step goes in it with its time.
2. **What changed?** The latest deployments (Deploy workflow runs; the `release` field of the log
   lines and `/app/app-config.json` say which commit is running), configuration or secret changes,
   migrations, provider maintenance.
3. **How big?** Readiness of each instance, the 5xx rate by `error.origin` and `http.route`, uptime
   checks, Sentry's users per issue.
4. **Roll back first** when the start matches a deployment: redeploy the previous image digests
   ([9. Failed deployment](#9-failed-deployment)); the root cause can wait for a stable system.
5. **Communicate:** who is on it, what users see, when the next update comes.

## Where to look

| Question                      | Look at                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Is an instance ready?         | `curl http://<api>:3000/api/health/ready` from inside the platform (the public URL answers 404 for probes)                                 |
| Is the public side up?        | `pnpm smoke --url <public URL>` (read-only; add `--api <API URL>` from inside the platform)                                                |
| What happened to one request? | The `X-Request-Id` the client got: the log lines with that `requestId`, its Sentry report (`request_id` tag), its trace (`app.request_id`) |
| Where do the 5xx come from?   | `app_server_errors_total` by `error_origin` and `http_route`; the error line `METHOD /path -> 5xx (request <id>, <origin>)`                |
| Which version is running?     | `release` on the log lines and spans (`service.version`), `release` in `/app/app-config.json` for the web image                            |
| Is the database the problem?  | Readiness `Database unreachable`, `error.origin=database`, `db_client_connection_*` pool metrics, `Slow query` warnings                    |
| Is Redis the problem?         | Readiness `checks.redis`, `Redis unavailable`, `Redis is not answering` and the matching recovery lines, `app_degraded_operations_total`   |
| The overall picture?          | Grafana → Application: "API service" (traffic, errors by origin, runtime, database, Redis, dependencies), "API SLOs" (budget, burn rates)  |
| Do pages feel slow?           | Grafana → Application → "Web Vitals": LCP, INP, CLS, FCP and TTFB at p75 per page, from real page loads                                    |
| Is a provider the problem?    | `app_dependency_duration_seconds` by `dependency_name` and `outcome`, `External:<name>` log lines, the provider's status page              |

PromQL for each metric: docs/observability.md#metrics. Log patterns: [alerting.md](alerting.md#log-patterns).

## Runbooks

Each runbook: the alerts that open it, symptoms, impact, first checks, signals, immediate actions,
mitigation, when to roll back, when it is recovered, what to validate afterwards, what to document.
The alerts are the rules of `observability/prometheus/rules`, whose `runbook_url` points at these
sections and whose `dashboard_uid` names the dashboard to open first
([observability.md](observability.md#alerts)). The general rule for rollback: if the problem
started with a deployment, roll back first and investigate after.

### 1. API down

- **Alerts:** `ApiMetricsAbsent` (no metrics at all); the external uptime checks.
- **Symptoms:** the uptime check on a page that calls the API fails; `/api/*` answers nginx's 502
  or 504 while `/healthz` (nginx alone) still answers 200; no access log lines from the API.
- **Impact:** total for signed-in use: the app shell loads, every API call fails, nobody can sign in.
- **First checks:** are the API containers running or restarting (platform events, exit codes)?
  The last lines of an instance: an `Environment variable X is invalid` line at boot means a
  configuration change; `fatal` lines mean a crash ([8](#8-repeated-application-crashes)); exit
  code 137 means killed for memory ([7](#7-memory-or-cpu-pressure)). The nginx error log:
  `connect() failed` or `could not be resolved` for the API upstream.
- **Signals:** container restarts; `level=fatal`; the boot line `Starting release <sha> in <env>`;
  no `http_server_request_duration_seconds` samples at all.
- **Immediate actions:** a deployment or configuration change in the last hour: roll it back
  (redeploy the previous digests, restore the previous variable). Otherwise follow the cause above.
- **Mitigation:** add capacity if instances are killed for memory or CPU; check that `API_UPSTREAM`
  resolves from the web container (nginx looks it up again every 10 seconds).
- **Roll back when:** it started within the window of a deployment or configuration change.
- **Recovered when:** every instance is ready, the smoke test passes, the 5xx rate is back to its
  baseline for 15 minutes.
- **Validate after:** `pnpm smoke --url <public URL> --api <API URL>`; sign in with a test
  account; the uptime checks are green from every location.
- **Document:** time of first failure, of detection and of recovery; the trigger; why no earlier
  alert fired, if none did.

### 2. Readiness failing

- **Alerts:** `ApiReadinessFailing`.
- **Symptoms:** instances marked unready, taken out of the load balancer; `GET /api/health/ready`
  answers 503 with the reason in the message: `Database unreachable`, `Redis unreachable` (only
  with `REDIS_REQUIRED=true`) or `Shutting down`. `status: "degraded"` with 200 is not a failure.
- **Impact:** some instances: less capacity, higher latency. All instances: an outage.
- **First checks:** the message decides: database → [3](#3-database-unavailable); Redis →
  [4](#4-redis-unavailable); `Shutting down` outside a deployment → something sends SIGTERM
  (autoscaling, node drain: platform events). A probe that times out instead of answering points
  at a blocked event loop or CPU starvation ([7](#7-memory-or-cpu-pressure)): readiness answers
  within 2.5 seconds whatever its dependencies do, so give the probe a timeout of 3 seconds or
  more.
- **Signals:** the warning `Readiness: database unreachable (<driver message>)` or
  `Readiness: Redis unreachable (REDIS_REQUIRED=true)`; ready instance count.
- **Immediate actions:** do not restart instances in a loop: liveness still answers 200 on
  purpose, and a restart does not fix a dependency. Fix the dependency.
- **Mitigation:** if a new hard dependency came with a deployment, roll back.
- **Roll back when:** the failure started with a deployment.
- **Recovered when:** every instance is ready for 10 minutes.
- **Validate after:** readiness on each instance; the smoke test.
- **Document:** which dependency, how long, how many instances.

### 3. Database unavailable

- **Alerts:** `ApiDatabaseErrors`; often `ApiReadinessFailing` with it.
- **Symptoms:** readiness 503 `Database unreachable`; 5xx lines ending `, database)`;
  `app_server_errors_total{error_origin="database"}` rising; Sentry issues with `error.origin:
database`; failing pg spans. The API keeps running (it even starts without a database, and
  says so: `Database unreachable at boot`), so this is not a crash loop.
- **Impact:** everything but the web shell fails. Signed-in users keep their refresh cookie: a
  failed refresh on a server error does not sign anyone out (docs/security.md).
- **First checks:** the driver's message in the readiness warning: `ECONNREFUSED` or a timeout
  (down, failover, network), `too many clients already` (connection limit),
  `password authentication failed` (rotated credentials), an SSL error (TLS settings), `the
database system is in recovery mode` (restart or failover). The provider's status, maintenance
  and failover events; storage free space. The VPS target's own database: `docker compose ... ps db`
  and `logs db` on the server, and its free disk (`df -h /`).
- **Signals:** `db_client_connection_count` by state, `db_client_connection_pending_requests`;
  the provider's CPU, connections, storage and replication metrics.
- **Immediate actions:** a failover in progress: wait; the pool reconnects on its own. Connection
  limit reached: the instances × `DB_POOL_MAX` must fit in the database's limit
  (docs/database.md#connections); look for idle or stuck sessions in `pg_stat_activity` and end
  them (`pg_terminate_backend`). A migration holding a lock: cancel it ([10](#10-failed-database-migration)).
- **Mitigation:** scale the database, free storage, restore the previous credentials or rotate
  them everywhere at once (on the VPS target's own database, PostgreSQL first:
  [deploy-vps.md](deploy-vps.md#change-a-setting-or-a-secret)). Data lost:
  [disaster-recovery.md](disaster-recovery.md).
- **Roll back when:** a deployment changed `DATABASE_URL`, `DB_POOL_MAX` or ran a migration just
  before.
- **Recovered when:** readiness 200 everywhere, no `database` errors for 15 minutes, no pending
  pool requests.
- **Validate after:** the smoke test; the data written just before the outage is there (requests
  that failed were rolled back and answered 5xx with a request id).
- **Document:** cause, duration, number of failed requests, whether data was lost.

### 4. Redis unavailable

- **Alerts:** `ApiDegradedMode` (`feature`, `dependency_name` labels).
- **Symptoms:** `Redis unavailable (<host>): <reason>` once per outage, or
  `Redis is not answering (<host>)` when it stays connected but stops replying; readiness
  `status: "degraded"`, `checks.redis: "unavailable"` (200); `Rate limiting falls back to
per-instance counters`; `Cache unavailable, serving from the source`;
  `app_degraded_operations_total` rising. With `REDIS_REQUIRED=true`: readiness 503
  `Redis unreachable`.
- **Impact:** degraded, not down: rate limits count per instance (more permissive by the number of
  instances), every cache read goes to the database (more database load), locks and idempotency
  claims fail closed (503 `Service temporarily unavailable, retry later`, logged
  `dependency: redis`): jobs skip their run, webhook deliveries are refused and retried by their
  sender. Redis holds nothing that must survive (docs/disaster-recovery.md#what-to-protect).
- **First checks:** the reason in the line: `ECONNREFUSED` or a timeout (down, network), `WRONGPASS`
  or `NOAUTH` (credentials changed), `LOADING` (Redis restarting and loading its data, transient),
  `OOM command not allowed` (memory full), `NOPERM` (a key or command outside the ACL). The
  provider's status and memory metrics; on the VPS target, `docker compose ... ps redis` and
  `logs redis` on the server.
- **Signals:** node-redis command metrics (errors, duration), database latency (cache misses).
- **Immediate actions:** none needed in the application: it reconnects by itself (backoff up to
  5 seconds). Watch database load and latency while the cache is out.
- **Mitigation:** restart or fail over Redis (on the VPS target,
  `docker compose ... up -d --wait redis`); restore the credentials; memory full: every key the
  template writes has a TTL, so check the eviction policy and what else writes to that Redis.
- **Roll back when:** a deployment changed `REDIS_URL` or the stores.
- **Recovered when:** `Redis connection restored after <n>s` or `Redis answering again after <n>s`,
  `Rate limiting uses the shared Redis counters again`, `Cache available again`; readiness `ok` on
  every instance.
- **Validate after:** `app_degraded_operations_total` stops increasing; work skipped by locks ran
  on its next schedule.
- **Document:** duration, what was refused while it failed closed, database load during the outage.

### 5. High 5xx rate

- **Alerts:** `ApiAvailabilityBudgetFastBurn` (CRITICAL), `ApiAvailabilityBudgetSlowBurn`,
  `ApiRouteErrorRatioHigh` (one route).
- **Symptoms:** availability burn rate alert; Sentry spike; 5xx lines
  `METHOD /path -> 5xx (request <id>, <origin>)`.
- **Impact:** the routes affected, for every user who calls them.
- **First checks:** split `app_server_errors_total` by `error_origin`, `http_route` and the
  release (`service.version`): `application` is a bug, usually of the latest release;
  `database` → [3](#3-database-unavailable); `dependency: <name>` →
  [12](#12-external-dependency-outage) (`dependency: redis` → [4](#4-redis-unavailable));
  `unavailable` is a deliberate 503 (readiness, shutdown). 502 or 504 from nginx without an API
  line → [1](#1-api-down) or [6](#6-high-latency).
- **Signals:** the stack trace in the error line or the Sentry issue; the trace of a failing
  request (`app.request_id`).
- **Immediate actions:** errors from the new release: roll back.
- **Mitigation:** a hotfix through the normal pipeline when a rollback is impossible (a contract
  the clients already use).
- **Roll back when:** the errors started with a deployment and belong to the new release.
- **Recovered when:** the burn rate is below 1 for 30 minutes.
- **Validate after:** the Sentry issue has no events in the fixed release; the smoke test.
- **Document:** budget spent (alerting.md#error-budget), root cause, the test that now covers it.

### 6. High latency

- **Alerts:** `ApiLatencyBudgetFastBurn` (CRITICAL), `ApiLatencyBudgetSlowBurn`,
  `ApiRouteLatencyHigh` (one route), `ApiDatabasePoolSaturated`.
- **Symptoms:** p95 or p99 of `http.server.request.duration` above the latency SLO, latency burn
  rate alert, users reporting slowness; nginx's access log `request_time`.
- **Impact:** slow pages, client timeouts, retries that add load.
- **First checks:** which routes (`http_route`); the database (`db.client.operation.duration`,
  `Slow query (<n> ms): <statement>` warnings, `db_client_connection_pending_requests` above zero
  means the pool is exhausted); dependencies (`app_dependency_duration_seconds` p95 per
  dependency); the event loop (`nodejs.eventloop.delay.p99`), CPU throttling; Redis down (cache
  misses, [4](#4-redis-unavailable)). A slow trace shows which span takes the time.
- **Immediate actions:** a deployment correlates: roll back. CPU-bound instances: add instances,
  if the database has connections to spare (instances × `DB_POOL_MAX`).
- **Mitigation:** the index a slow statement needs (`EXPLAIN ANALYZE` on a copy); cancel runaway
  queries (`pg_stat_activity`, `pg_cancel_backend`); raise `DB_POOL_MAX` only when the pool wait
  is the bottleneck and the database has headroom.
- **Roll back when:** the slowdown started with a deployment.
- **Recovered when:** p95 and p99 below the threshold for 30 minutes.
- **Validate after:** no pending pool requests; slow query count back to normal.
- **Document:** the slow component, the fix, the load at the time (for capacity planning,
  [load-testing.md](load-testing.md)).

### 7. Memory or CPU pressure

- **Alerts:** `ApiEventLoopDelayHigh`.
- **Symptoms:** CPU near the container's limit or throttled; `process.memory.usage` (RSS) or
  `v8js.memory.heap.used` growing toward the memory limit; longer `v8js.gc.duration`; event loop
  delay; restarts with exit code 137 (killed for memory).
- **Impact:** latency first, then restarts and failed requests.
- **First checks:** traffic grew (load), traffic is flat but memory climbs (a leak: a sawtooth that
  resets at each restart), or it started with a release (a regression). One instance or all?
- **Immediate actions:** release-related: roll back. Load: add instances (check the database
  connection budget) or raise the limits.
- **Mitigation:** for a leak, a rolling restart buys time; it is not a fix. Take a heap snapshot
  of one instance outside peak hours (Node.js `--heapsnapshot-signal` through `NODE_OPTIONS`) and
  compare two snapshots.
- **Roll back when:** it started with a deployment.
- **Recovered when:** below the warning thresholds for an hour without a restart.
- **Validate after:** memory flat over a full traffic cycle.
- **Document:** growth rate, the culprit, whether limits or capacity planning must change.

### 8. Repeated application crashes

- **Symptoms:** instances restarting in a loop; `fatal` lines `uncaughtException: <stack>` or
  `unhandledRejection: <stack>` (the process exits on purpose after logging and reporting them);
  Sentry events with level fatal and `error.origin: process`.
- **Impact:** from lost requests to an outage, depending on how many instances crash.
- **First checks:** the stack in the `fatal` line; whether the crash follows a specific request
  (the lines just before it, the same route each time: a "poison" request); the boot line and any
  `Environment variable X is invalid` line (a configuration change stops the boot, by design); exit
  code 137 → [7](#7-memory-or-cpu-pressure).
- **Immediate actions:** roll back the release or the configuration change. A poison request from
  outside: block it at the edge (WAF rule, path or client) until the fix ships.
- **Mitigation:** the fix with a test that reproduces the crash.
- **Roll back when:** crashes started with a deployment or configuration change.
- **Recovered when:** no restart for 30 minutes and no new `fatal` line.
- **Validate after:** the smoke test; the poison request, if any, now answers a 4xx or 5xx without
  a crash.
- **Document:** the stack, the trigger, why it was not caught by tests.

### 9. Failed deployment

- **Symptoms:** the Deploy workflow failed at a step (gates, image push, migration, rollout, smoke
  test), or alerts fired right after a rollout.
- **Impact:** none if it failed before the rollout (the running version is untouched); otherwise
  old and new versions may be serving side by side.
- **First checks:** which step. Before the migration: nothing changed in the environment, fix and
  run again. Migration → [10](#10-failed-database-migration). Rollout or smoke test: which
  `release` each instance runs.
- **Immediate actions:** rollout or smoke test failed: redeploy the image digests recorded before
  the deployment (docs/ci-cd.md#rollback). That is faster and safer than running Deploy with the
  previous tag: Deploy re-runs every gate, and an advisory published since then could block it.
- **Mitigation:** fix forward through a new pull request once the previous version serves.
- **Roll back when:** the smoke test failed, or errors or latency rose after the rollout. Do not
  fix forward under a live incident unless a rollback is impossible.
- **Recovered when:** one version serves everywhere and the smoke test passes with its `--release`.
- **Validate after:** `pnpm smoke --url <public URL> --api <API URL> --release <sha>`; error rate
  and latency at their baseline.
- **Document:** the failing step, the rollback time, what the gates missed.

### 10. Failed database migration

- **Symptoms:** the `api-migrate` job exits with `Error: P3018 A migration failed to apply` and the
  database error; later runs fail with `P3009 migrate found failed migrations`; or the job hangs on
  a lock and the deployment times out. Two more stop it before any statement runs:
  `P1002 ... Timed out trying to acquire a postgres advisory lock` (another migration run holds the
  database: wait for it, then deploy again) and
  `Migrations changed after they were applied to this database: <names>` (below).
- **Impact:** the deployment stops before the rollout, so the running version keeps serving.
  **Prisma does not wrap a migration in a transaction on PostgreSQL:** the statements before the
  failing one stay applied (verified with Prisma 7 on PostgreSQL 18). An expand migration leaves an
  extra table or column the running version ignores; a destructive statement can break it.
- **First checks:** which migration and which statement:
  `docker run --rm -e DATABASE_URL=<url> <api-migrate image>@<digest> node node_modules/prisma/build/index.js migrate status`.
  Compare the migration's statements with the database (`\d <table>` in `psql`) to see which ones
  took effect. Is the running version healthy?
- **Immediate actions:** do not roll out the new version. Never run `migrate dev` or `migrate reset`
  against the environment, and never edit `_prisma_migrations` by hand.
- **Mitigation**, in the database, then with the same image and `migrate resolve`:
  - the migration is right but the data was not ready (a `NOT NULL` on rows with nulls, a
    duplicate under a new unique index): undo the statements that took effect, fix the data, mark
    it rolled back (`migrate resolve --rolled-back <migration>`), and deploy the same release again;
  - the migration is wrong: undo what took effect, mark it rolled back, and ship a corrected
    migration in a new pull request (editing the failed file is acceptable only if it has not been
    applied in any environment);
  - finishing it by hand is the last resort: apply the remaining statements, then
    `migrate resolve --applied <migration>`;
  - `Migrations changed after they were applied to this database`: nothing ran; a migration
    applied here was edited since (docs/database.md#migrations). Put the file back as it was
    applied (`git log -p -- apps/api/prisma/migrations/<name>/migration.sql` shows its versions),
    ship the change as a new migration, and deploy again. Never update the checksum in
    `_prisma_migrations` to get past it: this database would keep a schema the new code does not
    expect.
- **Roll back when:** the partial migration broke the running version: repair the schema by hand
  first; if data was destroyed, restore ([disaster-recovery.md](disaster-recovery.md)).
- **Recovered when:** `migrate status` says `Database schema is up to date!` and the deployment
  completed.
- **Validate after:** the smoke test; the tables the migration touched hold what they should.
- **Document:** the statement, why the rehearsal did not catch it.
- **Prevention** (docs/database.md#migrations): small migrations, `SET lock_timeout` at their top,
  and a rehearsal against a restored copy of production before releasing anything that rewrites
  data or locks large tables.

### 11. Authentication or security attack

- **Symptoms:** `Refresh token reuse for user <id> (at refresh|logout)` (a stolen refresh token
  was replayed: that session family is already revoked); bursts of 401 and 429 on
  `/api/auth/sign-in` (credential stuffing, from one address or many); bursts of 403
  `Cross-origin request refused` (forged cross-site requests); reports through `SECURITY.md`; a
  leaked secret.
- **Impact:** account takeover, data exposure, or availability (floods).
- **First checks:** one user or many; the `ip` field of the access log (all requests from the
  proxy's address means `TRUST_PROXY` is wrong, and then the rate limit throttles everyone
  together); which secret could be exposed and since when.
- **Immediate actions:**
  - stolen session: the family is revoked automatically; to end every session of a user, revoke
    their rows under the user's row lock, the way the API changes sessions (a refresh in flight
    would otherwise commit a new token after a plain `UPDATE`, and that token keeps working):

    ```sql
    BEGIN;
    SELECT id FROM users WHERE id = '<id>' FOR UPDATE;
    UPDATE sessions SET revoked_at = now() WHERE user_id = '<id>' AND revoked_at IS NULL;
    COMMIT;
    ```

    Their access tokens still work until they expire, within 15 minutes;

  - credential stuffing: block at the edge (WAF, IP reputation); with several API instances, the
    shared rate limit store (`RATE_LIMIT_STORE=redis`) makes the per-IP limit hold across them;
  - leaked `JWT_ACCESS_SECRET`: rotate it without a previous value (docs/security.md#secret-rotation):
    every access token is refused at once; leaked database or Redis credentials: rotate them.
- **Mitigation:** fix the weakness; per-account limits, MFA or CAPTCHA if credential stuffing
  persists (docs/security.md#known-limits).
- **Roll back when:** a deployment introduced the weakness.
- **Recovered when:** the signals are back to their baseline and every exposed secret is rotated.
- **Validate after:** the old secret no longer works; affected users are signed out.
- **Document:** indicators, affected accounts and data, every action with its time. **Preserve
  evidence first**: export the relevant logs before their retention expires; do not redeploy over
  a compromised host before capturing it. Personal data breaches can carry legal deadlines for
  notification (REQUIERE CONFIGURACIÓN: who decides and how fast).

### 12. External dependency outage

- **Alerts:** `ApiDependencyFailing` (`dependency_name` label).
- **Symptoms:** 502 (`An upstream service failed`) or 504 (`An upstream service did not answer in
time`) on the routes that call a provider; 5xx lines ending `dependency: <name>)`; warnings from
  the `External:<name>` logger (`METHOD /path <status|timeout|network_error> <ms>ms attempts=<n>`);
  `app_dependency_duration_seconds_count{outcome!="success"}` per `dependency_name`.
- **Impact:** the features that need the provider; everything else works.
- **First checks:** the provider's status page; one provider or all (all: egress, DNS or proxy on
  our side); 401 or 403 from the provider means our credentials expired or were revoked; 429 means
  we exceed its quota (the client honors `Retry-After`).
- **Immediate actions:** none in the application (no restart helps); tell users what does not work.
- **Mitigation:** rotate expired credentials; contact the provider's support (contacts table);
  disable or queue the feature if the outage lasts (project-specific).
- **Roll back when:** a deployment changed the integration.
- **Recovered when:** the success ratio of that dependency is back to its baseline.
- **Validate after:** a real call through the feature.
- **Document:** provider, duration, failed operations to replay, whether timeouts and retries
  behaved (docs/observability.md#external-services).

### 13. Sentry critical error spike

- **Symptoms:** Sentry alert: a new issue in production, a regression, an issue's frequency jump.
- **Impact:** read it from the issue: users affected, routes (`http.route`), release.
- **First checks:** the release where it was first seen; `error.origin`; the `request_id` tag →
  the log line with the stack → the trace. Compare with the 5xx metrics: Sentry samples
  (`SENTRY_SAMPLE_RATE`) and can drop events at its quota, the metrics do not.
- **Immediate actions:** new in the latest release and user-facing: roll back. Otherwise fix
  forward with priority.
- **Mitigation:** without Sentry (not configured), the same information is in the error log lines.
- **Roll back when:** it is new in the release just deployed and affects a critical flow.
- **Recovered when:** no new events in the fixed release for 24 hours; the issue resolved.
- **Validate after:** the regression test that reproduces it passes.
- **Document:** the issue link, its cause, why tests missed it.

### 14. Data corruption or suspected data loss

- **Symptoms:** users report missing or wrong data; a migration, backfill, job or manual query
  wrote what it should not; PostgreSQL reports `invalid page in block` or `could not read block`
  (physical corruption).
- **Impact:** potentially permanent; possibly a personal data incident.
- **First checks:** who is writing the bad data (a release, a route, a job, a migration, a
  person) and since when: logs by route and release, `created_at` and `updated_at` of the damaged
  rows.
- **Immediate actions:** stop the writer: roll back the release, disable the job, revoke the
  operator's access. Freeze deployments. **Take a backup or snapshot of the current state now**:
  it is the evidence and it holds the good data written since the damage. Never repair production
  with a script that was not run on a copy first.
- **Mitigation:** restore a copy at the moment just before the first bad write into a separate
  database ([disaster-recovery.md](disaster-recovery.md#restore-procedure)), then repair: copy
  back only the damaged rows when the damage is identifiable (keeps everything written since);
  restore the whole database to that point only when the damage is widespread and the product
  owner accepts losing the writes since then.
- **Roll back when:** a release or job is the writer (immediately).
- **Recovered when:** the data is verified by its owners and the writer is fixed.
- **Validate after:** the checks of disaster-recovery.md#restore-testing on the repaired tables.
- **Document:** affected records and users, the window of lost or wrong data, the notification
  decision (REQUIERE CONFIGURACIÓN: data protection obligations).

### 15. Poor Web Vitals

- **Alerts:** `WebVitalsLcpPoor`, `WebVitalsInpPoor`, `WebVitalsClsPoor` (`page_route` label).
- **Symptoms:** a page's p75 above "good" for 30 minutes: LCP above 2.5 s (the main content
  appears late), INP above 200 ms (clicks and typing respond late), CLS above 0.1 (the layout
  jumps); users reporting a slow or jumpy page.
- **Impact:** slower, less usable pages for a quarter or more of their visits, and lower search
  ranking if it lasts; nothing is down.
- **First checks:** on the "Web Vitals" dashboard, which pages and since when; whether it started
  with a release (`release` in `/app/app-config.json`); the navigation types (a cold `navigate`
  versus `back-forward-cache`); LCP together with TTFB and FCP: a high TTFB is the server or the
  network (the API's latency on the "API service" dashboard, nginx), a high FCP with a normal TTFB
  is render-blocking JavaScript or CSS (`pnpm perf:check`, the bundle budget), a late LCP alone is
  the page's main content (an API call it waits for, a large image).
- **Immediate actions:** none urgent. If it started with a release and is severe, roll back.
- **Mitigation:** INP: long tasks in event handlers (split the work, defer what is not visible);
  CLS: give images and late content a reserved size, avoid inserting content above what is shown;
  LCP: make the main content's API call faster or earlier, lazy-load what is below it.
- **Roll back when:** a release caused it and the page is critical (sign-in, the main flow).
- **Recovered when:** the page's p75 is back under "good" for an hour of normal traffic.
- **Validate after:** the page's p75 on the dashboard over the next day; Lighthouse or the browser's
  performance panel on the page for the cause.
- **Document:** the page, the metric, the cause, the release, and a budget or test that would have
  caught it.

### 16. Email not delivered

- **Alerts:** `ApiMailBacklog` (messages wait more than 15 minutes), `ApiMailDeliveryFailed`
  (`mail_kind` label: messages given up on).
- **Symptoms:** users do not receive password resets or confirmations; readiness
  `checks.mail: "degraded"` (200, the instance still serves); in the log
  `Could not send <kind> message <id> (attempt n): <category>; retrying in <s> s`,
  `Gave up on <kind> message <id>: <category>`, or `Mail worker paused: <reason>` (the database);
  `app_mail_outbox_oldest_age_seconds` rising, `app_mail_deliveries_total{outcome="retry"}` rising
  without `outcome="sent"`. A refused configuration also reaches the error tracker as
  `SMTP refused the configuration (<category>)` (`dependency: smtp`).
- **Impact:** degraded, not down: nothing is lost, the outbox keeps every message
  (docs/architecture.md#email) and retries with backoff, but links arrive late, and a message
  that waits longer than its kind's validity (30 minutes for a password reset) is dropped unsent
  (`expired`): the person asks again once email works. Sign-in and every other feature work.
- **First checks:** `pnpm --filter api mail status` (in a deployment:
  `docker compose ... run --rm -T api node dist/infrastructure/mail/mail.cli.js status`): counts
  by status and kind, the age of the oldest waiting message, the latest failures and their
  category. The category says where to look: `connection`, `timeout`, `dns` (the server or the
  network), `auth`, `smtp_5xx_535` (credentials refused: rotated, expired, wrong
  `MAIL_SMTP_URL`), `tls` (the server does not offer STARTTLS, which production requires),
  `smtp_4xx_*` (the provider defers: rate limits, a sending quota), `smtp_5xx_*` (the provider
  refuses this message: a bad address, the sender's domain not verified, a suppression list).
  The provider's status page and its own logs for the same minutes.
- **Signals:** `app_mail_outbox_waiting`, `app_mail_outbox_oldest_age_seconds`,
  `app_mail_deliveries_total` by `outcome`, `app_mail_delivery_duration_seconds` (a slow server),
  `app_mail_suppressed_total` (per-address limits: one address asked repeatedly).
- **Immediate actions:** none needed for a transient outage: every instance retries on its own
  (30 s, then doubling to an hour, with jitter). If no message moves at all, check that an API
  instance runs: the workers live in the API.
- **Mitigation:** credentials: rotate them at the provider and update `MAIL_SMTP_URL`
  (percent-encode the password; docs/environment.md), then redeploy; waiting messages go out with
  their next attempt. A sender refused for domain authentication: fix SPF, DKIM and DMARC at the
  DNS. A provider down for long: switch `MAIL_SMTP_URL` to a second provider. Messages given up
  on (`failed`): once the cause is fixed, `mail retry --failed` (or `--id <id>`, `--kind <kind>`)
  queues them again; their address is kept for 7 days, after which they cannot be retried.
- **Roll back when:** a deployment changed `MAIL_SMTP_URL`, `MAIL_FROM` or `APP_ORIGIN`.
- **Recovered when:** `Sent <kind> message <id>` lines again; readiness `checks.mail: "ok"`;
  `app_mail_outbox_oldest_age_seconds` back under a minute; `mail status` shows nothing waiting
  for long.
- **Validate after:** `pnpm --filter api mail test --to <your address>` delivers; no new
  `failed` messages. Delivery is at least once: a worker that died after the server accepted a
  message and before recording it sends it again when its lease ends (2 minutes), so a few people
  may get a duplicate (with the same `Message-ID`); nothing to do about it.
- **Document:** duration, the category, how many messages were delayed, dropped (`expired`) or
  retried by hand, and what would have told you sooner.

## After the incident

Within a few working days, a blameless postmortem for every SEV1 and SEV2, and for any incident
that spent more than 20 % of an error budget ([alerting.md](alerting.md#error-budget)):

```
Summary          one paragraph: what users saw, how long
Impact           users, requests or data affected; error budget spent
Timeline         first failure, detection, acknowledgement, mitigation, recovery (with times)
Root cause       and the conditions that let it happen
Detection        which alert fired first; if none, which one should have
What went well   and what did not
Action items     each with an owner and a date: tests, alerts, runbooks, limits
```

Update this page when a runbook was wrong or missing, and [alerting.md](alerting.md) when an alert
fired late, never, or for nothing.
