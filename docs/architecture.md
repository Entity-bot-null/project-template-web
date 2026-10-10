# Architecture

A pnpm workspace with two applications that ship together and share one contract.

```
apps/
  api/          NestJS HTTP API, Prisma (PostgreSQL), Zod, served under /api
  web/          React single-page app (Vite, React Router), typed client from the contract
openapi/        openapi.json: the committed API contract
e2e/            Playwright end-to-end suite (whole stack)
scripts/        repository tooling (branch names, hooks, bundle budget, env guard)
docs/           standards, guides, ADRs
.github/        CI/CD workflows, templates, CODEOWNERS, Dependabot, ruleset
```

Each app owns its `package.json`, `tsconfig`, tests and Dockerfile; tooling that must behave the
same everywhere (ESLint, Prettier, TypeScript base, commitlint, hooks) lives once at the root.

## Runtime topology

```
Client (browser)
   │  HTTPS
   ▼
CDN / WAF / load balancer        TLS, HSTS, DDoS protection           REQUIRES CONFIGURATION
   │
   ▼
web server (nginx)               SPA, security headers + CSP, /app-config.json, /healthz
   │  /api (one origin for the browser)
   ▼
API (NestJS), N instances        stateless; request ids, redaction, error classification
   │            │                 │
   ▼            ▼                 ▼
PostgreSQL     Redis              external services
(required)     (OPTIONAL: shared   (through the external HTTP client:
               rate limits, cache, timeouts, retries, correlation)
               locks, idempotency)
   │
   ▼  (every tier)
Observability: logs (stdout → the platform), error tracking (Sentry, OPTIONAL),
traces and metrics (OTLP → collector or provider, OPTIONAL), uptime checks and alerts
(REQUIRES CONFIGURATION)
```

