# 0002. Observe with OpenTelemetry and Sentry, and keep Redis optional behind adapters

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** template maintainers

## Context

The template had structured logs, request ids, health probes and graceful shutdown. Production
needs more: error tracking, traces and metrics, uptime and alerts, and, for several instances, a
shared store for rate limits (plus cache, locks and idempotency when a product needs them). The
template must stay usable without any account or server (`pnpm install && pnpm dev`), keep every
existing gate, and avoid tying projects to one vendor. Security outranks everything: nothing
sensitive may leave the process through these new channels.

## Options

1. **Tracing and metrics:** a vendor SDK (Datadog, New Relic); `@opentelemetry/sdk-node` with
   auto-instrumentations (dozens of packages, gRPC and protobuf exporters); **a minimal
   OpenTelemetry setup**: the SDK packages, OTLP/HTTP exporters and five instrumentations (HTTP,
   Express, PostgreSQL, fetch, runtime), loaded only when an endpoint is configured. The NestJS
   instrumentation is left out until it supports Nest 12.
2. **Error tracking API:** `@sentry/node` 11 (sets up its own OpenTelemetry, conflicting with ours,
   and depends on `@sentry/bundler-plugins`, which brings the `sentry` CLI under FSL-1.1, a non-OSI
   license, into production); `@sentry/node-core` 10 (previous major); **`@sentry/core` 11** (the
   base of every Sentry SDK, one dependency) with an explicit client: no auto-instrumentation,
   capture where the error filter and the crash handlers decide.
3. **Error tracking web:** build-time DSN (one image per environment); **runtime config served by
   the web server** (`/app-config.json` from its environment, the CSP widened by the derived
   ingest origin only), with `@sentry/browser` in a lazy chunk.
4. **Redis client:** ioredis (maintenance mode); **node-redis** (official, OpenTelemetry metrics
   built in). Rate limit store: a community package; **our own store** with a Lua script that
   replicates the throttler's algorithm, falling back to memory.
5. **Queues:** BullMQ now; **an integration point only** until a project needs one.
6. **Process metrics:** `@opentelemetry/host-metrics` (depends on `systeminformation`, a package with
   a history of command injection advisories); **two observable instruments** from
   `process.cpuUsage()` and `process.memoryUsage()`.
7. **Local backend:** none; **an optional compose profile** with `grafana/otel-lgtm`.

## Decision

The options in bold. OpenTelemetry is the vendor-neutral instrumentation layer (export over OTLP to
any collector or provider); Sentry covers what traces do not (grouped errors, releases, browser
crashes) with every automatic collection off. Redis is optional infrastructure: each feature has an
interface, an in-process implementation and a Redis adapter, and a documented degraded behavior
(fallback to memory for rate limits, misses for the cache, fail closed for locks and claims).
Redaction is shared by the logger, the error tracker and the span processor.

## Consequences

- No optional integration is needed to develop, test or deploy; turning one on is configuration.
  ESLint keeps the SDKs and Redis out of feature code, so swapping a provider touches one adapter.
- `main.ts` must load the application after telemetry (dynamic import), and its static imports must
  stay free of instrumented modules. Because Nest 12 imports its HTTP platform with `import()`,
  the SDK registers an in-thread ESM loader hook (import-in-the-middle, `module.registerHooks`)
  restricted to the instrumented modules; Node.js versions without it are outside `engines`.
- The API's Sentry glue (about 100 lines on `@sentry/core`) is ours to maintain across Sentry
  majors; its options are typed so a renamed option fails the build.
- The rate limit script must keep matching the throttler's in-memory algorithm when the throttler
  changes: the integration spec compares both.
- The web bundle budget distinguishes the initial chunk from the lazy error tracking chunk.
- Wrong if: projects routinely need what the minimal OpenTelemetry setup leaves out (then add the
  instrumentation, or move to a collector-side solution), or the Sentry glue costs more than
  `@sentry/node` once its licensing and OpenTelemetry coupling are fixed upstream.
