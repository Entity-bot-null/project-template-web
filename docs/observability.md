# Observability

What the application tells you about itself, what is on by default, what each project turns on,
and how the signals answer the questions of an incident. Alerts and SLOs built on these signals:
[alerting.md](alerting.md); the runbooks that use them: [incident-response.md](incident-response.md).

## What is included

| Capability                                                                    | Class                  | On by default | Needs                                           |
| ----------------------------------------------------------------------------- | ---------------------- | ------------- | ----------------------------------------------- |
| Structured logs (JSON in production) with automatic redaction                 | CORE                   | yes           | nothing                                         |
| Request ids on every response, log line, error report and outgoing call       | CORE                   | yes           | nothing                                         |
| Deployment identity (environment, release) on every log line and report       | CORE                   | yes           | the image build (release) and `APP_ENVIRONMENT` |
| Liveness and readiness probes (database, Redis when configured)               | CORE                   | yes           | nothing                                         |
| Graceful shutdown (drain, close, flush)                                       | CORE                   | yes           | nothing                                         |
| Error classification (application, database, dependency) and the error metric | CORE                   | yes           | nothing                                         |
| Slow query log (statement only)                                               | CORE                   | yes (500 ms)  | nothing                                         |
| Shared client for external services (timeouts, retries, correlation)          | CORE                   | yes           | nothing                                         |
| Error tracking, API and web (Sentry)                                          | OPTIONAL               | no            | REQUIRES CONFIGURATION: a Sentry project        |
| Tracing and metrics (OpenTelemetry, OTLP)                                     | OPTIONAL               | no            | REQUIRES CONFIGURATION: a collector or provider |
| Local observability backend (Grafana, Prometheus, Tempo, Loki)                | OPTIONAL (development) | no            | Docker                                          |
| Uptime monitoring                                                             | REQUIRES CONFIGURATION | no            | an external uptime service                      |
| Alerting, dashboards, SLOs                                                    | REQUIRES CONFIGURATION | no            | the monitoring backend the project picks        |

Nothing optional is needed to run, test or deploy the template: without `SENTRY_DSN` and
`OTEL_EXPORTER_OTLP_ENDPOINT` the SDKs are not even loaded.

## Questions an incident asks

| Question                                             | Answered by                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the application failing?                          | Uptime checks and readiness; 5xx rate (`app.server.errors`, `http.server.request.duration` by status); new issues in Sentry                                     |
| When did it start?                                   | The metric's time series; the issue's first-seen time in Sentry                                                                                                 |
| How many users does it affect?                       | Sentry's users per issue (opaque user ids); share of requests failing; distinct `userId` in error log lines                                                     |
| Which endpoint is failing?                           | `http.route` on metrics, spans, error reports and the error log line (`GET /api/users/:id -> 500`)                                                              |
| Which version introduced it?                         | `release` (the commit SHA) on every log line, error report and span; Sentry's "first seen in release"; compare by `service.version`                             |
| Where exactly?                                       | The stack trace (Sentry, error log line); the trace's spans: route, Express handler, query, outgoing call                                                       |
| Application, database, infrastructure or dependency? | `error.origin` (`application`, `database`, `dependency`, `unavailable`) on the error metric, log line and report; readiness checks; pool and dependency metrics |
| Isolated error or regression?                        | Sentry issue frequency and its release; error rate before and after a deployment (`service.version`)                                                            |

## Identity

Every JSON log line, error report and span says which deployment and build produced it:

- `service` (`OTEL_SERVICE_NAME`, default `api`);
- `environment` (`APP_ENVIRONMENT`, default `NODE_ENV`): set `staging` or `production`, both run
  `NODE_ENV=production`;
- `release` (`APP_RELEASE`): the images are built with the commit SHA (`docker-images.yml`);
  `unversioned` when nothing set it (local runs).

## Logs

