# CI/CD

```
push / pull request
  └─ CI (.github/workflows/ci.yml)
       ├─ Dependency review    new vulnerable dependencies                        opt-in
       ├─ Gates (quality-gates.yml, reusable)
       │    ├─ Format, lint, types, workflows   prettier, eslint, tsc + contract types, script tests, actionlint + zizmor
       │    ├─ Static analysis (Semgrep)        SAST: code, Dockerfiles, nginx
       │    ├─ Unit and component tests         vitest + coverage thresholds + OpenAPI drift
       │    ├─ Integration tests                API + PostgreSQL + Redis services (Redis adapters, degraded mode)
       │    ├─ Security                         pnpm audit (high+), dependency policy, secretlint, gitleaks
       │    ├─ Build and performance budget     pnpm build, bundle size budget
       │    ├─ End-to-end tests                 Playwright on the built stack
       │    └─ Images (docker-images.yml)       api, api-migrate, web: built, scanned (Trivy), not pushed
       └─ CI passed            fails if any job above failed  ← required check
  └─ Conventions (conventions.yml)   branch name, PR title (Conventional Commits),
                                     again when the title is edited  ← required check
  └─ CodeQL (codeql.yml)       cross-file SAST                                    opt-in, advisory
merge to main (squash)
  ├─ CI on main
  ├─ Main guard (main-guard.yml)   a pushed commit that is no merged pull request → failure + issue
  └─ Release (release.yml)     release pull request: next version + changelog
                               merged → tag vX.Y.Z, GitHub release, SBOM attached
weekly / on demand
  ├─ Dependabot                update pull requests (dependabot.yml), the full CI on each
  │    └─ approved → Dependabot auto-merge (dependabot-auto-merge.yml): merged once CI passed
  └─ DAST (dast.yml)           OWASP ZAP on a throwaway stack, or staging (passive)   advisory
manual release (run from main)
  └─ Deploy (.github/workflows/deploy.yml): environment + ref
       ├─ Resolve              the ref to a commit SHA; refused unless it is on main
       ├─ Gates on that exact commit
       └─ Release (GitHub environment: staging / production)
            VPS target (DEPLOY_TARGET=vps): images to ghcr.io, deploy/vps/deploy.sh over SSH,
            smoke test, rollback; any other platform: the release job, to implement
```

Every job installs with `pnpm install --frozen-lockfile` (`.github/actions/setup`): a lockfile out
of sync with `package.json`, or a release that breaks the supply-chain policies, fails it.

## Quality gates: blocking and advisory

**BLOCKING** gates fail **CI passed** (the branch name and the title fail **Conventions**), so the
pull request cannot merge. They are deterministic and
have no known false positives on this code base: a failure means something to fix (or, for a
proven false positive, an inline suppression with its reason, visible in review). **ADVISORY**
checks report without blocking: they depend on the GitHub plan, on a running environment, or
produce findings that need judgment.

