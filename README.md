# Project template

A full-stack TypeScript starting point with the engineering standards already wired in: a NestJS
API on PostgreSQL and a React single-page app, sharing a committed OpenAPI contract, with
authentication, authorization, security controls, tests at every level, Git hooks, CI quality
gates and Docker images working from the first commit.

**Starting a new project?** Follow the step-by-step guide, [docs/step-by-step.md](docs/step-by-step.md):
what to do, in order, from the information and accounts you need to the app running in production,
with a check after every step (en español: [docs/step-by-step.es.md](docs/step-by-step.es.md)).
**Using it day to day?** The manual, [docs/manual.md](docs/manual.md), explains how everything works
and lists every command (en español: [docs/manual.es.md](docs/manual.es.md)).

## Stack

| Area                     | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime, package manager | Node.js 24, pnpm workspace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| API                      | NestJS 12 (Express), Prisma 7 + PostgreSQL, Zod, OpenAPI generated from the schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Web                      | React 19, Vite, React Router, openapi-fetch with types generated from the contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Quality                  | TypeScript `strict`, ESLint (type-aware), Prettier, commitlint, Husky + lint-staged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Tests                    | Vitest (unit, component, integration), Testing Library, supertest, Playwright (E2E)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Security                 | helmet/CSP, CSRF guard, httpOnly refresh cookies with rotation and theft detection, RBAC + ownership checks, rate limits, password policy (NIST SP 800-63B-4), password recovery by one-time link and change with immediate sign-out of other sessions, optional public sign-up confirmed by email, change of email confirmed from the new address and undoable from the previous one, invitations by administrators; SAST (Semgrep, CodeQL opt-in), workflow audit (zizmor), DAST (OWASP ZAP), pnpm audit, dependency and license policy, secretlint, gitleaks, image scanning (Trivy) |
| Delivery                 | GitHub Actions (reusable gates, least privilege, pinned), Dependabot, release-please (SemVer, changelog, SBOM), Docker images (API, migrations, nginx web) with provenance                                                                                                                                                                                                                                                                                                                                                                                                              |
| Observability            | JSON logs with automatic redaction and request/trace correlation, health probes, graceful shutdown, error classification; optional: Sentry (API + web), OpenTelemetry traces and metrics (OTLP), local Grafana backend; dashboards, SLOs and alert rules as tested code                                                                                                                                                                                                                                                                                                                 |
| Optional infrastructure  | Redis (shared rate limits, cache, locks, idempotency) behind adapters with in-process fallbacks; transactional email (outbox over SMTP, Mailpit locally); none required to run, test or deploy                                                                                                                                                                                                                                                                                                                                                                                          |

## Requirements

Node.js 24 (`.nvmrc`), pnpm (`corepack enable`; from Node.js 25, which ships no Corepack,
`npm install -g corepack` first), Docker. No external account: Sentry, an
OpenTelemetry backend and Redis are optional and off by default.

## Quick start

```
pnpm install
cp apps/api/.env.example apps/api/.env      # then set JWT_ACCESS_SECRET (openssl rand -hex 32)
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev                                    # web http://localhost:5173, API http://localhost:3000/api/docs, email http://localhost:8035
```

Sign in with `admin@example.com` / `admin-password` or `member@example.com` / `member-password`
(development seed only).

## Commands

