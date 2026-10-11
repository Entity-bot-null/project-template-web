# Observability

What the application tells you about itself, what is on by default, what each project turns on,
and how the signals answer the questions of an incident. Alerts and SLOs built on these signals:
[alerting.md](alerting.md); the runbooks that use them: [incident-response.md](incident-response.md).

## What is included

| Capability                                                                    | Class                  | On by default                  | Needs                                           |
| ----------------------------------------------------------------------------- | ---------------------- | ------------------------------ | ----------------------------------------------- |
| Structured logs (JSON in production) with automatic redaction                 | CORE                   | yes                            | nothing                                         |
| Request ids on every response, log line, error report and outgoing call       | CORE                   | yes                            | nothing                                         |
| Deployment identity (environment, release) on every log line and report       | CORE                   | yes                            | the image build (release) and `APP_ENVIRONMENT` |
| Liveness and readiness probes (database, Redis when configured)               | CORE                   | yes                            | nothing                                         |
| Graceful shutdown (drain, close, flush)                                       | CORE                   | yes                            | nothing                                         |
| Error classification (application, database, dependency) and the error metric | CORE                   | yes                            | nothing                                         |
| Slow query log (statement only)                                               | CORE                   | yes (500 ms)                   | nothing                                         |
| Shared client for external services (timeouts, retries, correlation)          | CORE                   | yes                            | nothing                                         |
| Error tracking, API and web (Sentry)                                          | OPTIONAL               | no                             | REQUIRES CONFIGURATION: a Sentry project        |
| Tracing and metrics (OpenTelemetry, OTLP)                                     | OPTIONAL               | no                             | REQUIRES CONFIGURATION: a collector or provider |
| Web Vitals of real page loads (LCP, INP, CLS, FCP, TTFB), per page            | OPTIONAL               | sent; recorded with metrics on | OpenTelemetry metrics                           |
| Local observability backend (Grafana, Prometheus, Tempo, Loki)                | OPTIONAL (development) | no                             | Docker                                          |
| Uptime monitoring                                                             | REQUIRES CONFIGURATION | no                             | an external uptime service                      |
| Dashboards, SLOs and alert rules as code, tested (`observability/`)           | OPTIONAL               | locally                        | Grafana and a Prometheus-compatible backend     |
| Alert routing (who is paged, where warnings go)                               | REQUIRES CONFIGURATION | no                             | Alertmanager, Grafana contact points or similar |

Nothing optional is needed to run, test or deploy the template: without `SENTRY_DSN` and
`OTEL_EXPORTER_OTLP_ENDPOINT` the SDKs are not even loaded.

## Questions an incident asks

| Question                                             | Answered by                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the application failing?                          | Uptime checks and readiness; 5xx rate (`app.server.errors`, `http.server.request.duration` by status); new issues in Sentry                                     |
| When did it start?                                   | The metric's time series; the issue's first-seen time in Sentry                                                                                                 |
| How many users does it affect?                       | Sentry's users per issue (opaque user ids); share of requests failing; distinct `userId` in error log lines                                                     |
| Which endpoint is failing?                           | `http.route` on metrics, spans and error reports; the path in the error log line (`GET /api/users/7 -> 500`)                                                    |
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

Spans and metrics also carry `service.instance.id`, a random id per process (the `instance` label
the dashboards and alerts group by), and nothing about the machine: no host name (a container's id,
or on a developer's computer often the person's name) and no machine id. To name the server, set
`OTEL_RESOURCE_ATTRIBUTES=host.name=<name>`.

## Logs