| Gate                                                                        | Where                         | Level                   |
| --------------------------------------------------------------------------- | ----------------------------- | ----------------------- |
| Formatting (Prettier)                                                       | `pnpm verify`, pre-commit, CI | BLOCKING                |
| Lint (ESLint, type-aware, security rules), zero warnings                    | `pnpm verify`, pre-commit, CI | BLOCKING                |
| Types, contract types in sync with `openapi/openapi.json`                   | `pnpm verify`, pre-push, CI   | BLOCKING                |
| Unit and component tests, coverage thresholds, OpenAPI drift                | `pnpm verify`, pre-push, CI   | BLOCKING                |
| Integration tests (API + PostgreSQL + Redis adapters)                       | CI (`pnpm test:integration`)  | BLOCKING                |
| End-to-end tests (Playwright)                                               | CI (`pnpm test:e2e`)          | BLOCKING                |
| Dependency advisories, high and critical (`pnpm audit`)                     | `pnpm verify`, CI             | BLOCKING                |
| Dependency policy: registry sources, licenses (`pnpm deps:check`)           | `pnpm verify`, CI             | BLOCKING                |
| Secrets in the tree (secretlint)                                            | pre-commit, `pnpm verify`, CI | BLOCKING                |
| Secrets in the git history (gitleaks)                                       | CI                            | BLOCKING                |
| SAST (Semgrep)                                                              | CI, `pnpm sast`               | BLOCKING                |
| Workflow lint and security (actionlint, zizmor), shell scripts (shellcheck) | CI, `pnpm lint:workflows`     | BLOCKING                |
| Build, performance budget                                                   | `pnpm verify`, CI             | BLOCKING                |
| Images build; fixable HIGH/CRITICAL advisories in them (Trivy)              | CI                            | BLOCKING                |
| Branch name, Conventional Commit PR title                                   | pre-push, commit-msg, CI      | BLOCKING                |
| Dependency review (new vulnerable dependencies in the diff)                 | CI, opt-in                    | BLOCKING when enabled   |
| CodeQL                                                                      | CI, opt-in                    | ADVISORY (Security tab) |
| DAST (OWASP ZAP)                                                            | weekly, on demand             | ADVISORY                |
| Advisories below high (`pnpm audit` reports them), unfixed image CVEs       | CI logs                       | ADVISORY                |
| Coverage and Playwright reports                                             | CI artifacts                  | ADVISORY                |

**Optional integrations never gate CI.** Sentry, OpenTelemetry backends, uptime services and
production Redis are not needed by any job: unit and E2E suites run with them off (the default),
the telemetry and error tracking specs use in-process collectors and a stubbed transport, and the
Redis adapters run against a throwaway Redis service in the integration job (pinned in
`.github/tool-images/Dockerfile`; a missing one fails those specs in CI instead of skipping them).

Nothing else gates a merge: style preferences beyond the linters, Semgrep's informational
registry, and ZAP warnings are for review, not for the pipeline. Promote an advisory check to
blocking only when it has run clean for a while.

## Required check

Require the **CI passed** and **Conventions** status checks on `main`, with pull requests and
squash merges only. **Conventions** (`conventions.yml`) checks the branch name and the title, and
runs again whenever the title is edited, without re-running the gates: the title becomes the
squash commit that release-please reads. Import `.github/rulesets/main.json` (Settings → Rules →
Rulesets → Import), or

```
gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/main.json
gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/tags.json
```

`main.json` accepts the checks only from GitHub Actions (`integration_id` 15368), so a status posted
through the API with someone's token does not count, and requires code owners' approval for the
paths in `.github/CODEOWNERS` (no effect until it is filled in). `tags.json` makes release tags
(`v*`) immutable: they cannot be moved or deleted, so a rollback to `v1.4.0` always deploys the
same code.

Rulesets and branch protection on private repositories need a paid GitHub plan. Without them the
rules still hold locally (the pre-push hook refuses pushes to `main`) and by convention; CI still
reports every failure on the pull request. Two workflows make up for part of it, on any plan:

- **Main guard** (`main-guard.yml`) checks every push to `main`: each commit must be a merged pull
  request. A direct or forced push fails the workflow and opens an issue naming the commits and who
  pushed them. It detects; it cannot prevent.