| Command                                             | What it does                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                          | Database and Mailpit up, then API and web dev servers; their URLs in a box under the logs             |
| `pnpm build`                                        | Build every app                                                                                       |
| `pnpm lint` / `pnpm lint:fix`                       | ESLint on the whole repository                                                                        |
| `pnpm format` / `pnpm format:check`                 | Prettier                                                                                              |
| `pnpm typecheck`                                    | TypeScript in every app, plus the contract types check                                                |
| `pnpm test`                                         | Unit and component tests                                                                              |
| `pnpm test:coverage`                                | The same, with coverage thresholds                                                                    |
| `pnpm test:integration`                             | API against PostgreSQL (`pnpm db:up` first)                                                           |
| `pnpm test:e2e`                                     | Browser tests on the built stack (`pnpm build` first)                                                 |
| `pnpm security`                                     | Dependency audit (high and critical fail), dependency policy and secret scan                          |
| `pnpm deps:check`                                   | Dependency policy: registry sources, licenses, install settings, release-delay exemptions             |
| `pnpm sast` / `pnpm lint:workflows`                 | Semgrep / actionlint + zizmor, the pinned images CI runs (need Docker)                                |
| `pnpm observability:check`                          | Dashboards and alert rules of `observability/`: metric names, runbooks, promtool tests (Docker)       |
| `pnpm iac:check`                                    | Terraform checks and tests, TFLint, Trivy, cloud-init, database roles (`infra/`, needs Docker)        |
| `pnpm sbom:generate`                                | CycloneDX SBOM of the production dependencies in `dist/sbom/`                                         |
| `pnpm perf:check`                                   | Web bundle size against its budget (after `pnpm build`)                                               |
| `pnpm smoke --url <public URL> --api <API URL>`     | Read-only smoke test of a running deployment (after a rollout, a restore, an incident)                |
| `pnpm verify`                                       | **All fast gates:** format check → lint → typecheck → tests + coverage → security → build → budget    |
| `pnpm contract`                                     | Regenerate `openapi/openapi.json` and the web client types                                            |
| `pnpm services:up`                                  | Database and Mailpit (the mail catcher, http://localhost:8035)                                        |
| `pnpm db:up` / `db:down` / `db:migrate` / `db:seed` | Local database                                                                                        |
| `pnpm --filter api mail status` / `test` / `retry`  | The email outbox: what waits or failed, a delivery check, failed messages sent again                  |
| `docker compose --profile redis up -d`              | Optional local Redis (`REDIS_PASSWORD` in the root `.env`)                                            |
| `docker compose --profile observability up -d`      | Optional local OpenTelemetry backend with the dashboards and alerts, Grafana at http://localhost:3001 |

## Layout

```
apps/api      NestJS API (prisma/ for schema and migrations; observability/, infrastructure/)
apps/web      React SPA (nginx/ for the production web server)
openapi/      the API contract
e2e/          Playwright tests
scripts/      repository tooling
docs/         standards and guides
infra/        infrastructure as code: Terraform for the DigitalOcean server target (optional)
.github/      CI/CD, templates, Dependabot, CODEOWNERS, rulesets, pinned tool images
.zap/         DAST rule levels
```

## Documentation

- **Adding something?** [docs/how-to.md](docs/how-to.md): step-by-step recipes (table or column,
  API module or endpoint, contract change, screen, E2E test, environment variable, role,
  dependency, pulling team changes). **Something failing?**
  [docs/troubleshooting.md](docs/troubleshooting.md).
- [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md): the rules, in one page.
- [CONTRIBUTING.md](CONTRIBUTING.md): how a change gets from an idea to `main`.
- [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) and [docs/definition-of-ready.md](docs/definition-of-ready.md).
- [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).
- **Going to production?** [docs/deploy-vps.md](docs/deploy-vps.md): the ready-made deployment to a
  Linux server with Docker (`DEPLOY_TARGET=vps`), by hand or, on DigitalOcean, with Terraform;
  [docs/production-readiness.md](docs/production-readiness.md): the checklist. Operating it:
  [docs/incident-response.md](docs/incident-response.md) (runbooks),
  [docs/alerting.md](docs/alerting.md) (SLOs and alerts),
  [docs/disaster-recovery.md](docs/disaster-recovery.md) (backups, restore, RPO/RTO),
  [docs/load-testing.md](docs/load-testing.md) (optional).
- [docs/architecture.md](docs/architecture.md), [docs/api-conventions.md](docs/api-conventions.md),
  [docs/error-handling.md](docs/error-handling.md), [docs/database.md](docs/database.md),
  [docs/authorization.md](docs/authorization.md),
  [docs/testing.md](docs/testing.md), [docs/environment.md](docs/environment.md),
  [docs/observability.md](docs/observability.md), [docs/ci-cd.md](docs/ci-cd.md),
  [docs/git-hooks.md](docs/git-hooks.md), [docs/branching.md](docs/branching.md),
  [docs/commits.md](docs/commits.md), [docs/code-review.md](docs/code-review.md),
  [docs/adr/](docs/adr/), [openapi/README.md](openapi/README.md).
- Template provenance and decisions: [docs/template/source-analysis.md](docs/template/source-analysis.md).
