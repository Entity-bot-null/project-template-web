# Engineering standards

The rules every change follows. Most are enforced by tools (column "Enforced by"); the rest are
checked in review. Details live in `docs/`.

## Language and code

| Rule                                                                                                                                                                                                                              | Enforced by                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| TypeScript everywhere, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`                                                                                                                            | `tsconfig.base.json`, `pnpm typecheck` |
| No `any` leaking into code, no floating promises, no unsafe member access                                                                                                                                                         | ESLint `strictTypeChecked`             |
| No `// eslint-disable` without a reason; unused disables are errors                                                                                                                                                               | ESLint `reportUnusedDisableDirectives` |
| One formatting style (Prettier: single quotes, 100 columns)                                                                                                                                                                       | `pnpm format:check`, pre-commit        |
| Configuration only through the validated `env` module                                                                                                                                                                             | ESLint `no-restricted-properties`      |
| No `console` in application code (use the logger; web: `console.error`/`console.warn` only)                                                                                                                                       | ESLint `no-console`                    |
| No `eval`/`new Function`, no raw-SQL `*Unsafe` calls, no unsanitized `dangerouslySetInnerHTML`                                                                                                                                    | ESLint, Semgrep (SAST)                 |
| Code, comments, commits and docs in English (the exceptions: `docs/manual.es.md` and `docs/step-by-step.es.md`, the Spanish manual and guide, and the user-facing copy in each language of the landing, `apps/landing/src/i18n/`) | review                                 |
| Comments explain why, not what                                                                                                                                                                                                    | review                                 |

## Architecture

- API modules: thin controllers, rules and queries in services, Zod schemas in `dto/`
  ([docs/architecture.md](docs/architecture.md)).
- The web app reaches the API only through `src/api/client.ts` and folds results with `call()`.
- The landing is static HTML and CSS in every language of the site, its texts in typed
  dictionaries ([docs/architecture.md](docs/architecture.md#landing-appslanding)), its Tailwind
  classes known to its stylesheet and in Tailwind's order (`pnpm lint`).
- Shared behavior lives in one place (`common/`, `src/auth/`, `src/hooks/`); do not copy it.
- Significant decisions are recorded as ADRs ([docs/adr/](docs/adr/)).

## API

- Contract first; the contract is generated, committed and drift-checked
  ([openapi/README.md](openapi/README.md)).
- `{ data, message }` envelope, conventions for routes, status codes, pagination
  ([docs/api-conventions.md](docs/api-conventions.md)).
- Every input validated by a schema; every output built from an explicit select.
- Errors through the standard filter, never leaking internals ([docs/error-handling.md](docs/error-handling.md)).

## Security

- Every route `@Auth(...)` unless deliberately public; ownership checked in the service (404 for
  others' records).
- No secrets in code, logs, git or the client bundle; tokens never in web storage.
- No security finding is silenced without its reason on the same line (`nosemgrep`,
  `eslint-disable`), visible in review.
- Full list and per-project settings: [docs/security.md](docs/security.md).

## Supply chain

| Rule                                                                                   | Enforced by                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Dependencies come from the registry, locked with sha512 integrity                      | frozen installs, `pnpm deps:check`                   |
| A release must be seven days old; a version with weaker publishing evidence is refused | `minimumReleaseAge`, `trustPolicy`, Dependabot       |
| Install scripts only for reviewed packages                                             | `allowBuilds`                                        |
| Production dependencies use permissive licenses; exceptions recorded with a reason     | `pnpm deps:check` (`scripts/dependency-policy.json`) |
| No high or critical advisory in dependencies or images                                 | `pnpm audit`, Trivy                                  |
| Actions pinned by SHA, tool images by digest; workflows least-privilege                | zizmor, actionlint                                   |
| Dependencies kept current by weekly grouped update pull requests                       | Dependabot                                           |

Details: [docs/security.md#dependency-policy](docs/security.md#dependency-policy).

## Testing

- Unit/component tests next to the code (`*.spec.ts(x)`), API integration tests
  (`*.int.spec.ts`), E2E for critical flows (`e2e/*.e2e.ts`) ([docs/testing.md](docs/testing.md)).
- Coverage thresholds are a ratchet: never lowered silently.
- Every bug fix starts with a failing test.

## Data

- Every schema change is a committed migration, compatible with the running version
  (expand/contract) ([docs/database.md](docs/database.md)).
- snake_case tables, UUIDv7 keys, `timestamptz`, explicit `onDelete`.

## Operations

- Structured logs with request ids, no sensitive data; liveness and readiness probes
  ([docs/observability.md](docs/observability.md)).
- Configuration validated at boot; one set of secrets per environment
  ([docs/environment.md](docs/environment.md)).
- Production only after [docs/production-readiness.md](docs/production-readiness.md); incidents
  follow [docs/incident-response.md](docs/incident-response.md), alerts and SLOs
  [docs/alerting.md](docs/alerting.md), backups and restores
  [docs/disaster-recovery.md](docs/disaster-recovery.md).
- Every deployment ends with the smoke test (`pnpm smoke`); a rollback redeploys the previous
  image digests, never reverses a migration.

## Observability and infrastructure

| Rule                                                                                                                      | Enforced by                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Everything printed by the logger is redacted (credentials in keys and in text)                                            | `AppLogger`, `redact.spec.ts`, `logger.spec.ts`  |
| Unexpected errors reach the error tracker through `errorTracker()` / `reportError()`, never an SDK directly               | ESLint `no-restricted-imports`                   |
| Application code uses `@opentelemetry/api` or `apps/api/src/observability/metrics.ts`; the SDK loads only when configured | ESLint `no-restricted-imports`                   |
| Metric attributes are low-cardinality: never user ids, emails or raw paths                                                | review                                           |
| Feature code uses the infrastructure adapters (cache, locks, idempotency), never Redis directly                           | ESLint `no-restricted-imports`                   |
| External services are called through `createExternalHttpClient` (timeouts, retries, correlation)                          | review                                           |
| Every optional dependency degrades instead of failing the boot; its degraded behavior is documented and tested            | integration specs (`infrastructure.int.spec.ts`) |
| Every cache entry has a TTL; sensitive data and authorization decisions are never cached                                  | `CacheService` (TTL), review                     |

## Workflow

- Short-lived branches, Conventional Commits, pull requests only, squash merge
  ([docs/branching.md](docs/branching.md), [docs/commits.md](docs/commits.md)).
- Hooks on commit and push ([docs/git-hooks.md](docs/git-hooks.md)); all gates in CI, one required
  check; each gate is BLOCKING or ADVISORY
  ([docs/ci-cd.md#quality-gates-blocking-and-advisory](docs/ci-cd.md#quality-gates-blocking-and-advisory)).
- Releases: semantic versions and the changelog come from the commit titles; a reviewed release
  pull request tags `vX.Y.Z` and attaches the SBOM ([docs/ci-cd.md#releases](docs/ci-cd.md#releases)).
- Review checklist ([docs/code-review.md](docs/code-review.md)); Ready and Done defined
  ([docs/definition-of-ready.md](docs/definition-of-ready.md), [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md)).

## The pipeline

```
code → format → lint → typecheck → test → coverage → security → build → CI → review → merge → release → deploy → observe
        └──────────── pnpm verify / pre-commit / pre-push ───────────┘   └ CI: + SAST, workflow audit,
                                                                            integration, E2E, images ┘
```