- **Dependabot auto-merge** (`dependabot-auto-merge.yml`) checks the approval and the CI result
  itself before merging an update ([Dependency updates](#dependency-updates)), so it needs no
  branch protection.

Nothing replaces required reviewers on deployments: that needs the environments of a paid plan or
a public repository.

## Repository settings (REQUIERE CONFIGURACIÓN)

For a **private** repository, environments (with their reviewers and secrets) need GitHub **Team**
(organization) or **Pro** (personal), rulesets need Team, and branch protection Pro or Team; on the
Free plan they exist only for public repositories, and without them the protections of this page
do not hold. The step-by-step guide sets everything below up in order
([step-by-step.md](step-by-step.md#phase-5-put-it-on-github)).

- Merge button: allow squash merging only; default commit message = pull request title.
- Automatically delete head branches.
- Environments `staging` and `production`, both with the deployment branch rule "`main` only"
  (the deploy workflow runs from `main` and deploys any commit on it), production with required
  reviewers. The rule matters: the workflow's own checks live in a file a branch could edit.
- Actions → General → Workflow permissions: **Read repository contents** (the default token is
  read-only; jobs that write ask for it themselves). Tick "Allow GitHub Actions to create pull
  requests" only when `RELEASE_PLEASE_TOKEN` is not set: release-please then opens its pull
  request with the default token.
- Secret `RELEASE_PLEASE_TOKEN`: a GitHub App installation token or a fine-grained token limited to
  this repository (contents, pull requests, issues: write), so CI runs on the release pull request
  ([Releases](#releases)).
- Variables: `IMAGE_PREFIX` (registry/namespace for images), `DAST_STAGING_URL` (staging origin
  for the passive scan), `ENABLE_CODEQL`, `ENABLE_DEPENDENCY_REVIEW` (both need a public
  repository or GitHub Advanced Security).
- Dependabot alerts and security updates on; private vulnerability reporting on.

## Dependency updates

Dependabot opens the update pull requests every week (`.github/dependabot.yml`; what it covers
and why: [security.md](security.md#dependency-maintenance)). Each one runs the full CI like any
other pull request. Then a maintainer reads it (the changelog links in its description) and
**approves** it, and **Dependabot auto-merge** (`dependabot-auto-merge.yml`) merges it with a
squash. The workflow checks every condition itself, so it works without branch protection:

- Dependabot opened the pull request, and every update in it is a patch, a minor version, or a new
  digest of the same image tag;
- it changes no workflow or action (`.github/workflows/`, `.github/actions/`): the workflow token
  may not merge those;
- the approval comes from a user with write access. Dependabot's own later commits (a rebase)
  keep it; a commit anyone else pushes needs an approval of the latest commit;
- **CI passed** succeeded on the latest commit. When the approval comes first, the job waits for
  CI, up to 50 minutes; past that, re-run the job.

It then starts CI on `main`, since a merge made with the workflow token triggers no workflow. A
major update, an update to the workflows, or a pull request the workflow declined (its run says
why) is merged by hand, after reading its release notes. An update that changes `deploy/vps`
also needs the files copied to the server
([deploy-vps.md](deploy-vps.md#update-the-server-files)).

## Releases

Versions follow [Semantic Versioning](https://semver.org/) and are derived from the Conventional
Commits on `main` (the squashed pull request titles, docs/commits.md) by **release-please**
(`release.yml`, `release-please-config.json`):

| Commits since the last release     | Next version (from 1.0.0) | Before 1.0.0 |
| ---------------------------------- | ------------------------- | ------------ |
| `fix:` / `perf:` only              | patch: 1.4.**1**          | patch        |
| at least one `feat:`               | minor: 1.**5**.0          | minor        |
| `!` or a `BREAKING CHANGE:` footer | major: **2**.0.0          | minor        |

1. Every push to `main` updates one open **release pull request**: the version in the
   `package.json` files and `.release-please-manifest.json`, and the new `CHANGELOG.md` entry
   (features, fixes, performance, reverts; housekeeping types are left out).
2. Merging it (review and CI like any pull request) creates the tag `vX.Y.Z` (immutable) and the
   GitHub release with the same notes, then attaches the SBOM (`sbom.cdx.json`).
3. Deploying is separate: run **Deploy** with the tag as the ref, staging first.

The first release is `0.1.0`; to start at `1.0.0`, merge a commit with the footer
`Release-As: 1.0.0`. Pull requests opened with the default token start no workflows, so set
`RELEASE_PLEASE_TOKEN` (above); without it, close and reopen the release pull request to start CI.
Changesets was not chosen: it suits packages published separately, with a changeset file per
change; here the apps ship together under one version and the commit titles already say what
changed. semantic-release would release on every merge; the release pull request lets the team
choose the moment and review the notes.

## Images

`docker-images.yml` builds `api`, `api-migrate` (the `migrate` stage: Prisma CLI plus the committed
migrations) and `web`, tagged with the commit SHA and built with `APP_RELEASE=<commit SHA>`, the
release every log line, error report and span of the image carries
(docs/observability.md#identity), cached in the GitHub Actions cache, and scans
each one with Trivy before any push: a fixable HIGH or CRITICAL advisory fails the job
(docs/security.md#container-images). The builds pass the day as `OS_UPGRADE_DATE`: the operating
system upgrade in the Dockerfiles runs again once a day instead of coming from the cache until the
base image changes. To publish, set `IMAGE_PREFIX` (for example
`ghcr.io/owner/repo`), add the registry login step marked in the file (and `packages: write` for
GHCR), and call it with `push: true`. Pushed images carry their SBOM and SLSA provenance as
attestations; signed GitHub attestations are one commented step away
(docs/security.md#artifact-integrity).

Locally: `docker compose --profile stack up --build` runs migrations, the API and the web image at
http://localhost:8080, the production topology on one machine. Add `--profile redis` (and
`STACK_REDIS_URL`, `STACK_RATE_LIMIT_STORE=redis` in the root `.env`) to run it with shared rate
limits, `--profile observability` (and `STACK_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318`)
to see its traces and metrics in Grafana.

The build context is an allowlist (`.dockerignore`): the root manifests, the lockfile and `apps/`.
A new top-level folder an image needs (a shared `packages/`) must be added there.

## Workflow security

The rules every workflow follows, checked by zizmor and actionlint (`pnpm lint:workflows`) on every
pull request; exceptions are listed with their reason in `.github/zizmor.yml`:

- **Least privilege.** Each workflow declares `permissions` at the top (`contents: read`, or none);
  a job that writes (code scanning results, the release pull request, a release asset) asks for
  exactly that, with a comment saying why. The default token of the repository is read-only. The
  release's SBOM is generated by a read-only job and attached by one that checks out and installs
  nothing, so no dependency code runs next to the token that can edit releases.
- **No credentials left behind.** `actions/checkout` runs with `persist-credentials: false`; a step
  that needs the token receives it as an environment variable, read-only where possible.
- **No injection.** Values a user controls (branch names, titles, inputs) reach shell scripts only
  through `env:`, never as `${{ }}` inside `run:`.
- **No privileged triggers.** No `pull_request_target` and no `workflow_run` consuming artifacts of
  pull request runs: code from a fork never runs with secrets or a write token. Artifacts
  (coverage, reports) are uploaded for people, never downloaded by another workflow; the SBOM
  passes only between two jobs of the same release run.
- **Secrets only where used.** Pull request jobs use none. Deployment secrets live in the GitHub
  environments, which only `main` can deploy to.
- **Everything pinned** (below), and caches are keyed by the lockfile; caches written by pull
  requests are visible only to that pull request's branch.

## Pinning

| What                                                                                                                     | Pinned by                                          | Updated by                                     |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------- |
| GitHub Actions (`uses:`)                                                                                                 | commit SHA, tag in comment                         | Dependabot (`github-actions`)                  |
| Tool images (actionlint with shellcheck, zizmor, Semgrep, gitleaks, Trivy, ZAP) and the CI PostgreSQL and Redis services | tag and digest in `.github/tool-images/Dockerfile` | Dependabot (`docker`), tag and digest together |
| Base images in the Dockerfiles (Node.js from ECR Public's mirror of Docker's official images, nginx from NGINX's GHCR)   | tag and digest                                     | Dependabot (`docker`), tag and digest together |
| Compose images                                                                                                           | tag                                                | Dependabot (`docker-compose`)                  |
| npm packages                                                                                                             | `pnpm-lock.yaml` (integrity hashes)                | Dependabot (`npm`), `pnpm update`              |

The Dockerfiles' base images come from registries without Docker Hub's anonymous pull limit, which
CI runners share and hit: the same images, with the same digests, as on Docker Hub.

A tool image runs with the repository checked out (gitleaks reads the whole history, Trivy gets
the Docker socket), so a tag moved by an attacker would run with that access: the digest makes
the reference immutable. Workflows and the local commands read the reference through
`node scripts/tool-image.mjs <name>`, which refuses one without a digest; nobody edits digests by
hand. zizmor's online audits also verify that every pinned action SHA belongs to the action's
repository (impostor commits).

**Registries.** Docker Hub limits anonymous pulls per address, and CI runners share theirs, so a
busy day of pull requests fails jobs with `toomanyrequests`. Where an image is published elsewhere
with the same digest, the pin points there (GHCR, or Docker's mirror of its official images on
Amazon ECR Public). The images only Docker Hub hosts are pulled in CI through `mirror.gcr.io` by
their digest (`TOOL_IMAGE_MIRROR` in `quality-gates.yml`, read by `scripts/tool-image.mjs`):
the digest makes the content identical whatever the source, Docker Hub stays the fallback, and
Dependabot keeps updating the pins from their source.

## Deployment

`deploy.yml` is the integration point. Run it from `main` (it refuses any other branch) with the
environment and the ref to deploy: a branch, a release tag or a commit SHA. The ref is resolved
once to a commit, which must be on `main` (reviewed and merged code only); the gates and the
release then use that SHA, never the ref, which could move in between.

Two release paths follow the gates:

- **The reference target, one Linux server with Docker** (repository variable
  `DEPLOY_TARGET=vps`, [deploy-vps.md](deploy-vps.md)), implemented: `publish` pushes the three
  images to ghcr.io once per commit (production reuses the ones staging ran), and `release-vps`,
  in the GitHub environment, checks that the server's copy of `deploy/vps` matches the release,
  runs `deploy.sh` on the server over SSH (pull by digest, migrate, roll out, back to the running
  release when the rollout fails), runs the smoke test and calls `rollback.sh` when it fails.
- **Any other platform:** the `release` job fails on purpose until it is implemented for it
  (REQUIERE CONFIGURACIÓN), in the order below.

The pipeline from a merged commit to production, and who does each step:

| Step                          | VPS target (`DEPLOY_TARGET=vps`)                                 | Any other platform (REQUIERE CONFIGURACIÓN)         |
| ----------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| 1. Build                      | Gates (`pnpm build`, the three images)                           | the same                                            |
| 2. Test                       | Gates (unit, component, integration, E2E, coverage)              | the same                                            |
| 3. Security gates             | Gates (audit, dependency policy, secrets, SAST, Trivy)           | the same                                            |
| 4. Publish the images         | `publish`: ghcr.io, once per commit                              | `docker-images.yml` with `push: true`               |
| 5. Deploy by immutable digest | `release-vps` hands `<image>@<digest>` to `deploy.sh`            | the release job                                     |
| 6. Migrate (expand/contract)  | `deploy.sh` runs the `api-migrate` image                         | the release job runs the `api-migrate` image        |
| 7. Deploy the API             | `deploy.sh`, waiting for readiness                               | the release job                                     |
| 8. Deploy the web image       | `deploy.sh`                                                      | the release job                                     |
| 9. Smoke test                 | `scripts/smoke-test.mjs` in `release-vps`                        | `scripts/smoke-test.mjs` in the release job         |
| 10. Rollback on failure       | `deploy.sh` on a failed rollout, `rollback.sh` on a failed smoke | the release job, or by hand ([Rollback](#rollback)) |

Steps 1 to 3 run on the exact commit being deployed (the `gates` job of `deploy.yml`). For any
other platform, implement the release job in this order (the VPS target follows it too):

1. **Images, once per commit.** Push them (`docker-images.yml` with `push: true`, tags
   `<IMAGE_PREFIX>/<image>:<sha>`). When the images of that SHA already exist (pushed for staging),
   reuse them: production must run the digests staging verified, not a rebuild (a rebuild picks up
   newer base image patches and is a different artifact). Resolve each digest
   (`docker buildx imagetools inspect <image>:<sha>`) and deploy `<image>@<digest>` from here on;
   verify its attestation first where signed attestations are enabled
   (docs/security.md#artifact-integrity).
2. **Record the digests running now**, before changing anything: they are the rollback target.
3. **Migrate:** run the `api-migrate` image against the environment's database
   (`prisma migrate deploy`). If it fails, stop here: the running version keeps serving
   (docs/incident-response.md#10-failed-database-migration).
4. **Roll out `api`, then `web`**, letting the platform wait for readiness
   (`GET /api/health/ready` on the API itself; the web server does not expose it).
5. **Smoke test:** `node scripts/smoke-test.mjs --url <public URL> --api <API URL inside the
platform> --release <sha>` checks the public side (web server, app shell and its security
   headers, runtime configuration of the expected release, the API through the proxy, probes not
   public) and the API's liveness and readiness. Read-only: it signs nobody in.
6. **On failure, roll back** to the digests recorded in step 2.

Staging first: deploy to `staging`, verify (the DAST baseline can run against it), then deploy the
same commit to `production`. Before the first production release, go through
[production-readiness.md](production-readiness.md).

### Compatibility between versions

During a rollout the old and the new API run side by side against the same database, and a
rollback runs the old version against the new schema. So every release must be:

- **backward compatible with the schema before it:** the new code works before its migration's
  contract step (it only adds, docs/database.md#expand-and-contract);
- **forward compatible with the schema after it:** the previous code keeps working on the migrated
  schema (it ignores new tables and nullable columns; nothing it reads was removed or renamed);
- **compatible on the wire:** the web app and the API of adjacent releases understand each other
  (new response fields are additive, new request fields optional, removals after a release in
  which nothing uses them; the contract diff shows each one in review, `openapi/README.md`); the
  web image rolls out after the API for that reason.

A change that cannot meet these (a rename, a type change, a new required field) is split across
releases: expand, migrate the readers and writers, contract.

### Rollback

| What failed                                   | Rollback                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The application (errors, latency, a bug)      | Redeploy the previous digests of `api` and `web` (step 2). The platform's own "previous revision" does the same when it points at those digests. No migration is reversed: the previous version runs on the new schema.                                     |
| An image (it does not start, fails readiness) | The same: the previous digests. Never rebuild an old commit for a rollback: it would be a new, unverified artifact.                                                                                                                                         |
| The migration                                 | Nothing to roll back in the application: the rollout had not started. Repair the database and resolve the migration (docs/incident-response.md#10-failed-database-migration); if a destructive statement removed data, restore (docs/disaster-recovery.md). |
| A release whose contract step already ran     | The previous version may need what was removed: roll forward with a fix instead, or restore. That is why contract steps ship one release after the code stopped using what they remove.                                                                     |

Running **Deploy** with an earlier release tag also rolls back, through every gate on that old
commit: slower, it rebuilds the images unless they still exist in the registry, and a gate can
fail on an advisory published since that release. Keep it for planned rollbacks; in an incident,
redeploy the recorded digests. Never roll back by reversing a migration in production.

## Running the gates locally

`pnpm verify` runs the fast gates (format, lint, typecheck, coverage, security with the dependency
policy, build, budget). Before a large pull request also run `pnpm test:integration` (PostgreSQL
from `pnpm db:up`; the Redis adapter specs run when `docker compose --profile redis up -d` is up
and `REDIS_URL` is set in `apps/api/.env`, and are skipped when no Redis URL is set) and `pnpm test:e2e`. With Docker running, `pnpm sast` and `pnpm lint:workflows` run the same pinned
images CI runs.
