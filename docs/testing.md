# Testing

## Kinds of tests

| Kind           | What it proves                                                                       | Runner                           | Files                              | Needs                                  |
| -------------- | ------------------------------------------------------------------------------------ | -------------------------------- | ---------------------------------- | -------------------------------------- |
| Unit           | one function, class or hook, dependencies faked                                      | Vitest (`node` for API)          | `*.spec.ts` next to the code       | nothing                                |
| Component      | a React component or screen, through the DOM, as a user                              | Vitest + Testing Library (jsdom) | `*.spec.tsx` next to the code      | nothing                                |
| Integration    | the real API over HTTP with a real database; the Redis adapters against a real Redis | Vitest + supertest               | `apps/api/src/**/*.int.spec.ts`    | PostgreSQL (+ Redis, optional locally) |
| End-to-end     | critical user flows in a real browser, full built stack                              | Playwright (Chromium)            | `e2e/*.e2e.ts`                     | PostgreSQL, build, browser             |
| Contract drift | code, `openapi.json` and the web types agree                                         | Vitest spec + typecheck script   | `openapi.spec.ts`, `api-types.mjs` | nothing                                |

### File naming

- `*.spec.ts(x)`: unit and component tests, next to the file they test (`users.service.ts` →
  `users.service.spec.ts`).
- `*.int.spec.ts`: API integration tests, next to the module (`auth.int.spec.ts`).
- `e2e/*.e2e.ts`: end-to-end tests.
- `*.test.*` is **not used**: one suffix per kind keeps runners and reviewers unambiguous, and no
  runner collects `.test.` files, so they would silently never run.

### Structure

```
apps/api/src/<module>/x.ts           code
apps/api/src/<module>/x.spec.ts      unit tests
apps/api/src/<module>/<module>.int.spec.ts   integration tests
apps/api/test/                       integration plumbing: app factory, DB reset, auth helpers, env
apps/web/src/<area>/X.tsx            code
apps/web/src/<area>/X.spec.tsx       unit/component tests
apps/web/src/test/                   setup, HTTP mocks, fixtures, render helpers
e2e/                                 Playwright specs
```

## Commands

```
pnpm test               unit + component, every app (fast, no services)
pnpm test:coverage      the same with coverage thresholds
pnpm test:integration   API against PostgreSQL (pnpm db:up first); the Redis adapter specs too
                        when a Redis is up (docker compose --profile redis up -d, REDIS_URL in
                        apps/api/.env, or REDIS_TEST_URL), skipped when no Redis URL is set, required in CI;
                        the email outbox specs against Mailpit the same way (pnpm services:up,
                        MAIL_SMTP_URL in apps/api/.env, or MAIL_TEST_SMTP_URL + MAILPIT_TEST_URL):
                        they write to addresses of their own and delete only those
pnpm test:e2e           browser suite (pnpm db:up and pnpm build first; browser once:
                        pnpm exec playwright install chromium)
pnpm test:scripts       the repository scripts' own tests (scripts/*.test.mjs, node --test)
pnpm --filter api test:watch / pnpm --filter web test:watch
```

## Mocks, HTTP mocks and fixtures

- **API unit tests** construct the class with fakes (`new UsersService(fakePrisma)`) rather than
  a Nest testing module; `vi.fn()` for spies; `vi.mock('../../env/env.js', ...)` to vary
  configuration; real `JwtService` and real argon2 where they are cheap.
- **Web HTTP mocks:** `stubFetch({ 'GET /api/users': () => ok({...}) })` from `src/test/http.ts`
  replaces `fetch` with a router answering API envelopes; an unexpected request fails the test.
  Helpers: `ok`, `failure`, `session`, `json`, `deferred` (hold a response to test loading and
  races), `setSessionHint`.
- **Fixtures:** `src/test/fixtures.ts` (typed from the generated contract, so a contract change
  breaks a stale fixture at compile time); `apps/api/test/auth.ts` (`seedUser`, `signIn`, `asUser`
  mints a token without a database row); `apps/api/test/access.ts` (`expectRecordAccess`, the
  object-level authorization matrix of a route on one record: [authorization.md](authorization.md#tests)).
- **Integration state:** each suite builds its own app (`createTestApp`), and resets the database
  (`resetDatabase`) where it writes. Suites run one file at a time on `<db>_test`, created and
  migrated by the global setup. Never point them at a database you care about.
- **E2E state:** `<db>_e2e`, migrated, emptied and seeded with the development accounts on every run.
- **Redis state:** each Redis spec writes under its own random key prefix (`it-<id>:`) and deletes
  its keys afterwards, so a development Redis is safe to use. `createTestApp(customize)` overrides
  providers (`REDIS_OPTIONS`, `RATE_LIMIT_STORE`) to run the real application on the test Redis, or
  on one nobody listens on to test the degraded mode.
- **Observability in specs:** telemetry specs use in-memory exporters or a loopback OTLP collector,
  Sentry specs a stubbed `fetch`: nothing leaves the machine, no account is needed.

## Writing good tests

- Test behavior through the public surface (HTTP for the API, roles and labels for the UI:
  `getByRole`, `getByLabelText`), not private details.
- One reason to fail per test; the name says the rule (`answers 404 for another user's record`).
- Every bug fix starts with a failing test.
- Authorization: for every protected route, test the allowed role, a forbidden role, anonymous,
  and another user's record.

## Coverage

V8 coverage per app, thresholds in `apps/api/vitest.config.ts` and `apps/web/vite.config.ts`,
enforced by `pnpm test:coverage` (in `pnpm verify` and CI). Reports: `apps/*/coverage/index.html`.

The thresholds are a **ratchet**, not a target picked in advance: they were set to the coverage
measured when the template was built, rounded down, and raised since with the coverage (API:
lines 95, branches 87, functions 91, statements 94; web: lines 95, branches 87, functions 93,
statements 93).

**What the API number measures:** the logic (services, guards, pipes, filters, utilities, env
schema). Controllers and modules are excluded: they are wiring (routes, decorators, the module
graph), verified by the integration suite, which runs against a database and is therefore not part
of the fast coverage gate. So a new module does not lower coverage by its controller, but it does by
any service method without a unit test.

For a new project: keep them as the floor; after a feature raises coverage, raise the thresholds in
the same pull request; lower them only in a reviewed pull request that explains why. When new code
falls below the floor, add the tests it lacks; in practice, error paths and every service method
([how-to.md](how-to.md#add-an-api-module) shows a module that passes). Critical areas can get
their own stricter numbers with glob keys, for example
`thresholds: { 'src/auth/**': { lines: 95 } }`.

## Performance budget

`pnpm perf:check` (after `pnpm build`; in `pnpm verify` and CI) compares the gzip size of the
built web assets with `apps/web/performance-budget.json`. The template's budget is its measured
build rounded up (initial JavaScript 110 kB, the lazy error tracking chunk 35 kB, the lazy Web
Vitals chunks 5 kB, all JavaScript 145 kB, CSS 5 kB). Each project should set its own from its
targets (device class, network, Core Web Vitals goals) and raise it only deliberately. Load
testing of the API is OPTIONAL and project-specific: [load-testing.md](load-testing.md).
