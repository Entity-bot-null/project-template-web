# This template: Golden Template Web

What Doberman must know about this repository to review a change in it. The repository's own
documents are the authority: [AGENTS.md](../../../../AGENTS.md),
[DEFINITION_OF_DONE.md](../../../../DEFINITION_OF_DONE.md),
[docs/code-review.md](../../../../docs/code-review.md) (the reviewer checklist this audit extends),
[docs/architecture.md](../../../../docs/architecture.md),
[docs/security.md](../../../../docs/security.md),
[docs/api-conventions.md](../../../../docs/api-conventions.md),
[docs/testing.md](../../../../docs/testing.md), [docs/database.md](../../../../docs/database.md).
When this file and those disagree, they win; say so in the report.

## Contents

- [Stack](#stack)
- [Flows](#flows)
- [Invariants to check against](#invariants-to-check-against)
- [Red flags in a diff](#red-flags-in-a-diff)
- [Rollout impact](#rollout-impact)
- [Gates](#gates)
- [Whole-repository audit order](#whole-repository-audit-order)

## Stack

pnpm workspace: `apps/api` (NestJS, Prisma + PostgreSQL, Zod DTOs, optional Redis behind
adapters, OpenTelemetry and Sentry behind `observability/`), `apps/web` (React + Vite SPA,
openapi-fetch client, React Router), `apps/landing` (Astro + Tailwind CSS public site, static
pages in English and Spanish, no client JavaScript), OpenAPI contract first (`pnpm contract` writes
`openapi/openapi.json` and `apps/web/src/api/schema.d.ts`), TypeScript strict, Vitest (unit,
component, integration with supertest), Playwright (E2E), Docker images scanned by Trivy, VPS
deployment (`deploy/vps`).

## Flows

**Browser to database:**

```
Page (apps/web/src/pages) → useLoader (latest request wins) or an event handler
  → api client (apps/web/src/api/client.ts: openapi-fetch, same origin)
  → auth middleware (apps/web/src/auth/middleware.ts: bearer from memory, one refresh and one
                     replay after a 401)
  → call() (apps/web/src/api/errors.ts: folds into ApiResult { ok, data } | { ok: false, failure })
  → API request pipeline (apps/api/src/app.setup.ts + AppModule, in order):
      request id + context + access log → helmet → no-store → CORS (if configured)
      → JSON-only bodies → cookie parser → Fetch Metadata guard (CSRF) → rate limiter
      → @Auth (JwtAuthGuard, RolesGuard) → Zod validation pipe → controller (thin)
      → service (rules, ownership checks, explicit select) → Prisma → PostgreSQL
      → envelope interceptor { data, message } / error filter
  → state → Page (loading, loaded, failed + retry)
```

**Session** (docs/architecture.md, docs/security.md#authentication-and-tokens):

```
sign-in → access token (15 min) in memory + httpOnly refresh cookie + readable has_session hint
API call → Authorization: Bearer; 401 → POST /api/auth/refresh (single-flighted, Web Lock across
          tabs) → new token + rotated cookie → replay once
reload → boot: one refresh, only if the has_session hint exists
logout → local first, other tabs told, then the server ends the family and clears the cookies
replay of an already rotated refresh token (outside the race leeway) → the whole family ends
```

## Invariants to check against

**Web session** (`apps/web/src/auth/session.ts`, `middleware.ts`, `guards.tsx`)

- The access token lives in module memory only: never `localStorage`, `sessionStorage`, a
  readable cookie or a URL.
- One refresh at a time (`refresh()` single-flight, `navigator.locks` across tabs); every caller
  shares it. The server rotates the refresh token: two parallel refreshes race.
- `epoch` bumps on every sign-in and sign-out: a refresh that lands afterwards does not overwrite
  the outcome. `signIn` waits for a logout or refresh still in flight.
- Only a 401/403 on refresh ends the session; network errors and 5xx keep it (except at boot).
- The middleware refreshes once and replays once, only requests that carried a token, never
  for another user than the one who sent the request (another tab may have signed in as someone
  else), and never on the auth routes.
- Sign-out: local state first, other tabs told, then the server; a failed server logout is shown,
  not hidden.

**Web data and UI** (`apps/web/src/api/**`, `apps/web/src/hooks/**`, pages)

- The API only through `src/api/client.ts` and `call()`; never `fetch` directly.
- `useLoader`: every request takes a number and only the latest may set state (late responses after
  unmount, key change or retry are dropped). It does not abort the request: a change that relies on
  cancellation must pass a signal itself.
- Every page shows loading, empty, error and retry; mutations disable their submit while pending;
  errors come from `ApiFailure` messages; nothing renders untrusted HTML.
- Role-gated routes in the router are a convenience: the API decides.

**Landing** (`apps/landing/**`)

- Every visible text comes from the dictionaries (`src/i18n/en.ts`, `es.ts`), written in both
  languages in the same change; a page exists in every language (`src/pages/`, `src/pages/es/`).
- Static HTML and CSS only: no client script, no inline `style` attribute or `<style>` tag
  rendered into a page (the web server's Content-Security-Policy refuses them), no font or asset
  from another origin; the JavaScript budget of `apps/landing/performance-budget.json` is 0 kB.
- One `h1` per page, a heading on every section, landmarks, the skip link, `lang` on the page and
  on each language link; a picture of the app (`data-ui`) carries `role="img"` and a label in the
  page's language.
- Links into the app through `src/lib/links.ts` (`appPath`), never a hard-coded origin; canonical
  and alternate links, the sitemap and robots.txt from the build's `site`.

**API authorization and input** (`apps/api/src/**`)

- `@Auth(...)` on every non-public route (no roles = any signed-in user); a public route has a
  written reason. Handler-level `@Auth()` inside an `@Auth('admin')` controller keeps admin.
- Ownership in the service: a user asking for another user's record gets 404, not 403 and not the
  record (`UsersService.findVisible` is the pattern). Test matrix: allowed role, forbidden role,
  anonymous, another user's record.
- Zod schemas for bodies and queries (`@ZodBody`, `@ZodQuery`), sizes bounded; responses from an
  explicit `select` (never the password hash, never a whole row); `@ApiData` / `@ApiErrors` keep the
  contract honest.
- `process.env` only in `apps/api/src/env/env.ts`; a new variable in the schema, `.env.example`
  and docs/environment.md; optional integrations off by default and never stopping the boot.

**API sessions** (`apps/api/src/auth/sessions.service.ts`, `auth.controller.ts`)

- Refresh tokens: 32 random bytes, stored as SHA-256; single use; rotation inside a family; a
  token reused within the leeway is a client race (the loser gets a 401, nothing revoked); reused
  later is theft (the family ends). Every session change of a user takes that user's row lock.
- Cookie attributes (`httpOnly`, `secure`, `sameSite`, path, `__Host-` prefix in production) are
  security controls; the Fetch Metadata guard and JSON-only bodies are the CSRF defense.
- Sign-in and refresh have their own rate limits (`@Throttle`), on top of the global limiter.

**Database** (`apps/api/prisma/**`, docs/database.md)

- Schema changes ship as a committed migration made by `pnpm db:migrate`; a committed migration
  is never edited; destructive changes follow expand/contract so the previous version keeps working
  during the deploy.
- New queries have their indexes; list queries are paginated with a bounded limit; raw SQL only
  through the tagged `$queryRaw` (lint bans the unsafe variants).
- Writes that must be atomic use a transaction; concurrent writers of the same row are serialized
  (row lock, `LockService`) or idempotent (`IdempotencyService`).

**Infrastructure and observability**

- Redis, Sentry and the OpenTelemetry SDK only behind `CacheService`, `LockService`,
  `IdempotencyService`, `errorTracker()` and `observability/` (lint rule); without Redis the API
  degrades as docs/architecture.md#degradation says, and that path is tested.
- External calls through `createExternalHttpClient`: a timeout per attempt, retries only for
  idempotent requests and retryable failures, request id and trace propagation, logs and metrics
  with the method and path only (never headers, query strings or bodies).
- `new Logger(...)` output is redacted, but code logs ids, never personal data; metrics use
  low-cardinality attributes only. Web: `reportError()`.

**Gates and supply chain**

- No threshold (`vitest.config.ts`, `vite.config.ts`), lint rule, budget
  (`apps/web/performance-budget.json`, `apps/landing/performance-budget.json`), ignore file,
  supply-chain setting (`pnpm-workspace.yaml`),
  dependency policy or workflow permission weakened; `nosemgrep`/`eslint-disable` carry their reason.
- Dependencies go to the app that uses them; the root only gets repository tooling.
- A deployment change updates docs/deploy-vps.md and both step-by-step guides; the manual and the
  step-by-step guide change in English and Spanish together.

## Red flags in a diff

Each one is a lead to verify, not a finding by itself:

- A new controller method without `@Auth` (or with a weaker role than its controller), or a service
  method that loads by id without checking the actor.
- `findUnique`/`findMany` without `select`, or a response built by spreading a Prisma row.
- `$queryRawUnsafe`, `$executeRawUnsafe`, string-built SQL, `orderBy` from user input without an
  allowlist, `take` without a maximum.
- `process.env` outside `env.ts`; a new secret with a default value; an optional integration that
  throws when unconfigured.
- Changes to `refresh()`, `epoch`, `boot()`, `signIn`/`signOut` order, the middleware's replay,
  cookie options, the Fetch Metadata guard, CORS origins or rate limits.
- `fetch(` in the SPA, the access token stored anywhere but the session module, `dangerouslySetInnerHTML`.
- `useEffect` + request + `setState` outside `useLoader` (no latest-wins guard); a mutation whose
  button is not disabled while pending; a list not refreshed after its mutation.
- A migration that drops or renames a column or table in one step; an edited migration.
- `openapi/openapi.json` or `schema.d.ts` edited without `pnpm contract`, or a controller change
  without them.
- Tests whose stubs answer instantly for a flow whose bug is a race; integration tests that only
  test the happy path of a protected route.

## Rollout impact

A change is released by the deploy workflow (images built, scanned, migrations run before the new
version). Check: migrations safe while the previous version runs, new environment variables
documented and defaulted safely, breaking API changes marked (`!`, `BREAKING CHANGE:`) and
coordinated with open browser tabs (the SPA in a tab is the previous version until reload).

## Gates

The plan comes from `doberman.mjs start` (`verify` in `package.json`, plus the CI-only gates of
`template.json`). Notes:

- `pnpm verify` = format, lint (Prisma client generated first), typecheck (the web contract types
  check included), unit and component tests with coverage (the OpenAPI drift spec included),
  security, build, performance budget. Run them one by one so each gets its own result.
- `pnpm test:integration` needs PostgreSQL: `DATABASE_URL` from the environment or `apps/api/.env`
  (without it: `SKIPPED — REQUIRES CONFIGURATION`; never create the file), and the server running.
  The plan's `services` says when to start the development services (`pnpm services:up`:
  PostgreSQL, Redis and Mailpit) and how to stop them (`docker compose stop db redis mailpit`). The
  Redis adapter specs and the outbox specs use `REDIS_URL` and `MAIL_SMTP_URL` of `apps/api/.env`
  (or `REDIS_TEST_URL` and `MAIL_TEST_SMTP_URL`); without a URL they are skipped locally: report
  them as not run.
- `pnpm test:e2e` after `pnpm build`; Playwright starts the API (`<db>_e2e`) and the web preview by
  itself, and needs Chromium installed (never install it on the user's behalf).
- Images: only when the change touches what goes into them (paths in the plan); build with the
  workflow's Dockerfiles and targets, scan with the pinned Trivy, then remove the `doberman-scan/*`
  images.
- `pnpm test:scripts` (CI only, outside `verify`): the tests of the repository's own scripts, the
  Doberman engine and Semgrep's file selection. On Windows the POSIX signal test is skipped.
- `pnpm iac:check` (Docker and the network) only when the change touches `infra/`,
  `deploy/vps/db-init.sh`, the tool images or its scripts: Terraform checks, TFLint, Trivy,
  cloud-init and the two roles scripts (Terraform's and the server's). Never a real
  `terraform plan` or `apply`: they need a DigitalOcean account and token.
- `pnpm sast` and `pnpm lint:workflows` need Docker; `pnpm security` needs the network. gitleaks
  needs commits; on Windows (Git Bash) the plan's `commandWindows` passes a Windows path to Docker.
- `pnpm observability:check` (Docker; when `observability/**` or `.github/tool-images/**` change):
  dashboards and alert rules against runbooks and exported metrics, then promtool and rule tests.
- `pnpm contract` writes files: never run it in the workspace. Contract drift is already checked by
  `pnpm typecheck` and the drift spec in `pnpm test:coverage`.

## Whole-repository audit order

With `--full` or a repository without commits, review by risk, following the flows instead of
reading every file: API authorization and ownership → sessions and the web session store →
request pipeline hardening (CSRF, CORS, rate limits, headers) → input and output validation →
database and migrations → infrastructure degradation → observability and redaction → web data and
UI states → deployment and images → gates, CI and supply chain → tests (do they prove the above?)
→ docs consistency.
