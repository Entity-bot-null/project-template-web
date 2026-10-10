# Alerting and SLOs

What to measure, what to promise, and when to wake someone up. The template emits the signals
(docs/observability.md); the alert rules live in the monitoring backend each project picks
(Prometheus and Alertmanager, Grafana, a managed provider, Sentry's alert rules, the uptime
service): **REQUIERE CONFIGURACIÓN**. Nothing here depends on one provider.

Thresholds marked "starting point" are where to begin, not universal values: the right numbers
depend on traffic, infrastructure and what the product promises. Tune them with real data and keep
a record of why each one changed.

## SLIs and SLOs

An **SLI** is a ratio of good events to all events; an **SLO** is the target for it over a window;
the **error budget** is what the SLO allows to fail.

| SLI          | Good events / all events                                                            | Fed by                                                       | Example SLO (adjust per product) |
| ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| Availability | API responses other than 5xx / all API responses (health probes are never measured) | `http.server.request.duration` (count, by status)            | 99.9 % over 30 days              |
| Latency      | API responses faster than the threshold / all API responses, per route class        | `http.server.request.duration` (histogram buckets)           | 95 % under 250 ms over 30 days   |
| Uptime       | successful external checks / all external checks                                    | the uptime service (docs/observability.md#uptime-monitoring) | 99.9 % over 30 days              |

How to compute them (PromQL on the OTLP metrics converted by Prometheus; any backend has the same
arithmetic):

```
# Availability over 30 days ("or vector(0)": with no 5xx at all the series does not exist, and
# the ratio would be empty instead of 1)
1 - (sum(increase(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[30d])) or vector(0))
  / sum(increase(http_server_request_duration_seconds_count[30d]))

# Latency: share of requests under 250 ms over 30 days (authentication routes excluded, below)
sum(increase(http_server_request_duration_seconds_bucket{le="0.25", http_route!~"/api/auth/.*"}[30d]))
  / sum(increase(http_server_request_duration_seconds_count{http_route!~"/api/auth/.*"}[30d]))
```

- **The latency threshold must be a bucket boundary.** The HTTP histogram's buckets are 5, 10, 25,
  50, 75, 100, 250, 500, 750 ms, 1, 2.5, 5, 7.5 and 10 s; a threshold between two of them (300 ms)
  cannot be computed from the buckets. Pick a boundary, or add one with a metrics View in
  `observability/telemetry-sdk.ts`.
- **Route classes:** sign-in hashes passwords with argon2id, slow on purpose; give authentication
  routes their own latency SLO (or none) so they do not hide regressions elsewhere.
- **What the API cannot see:** when no instance answers, there are no API metrics at all. The
  uptime SLI covers that blind spot; count both.
- **Low traffic:** with a few hundred requests a day one failure moves the ratio by whole percents.
  Require a minimum number of requests before an SLO alert fires, or rely on the uptime checks.
- **Without OpenTelemetry** (CORE setup), the same SLIs come from the access log lines (`status`,
  `durationMs`) in the log platform, or from the load balancer's metrics.

### Error budget

For a 99.9 % SLO over 30 days the budget is 0.1 % of requests, the equivalent of 43 minutes of full
outage. The **burn rate** is how fast it is spent: the error ratio over a window divided by
`1 - SLO`. A burn rate of 1 uses the whole budget exactly at the end of the window.

```
# Burn rate over the last hour, 99.9 % availability SLO
(
  (sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[1h])) or vector(0))
  / sum(rate(http_server_request_duration_seconds_count[1h]))
) / 0.001
```

Alert on burn rate over two windows, a long one that proves it is sustained and a short one that
proves it is still happening (the multiwindow method of Google's SRE workbook):

| Burn rate | Long window | Short window | Budget spent        | Severity |
| --------- | ----------- | ------------ | ------------------- | -------- |
| 14.4      | 1 hour      | 5 minutes    | 2 % in one hour     | CRITICAL |
| 6         | 6 hours     | 30 minutes   | 5 % in six hours    | WARNING  |
| 1         | 3 days      | 6 hours      | on track to run out | WARNING  |

The same table applies to the latency SLO, with "slower than the threshold" as the bad event.

### When the budget runs out (REQUIERE CONFIGURACIÓN: agree on it before the first incident)

Who decides is the product owner with the engineering lead. A policy to start from:

- **Budget left:** ship features as usual; spend budget on planned risk (migrations, upgrades).
- **Budget exhausted** (the SLI is below the SLO over the window): feature releases stop, except
  fixes and security patches, until the SLI is back above the SLO; the team works on the causes
  found in the postmortems.
- **One incident spends more than 20 % of the budget:** a postmortem with action items, which go
  ahead of feature work (docs/incident-response.md#after-the-incident).
- **The same cause burns budget twice:** its fix is the next priority, whatever the roadmap says.
- **The SLO is never at risk for months:** it may be too loose for what users expect, or the team
  is over-investing in reliability; revisit it.

## Alert catalog

Every alert links to its runbook (docs/incident-response.md) and to a dashboard, and has an owner.
Each condition has a log-based equivalent, so alerting works without OpenTelemetry (patterns in the
last column of [Log patterns](#log-patterns)).

### CRITICAL: page the on-call person

| Alert                    | Signal                                                                                                                                      | Threshold                                                                                                       | Evaluation window                             | Response                                                                                    | Escalation                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| External uptime failure  | Uptime checks on `/healthz` and on a page that calls the API                                                                                | failing from 2 or more locations                                                                                | 2 to 3 consecutive checks (1-minute interval) | [API down](incident-response.md#1-api-down)                                                 | on-call; incident commander if over 15 minutes |
| Readiness failure        | Ready instances reported by the orchestrator; `GET /api/health/ready` answering 503                                                         | no ready instance, or fewer than the minimum capacity (REQUIERE CONFIGURACIÓN)                                  | 2 minutes                                     | [Readiness failing](incident-response.md#2-readiness-failing)                               | on-call                                        |
| Sustained high 5xx       | Availability burn rate (above)                                                                                                              | 14.4 over 1 hour and over 5 minutes, with a minimum request count                                               | 1 hour and 5 minutes                          | [High 5xx rate](incident-response.md#5-high-5xx-rate)                                       | on-call                                        |
| Database unavailable     | `app_server_errors_total{error_origin="database"}`; readiness `Database unreachable`; the provider's instance health                        | database errors above their normal background (starting point: any for 2 minutes), or the provider reports down | 2 minutes                                     | [Database unavailable](incident-response.md#3-database-unavailable)                         | on-call; database owner                        |
| Repeated crashes         | Container restarts; `fatal` log lines                                                                                                       | starting point: 3 restarts of one instance in 15 minutes, or `fatal` lines on several instances                 | 15 minutes                                    | [Repeated crashes](incident-response.md#8-repeated-application-crashes)                     | on-call                                        |
| Security-critical signal | `Refresh token reuse for user` lines across users; a secret found in the repository or its history; a confirmed breach report (SECURITY.md) | starting point: reuse lines for 3 or more users in 10 minutes; any leaked production secret                     | 10 minutes; immediate for a leaked secret     | [Security attack](incident-response.md#11-authentication-or-security-attack)                | on-call and the security contact               |
| Backups behind the RPO   | The provider's latest restorable time (PITR) or the last successful backup                                                                  | older than the RPO (docs/disaster-recovery.md#rpo-and-rto)                                                      | 15 minutes                                    | Fix the backup job or storage; [disaster-recovery.md](disaster-recovery.md#backup-strategy) | on-call; database owner                        |

### WARNING: a channel, looked at the same working day

| Alert                        | Signal                                                                                                                                  | Threshold                                                                                                 | Evaluation window                  | Response                                                                         | Escalation                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| High p95/p99 latency         | `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[5m])))`, and p99; latency burn rate | above the latency SLO threshold, or latency burn rate 6 over 6 hours                                      | 15 minutes; 6 hours and 30 minutes | [High latency](incident-response.md#6-high-latency)                              | CRITICAL when the latency burn rate reaches 14.4      |
| Elevated error rate          | Availability burn rate                                                                                                                  | 6 over 6 hours and 30 minutes; 1 over 3 days and 6 hours                                                  | as stated                          | [High 5xx rate](incident-response.md#5-high-5xx-rate)                            | CRITICAL at 14.4                                      |
| Sentry issue increase        | Sentry alert rules on the production environment: a new issue, a regression (a resolved issue back), an issue's events per hour         | any new issue or regression; frequency REQUIERE CONFIGURACIÓN                                             | Sentry's rule interval             | [Sentry spike](incident-response.md#13-sentry-critical-error-spike)              | CRITICAL if it matches a 5xx burn                     |
| CPU or memory pressure       | Container CPU against its limit (platform), `process.memory.usage` (RSS) against the memory limit, `nodejs.eventloop.delay.p99`         | starting point: CPU above 80 % or RSS above 85 % of the limit for 15 minutes; event loop p99 above 200 ms | 15 minutes                         | [Memory or CPU pressure](incident-response.md#7-memory-or-cpu-pressure)          | CRITICAL on out-of-memory restarts                    |
| Database pool saturation     | `db_client_connection_pending_requests` (pg pool); slow query warnings                                                                  | pending requests above zero for 5 minutes; slow queries well above their usual count                      | 5 minutes                          | [High latency](incident-response.md#6-high-latency)                              | CRITICAL if requests fail on the 5-second pool wait   |
| External dependency failures | `app_dependency_duration_seconds_count{outcome!="success"}` against all calls, per `dependency_name`; `error.origin=dependency` issues  | starting point: more than 5 % failed calls of one dependency for 10 minutes                               | 10 minutes                         | [External dependency outage](incident-response.md#12-external-dependency-outage) | CRITICAL when the feature is critical for the product |
| Redis degraded mode          | Readiness `status: "degraded"`; `app_degraded_operations_total` increasing; `Redis unavailable` lines                                   | degraded for 5 minutes                                                                                    | 5 minutes                          | [Redis unavailable](incident-response.md#4-redis-unavailable)                    | CRITICAL when `REDIS_REQUIRED=true` (readiness 503)   |
| Security anomalies           | 401 and 429 on `/api/auth/sign-in`; 403 `Cross-origin request refused`; a single `Refresh token reuse` line                             | starting point: three times the usual rate for 10 minutes; any reuse line                                 | 10 minutes                         | [Security attack](incident-response.md#11-authentication-or-security-attack)     | the security contact; CRITICAL when it spreads        |
| Backup missed                | The backup job or the provider's backup status                                                                                          | one scheduled backup missing or failed                                                                    | per schedule                       | [disaster-recovery.md](disaster-recovery.md#backup-strategy)                     | CRITICAL once behind the RPO                          |
| Certificate expiry           | The uptime service's TLS check                                                                                                          | starting point: certificate expiring within 14 days                                                       | daily                              | renew at the edge (CDN, load balancer)                                           | CRITICAL within 3 days                                |

### Log patterns

The same conditions, from the JSON log lines (any log platform; `level` and `message` fields):

| Condition                 | Pattern                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 5xx answered by the API | `level=error` and message containing `-> 5` (`GET /api/users/7 -> 500 (request ...)`)                                                                      |
| By origin                 | `..., application)`, `..., database)`, `..., dependency: <name>)` (Redis: `dependency: redis`), `..., unavailable)` (deliberate 503s: readiness, shutdown) |
| Crash                     | `level=fatal` (`uncaughtException: ...`, `unhandledRejection: ...`)                                                                                        |
| Database down (readiness) | `Readiness: database unreachable`                                                                                                                          |
| Database down at boot     | `Database unreachable at boot`                                                                                                                             |
| Redis down, back          | `Redis unavailable (`; `Redis connection restored after`                                                                                                   |
| Redis stalled, back       | `Redis is not answering (`; `Redis answering again after`                                                                                                  |
| Degraded rate limiting    | `Rate limiting falls back to per-instance counters`                                                                                                        |
| Stolen refresh token      | `Refresh token reuse for user`                                                                                                                             |
| Slow query                | `Slow query (`                                                                                                                                             |
| External call failed      | context `External:<name>`, `level=warn`                                                                                                                    |
| Boot of a release         | `Starting release <sha> in <environment>`                                                                                                                  |

## Escalation (REQUIERE CONFIGURACIÓN)

The contacts live in docs/incident-response.md#roles-and-contacts. A policy to start from:

| Severity           | Notifies                         | Acknowledge within (starting point) | If nobody acknowledges             | Updates                         |
| ------------------ | -------------------------------- | ----------------------------------- | ---------------------------------- | ------------------------------- |
| CRITICAL           | primary on-call (page)           | 5 minutes                           | secondary on-call after 15 minutes | every 30 minutes until resolved |
| CRITICAL, security | on-call and the security contact | 5 minutes                           | the engineering lead               | restricted channel              |
| WARNING            | the team's channel               | same working day                    | becomes a ticket after 24 hours    | in the ticket                   |

Every page that needed no action is a defect of the alert: tune it or delete it. Review the alerts
after each incident (did one fire first?) and once a quarter (noise, gaps), and fire a test alert
through the routing at least once a quarter.