The browser only ever talks to its own origin: the web server forwards `/api` to the API (in
development the Vite dev server does the same). So the refresh cookie is same-origin, CORS stays
off, and `SameSite=Strict` works. Several API instances need the shared rate limit store
(`RATE_LIMIT_STORE=redis`, docs/security.md#rate-limiting); everything else in the API is already
stateless.

## API (`apps/api`)

```
src/
  main.ts            entry point: crash handlers, telemetry and error tracking, then the server
  server.ts          Nest app: configureApp, Swagger UI outside production, listen
  app.module.ts      modules + global rate limiter (store from RATE_LIMIT_STORE)
  app.setup.ts       HTTP pipeline shared by main, tests and the OpenAPI export
  env/               the validated configuration (the only reader of process.env)
  common/            cross-cutting: error filter, envelope interceptor, Zod pipe, OpenAPI
                     decorators, request id + access log, CSRF guard, external HTTP client,
                     pagination, types
  observability/     redaction, request context, error tracker (Sentry adapter), telemetry
                     (OpenTelemetry SDK, loaded only when on), application metrics
  infrastructure/    optional infrastructure behind interfaces: redis/ (connection),
                     rate-limit/, cache/, coordination/ (locks, idempotency)
  lifecycle/         shutdown sequence (drain, close, flush)
  auth/              sign-in, refresh rotation, logout, JWT guard, roles guard, @Auth()
  users/             example resource: me, admin list, owner-or-admin read
  health/            liveness and readiness probes
  prisma/            PrismaService (generated client in prisma/generated, ignored by git)
  openapi/           document builder, export script, drift spec
  seed/              development accounts (refuses production)
prisma/              schema.prisma, migrations/
test/                integration plumbing
```

**Request pipeline** (`configureApp` and `AppModule`, in order): request id + request context +
access log → helmet
headers → `Cache-Control: no-store` → CORS (only if configured) → JSON-only bodies → cookie parser
→ global guards: Fetch Metadata (CSRF), then the rate limiter → route guards (`@Auth`: JWT, then
roles) → Zod validation pipe → handler → envelope interceptor; any exception → error filter.

**Module conventions:** one folder per feature (`controller`, `service`, `dto/*.schemas.ts`, specs
next to them, an `*.int.spec.ts`). Controllers are thin: parse (decorators), authorize (`@Auth`),
delegate. Services hold the rules and the queries, including ownership checks. DTOs are Zod
schemas; their inferred types are the TypeScript types. Response objects come from explicit
`select`s.

**Authentication flow:**

```
sign-in ─► 200 { accessToken (15 min), user }   + Set-Cookie: the refresh token (httpOnly;
          __Host-refresh_token in production, refresh_token on /api/auth elsewhere)
          (a new session family; the browser's previous one, if any, ends)
API call ─► Authorization: Bearer <accessToken>
401 ─► POST /api/auth/refresh (cookie) ─► new access token + rotated cookie ─► replay once
reload ─► boot: POST /api/auth/refresh (only if the has_session hint cookie exists)
logout ─► the session family ends, cookies cleared, other tabs signed out
replay of an old refresh token ─► its whole family ends (theft), logged
```

## Optional infrastructure

Every piece below is OPTIONAL: the template runs, passes every gate and deploys without it. Each one
sits behind an interface with an in-process implementation, so turning it on is configuration, not
a code change, and feature code never depends on the provider (ESLint keeps `@redis/client`,
`@sentry/*` and the OpenTelemetry SDK out of feature code).

| Capability                | Without configuration (CORE)           | With configuration (OPTIONAL)                      | Switch                         |
| ------------------------- | -------------------------------------- | -------------------------------------------------- | ------------------------------ |
| Rate limit counters       | in memory, per instance                | Redis, shared by every instance                    | `RATE_LIMIT_STORE=redis`       |
| Cache                     | in memory, per instance, bounded       | Redis, shared                                      | `CACHE_STORE=redis`            |
| Locks, idempotency claims | in process                             | Redis, across instances                            | `REDIS_URL`                    |
| Error tracking            | logs only                              | Sentry                                             | `SENTRY_DSN`, `WEB_SENTRY_DSN` |
| Traces and metrics        | not loaded                             | OpenTelemetry → OTLP                               | `OTEL_EXPORTER_OTLP_ENDPOINT`  |
| Job queues                | not included (integration point below) | BullMQ or a managed queue, when a project needs it | code                           |

### Redis

`infrastructure/redis/redis.service.ts` owns the one connection (node-redis). Only the adapters in
`infrastructure/` use it.

- **Lifecycle:** connects in the background at boot (the boot never waits for Redis), closes on
  shutdown after requests have drained (falls back to destroying the socket after 2 s).
- **Reconnect:** exponential backoff with jitter from 100 ms to 5 s, forever: Redis coming back after
  an outage is picked up without a restart. Only state changes are logged: connected, unavailable
  (once per outage), restored after N seconds; not answering, answering again. An error on a
  connection that is still up (a keep-alive PING answered `BUSY`) is not an outage.
- **Timeouts:** 5 s to connect; each command at most `REDIS_COMMAND_TIMEOUT_MS` (500 ms), already
  sent or not (a Redis that stays connected but stops answering fails the command at the deadline;
  a late reply is dropped). While disconnected, commands fail at once instead of queueing. Replies
  that mean "not now" (`LOADING`, `BUSY`, `READONLY`, `MISCONF` on a full disk, `OOM`...) count as
  unavailable too.
- **Stalls:** after 3 commands in a row get no reply in time, commands fail at once, without being
  sent, for 5 s; then one PING probes Redis: a reply ends the stall, another timeout starts another
  5 s. A Redis that is connected but stalled costs three requests the timeout, not every request.
- **Health:** a PING for readiness (`redis: ok | unavailable | disabled`); a hard dependency only
  with `REDIS_REQUIRED=true`.
- **Keys:** `REDIS_KEY_PREFIX` + feature + key, e.g. `app:cache:profiles:3:user-7`,
  `app:ratelimit:{default:<hash>}:hits`, `app:lock:jobs:report`. One prefix per application and
  environment when they share a Redis. Every key the template writes has a TTL (cache generations
  excepted: a few bytes per namespace).
- **ACL for production:** a user limited to `~<prefix>*` and the commands the adapters run:
  `+get +set +del +incr +eval +evalsha +ping +time +pttl +pexpire +zadd +zcard +zrange +zremrangebyscore`
  (plus `+client|setinfo`, `+hello`, `+auth` for the connection handshake).
- **Server:** any Redis-compatible server (Redis, Valkey, managed services). Development uses
  `redis:8-alpine` (`docker compose --profile redis up -d`); production settings:
  [docs/security.md#redis](security.md#redis).

### Degradation

What each feature does while an optional Redis is configured but unreachable, or connected but
stalled (it never stops the boot):

| Feature            | Behavior while Redis is down                                                                                                 | Recovers            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Readiness          | 200 `degraded` (503 with `REDIS_REQUIRED=true`), within 2.5 s even when Redis does not answer                                | at once             |
| Rate limiting      | per-instance memory counters: still limits, never fails open                                                                 | at the next request |
| Cache              | reads miss, writes are skipped: every request is served from the source of truth                                             | at the next request |
| Cache invalidation | kept and retried before the next cache operation, once per key (past 100 keys, one `invalidate()`); the TTL bounds staleness | when Redis answers  |
| Locks, idempotency | fail closed: `RedisUnavailableError`, answered 503 in a request                                                              | at the next call    |
| Redis stalled      | 3 commands wait the command timeout; then all fail at once for 5 s between PING probes, and the fallbacks above apply        | at the next probe   |
| Everything else    | unaffected                                                                                                                   |                     |

Each fallback is logged once and counted (`app.degraded.operations`); readiness shows it.

### Cache

`CacheService` (`infrastructure/cache/`), explicit and opt-in: nothing is cached unless a service
asks, HTTP responses never are.

```ts
const profiles = this.cache.namespace<ProfileView>('profiles', { ttlSec: 60 });
const view = await profiles.getOrSet(userId, () => this.loadProfile(userId));
await profiles.delete(userId); // after changing that profile
await profiles.invalidate(); // after a change that affects every entry
```

- **Use it for** reads that are expensive, frequent, and tolerate being up to `ttlSec` old:
  reference data, computed aggregates, responses of slow external services.
- **Don't use it for** data that changes on every request, data that must be read fresh (balances,
  stock, permissions), or cheap queries (a primary key lookup is already fast).
- **Never cache** tokens, sessions, passwords or hashes, authorization decisions or roles (a
  revoked permission must apply at once), personal data across users (a key must always include
  the owner), or anything a user must see change immediately.
- **Keys:** a namespace per kind of value (`[a-z][a-z0-9-]*`), the key inside it; long keys are
  hashed. **TTL** is mandatory and capped at 24 h. Values are JSON; `undefined` is never cached.
- **Stale data:** delete the entry where the data changes, in the same code path; use `invalidate()`
  (O(1): it bumps the namespace's generation) when a change affects many entries. `getOrSet`
  shares one load between concurrent callers and never stores a result that raced an
  `invalidate()`, or a `set()` or `delete()` of its key on the same instance. The remaining
  window (another instance changing the key while a slow load of it runs) is bounded by the TTL:
  keep TTLs short for data that changes.

### Locks and idempotency

`LockService` and `IdempotencyService` (`infrastructure/coordination/`), prepared for the cases
that need them; the template itself does not (its scheduled session sweep is harmless if two
instances run it).

- **`withLock(name, ttlMs, work)`:** one instance at a time runs `work` (a scheduled report, a
  migration-like job); the others get `{ acquired: false }` at once. The TTL must exceed the work.
- **`claim(scope, key, { processingTtlSec, doneTtlSec })`:** the first delivery of a message id (a
  webhook event, a job id) gets the claim for `processingTtlSec`. `complete()` it once processed:
  later deliveries are `done` (acknowledge them) for `doneTtlSec`. `release()` it when processing
  fails, so the sender's retry goes through. A delivery that arrives while another one is being
  processed is `in-progress`: answer it with an error status so the sender retries, never with a
  2xx, which would lose the message if the first attempt then fails or crashes. An attempt that
  crashes holds the message until `processingTtlSec` runs out, then a retry processes it.
- Both are leases with a TTL: an efficiency and deduplication tool, not a correctness guarantee (a
  paused owner can lose its lease). **Payments and anything that must happen exactly once** use the
  database: an idempotency key with a unique constraint, written in the same transaction as the
  effect. Without `REDIS_URL` they hold within one process only.

### Job queues

Not included: no queue library is installed until a project needs one. The integration point, when
work must leave the request (emails, image processing, document generation, heavy computations):

```
API ──enqueue (job name, payload with ids only)──► queue (Redis: BullMQ, or SQS / Pub/Sub / ...)
                                                       │
                                     worker (apps/worker) ◄┘  same env validation, logger,
                                                              redaction, error tracking,
                                                              telemetry and shutdown sequence
```

- Add `apps/worker` as another app (see [Extending](#extending)): its own entry point importing the
  same `observability/` setup and the modules it needs, no HTTP server, SIGTERM stops taking jobs
  and finishes the current one.
- Producer side: a `JobQueue` interface in `infrastructure/` with the provider adapter, so feature
  code enqueues without knowing the provider; payloads carry ids, never personal data or secrets.
- Jobs are idempotent (they will be retried): check and claim with `IdempotencyService`, or make the
  write itself idempotent. Propagate the request id (and trace context) in the job's metadata.
- With BullMQ on the same Redis, its keys have no TTL: keep `maxmemory-policy` on `volatile-*` or
  `noeviction` (the template's `volatile-lru` already protects them), or give queues their own
  Redis.

## Web (`apps/web`)

```
src/
  main.tsx, App.tsx    mount, boot refresh, router
  router.tsx           every route, guarded as layout routes
  api/                 client.ts (openapi-fetch), errors.ts (call, describeFailure), schema.d.ts (generated)
  monitoring/          runtime config (/app-config.json), error tracking (Sentry), Web Vitals; lazy chunks
  auth/                session store (token in memory), 401 middleware, guards, useAuth
  hooks/               useLoader (load, retry, stale-response protection)
  components/          layout and shared UI
  pages/               one component per screen
  test/                setup, HTTP mocks, fixtures, render helper
```

Styling is plain CSS on purpose (`index.css`): the design system is a product decision (OPCIONAL:
Tailwind, CSS modules, a component library).

## Key decisions

| Decision                                                                      | Why                                                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| pnpm workspace, one lockfile                                                  | One install, one audit, one set of hooks and gates for every app.                      |
| Contract generated from Zod + controllers, committed and drift-checked        | Validation and documentation cannot disagree; contract changes are reviewed as a diff. |
| Access token in memory, refresh token httpOnly + rotation                     | No token reachable by injected scripts; stolen refresh tokens are detected on reuse.   |
| One origin through a proxy                                                    | Same-origin cookies, no CORS, strict SameSite.                                         |
| Validated env, fail fast                                                      | Misconfiguration stops the deploy instead of failing a request later.                  |
| ESLint `strictTypeChecked` + TypeScript `strict` + `noUncheckedIndexedAccess` | Bugs found by the compiler and linter, not by users.                                   |
| Integration tests on a real PostgreSQL                                        | Locks, constraints and migrations are part of the behavior.                            |

Record new decisions as ADRs in `docs/adr/`.

## Extending

Step-by-step recipes with a complete, tested example: [how-to.md](how-to.md).

- **New API module:** copy `users/` or follow [the recipe](how-to.md#add-an-api-module). The Nest
  CLI generators produce class-validator DTOs and Jest specs, which this template does not use.
- **New database table:** [the recipe](how-to.md#add-a-table-or-a-column) (`pnpm db:migrate` creates,
  applies and regenerates).
- **New screen:** [the recipe](how-to.md#add-a-screen-to-the-web-app): a page in `pages/`, its route
  under the right guard, API calls through `api` + `call()`, a component spec.
- **Another app** (public website, admin console, background worker): a new folder in `apps/` with
  its own `package.json` (picked up by the workspace), tsconfig extending `tsconfig.base.json`,
  `test`/`typecheck`/`build` scripts (picked up by the root commands), and its own Dockerfile.
  A background worker (OPCIONAL) follows the API's patterns: validated env, structured logs,
  graceful shutdown on SIGTERM, idempotent jobs.
- **Optional infrastructure** (queues, email, object storage, search): add it like the existing
  adapters: an interface and an in-process or fake implementation in `infrastructure/`, the
  provider adapter next to it, its variables in the env schema, its health in the readiness probe
  (hard or degradable), its degraded behavior in the table above, and an integration spec that
  runs in CI against a throwaway container.