- One logger for the API (`common/logging/logger.ts`, Nest's `ConsoleLogger` extended): **JSON
  lines in production** (`{"level","pid","timestamp","message","context","service","environment",
"release","requestId","traceId","spanId"}`), readable text in development. `LOG_LEVEL` sets the
  minimum level; `LOG_FORMAT` overrides the format.
- **Redaction, automatic** (`observability/redact.ts`): every message, object, error and stack trace
  is masked before it is printed: values under sensitive keys (`password`, `token`, `authorization`,
  `cookie`, `apiKey`, `secret`...), and credentials written inline in strings (connection strings,
  bearer tokens, JWTs, `token=` in URLs, private keys, well-known provider tokens). A secret handed to
  the logger by mistake comes out as `[REDACTED]` ([security.md](security.md#logging)).
- **Correlation:** a line written while serving a request carries its `requestId` (and the
  `traceId`/`spanId` when tracing is on), wherever in the code it was written. Text lines show
  `(req <id>)`.
- Use `new Logger(ClassName.name)`; never `console.log` in application code (lint rule).
- **Access log:** one line per request with `requestId`, method, path, status, `durationMs`, the
  client `ip` and the `userId` when a guard identified one
  (`common/logging/request-context.middleware.ts`). Health probes log at `debug`.
- **Web server access log** (nginx, `apps/web/nginx/default.conf.template`): address, time, method,
  path without the query string, status, bytes, duration, user agent and `request_id`, the same id
  the API logs for that request.
- **Never logged:** headers, cookies, tokens, request or response bodies, query strings, passwords,
  environment values. Log identifiers (user id, record id, request id), not personal data.
- **Errors:** every 5xx is logged once by the error filter with the stack, the request id and its
  origin: `GET /api/users/7 -> 502 (request 0190..., dependency: billing)`. 4xx are normal client
  behavior and not logged as errors.
- Logs go to stdout/stderr; the platform collects them (REQUIRES CONFIGURATION: retention, access,
  search).

## Request ids

Every response carries `X-Request-Id`. An incoming id (from a proxy or another service) is kept if
it is well formed, otherwise replaced; the web image's nginx sends its own `$request_id`, so proxy
and API lines correlate. The id is also attached to the request's span (`app.request_id`), to its
error reports (`request_id` tag) and to outgoing calls made through the external HTTP client
(`X-Request-Id` header). Bug reports ask for it (`.github/ISSUE_TEMPLATE/bug_report.yml`).

## Health checks

| Endpoint                | Meaning                               | Used by                                             |
| ----------------------- | ------------------------------------- | --------------------------------------------------- |
| `GET /api/health/live`  | the process serves requests           | container `HEALTHCHECK`, restart policies           |
| `GET /api/health/ready` | hard dependencies reachable, else 503 | orchestrator readiness, deploy smoke test           |
| `GET /healthz` (web)    | nginx serves                          | web container `HEALTHCHECK`, external uptime checks |

Readiness answers `{ status, checks: { database, redis } }`:

- the database is always a hard dependency: unreachable → 503;
- Redis is checked only when configured: `disabled` without `REDIS_URL`; when it is down,
  `status: "degraded"` with 200 (features fall back, docs/architecture.md#degradation), or 503
  with `REDIS_REQUIRED=true`;
- during shutdown it answers 503 at once, so no new traffic is routed to the instance.

Probes are exempt from rate limiting, never require authentication, and are not traced. The
orchestrator calls the API's probes on the API itself: the web server answers 404 for
`/api/health/` (in any letter case) from outside, so the public cannot read dependency status or
make the API query the database at will. Add every new hard dependency to the readiness check.

Readiness answers within 2.5 seconds whatever its dependencies do: the database and Redis are
checked at once, and a check that has not answered by then counts as unreachable (503 for the
database, `degraded` for an optional Redis). Requests are bounded too: the pool waits at most 5
seconds for a connection, the database cancels a statement after `DB_STATEMENT_TIMEOUT_MS` (30 s)
and the driver gives up 5 seconds later, and each Redis command waits at most
`REDIS_COMMAND_TIMEOUT_MS` (a stalled Redis is then skipped for a few seconds:
docs/architecture.md#redis). An unreachable or stalled dependency fails requests and the readiness
check instead of hanging them. An API started while the database is down boots anyway, logs
`Database unreachable at boot (<host>: <reason>)` and answers readiness with 503 until the database
answers.

## Graceful shutdown

On SIGTERM (`app.enableShutdownHooks()`, `lifecycle/shutdown.ts`):

1. readiness starts answering 503 and the HTTP server stops accepting connections;
2. requests in flight finish (at most 10 seconds, then their connections are closed);
3. the modules close: database pool, Redis connection, timers;
4. buffered spans, metrics and error reports are flushed; the process exits.

Each step is logged (`Shutting down...`, `HTTP server closed`, `Redis connection closed`,
`Shutdown complete (SIGTERM)`). Containers run `node` directly (no shell wrapper), so the signal
reaches it. Give the platform a termination grace period above 15 seconds.

An exception or rejected promise that nothing caught is logged at `fatal` with its stack, reported
to the error tracker (waiting at most 2 seconds for it to be sent) and the process exits
(`main.ts`): the orchestrator restarts a clean process instead of serving from an unknown state.
Alert on `fatal` lines.

## Error tracking

OPTIONAL, REQUIRES CONFIGURATION (a Sentry project, sentry.io or self-hosted). Off without a DSN:
errors are then only logged.

**What is reported:**

| Source                                                                             | API | Web |
| ---------------------------------------------------------------------------------- | --- | --- |
| Unexpected errors behind a 500 (bugs), database failures                           | yes |     |
| Failing external services and Redis (`origin: dependency`), grouped per dependency | yes |     |
| Uncaught exceptions and unhandled rejections (crashes)                             | yes | yes |
| Errors thrown while rendering a route (`RouteErrorPage`)                           |     | yes |
| 4xx, deliberate 503s (readiness, shutdown), 404 pages                              | no  | no  |

**Metadata on each report:** environment, release, request id, method, route pattern
(`/api/users/:id`), status code, error origin and dependency, an opaque user id; in the browser the
page path and the source (`route`, `window`). Nothing else.

**Never sent** ([security.md](security.md#error-tracking-data)): passwords, tokens, cookies,
`Authorization` headers, request and response bodies, query strings, local variables, console
output. The SDK's own data collection is switched off category by category (`DATA_COLLECTION` in
`observability/sentry.ts` and `apps/web/src/monitoring/sentry.ts`), and every event is scrubbed again
before it leaves (`scrubEvent`), with the same redaction as the logs.

**Setup:**

1. Create two Sentry projects: one Node.js (API), one browser JavaScript (web). Separate projects
   keep their quotas and permissions apart.
2. API: `SENTRY_DSN` (and optionally `SENTRY_SAMPLE_RATE`), from the platform's secret store.
3. Web: `WEB_SENTRY_DSN` on the web container (public by design: it only allows sending events).
   The web server serves it to the app in `/app-config.json` and adds Sentry's ingest origin to the
   CSP `connect-src`, nothing else.
4. Set `APP_ENVIRONMENT` on both, and deploy images built by CI (the release is baked in).

| Environment | API                                                                 | Web                                                  |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| development | unset (errors in the console); or a dev project's DSN               | unset; `WEB_SENTRY_DSN` for `pnpm dev`               |
| test / CI   | unset: no account needed, nothing sent                              | unset                                                |
| staging     | the project's DSN, `APP_ENVIRONMENT=staging`                        | the browser project's DSN, `APP_ENVIRONMENT=staging` |
| production  | the same DSN, `APP_ENVIRONMENT=production`; https only (boot check) | the same, `APP_ENVIRONMENT=production`               |

Use the same projects for staging and production and filter by environment; alert rules should
target production. To check a configuration without a real failure, stop the database briefly in
staging and call an authenticated route: one `database` issue appears, with the request id.

Implementation: the API builds its client on `@sentry/core` (the base of every Sentry SDK), not
`@sentry/node`, which brings its own OpenTelemetry setup and a CLI under a non-OSI license
([ADR 0002](adr/0002-observability-and-optional-infrastructure.md)). The web SDK
(`@sentry/browser`) is a separate chunk, fetched only when a DSN is configured (bundle budget in
`apps/web/performance-budget.json`).

## OpenTelemetry

OPTIONAL. On when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (and `OTEL_SDK_DISABLED` is not `true`);
off, the SDK is never imported and nothing is patched, so development and tests pay no overhead.

**What it generates:**

| Signal                        | Instrumentation                   | Data                                                                                                       |
| ----------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Server spans + request metric | HTTP (`instrumentation-http`)     | one span per request; `http.server.request.duration` (method, route, status)                               |
| Route spans                   | Express                           | the route pattern of each request (`GET /api/users/:id`) and its handler, also on the HTTP metrics         |
| Database spans + pool metrics | PostgreSQL (`instrumentation-pg`) | one span per query (statement with placeholders, never values); connection pool usage and waiting requests |
| Client spans + client metric  | fetch (`instrumentation-undici`)  | outgoing calls; `http.client.request.duration`; W3C trace context injected                                 |
| Redis metrics                 | node-redis's own                  | command duration and errors, connections                                                                   |
| Runtime metrics               | Node.js runtime                   | event loop delay and utilization, heap, garbage collection                                                 |
| Process metrics               | built in                          | `process.cpu.time`, `process.memory.usage` (RSS)                                                           |
| Application metrics           | `observability/metrics.ts`        | see [Metrics](#metrics)                                                                                    |

NestJS handler spans are not included: the official instrumentation does not support Nest 12 yet
(add `@opentelemetry/instrumentation-nestjs-core` when it does). Nest 12 loads its HTTP platform
with `import()`, so the SDK also registers an in-thread ESM loader hook (`import-in-the-middle`)
limited to the instrumented modules (`http`, `https`, `express`, `pg`, `pg-pool`).

Health probes are never traced. Every span is checked before export: query strings and URL
credentials removed, string attributes redacted like log lines (`RedactingSpanProcessor`).

**Where it goes:** OTLP over HTTP (JSON) to `<OTEL_EXPORTER_OTLP_ENDPOINT>/v1/traces` and
`/v1/metrics`, metrics every `OTEL_METRIC_EXPORT_INTERVAL` ms (default 60 s). Provider credentials
go in `OTEL_EXPORTER_OTLP_HEADERS` (for example `Authorization=Basic ...`), from the secret store;
the code never reads them. Traces are propagated with W3C `traceparent` to downstream services.

**Sampling:** every trace by default. In production set the standard variables, for example
`OTEL_TRACES_SAMPLER=parentbased_traceidratio` and `OTEL_TRACES_SAMPLER_ARG=0.1` (10 % of new
traces, and whatever the caller decided for propagated ones). Metrics are not sampled.

**Connecting a collector or provider** (REQUIRES CONFIGURATION), two shapes, both standard OTLP:

```
API ──OTLP──► OpenTelemetry Collector ──► Prometheus / Mimir (metrics) ──► Grafana (dashboards, alerts)
                (sidecar or gateway)    └─► Tempo / Jaeger (traces)

API ──OTLP──► managed provider (Grafana Cloud, Honeycomb, Datadog, New Relic, Elastic, ...)
```

- Self-hosted: run an OpenTelemetry Collector next to the API (`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
  for a sidecar), with an `otlp` receiver and the exporters of your backends (`prometheusremotewrite`,
  `otlp` to Tempo). The collector is also where to add tail sampling, attribute filtering or a
  second destination without touching the application.
- Managed: point `OTEL_EXPORTER_OTLP_ENDPOINT` at the provider's OTLP/HTTP endpoint and put its key
  in `OTEL_EXPORTER_OTLP_HEADERS`. A provider that only accepts OTLP over gRPC or protobuf needs a
  collector in between.
- Logs stay on stdout (the platform ships them); the trace and span ids in each JSON line link them
  to traces in any backend that indexes them.

### Local backend

`docker compose --profile observability up -d` starts `grafana/otel-lgtm` (collector, Prometheus,
Tempo, Loki, Grafana in one image, development only). Set
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in `apps/api/.env`, restart `pnpm dev`, send a
few requests, and open Grafana at http://localhost:3001: Explore → Tempo for traces, Prometheus for
metrics. Never deploy this service: its Grafana has anonymous admin access.

## Metrics

With telemetry on, these answer the usual questions (names as exported; Prometheus converts dots to
underscores and adds unit suffixes, `http_server_request_duration_seconds`):

| Question                 | Metric                                                                                  | Example (PromQL)                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request count            | `http.server.request.duration` (count)                                                  | `sum by (http_route) (rate(http_server_request_duration_seconds_count[5m]))`                                                                                             |
| Error rate               | same, by `http_response_status_code`; `app.server.errors` by `error.origin`             | `(sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])) or vector(0)) / sum(rate(http_server_request_duration_seconds_count[5m]))` |
| Latency p50 / p95 / p99  | `http.server.request.duration` (histogram)                                              | `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[5m])))`                                                              |
| Database latency         | `db.client.operation.duration` (pg), slow query count `app.db.slow_queries`             | `histogram_quantile(0.95, sum by (le) (rate(db_client_operation_duration_seconds_bucket[5m])))`                                                                          |
| Connection exhaustion    | `db.client.connection.count` (state used/idle), `db.client.connection.pending_requests` | pending requests above zero for minutes                                                                                                                                  |
| External service latency | `app.dependency.duration` (dependency, outcome, status), `http.client.request.duration` | p95 and failure share per `dependency_name`                                                                                                                              |
| Degraded features        | `app.degraded.operations` (feature, dependency)                                         | any increase while Redis is down                                                                                                                                         |
| Cache effectiveness      | `app.cache.operations` (namespace, result)                                              | hit ratio per namespace                                                                                                                                                  |
| Process health           | `nodejs.eventloop.delay.*`, `v8js.memory.heap.used`, `v8js.gc.duration`                 | event loop p99 delay                                                                                                                                                     |
| CPU and memory           | `process.cpu.time`, `process.memory.usage`                                              | `rate(process_cpu_time_seconds_total[5m])` against the container's CPU limit                                                                                             |

Percentiles are computed by the backend from histogram buckets; the API exports the buckets, not
precomputed percentiles. CPU and memory of the container itself (limits, throttling, OOM kills)
come from the platform (cAdvisor, the cloud provider's metrics), not from inside the process.

Add a metric for a feature in `observability/metrics.ts`, with low-cardinality attributes only:
never user ids, emails or raw paths as attribute values.

## Database

| To detect             | Signal                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Database unavailable  | readiness 503 (`Database unreachable`), `Database unreachable at boot`, `error.origin=database` errors, failing pg spans  |
| Slow queries          | `Slow query (812 ms): SELECT ...` warnings (statement only, `DB_SLOW_QUERY_MS`), `app.db.slow_queries`, pg span durations |
| Connection exhaustion | pool metrics (used vs. max, pending requests); requests failing after the 5 s connect timeout                             |
| High latency          | `db.client.operation.duration` p95/p99                                                                                    |
| Failed transactions   | 5xx with `error.origin=database` (logged with stack, reported); error status on pg spans                                  |

Queries are never logged with their values, and spans record statements with placeholders only
(`enhancedDatabaseReporting` stays off). Don't log every query: the slow query log and the spans
are enough; raise `DB_SLOW_QUERY_MS` if it gets noisy, lower it to hunt.

## External services

Call third-party APIs through `createExternalHttpClient` (`common/http/external-http.ts`, recipe in
[how-to.md](how-to.md#call-an-external-service)): per-attempt timeout, retries with backoff only
for idempotent requests and retryable failures (network, timeout, 429, 502-504, honoring
`Retry-After`), the request id and trace context forwarded, one metric
(`app.dependency.duration` with `dependency.name`, outcome, status) and one log line per call with
method and path only. A failure raises `ExternalServiceError`, which the error filter answers with
502 (or 504 for a timeout) and records as `origin: dependency`, so a provider's outage is never
counted as an application bug. API keys come from env through the `headers` option and are never
logged.

## Uptime monitoring

REQUIRES CONFIGURATION: any external uptime service works (status page tools, the cloud
provider's synthetic checks, a self-hosted prober); none is assumed.

| Check                                                            | From                                                                       | Detects                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET https://<public URL>/healthz`, expect 200 within 5 s        | outside, several regions, every 1 min                                      | application unavailable (web tier), timeouts, TLS/DNS problems |
| `GET https://<public URL>/` , expect 200 and the app's `<title>` | outside, every 5 min                                                       | broken deployments that still answer `/healthz`                |
| `GET http://<api>:3000/api/health/ready`, expect 200             | inside the platform (the orchestrator, or a prober on the private network) | readiness failure, database down, required Redis down          |
| a page that calls the API, expect 200                            | outside, every 5 min                                                       | HTTP 5xx from the API through the proxy                        |

Alert after two or three consecutive failures from more than one location (one failed probe is
noise). The readiness probe must stay off the public internet; `/healthz` and the public pages are
what the outside sees.

## Alerting

REQUIRES CONFIGURATION in the chosen backend. The SLIs, SLOs and error budget, the burn-rate
alerts, the CRITICAL and WARNING catalog with thresholds, evaluation windows and escalation, and
the log patterns that alert without metrics: [alerting.md](alerting.md). What to do when an alert
fires: [incident-response.md](incident-response.md).
