# CI/CD

```
push / pull request
  └─ CI (.github/workflows/ci.yml)
       ├─ Dependency review    new vulnerable dependencies                        opt-in
       ├─ Gates (quality-gates.yml, reusable)
       │    ├─ Format, lint, types, workflows   prettier, eslint, tsc + contract types, script tests, actionlint + zizmor
       │    ├─ Static analysis (Semgrep)        SAST: code, Dockerfiles, nginx
       │    ├─ Observability as code            dashboards and alert rules: metric names, runbooks, promtool tests
       │    ├─ Infrastructure as code           infra/terraform: fmt, validate, tests, TFLint, Trivy, cloud-init, roles SQL
       │    ├─ Unit and component tests         vitest + coverage thresholds + OpenAPI drift
       │    ├─ Integration tests                API + PostgreSQL + Redis + Mailpit services (adapters, degraded mode, email outbox)
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
  └─ Release (release.yml)     release pull request: next version + changelog, and CI on it
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

| Gate                                                                                     | Where                          | Level                   |
| ---------------------------------------------------------------------------------------- | ------------------------------ | ----------------------- |
| Formatting (Prettier)                                                                    | `pnpm verify`, pre-commit, CI  | BLOCKING                |
| Lint (ESLint, type-aware, security rules), zero warnings                                 | `pnpm verify`, pre-commit, CI  | BLOCKING                |
| Types, contract types in sync with `openapi/openapi.json`                                | `pnpm verify`, pre-push, CI    | BLOCKING                |
| Unit and component tests, coverage thresholds, OpenAPI drift                             | `pnpm verify`, pre-push, CI    | BLOCKING                |
| Integration tests (API + PostgreSQL + Redis adapters + Mailpit, the email outbox)        | CI (`pnpm test:integration`)   | BLOCKING                |
| End-to-end tests (Playwright)                                                            | CI (`pnpm test:e2e`)           | BLOCKING                |
| Dependency advisories, high and critical (`pnpm audit`)                                  | `pnpm verify`, CI              | BLOCKING                |
| Dependency policy: registry sources, licenses (`pnpm deps:check`)                        | `pnpm verify`, CI              | BLOCKING                |
| Secrets in the tree (secretlint)                                                         | pre-commit, `pnpm verify`, CI  | BLOCKING                |
| Secrets in the git history (gitleaks)                                                    | CI                             | BLOCKING                |
| SAST (Semgrep)                                                                           | CI, `pnpm sast`                | BLOCKING                |
| Workflow lint and security (actionlint, zizmor), shell scripts (shellcheck)              | CI, `pnpm lint:workflows`      | BLOCKING                |
| Dashboards and alert rules (`observability/`), their unit tests (promtool)               | CI, `pnpm observability:check` | BLOCKING                |
| Infrastructure as code: Terraform checks and tests, TFLint, Trivy, cloud-init, roles SQL | CI, `pnpm iac:check`           | BLOCKING                |
| Build, performance budget                                                                | `pnpm verify`, CI              | BLOCKING                |
| Images build; fixable HIGH/CRITICAL advisories in them (Trivy)                           | CI                             | BLOCKING                |
| Branch name, Conventional Commit PR title                                                | pre-push, commit-msg, CI       | BLOCKING                |
| Dependency review (new vulnerable dependencies in the diff)                              | CI, opt-in                     | BLOCKING when enabled   |
| CodeQL                                                                                   | CI, opt-in                     | ADVISORY (Security tab) |
| DAST (OWASP ZAP)                                                                         | weekly, on demand              | ADVISORY                |
| Advisories below high (`pnpm audit` reports them), unfixed image CVEs                    | CI logs                        | ADVISORY                |
| Coverage and Playwright reports                                                          | CI artifacts                   | ADVISORY                |

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
  read-only; jobs that write ask for it themselves), and tick "Allow GitHub Actions to create and
  approve pull requests": without `RELEASE_PLEASE_TOKEN`, release-please opens its pull request
  with the default token.
- Secret `RELEASE_PLEASE_TOKEN` (optional): a GitHub App installation token or a fine-grained token
  limited to this repository (contents, pull requests, issues: write), for release pull requests
  that run every pull request workflow ([Release pull requests](#release-pull-requests)).
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
   `package.json` files, `openapi/openapi.json` (`info.version`, which the API takes from its
   `package.json`, so the contract test keeps passing) and `.release-please-manifest.json`, and the
   new `CHANGELOG.md` entry (features, fixes, performance, reverts; housekeeping types are left
   out).
2. Merging it (review and CI like any pull request) creates the tag `vX.Y.Z` (immutable) and the
   GitHub release with the same notes, then attaches the SBOM (`sbom.cdx.json`).
3. Deploying is separate: run **Deploy** with the tag as the ref, staging first.

A project created from the template continues from the template's version (`1.0.0` in
`.release-please-manifest.json`): its first `fix` makes 1.0.1, its first `feat` 1.1.0. To choose
another version, merge a pull request with the footer `Release-As: <version>` added to its commit
message in the **Squash and merge** dialog. Changesets was not chosen: it suits packages published separately, with a changeset file per
change; here the apps ship together under one version and the commit titles already say what
changed. semantic-release would release on every merge; the release pull request lets the team
choose the moment and review the notes.

## Release pull requests

release-please opens and updates the release pull request with the workflow's token. GitHub holds
the pull request runs that token causes until someone with write access approves them, and the
ruleset requires **CI passed** and **Conventions** on every pull request. The release workflow
therefore starts both on the release branch itself (`gh workflow run ci.yml` and
`gh workflow run conventions.yml`, events that token can trigger): their checks land on the branch's
latest commit, the one the ruleset checks. Nothing to configure. A dispatched **Conventions** checks
the branch name and the title of the branch's open pull request, as on a pull request event, and
only runs for a `release-please--` branch. The pull request's other workflows (CodeQL) keep waiting
for an approval no rule requires; a project that makes one of them a required check starts it in
the same job (`release-pr-ci` in `release.yml`). A change that adds nothing to the changelog
(`chore`, `docs`, `ci`, `build`, Dependabot's updates…) leaves the release pull request as it was,
behind `main`: **Update branch** on it brings it up to date, and CI runs as for anyone's push.

`RELEASE_PLEASE_TOKEN` is optional: a GitHub App token or a fine-grained token (contents, pull
requests and issues: read and write) opens the release pull request as that identity instead. Every
pull request workflow then runs on it as on a person's, and the release workflow starts nothing
itself. A personal token makes its owner the pull request's author, who then cannot approve it under
the ruleset: prefer a GitHub App token.

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
  passes only between two jobs of the same release run. The one artifact read across runs is the
  Deploy workflow's record of the images it published, and only from a run of that workflow from a
  commit on `main` (`scripts/recorded-images.mjs`).
- **Secrets only where used.** Pull request jobs use none. Deployment secrets live in the GitHub
  environments, which only `main` can deploy to.
- **Everything pinned** (below), and caches are keyed by the lockfile; caches written by pull
  requests are visible only to that pull request's branch.

## Infrastructure as code

`infra/terraform/digitalocean` provisions the server target on DigitalOcean
([deploy-vps.md](deploy-vps.md#provision-with-terraform-digitalocean)). The CI job **Infrastructure
as code (Terraform)**, and `pnpm iac:check` locally, check it with the pinned images, the
configuration mounted read-only, without a cloud account or a token:

| Check                                                                                 | Fails on                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `terraform fmt -check -recursive`                                                     | a file Terraform would reformat                                                         |
| `terraform init -backend=false -lockfile=readonly`, `terraform validate`              | a provider whose checksum is not in `.terraform.lock.hcl`; an invalid configuration     |
| `terraform test` (`tests/*.tftest.hcl`, the DigitalOcean provider mocked)             | the server, firewalls, database or alerts drifting from the guide; a bad input accepted |
| TFLint, every bundled Terraform rule (`infra/terraform/.tflint.hcl`)                  | any finding, notices included                                                           |
| Trivy's misconfiguration checks (those bundled with the pinned image)                 | HIGH or CRITICAL, unless an inline `trivy:ignore` gives its reason                      |
| `cloud-init schema` on the rendered user data, with Ubuntu 24.04's cloud-init         | an invalid key or value                                                                 |
| shellcheck on the user data's `runcmd`, the fingerprint of `files/docker.asc`         | a shell finding; a key other than Docker's                                              |
| `database/roles.sql` on PostgreSQL as an administrator that is not a superuser, twice | an error; roles or rights other than the guide's                                        |

A real `terraform plan` or `apply` is never part of CI: it needs an account, a token and the
state. Run them by hand, per environment. The Terraform and TFLint images are updated by
Dependabot like every tool image, and the providers by its `terraform` entry (version and
checksums together); a Terraform minor release also needs `required_version` in `versions.tf`,
which the gate enforces.

## Pinning

| What                                                                                                                                                                   | Pinned by                                                          | Updated by                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| GitHub Actions (`uses:`)                                                                                                                                               | commit SHA, tag in comment                                         | Dependabot (`github-actions`)                            |
| Tool images (actionlint with shellcheck, zizmor, Semgrep, gitleaks, Trivy, Terraform, TFLint, Ubuntu, ZAP, promtool) and the CI PostgreSQL, Redis and Mailpit services | tag and digest in `.github/tool-images/Dockerfile`                 | Dependabot (`docker`), tag and digest together           |
| Base images in the Dockerfiles (Node.js from ECR Public's mirror of Docker's official images, nginx from NGINX's GHCR)                                                 | tag and digest                                                     | Dependabot (`docker`), tag and digest together           |
| Compose images                                                                                                                                                         | tag                                                                | Dependabot (`docker-compose`)                            |
| npm packages                                                                                                                                                           | `pnpm-lock.yaml` (integrity hashes)                                | Dependabot (`npm`), `pnpm update`                        |
| Terraform providers (`infra/terraform`)                                                                                                                                | exact version in `versions.tf`, checksums in `.terraform.lock.hcl` | Dependabot (`terraform`), version and checksums together |
| Node.js                                                                                                                                                                | the major in `.nvmrc` (CI, hooks); the base images above           | the major by hand ([below](#nodejs))                     |
| pnpm                                                                                                                                                                   | `packageManager` in `package.json`, recorded in `pnpm-lock.yaml`   | by hand ([below](#pnpm))                                 |
| The runners (`runs-on` of every job)                                                                                                                                   | `ubuntu-24.04`, the servers' Ubuntu                                | by hand ([below](#ubuntu))                               |

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
with the same digest, the pin points there (GHCR, Quay for promtool, or Docker's mirror of its
official images on Amazon ECR Public). ECR Public caps anonymous pulls per address as well
(`toomanyrequests: Data limit exceeded`), so the tool images on Docker Hub or ECR Public are
pulled in CI through `mirror.gcr.io` by their digest (`TOOL_IMAGE_MIRROR` in `quality-gates.yml`,
read by `scripts/tool-image.mjs`; an ECR Public image under its Docker Hub name): the digest makes
the content identical whatever the source, the pinned registry stays the fallback, and Dependabot
keeps updating the pins from their source. The same goes for what CI pulls without a script:

- the PostgreSQL, Redis and Mailpit service containers of the integration and end-to-end jobs get the
  mirror's copy from the `Tool images` job (`node scripts/tool-image.mjs --mirrored <name>`), which
  first asks the mirror whether it has that digest, since a service container cannot fall back;
- the image builds, of the gates (`docker-images.yml`) and of a deployment (`deploy.yml`), get a
  BuildKit build context per base image the mirror has
  (`node scripts/tool-image.mjs --build-contexts <Dockerfile>`): a context named like a `FROM`
  reference replaces it, so the Dockerfiles keep their pins and Dependabot its updates. The image
  is the same, but its provenance names `mirror.gcr.io` as where the base image came from.

GHCR limits anonymous pulls too, so before a script runs a tool image it pulls it and, when a
registry answers with its rate limit, retries after 5, 10 and 20 seconds (`ensureImage`).

## Keeping the stack current

Dependabot's pull requests are the weekly routine ([Dependency updates](#dependency-updates)). What
it never proposes is moved by a person, on its own branch, with the full CI on its pull request
(the images are built and scanned there too):

| Part                | Dependabot proposes                                                      | Moved by hand                                                                      |
| ------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| npm packages        | minors and patches (grouped), majors (one per pull request)              | merging a major, after its release notes; [TypeScript](#typescript)                |
| Node.js             | the base image's new digest within the major, weekly                     | [the major](#nodejs), and `@types/node`'s with it                                  |
| pnpm                | nothing: it never edits `packageManager`                                 | [a new version](#pnpm)                                                             |
| GitHub Actions      | new SHA and version comment, in the workflows and `.github/actions/*`    | merging: the auto-merge never merges a change to a workflow or an action           |
| Tool images         | tag and digest together                                                  | a Terraform minor also needs `required_version` ([above](#infrastructure-as-code)) |
| PostgreSQL, Redis   | the new digest within the major (CI images); Compose tags within it      | [the major](#postgresql-and-redis)                                                 |
| Terraform providers | version and lock-file checksums together                                 | nothing                                                                            |
| Ubuntu              | nothing: neither a runner label nor the servers' release is a dependency | [the next LTS](#ubuntu), everywhere at once                                        |

### Node.js

`.nvmrc` names the major (`24`), not a release: CI runs a release of it, and the Dockerfiles' base
image (`node:24-bookworm-slim`, by digest) gets the new patch releases through Dependabot. A major
moves once it is an LTS release (an even major, from its October):

1. `.nvmrc`: the new major. `package.json` `engines.node` accepts it already
   (`^24.15.0 || >=26.0.0`); drop the old major once everybody has moved (`engineStrict` refuses an
   install outside the range).
2. `@types/node` in the root and both apps: `pnpm add -D @types/node@^<major>` in each (Dependabot
   leaves its majors to this step).
3. The Dockerfiles (`apps/api/Dockerfile`, every `FROM` of the base image; `apps/web/Dockerfile`):
   the new tag with its digest, from
   `docker buildx imagetools inspect public.ecr.aws/docker/library/node:<major>-bookworm-slim`.
4. Corepack is not part of Node.js 25 and later, and the images install pnpm with it: replace
   `RUN corepack enable` with `RUN npm install -g corepack@<version> && corepack enable` (an exact
   version, at least a week old). On `node:26-bookworm-slim` this gives the pnpm of
   `packageManager`; the hardened stage already deletes npm and Corepack from the shipped images.
5. The documents and comments that name the major:
   `grep -rnE "Node\.js 24|24\.15|node:24" README.md CONTRIBUTING.md docs apps/*/Dockerfile`
   (the manual and the step-by-step guide in both languages).
6. `pnpm install`, the gates ([Running the gates locally](#running-the-gates-locally)) and the
   images (`docker compose --profile stack up --build`). On the pull request, CI builds and scans
   the images on the new base.

### pnpm

`packageManager` in `package.json` pins pnpm for developers (pnpm switches to it by itself), CI
(`pnpm/action-setup` reads it) and the images (Corepack reads it); `pnpm-lock.yaml` records it
with its checksum (`packageManagerDependencies`). Dependabot only rewrites dependency declarations,
never `packageManager`.

1. Read the release notes: the settings of `pnpm-workspace.yaml` (the supply-chain policies) change
   between majors; `pnpm deps:check` (in `pnpm security`) checks they still hold.
2. `pnpm self-update <version>`, a release at least a week old: it rewrites `packageManager` (the
   project's `minimumReleaseAge` does not apply to `self-update`).
3. `pnpm install`: it records the version in `pnpm-lock.yaml`. Without it every
   `pnpm install --frozen-lockfile` fails ("Cannot update packageManagerDependencies").
4. The version named in the manual and the step-by-step guide (both languages).
5. The gates, and the images.

### TypeScript

Dependabot proposes TypeScript like any package, a major in its own pull request. typescript-eslint
supports a range of TypeScript versions (`pnpm view typescript-eslint peerDependencies`:
`>=4.8.4 <6.1.0` with typescript-eslint 8.71, so neither 6.1 nor 7 yet): a version outside it is not
merged until typescript-eslint supports it. Then `pnpm typecheck`, `pnpm lint` and the tests.

### Ubuntu

CI's runners and the servers run the same Ubuntu LTS, 24.04: `runs-on: ubuntu-24.04` in every
workflow, the servers' release ([deploy-vps.md](deploy-vps.md#1-what-you-need); `droplet_image` in
`infra/terraform/digitalocean`) and the `ubuntu` tool image of the cloud-init check. CI does not use
`ubuntu-latest`: GitHub moves that label to a new release on its own schedule (Ubuntu 26.04, from
October 2026), which would change the system of every job without a commit. The next LTS moves all
of them in one pull request with the full CI, once what the jobs install on the runner supports it
(Playwright's browser dependencies, `playwright install --with-deps`) and the servers' guides have
been followed on it.

### PostgreSQL and Redis

Their majors move by hand, together, so CI keeps testing what runs:

1. `docker-compose.yml` (`db`, `redis`) and `.github/tool-images/Dockerfile` (`postgres`, `redis`,
   tag and digest): the same major.
2. PostgreSQL in production: the managed database's major upgrade, by the provider's procedure,
   then `postgres_version` in `infra/terraform/digitalocean` to match (its validation lists the
   accepted majors), and a restore drill afterwards
   ([disaster-recovery.md](disaster-recovery.md#checklist)).
3. Local data: a PostgreSQL data directory does not start under the next major. Dump it before
   (`docker compose exec db pg_dumpall -U app > dump.sql`), remove the volume, start the new
   version and restore it; or start empty, with `pnpm db:migrate` and `pnpm db:seed`.

## Deployment

`deploy.yml` is the integration point. Run it from `main` (it refuses any other branch) with the
environment and the ref to deploy: a branch, a release tag or a commit SHA. The ref is resolved
once to a commit, which must be on `main` (reviewed and merged code only); the gates and the
release then use that SHA, never the ref, which could move in between.

Two release paths follow the gates:

- **The reference target, one Linux server with Docker** (repository variable
  `DEPLOY_TARGET=vps`, [deploy-vps.md](deploy-vps.md)), implemented: `publish` pushes the three
  images to ghcr.io once per commit, scans the digests it pushed and records them in the run
  (production reuses the digests staging recorded, and scans them again), and `release-vps`, in the
  GitHub environment,
  checks that the server's copy of `deploy/vps` matches the release, runs `deploy.sh` on the
  server over SSH with the recorded digests (pull by digest, migrate, roll out, back to the running
  release when the rollout fails), runs the smoke test and calls `rollback.sh` when it fails.
- **Any other platform:** the `release` job fails on purpose until it is implemented for it
  (REQUIERE CONFIGURACIÓN), in the order below.

The pipeline from a merged commit to production, and who does each step:

| Step                          | VPS target (`DEPLOY_TARGET=vps`)                                   | Any other platform (REQUIERE CONFIGURACIÓN)         |
| ----------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| 1. Build                      | Gates (`pnpm build`, the three images)                             | the same                                            |
| 2. Test                       | Gates (unit, component, integration, E2E, coverage)                | the same                                            |
| 3. Security gates             | Gates (audit, dependency policy, secrets, SAST, Trivy)             | the same                                            |
| 4. Publish the images         | `publish`: ghcr.io, once per commit, scanned and recorded          | `docker-images.yml` with `push: true`               |
| 5. Deploy by immutable digest | `release-vps` hands the recorded `<image>@<digest>` to `deploy.sh` | the release job                                     |
| 6. Migrate (expand/contract)  | `deploy.sh` runs the `api-migrate` image                           | the release job runs the `api-migrate` image        |
| 7. Deploy the API             | `deploy.sh`, waiting for readiness                                 | the release job                                     |
| 8. Deploy the web image       | `deploy.sh`                                                        | the release job                                     |
| 9. Smoke test                 | `scripts/smoke-test.mjs` in `release-vps`                          | `scripts/smoke-test.mjs` in the release job         |
| 10. Rollback on failure       | `deploy.sh` on a failed rollout, `rollback.sh` on a failed smoke   | the release job, or by hand ([Rollback](#rollback)) |

Steps 1 to 3 run on the exact commit being deployed (the `gates` job of `deploy.yml`). For any
other platform, implement the release job in this order (the VPS target follows it too):

1. **Images, once per commit.** Push them (`docker-images.yml` with `push: true`, tags
   `<IMAGE_PREFIX>/<image>:<sha>`), take each digest from the build's output, scan that digest and
   record it. Production must run the digests staging verified, not a rebuild (a rebuild picks up
   newer base image patches and is a different artifact): reuse the digests staging recorded. Never
   look a digest up from the tag: any workflow of the repository with `packages: write`, on any
   branch, can push `<image>:<sha>`, and a lookup after the approval wait would ship whatever it
   points to then. The VPS jobs do this with an artifact per image, trusted only from a run of
   `deploy.yml` from a commit on `main` (`scripts/recorded-images.mjs`). Deploy `<image>@<digest>`
   from here on; verify its attestation first where signed attestations are enabled
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
releases: expand, migrate the readers and writers, contract. Nothing at run time tells a contract
step that came too early (readiness and the smoke test read no table), so the migration that
contracts says why it is safe, `-- contract: <reason>` above the statement, and
`scripts/check-migrations.mjs` refuses one without it (docs/database.md#expand-and-contract).

### Rollback

| What failed                                   | Rollback                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The application (errors, latency, a bug)      | Redeploy the previous digests of `api` and `web` (step 2). The platform's own "previous revision" does the same when it points at those digests. No migration is reversed: the previous version runs on the new schema.                                     |
| An image (it does not start, fails readiness) | The same: the previous digests. Never rebuild an old commit for a rollback: it would be a new, unverified artifact.                                                                                                                                         |
| The migration                                 | Nothing to roll back in the application: the rollout had not started. Repair the database and resolve the migration (docs/incident-response.md#10-failed-database-migration); if a destructive statement removed data, restore (docs/disaster-recovery.md). |
| A release whose contract step already ran     | The previous version may need what was removed: roll forward with a fix instead, or restore. That is why contract steps ship one release after the code stopped using what they remove.                                                                     |

Running **Deploy** with an earlier release tag also rolls back, through every gate on that old
commit: slower, it rebuilds the images unless an earlier run recorded them (the VPS target keeps
its records 90 days; an image still in the registry is not enough, by design), and a gate can fail
on an advisory published since that release. Keep it for planned rollbacks; in an incident,
redeploy the recorded digests. Never roll back by reversing a migration in production.

## Running the gates locally

`pnpm verify` runs the fast gates (format, lint, typecheck, coverage, security with the dependency
policy, build, budget). Before a large pull request also run `pnpm test:integration` (PostgreSQL
from `pnpm db:up`; the Redis adapter specs run when `docker compose --profile redis up -d` is up
and `REDIS_URL` is set in `apps/api/.env`, and are skipped when no Redis URL is set) and
`pnpm test:e2e`. With Docker running, `pnpm sast`, `pnpm lint:workflows`,
`pnpm observability:check` and `pnpm iac:check` run the same pinned images CI runs.
