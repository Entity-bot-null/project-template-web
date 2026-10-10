# Source analysis

This template was extracted from a production web platform: a NestJS API, a React SPA, a static
marketing site and a media-processing worker, developed by a small team. This document records what
that code base actually had, what became part of the template, what was left out, and what was
missing and had to be added. Names, domains, credentials and business logic of the source were
removed; nothing here identifies it.

Tags: **REUTILIZABLE** (taken into the template), **ESPECÍFICO DEL PROYECTO** (left out),
**OPCIONAL** (documented, not included), **REQUIERE CONFIGURACIÓN** (included, must be set per
project), **FALTABA** (absent in the source, added).

## 1. Stack

| Existed in the source                                   | Tag                     | In the template                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24, pnpm, TypeScript 6, ESM                     | REUTILIZABLE            | Same; Node pinned in `.nvmrc`, `engines`, `packageManager`                                                                                                            |
| NestJS 12 on Express 5                                  | REUTILIZABLE            | Same                                                                                                                                                                  |
| Prisma 7 with the PostgreSQL driver adapter             | REUTILIZABLE            | Same (pinned 7.10)                                                                                                                                                    |
| Zod 4 for env, bodies, queries, responses               | REUTILIZABLE            | Same                                                                                                                                                                  |
| React 19, Vite, React Router, openapi-fetch             | REUTILIZABLE            | Same (React Router 8)                                                                                                                                                 |
| Vitest, Testing Library, jsdom, supertest               | REUTILIZABLE            | Same                                                                                                                                                                  |
| Redis (cache, rate limits, denylist), job queues        | REUTILIZABLE / OPCIONAL | Redis adapters included, off by default (rate limits, cache, locks, idempotency); denylist and job queues not included (docs/architecture.md#optional-infrastructure) |
| Tailwind CSS                                            | OPCIONAL                | Not included (design system is a product choice)                                                                                                                      |
| Astro static marketing site                             | OPCIONAL                | Not included; "another app" in docs/architecture.md                                                                                                                   |
| Background media-processing worker                      | ESPECÍFICO DEL PROYECTO | Removed; worker pattern documented                                                                                                                                    |
| S3-compatible storage, SMTP email, payment placeholders | ESPECÍFICO DEL PROYECTO | Removed                                                                                                                                                               |

## 2. Architecture

| Existed                                                                         | Tag          | Template                                                                  |
| ------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| Separate projects side by side, one lockfile each, deliberately not a workspace | Deviation    | One pnpm workspace: one install, one audit, one set of gates              |
| Browser talks to one origin (`/api` behind the same host)                       | REUTILIZABLE | Kept: Vite proxy in development, nginx in the web image                   |
| The API image built and served both frontends                                   | Deviation    | Separate `api` and `web` images; nginx serves the SPA and forwards `/api` |
| Committed `openapi.json` shared by API and SPA                                  | REUTILIZABLE | Kept, moved to `openapi/`                                                 |
| Module-per-feature backend, thin controllers, services own rules                | REUTILIZABLE | Kept                                                                      |

## 3. Quality tools

| Existed                                                     | Tag          | Template                                                                                       |
| ----------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Biome (lint + format) in the API and the worker             | Replaced     | ESLint `strictTypeChecked` + Prettier everywhere (type-aware rules, one formatter)             |
| oxlint in the SPA, no formatter; nothing in the static site | FALTABA      | Same ESLint + Prettier for every file                                                          |
| `lint` script = Biome + `tsc --noEmit`                      | REUTILIZABLE | Split into `lint` and `typecheck`, both at the root                                            |
| `strict` TypeScript in API and worker, **not** in the SPA   | FALTABA      | `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` everywhere (`tsconfig.base.json`) |

## 4. Testing

| Existed                                                                                                                                              | Tag                     | Template                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| Unit specs next to the code (`*.spec.ts`)                                                                                                            | REUTILIZABLE            | Kept                                                        |
| HTTP tests of the real app against a real `<db>_test` database (global setup creates and migrates it, truncate between tests, offline-minted tokens) | REUTILIZABLE            | Kept, renamed `*.int.spec.ts` (they are integration tests)  |
| SPA specs with Testing Library and a fetch router stub                                                                                               | REUTILIZABLE            | Kept (`src/test/http.ts`)                                   |
| Worker integration tests on real tools in a Docker test stage                                                                                        | ESPECÍFICO DEL PROYECTO | Removed with the worker                                     |
| Coverage script without thresholds                                                                                                                   | FALTABA                 | Thresholds as a measured ratchet (docs/testing.md#coverage) |
| No browser E2E                                                                                                                                       | FALTABA                 | Playwright suite on the built stack                         |
| No performance checks                                                                                                                                | FALTABA                 | Bundle size budget (`pnpm perf:check`)                      |

## 5. Configuration

| Existed                                                                               | Tag                     | Template                                                  |
| ------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| Env declared and validated with Zod, boot fails naming the variable; one `env` import | REUTILIZABLE            | Kept; reading `process.env` elsewhere is now a lint error |
| `.env.example` next to each project; root example only for deployment values          | REUTILIZABLE            | Kept                                                      |
| Unit test configs pin fake env values so developer settings never leak                | REUTILIZABLE            | Kept, and `.env` is skipped under `NODE_ENV=test`         |
| Production domain and sender address as defaults in examples                          | ESPECÍFICO DEL PROYECTO | Removed; placeholders only                                |

## 6. Git workflow

| Existed                                                                       | Tag                     | Template                                                                       |
| ----------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Pull requests only, `feat/`, `fix/`, `chore/` branches                        | REUTILIZABLE            | Kept, extended types, checked by a script                                      |
| "Never push to main" by convention: branch protection unavailable on the plan | FALTABA                 | Pre-push guard refuses it locally; importable ruleset for when the plan allows |
| Tracker key in titles, commits as `KEY-123: summary`                          | ESPECÍFICO DEL PROYECTO | Conventional Commits, tracker key optional in footers or branch names          |
| No hooks                                                                      | FALTABA                 | Husky: pre-commit, commit-msg, pre-push                                        |

## 7. CI/CD

| Existed                                                                              | Tag                     | Template                                                             |
| ------------------------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------- |
| No CI workflows in the repository                                                    | FALTABA                 | Reusable GitHub Actions quality gates, single required check         |
| Deployment via a self-hosted PaaS compose file (network aliases, env tab)            | ESPECÍFICO DEL PROYECTO | Removed; provider-neutral `deploy.yml` integration point             |
| Multi-stage Dockerfiles, frozen lockfile installs, `.dockerignore` excluding secrets | REUTILIZABLE            | Kept; non-root runtime, healthchecks, separate migration image added |
| Healthchecks and `depends_on: service_healthy` in compose                            | REUTILIZABLE            | Kept                                                                 |

## 8. Security

| Existed                                                                                            | Tag                     | Template                                                                                              |
| -------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| argon2id at OWASP parameters, dummy hash against user enumeration by timing                        | REUTILIZABLE            | Kept                                                                                                  |
| Refresh tokens: random, hashed at rest, rotated, reuse detection with a race leeway, user row lock | REUTILIZABLE            | Kept                                                                                                  |
| Refresh cookie httpOnly, path `/api/auth`; readable session hint cookie; access token in memory    | REUTILIZABLE            | Kept; SameSite now `Strict` by default (configurable)                                                 |
| JWT algorithm pinned on signer and verifier; claims validated with a schema                        | REUTILIZABLE            | Kept                                                                                                  |
| `@Auth(...roles)` decorator; ownership checks in services answering 404                            | REUTILIZABLE            | Kept, with an example resource                                                                        |
| Per-IP and per-route rate limits (Redis), per-account sign-in limit                                | REUTILIZABLE / OPCIONAL | `@nestjs/throttler`, counters in memory or Redis (`RATE_LIMIT_STORE`); per-account limits documented  |
| `trust proxy` restricted to private hops                                                           | REUTILIZABLE            | Kept, configurable (`TRUST_PROXY`)                                                                    |
| Dev-only routes allowlisted by `NODE_ENV`                                                          | REUTILIZABLE            | Pattern kept (Swagger UI outside production)                                                          |
| Dev services published on loopback only                                                            | REUTILIZABLE            | Kept                                                                                                  |
| Supply chain: pnpm install-script allowlist                                                        | REUTILIZABLE            | Kept; `minimumReleaseAge`, `engineStrict`, scoped security overrides added                            |
| No security headers, no CSP                                                                        | FALTABA                 | helmet on the API; strict CSP and headers in nginx                                                    |
| CSRF relied on SameSite=Lax only                                                                   | FALTABA                 | Fetch-Metadata guard on every route, SameSite=Strict                                                  |
| No dependency audit, no secret scanning, no SECURITY.md                                            | FALTABA                 | `pnpm security` (audit, dependency policy, secretlint), gitleaks in CI, SECURITY.md, docs/security.md |
| Sign-up, email verification, password reset, admin bootstrap by env                                | ESPECÍFICO DEL PROYECTO | Not included; requirements listed in docs/security.md                                                 |

## 9. Error handling

| Existed                                                                             | Tag          | Template                                         |
| ----------------------------------------------------------------------------------- | ------------ | ------------------------------------------------ |
| `{ data, message }` envelope (interceptor) and global exception filter, generic 500 | REUTILIZABLE | Kept                                             |
| Prisma error mapping (P2002/P2003/P2025)                                            | REUTILIZABLE | Kept, without column names in messages           |
| `call()` → `ApiResult`, `describeFailure`, `useLoader`, `LoadFailed` in the SPA     | REUTILIZABLE | Kept                                             |
| Body parser errors (payload too large) surfaced as 500                              | Bug found    | Mapped to their 4xx (integration test covers it) |
| No request id in error logs, no route error boundary                                | FALTABA      | Request id everywhere; `RouteErrorPage`          |

## 10. API contracts

| Existed                                                                                   | Tag          | Template                                                          |
| ----------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------- |
| `@ZodBody`, `@ZodQuery`, `@ApiData`, `@ApiErrors`: one Zod schema validates and documents | REUTILIZABLE | Kept                                                              |
| Export script, committed contract, drift spec, generated SPA types, typed client          | REUTILIZABLE | Kept; generated types now drift-checked too                       |
| Documented modules listed by hand                                                         | Simplified   | Every controller documented; exclude with `@ApiExcludeController` |
| `{ items, total }` pagination with capped `limit`                                         | REUTILIZABLE | `PageQuerySchema`, `pageOf()`                                     |

## 11. Database

| Existed                                                                                 | Tag                     | Template                                                  |
| --------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| snake_case mapping, committed migrations, raw SQL for constraints Prisma cannot express | REUTILIZABLE            | Kept (docs/database.md)                                   |
| `timestamptz(3)` convention documented but not applied everywhere; text ids             | Improved                | UUIDv7 `@db.Uuid`, `Timestamptz(3)` applied in the schema |
| Idempotent seed refusing production                                                     | REUTILIZABLE            | Kept                                                      |
| Staged schema migration notes, business data model                                      | ESPECÍFICO DEL PROYECTO | Removed                                                   |
| Production migrations not wired into the image                                          | FALTABA                 | `migrate` image target; expand/contract rules             |

## 12. Observability

| Existed                                                           | Tag          | Template                                                                   |
| ----------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| Nest text logger, debug lines off in production                   | REUTILIZABLE | JSON logs in production, levels by env                                     |
| One health endpoint with dependency status (503 without database) | REUTILIZABLE | Split into liveness and readiness                                          |
| Worker logs with timestamps to stdout                             | REUTILIZABLE | Pattern documented for workers                                             |
| No request ids, no access log, no metrics                         | FALTABA      | Request ids, access log; OpenTelemetry traces and metrics (OPCIONAL, OTLP) |

## 13. Conventions

| Existed                                                      | Tag                     | Template                                             |
| ------------------------------------------------------------ | ----------------------- | ---------------------------------------------------- |
| Code, commits and docs in English                            | REUTILIZABLE            | Kept (ENGINEERING_STANDARDS.md)                      |
| UI copy in a specific language with typography rules         | ESPECÍFICO DEL PROYECTO | Removed; template UI in English, replace per product |
| Per-module conventions document, AGENTS.md for AI assistants | REUTILIZABLE            | AGENTS.md kept, generic                              |
| No person names in docs                                      | REUTILIZABLE            | Kept                                                 |

## 14. Automation

| Existed                                                                             | Tag                     | Template                                              |
| ----------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------- |
| Root scripts orchestrating installs, dev servers, migrations, seed, build, contract | REUTILIZABLE            | Workspace scripts; `pnpm verify` runs every fast gate |
| `docker compose up` before dev and migrations                                       | REUTILIZABLE            | `pnpm db:up` (waits for health) inside `pnpm dev`     |
| POSIX-only commands in scripts (`cp -n`)                                            | Fixed                   | Cross-platform (Node scripts, no shell tricks)        |
| Brand icon generator                                                                | ESPECÍFICO DEL PROYECTO | Removed                                               |

## 15. Dependencies

| Existed                                                              | Tag          | Template                                                 |
| -------------------------------------------------------------------- | ------------ | -------------------------------------------------------- |
| Caret ranges, Prisma pinned exactly, Node types matching the runtime | REUTILIZABLE | Kept                                                     |
| `packageManager` pinned in one project only                          | FALTABA      | Pinned at the root (CI and corepack use it)              |
| No update automation                                                 | FALTABA      | Dependabot (npm, actions, Docker, compose) with cooldown |

## 16. Documentation

| Existed                                                                   | Tag                     | Template             |
| ------------------------------------------------------------------------- | ----------------------- | -------------------- |
| README with commands and env tables; architecture doc with decisions      | REUTILIZABLE            | Kept and generalized |
| Product spec, task list, people and ownership                             | ESPECÍFICO DEL PROYECTO | Removed              |
| API README left as the framework's boilerplate                            | Removed                 | Replaced by docs/    |
| No CONTRIBUTING, SECURITY, DoD, DoR, ADRs, PR/issue templates, CODEOWNERS | FALTABA                 | All added            |
