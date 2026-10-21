# Instructions for AI coding agents

Read [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) first, then the doc in `docs/` for the
area you touch. [docs/manual.md](docs/manual.md) lists every command. For the usual changes (table, API module,
endpoint, screen, environment variable, role, dependency) follow the recipe in
[docs/how-to.md](docs/how-to.md); errors and fixes are in
[docs/troubleshooting.md](docs/troubleshooting.md).

## Rules

- pnpm workspace: run commands from the repository root (`pnpm --filter api ...` for one app).
  Add dependencies to the app that uses them (`pnpm --filter web add x`), never to the root unless
  it is repository tooling.
- Never read `process.env` outside `apps/api/src/env/env.ts`; new variables go in the schema, the
  `.env.example` and docs/environment.md.
- API: Zod schemas in `dto/`, `@ZodBody`/`@ZodQuery`/`@ApiData`/`@ApiErrors` on handlers,
  `@Auth(...)` on every non-public route, ownership checks in the service. After any controller or
  DTO change run `pnpm contract` and commit `openapi/openapi.json` and
  `apps/web/src/api/schema.d.ts`; never edit them by hand.
- Web: call the API only through `src/api/client.ts`, fold results with `call()`, keep the access
  token in memory.
- Landing (`apps/landing`, Astro + Tailwind CSS): every text in `src/i18n/en.ts` and `es.ts`, both
  languages in the same change; pages are static HTML and CSS (no client script, no inline style,
  nothing from another origin: the CSP refuses them, and the JavaScript budget is 0 kB); links into
  the app through `src/lib/links.ts`. Recipe: [docs/how-to.md](docs/how-to.md#change-the-landing).
- Tests next to the code: `*.spec.ts(x)` unit/component, `*.int.spec.ts` API integration,
  `e2e/*.e2e.ts` browser. Never weaken a test, a lint rule, a type or a threshold to make a check
  pass; fix the cause.
- Database changes: edit `apps/api/prisma/schema.prisma`, then `pnpm db:migrate --name <name>`
  (creates, applies, regenerates the client); never edit a committed migration.
- Before finishing: `pnpm verify`; for API changes also `pnpm test:integration`.
- Git: branches `<type>/<description>`, Conventional Commits, never push to `main`.
- Never commit `.env` files, secrets, tokens or personal data.
- `docs/manual.md`/`docs/manual.es.md` (the manual) and `docs/step-by-step.md`/`docs/step-by-step.es.md`
  (the step-by-step guide) exist in English and Spanish: a change to one (a command, a step, a
  variable) goes to the other in the same change, and a change to deployment (`deploy/vps/`,
  `deploy.yml`) updates `docs/deploy-vps.md` and both step-by-step guides.
- Observability and infrastructure: log through `new Logger(...)` (output is redacted, but log ids,
  never personal data); report unexpected errors with `errorTracker()` (API) or `reportError()`
  (web); call external services with `createExternalHttpClient`; use `CacheService`,
  `LockService` and `IdempotencyService`, never Redis, Sentry or the OpenTelemetry SDK directly
  (lint rule). Optional integrations must keep working when unconfigured.
- Never weaken a supply-chain or security setting to get past a failure (`minimumReleaseAge`,
  `trustPolicy`, `allowBuilds`, `scripts/dependency-policy.json`, workflow `permissions`, pins);
  a `nosemgrep` or an exception needs its reason on the same line and a human reviewer.