- One logger for the API (`common/logging/logger.ts`, Nest's `ConsoleLogger` extended): **JSON
  lines in production** (`{"level","pid","timestamp","message","context","service","environment",
"release","requestId","traceId","spanId"}`), readable text in development. `LOG_LEVEL` sets the
  minimum level; `LOG_FORMAT` overrides the format.
- **Redaction, automatic** (`apps/api/src/observability/redact.ts`): every message, object, error and stack trace
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
  (`common/logging/request-context.middleware.ts`), written when the response is sent
  (`request completed`). Health probes log at `debug`. A request whose connection closes first (the
  client or the proxy gave up, a shutdown cut it) gets its one line then: `request aborted` with
  `aborted: true` (`aborted` after the duration in text lines), the time until the connection
  closed, and the status only if the response had started (`statusCode: null` otherwise, `-` in
  text lines). Many of them on one route point at a slow dependency behind it.
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
2. requests in flight finish (at most 10 seconds, then their connections are closed: each request
   cut leaves an access line marked aborted);
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
`apps/api/src/observability/sentry.ts` and `apps/web/src/monitoring/sentry.ts`), and every event is scrubbed again
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

| Signal                        | Instrumentation                         | Data                                                                                                       |
| ----------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Server spans + request metric | HTTP (`instrumentation-http`)           | one span per request; `http.server.request.duration` (method, route, status)                               |
| Route spans                   | Express                                 | the route pattern of each request (`GET /api/users/:id`) and its handler, also on the HTTP metrics         |
| Database spans + pool metrics | PostgreSQL (`instrumentation-pg`)       | one span per query (statement with placeholders, never values); connection pool usage and waiting requests |
| Client spans + client metric  | fetch (`instrumentation-undici`)        | outgoing calls; `http.client.request.duration`; W3C trace context injected                                 |
| Redis metrics                 | node-redis's own                        | command duration and errors, connections                                                                   |
| Runtime metrics               | Node.js runtime                         | event loop delay and utilization, heap, garbage collection                                                 |
| Process metrics               | built in                                | `process.cpu.time`, `process.memory.usage` (RSS)                                                           |
| Application metrics           | `apps/api/src/observability/metrics.ts` | see [Metrics](#metrics)                                                                                    |

NestJS handler spans are not included: the official instrumentation does not support Nest 12 yet
(add `@opentelemetry/instrumentation-nestjs-core` when it does). Nest 12 loads its HTTP platform
with `import()`, so the SDK also registers an in-thread ESM loader hook (`import-in-the-middle`)
limited to the instrumented modules (`http`, `https`, `express`, `pg`, `pg-pool`).

Health probes are never traced. Every span is checked before export (`RedactingSpanProcessor`):
query strings and URL credentials removed, a value under a sensitive name (`authorization`,
`cookie`, `password`, `token`...: the log redaction's list) masked whole, and every other string
attribute, string arrays included, redacted like log lines, on the span and on its events (an
exception event carries the error's message and stack trace), and so is its status message.

The telemetry's own requests (the OTLP exports, the error tracker's reports) are sent with tracing
suppressed and never counted in `http.client.request.duration`: the collector does not show up as
an external service.

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
Tempo, Loki, Grafana in one image, development only), with the dashboards and rules of
`observability/` mounted read-only
([Dashboards and alerts as code](#dashboards-and-alerts-as-code)). Set
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in `apps/api/.env`, restart `pnpm dev`, send a
few requests, and open Grafana at http://localhost:3001:

- Dashboards → Application: "API service", "API SLOs" and "Web Vitals" (browse the app of
  `pnpm dev`, then switch tabs: a page load reports when it is hidden);
- Alerting → Alert rules: the Prometheus rules, under data source-managed, evaluated every 30
  seconds (nothing is notified: routing is not configured locally);
- Explore → Tempo for traces, Prometheus for metrics; Prometheus itself on http://localhost:9090.

Grafana reloads a changed dashboard file within 30 seconds; Prometheus reads the rule files when it
starts, so after changing them run `docker compose --profile observability restart otel-lgtm`. The
API pushes metrics every minute (`OTEL_METRIC_EXPORT_INTERVAL`): set 5000 locally to see panels
fill sooner. Never deploy this service: its Grafana has anonymous admin access.

## Dashboards and alerts as code

The dashboards, the SLOs and the alert rules are files in `observability/`, reviewed and tested
like code, and tied to no vendor: Grafana dashboards that read any Prometheus-compatible data
source, and Prometheus rule files that Prometheus, Grafana Mimir and Grafana Cloud load unchanged.

| File                                                    | What                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observability/grafana/dashboards/api-service.json`     | "API service": rate, errors and latency per route, 5xx by origin, readiness, Node.js runtime, database, cache, Redis, external calls, degraded features                          |
| `observability/grafana/dashboards/api-slo.json`         | "API SLOs": objective, SLI and error budget over 30 days, burn rate per alert window, the SLO alerts                                                                             |
| `observability/grafana/dashboards/web-vitals.json`      | "Web Vitals": p75 of LCP, INP, CLS, FCP and TTFB, per page over time, share of good page loads, page loads by navigation type, the Web Vitals alerts ([Web Vitals](#web-vitals)) |
| `observability/prometheus/rules/api-slo.yaml`           | the availability and latency SLOs: recording rules and multiwindow burn-rate alerts ([alerting.md](alerting.md#slis-and-slos))                                                   |
| `observability/prometheus/rules/api-alerts.yaml`        | symptom alerts ([below](#alerts))                                                                                                                                                |
| `observability/prometheus/rules/web-vitals-alerts.yaml` | Core Web Vitals at p75 above "good" on a page ([below](#alerts))                                                                                                                 |
| `observability/prometheus/tests/*.test.yaml`            | unit tests of the rules with synthetic series (`promtool test rules`)                                                                                                            |
| `observability/prometheus/prometheus.yaml`              | the local backend's Prometheus configuration, which loads the rules                                                                                                              |
| `observability/grafana/dashboards.yaml`                 | the local backend's dashboard provider (folder "Application")                                                                                                                    |
| `observability/api-metrics.json`                        | the series the API exports ([Metric catalog](#metric-catalog))                                                                                                                   |

**Rules of the files**, checked by `pnpm observability:check` (CI job "Observability as code";
needs Docker, and the part that does not also runs in `pnpm test:scripts`):

- every query reads its data source through the dashboard's `datasource` variable, never a fixed
  uid, so the same JSON imports into any Grafana; the other variables are `job`
  (`OTEL_SERVICE_NAME`) and `environment` (`APP_ENVIRONMENT`);
- every metric a dashboard or rule reads is in the catalog or written by a recording rule: a
  renamed metric fails the check instead of leaving an empty panel or an alert that never fires;
- every alert has a `severity` label (`critical` pages, `warning` goes to the team's channel), a
  `runbook_url` to a section of [incident-response.md](incident-response.md) that exists, the
  `dashboard_uid` to open first, a summary and a description, and a unit test that makes it fire;
- promtool, pinned in `.github/tool-images/Dockerfile`, checks the configuration and the rules,
  parses every dashboard query (each one compiled into a recording rule) and runs the unit tests.

`runbook_url` is a path in this repository: make it a link in the notification template of your
routing (the repository's URL in front). The rules group by `job` and
`deployment_environment_name`, so two services, or staging and production, can share a backend
without mixing; that needs `deployment.environment.name` kept as a label (Prometheus:
`otlp.promote_resource_attributes`, as `observability/prometheus/prometheus.yaml` does), or one
backend per environment.

### Alerts

Thresholds are starting points ([alerting.md](alerting.md#alert-catalog)); a change comes with its
unit test.

| Alert                           | Severity | Fires when                                                                                   | Runbook                                                                              |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ApiAvailabilityBudgetFastBurn` | critical | 5xx burn rate above 14.4 over 1 hour and over 5 minutes, at least 100 requests in the hour   | [5. High 5xx rate](incident-response.md#5-high-5xx-rate)                             |
| `ApiAvailabilityBudgetSlowBurn` | warning  | burn rate above 6 over 6 hours and 30 minutes, or above 1 over 3 days and 6 hours            | [5. High 5xx rate](incident-response.md#5-high-5xx-rate)                             |
| `ApiLatencyBudgetFastBurn`      | critical | the same burn rates, counting responses slower than 500 ms (authentication excluded)         | [6. High latency](incident-response.md#6-high-latency)                               |
| `ApiLatencyBudgetSlowBurn`      | warning  | as the availability slow burn, for the latency SLO                                           | [6. High latency](incident-response.md#6-high-latency)                               |
| `ApiReadinessFailing`           | critical | an instance's readiness answered 503 in every 2-minute window for 2 minutes                  | [2. Readiness failing](incident-response.md#2-readiness-failing)                     |
| `ApiDatabaseErrors`             | critical | 5xx with origin `database` for 2 minutes                                                     | [3. Database unavailable](incident-response.md#3-database-unavailable)               |
| `ApiRouteErrorRatioHigh`        | warning  | a route's 5xx above 5 % for 10 minutes, with at least 20 requests                            | [5. High 5xx rate](incident-response.md#5-high-5xx-rate)                             |
| `ApiRouteLatencyHigh`           | warning  | a route's p95 above 500 ms for 15 minutes (authentication excluded)                          | [6. High latency](incident-response.md#6-high-latency)                               |
| `ApiDegradedMode`               | warning  | a feature served by its fallback for 5 minutes (Redis or the cache store down)               | [4. Redis unavailable](incident-response.md#4-redis-unavailable)                     |
| `ApiDependencyFailing`          | warning  | over 5 % of a dependency's calls failing for 10 minutes, with at least 20 calls              | [12. External dependency outage](incident-response.md#12-external-dependency-outage) |
| `ApiDatabasePoolSaturated`      | warning  | requests waiting for a database connection for 5 minutes                                     | [6. High latency](incident-response.md#6-high-latency)                               |
| `ApiEventLoopDelayHigh`         | warning  | event loop p99 above 200 ms for 15 minutes                                                   | [7. Memory or CPU pressure](incident-response.md#7-memory-or-cpu-pressure)           |
| `ApiMetricsAbsent`              | warning  | no metrics from the API for 10 minutes (the dead man's switch: every other alert is blind)   | [1. API down](incident-response.md#1-api-down)                                       |
| `WebVitalsLcpPoor`              | warning  | a page's LCP p75 over the last hour above 2.5 s for 30 minutes, from at least 100 page loads | [15. Poor Web Vitals](incident-response.md#15-poor-web-vitals)                       |
| `WebVitalsInpPoor`              | warning  | the same for INP above 200 ms                                                                | [15. Poor Web Vitals](incident-response.md#15-poor-web-vitals)                       |
| `WebVitalsClsPoor`              | warning  | the same for CLS above 0.1                                                                   | [15. Poor Web Vitals](incident-response.md#15-poor-web-vitals)                       |

Health probes are not in the HTTP metrics: `ApiReadinessFailing` counts the 503s the error filter
records (`app_server_errors_total{error_origin="unavailable", http_route="/api/health/ready"}`),
so something must probe readiness (the orchestrator, or an internal uptime check). On the VPS
target nothing does between deployments: the container health check probes liveness, and the edge
answers 404 to `/api/health/` from outside. There, `ApiReadinessFailing` stays silent until an
internal check polls readiness; a database outage still shows as `ApiDatabaseErrors`, the SLO
alerts and the uptime check.
`ApiMetricsAbsent` names the job `api`: edit it if `OTEL_SERVICE_NAME` differs.

### Use them with your backend

The files stay the same; only how they are loaded changes (REQUIRES CONFIGURATION):

- **Grafana Cloud** (or self-hosted Grafana Mimir): send the API's OTLP to the stack
  ([OpenTelemetry](#opentelemetry)). Dashboards: Dashboards → New → Import, one JSON file at a
  time, choosing the stack's Prometheus data source for `datasource`; or from a pipeline, Grafana's
  HTTP API (`POST /api/dashboards/db` with `{"dashboard": <file>, "overwrite": true}`). Rules, with
  [mimirtool](https://grafana.com/docs/mimir/latest/manage/tools/mimirtool/): each file becomes a
  namespace named after it, evaluated by the stack's ruler, listed in Alerting → Alert rules as
  data source-managed:

  ```sh
  mimirtool rules check observability/prometheus/rules/*.yaml   # offline
  mimirtool rules load observability/prometheus/rules/*.yaml \
    --address=<the stack's Prometheus URL> --id=<its instance id> --key=<token with rules:write>
  ```

- **Grafana and Prometheus, self-hosted:** the dashboards through a file provider like
  `observability/grafana/dashboards.yaml` (or imported as above); the rule files in Prometheus'
  `rule_files` (`promtool check config` before reloading); an Alertmanager for the routing.
- **The data source's scrape interval**, in every case: the API pushes its metrics every
  `OTEL_METRIC_EXPORT_INTERVAL` (60 s), and the panels' `$__rate_interval` is derived from the
  Prometheus data source's scrape interval (15 s unless set). Set it to 60 s (the data source's
  settings, "Scrape interval"), or the rate panels can show gaps or nothing over short ranges. The
  2-minute rules (`ApiReadinessFailing`, `ApiDatabaseErrors`) need two exports in their window:
  keep `OTEL_METRIC_EXPORT_INTERVAL` at 60000 or below.
- **Routing**, in every case: `severity="critical"` to the on-call person's pager,
  `severity="warning"` to the team's channel, per
  [alerting.md](alerting.md#escalation-requiere-configuración).

### Metric catalog

`observability/api-metrics.json` lists the series the API exports, named as Prometheus stores them,
with their attribute labels. The check refuses a dashboard or rule that reads anything else, and
`apps/api/src/observability/metrics-catalog.spec.ts` keeps the catalog true to the code: every
metric the process creates is listed under its Prometheus name, and the application's own
(`app_*`, `process_*`) with exactly their attributes. After adding a metric or upgrading an
instrumentation, rewrite it from real series: start the local backend, run the API against it with
traffic that exercises the metric, then
`node scripts/check-observability.mjs --update-catalog http://localhost:9090` and review the diff.

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

Add a metric for a feature in `apps/api/src/observability/metrics.ts`, with low-cardinality attributes only:
never user ids, emails or raw paths as attribute values.

## Web Vitals

How fast and stable the pages are for real users, measured in their browsers: the five metrics of
Google's [web-vitals](https://github.com/GoogleChrome/web-vitals) library for each page load. Sent
by default (`WEB_VITALS_SAMPLE_RATE`, 1); recorded only when the API's metrics are on
([OpenTelemetry](#opentelemetry)).

| Metric                         | Measures                                    | Good     | Poor above |
| ------------------------------ | ------------------------------------------- | -------- | ---------- |
| LCP, Largest Contentful Paint  | when the main content is painted            | ≤ 2.5 s  | 4 s        |
| INP, Interaction to Next Paint | how long the page takes to respond to input | ≤ 200 ms | 500 ms     |
| CLS, Cumulative Layout Shift   | how much the layout moves unexpectedly      | ≤ 0.1    | 0.25       |
| FCP, First Contentful Paint    | when the first content is painted           | ≤ 1.8 s  | 3 s        |
| TTFB, Time to First Byte       | when the first byte of the page arrives     | ≤ 0.8 s  | 1.8 s      |

LCP, INP and CLS are the Core Web Vitals: a page passes when all three are good for at least 75 %
of its page loads, so the dashboard and the alerts read the 75th percentile.

**From the browser to the metrics:**

1. After the first render, the app loads `monitoring/webVitals.ts` (a chunk of its own; the
   deployment settings are another, shared with error tracking) and, for the page loads the sample
   rate picks, the library with `monitoring/webVitalsReporter.ts` (3.7 kB gzip). Neither is in the
   initial bundle (budgets in `apps/web/performance-budget.json`); `WEB_VITALS_SAMPLE_RATE=0`
   loads no library at all.
2. The values are queued and sent in one request when the page is hidden (`visibilitychange`, or
   `pagehide`), the moment the library reports CLS, INP and LCP: with `navigator.sendBeacon`,
   which survives the page closing, or `fetch` with `keepalive` where a beacon is refused. A queue
   of 10 is sent at once. Each metric of a page load is sent once: the library reports CLS and INP
   again when a tab hidden and shown again is hidden once more, and those later values are not
   sent, so a page load is one sample of each metric (CLS and INP as they were when the page was
   first hidden), never one per visit to the tab.
3. `POST /api/telemetry/web-vitals` validates the batch and records two histograms; with metrics
   off it validates and answers 204 all the same, at the cost of a few function calls. The route is
   public and protected like every other ([security.md](security.md#web-vitals)).

| Metric (Prometheus name)                                                           | Attributes                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `app.web_vitals.duration` (`app_web_vitals_duration_seconds`): LCP, INP, FCP, TTFB | `web_vital.name`, `web_vital.rating`, `web_vital.navigation_type`, `page.route` |
| `app.web_vitals.cls` (`app_web_vitals_cls`)                                        | `web_vital.rating`, `web_vital.navigation_type`, `page.route`                   |

- `page.route` is the route pattern of the page as loaded (`/admin/users`, `/` for the index, `/*`
  for the not-found page), attributed to the page load like in the Chrome UX Report: never its URL
  or query string. The API accepts only the patterns of the app's routes (`WEB_VITALS_ROUTES` in
  `apps/api/src/telemetry/web-vitals.schemas.ts`), so no client can create series at will.
  **Adding a page:** add its pattern there and run `pnpm contract`; `webVitalsReporter.spec.ts`
  fails until the app's routes and the list match.
- `web_vital.rating` (`good`, `needs-improvement`, `poor`) is computed by the API from the value
  with the thresholds above, never taken from the client. The histograms' buckets hold every
  threshold, so a p75 compared with one, and the share of good page loads, are exact.
- `web_vital.navigation_type`: `navigate`, `reload`, `back-forward`, `back-forward-cache` (restored
  from the browser's cache, near-instant: read it apart), `prerender`, `restore`.

```promql
# LCP at the 75th percentile per page, over the last hour
histogram_quantile(0.75, sum by (le, page_route) (rate(app_web_vitals_duration_seconds_bucket{web_vital_name="LCP"}[1h])))
# Share of page loads with a good INP
sum(rate(app_web_vitals_duration_seconds_count{web_vital_name="INP", web_vital_rating="good"}[1h]))
  / sum(rate(app_web_vitals_duration_seconds_count{web_vital_name="INP"}[1h]))
```

The "Web Vitals" dashboard shows them, and three alerts warn when a page's LCP, INP or CLS p75
stays above "good" ([Alerts](#alerts)). With a lot of traffic, lower `WEB_VITALS_SAMPLE_RATE`: a
p75 is stable from a few hundred page loads per page and hour, and the alerts need 100.

**The first report of a new series is not counted.** The API pushes cumulative histograms, and
Prometheus computes `rate()` and `increase()` from the difference between two samples of a
series. A series starts when an API process records the first value of a label set (metric, page,
rating, navigation type): its first export has no sample before it, so the page loads it holds,
those of the first export interval (60 s), are in no `rate()` or `increase()`. Every API process
does this once per label set, and every restart or deployment starts new series (`instance` is new).
With steady traffic the loss is small. With little traffic it is not: a label set seen once per
process, such as a `poor` rating on a quiet page, is never counted, so the page-load counts read
low, the alerts' 100 page loads take longer to reach, and on quiet pages the p75 and the share of
good page loads lean towards good. The alerts and the dashboard are meant for pages with steady
traffic; read a quiet page over a longer range. Prometheus (3.15, the version the checks pin) has
no setting that turns the start of an OTLP series into a zero sample:
`created-timestamp-zero-ingestion` covers the scraped formats only. Every API metric behaves the
same right after a process starts.

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

The rules ship in `observability/prometheus/rules` ([Dashboards and alerts as
code](#dashboards-and-alerts-as-code)); loading them and routing their notifications is REQUIRES
CONFIGURATION in the chosen backend. The SLIs, SLOs and error budget, the burn-rate alerts, the
CRITICAL and WARNING catalog with thresholds, evaluation windows and escalation, and the log
patterns that alert without metrics: [alerting.md](alerting.md). What to do when an alert fires:
[incident-response.md](incident-response.md).
