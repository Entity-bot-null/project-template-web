# Manual

Versión en español: [manual.es.md](manual.es.md). Both versions describe the same steps and
commands; a change to one goes to the other in the same pull request.

How to use this template, from an empty machine to a project running in production, with every
command it ships. Each step says what to run, what it does and what you should see. The other
pages in `docs/` hold the reasoning and the details; this one is the path through them.

Conventions:

- Commands run from the repository root unless a step says otherwise. On Windows use **Git Bash**
  (installed with Git for Windows): every command here is written for it.
- `<angle brackets>` are values you replace. `OWNER/REPO` is your GitHub repository.
- **REQUIERE CONFIGURACIÓN** marks a step only your project can complete (a provider, an account, a
  decision); the template prepares it but cannot do it for you.
- `pnpm <script>` runs a root script; `pnpm --filter api <script>` and `pnpm --filter web <script>`
  run a script of one app.

## Contents

1. [Before you start](#1-before-you-start)
2. [Create a project from the template](#2-create-a-project-from-the-template)
3. [Daily development](#3-daily-development)
4. [Tests](#4-tests)
5. [Commits, pushes and pull requests](#5-commits-pushes-and-pull-requests)
6. [Configuration](#6-configuration)
7. [Command reference](#7-command-reference)
8. [CI/CD](#8-cicd)
9. [Releases](#9-releases)
10. [Deploying and rolling back](#10-deploying-and-rolling-back)
11. [Optional infrastructure](#11-optional-infrastructure)
12. [Running in production](#12-running-in-production)
13. [Maintenance calendar](#13-maintenance-calendar)
14. [When something fails](#14-when-something-fails)
15. [Appendix: ports, accounts, files](#15-appendix-ports-accounts-files)

## 1. Before you start

### 1.1 Install the tools

| Tool                   | Version                                     | Check                    | Notes                                                                                                                   |
| ---------------------- | ------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Node.js                | 24.15 or later, or 26+ (`.nvmrc`: 24)       | `node --version`         | nvm (`nvm install 24 && nvm use`), fnm (`fnm use`), Volta or the official installer. Older versions are refused.        |
| pnpm                   | 12.5.1 (`packageManager` in `package.json`) | `pnpm --version`         | `corepack enable` once, and Node's Corepack provides the exact version. Without Corepack: `npm install -g pnpm@12.5.1`. |
| Docker with Compose v2 | any current                                 | `docker compose version` | Docker Desktop (Windows, macOS) or Docker Engine (Linux). Needed for the database, the images and the security tools.   |
| Git                    | any current                                 | `git --version`          | Windows: Git for Windows, which brings Git Bash and `openssl`.                                                          |
| openssl                | any                                         | `openssl version`        | Generates secrets. Without it: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.         |
| GitHub CLI (optional)  | any current                                 | `gh --version`           | Only for the repository settings in [2.9](#29-set-up-github); everything can also be done in the web UI.                |

Disk: the development database image is small; the production images take about 1 GB each, the
optional local observability backend about 3.7 GB and the DAST scanner about 3.7 GB.

### 1.2 Windows notes

- If `pnpm db:up` fails with "port is already allocated" or "bind failed", Windows often reserves
  the database's port (5442): use another port ([2.4](#24-create-the-environment-files)).
- Git Bash rewrites paths that start with `/` when it passes them to `docker`. Prefix such commands
  with `MSYS_NO_PATHCONV=1` (shown where needed).
- Docker Desktop must be running before any command that uses Docker.

## 2. Create a project from the template

Once per new project, in this order.

### 2.1 Get the code

Either mark the template repository as a template on GitHub (Settings → **Template repository**)
and create the new repository with **Use this template**, then clone it; or copy it without its
history:

```
git clone --depth 1 <template repository URL> my-project
cd my-project
rm -rf .git
git init -b main
```

### 2.2 Rename it (REQUIERE CONFIGURACIÓN)

| Where                             | What to change                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `package.json` (root)             | `name`, `description`                                                                                                        |
| `README.md`                       | the title and the first paragraph                                                                                            |
| `apps/web/index.html`             | `<title>`, the meta description, `lang`                                                                                      |
| `apps/api/src/openapi/openapi.ts` | `.setTitle('API')`, then run `pnpm contract`                                                                                 |
| `apps/landing/src/lib/site.ts`    | `SITE_NAME`, the name on the public site; its words are in `apps/landing/src/i18n/` ([how-to](how-to.md#change-the-landing)) |
| `apps/landing/public/`            | `favicon.svg`, the icon, and `og.png`, the picture a shared link shows, with the name drawn in it (1200 × 630)               |
| `SECURITY.md`                     | the private contact for vulnerability reports                                                                                |
| `.github/CODEOWNERS`              | real users or teams instead of the placeholders, uncommented                                                                 |
| `LICENSE` (none ships)            | the license the product needs, if it is distributed                                                                          |

The workspace packages are called `api`, `web` and `landing` on purpose: they are private and need
no rename.

### 2.3 Install

```
corepack enable        # once per machine (Node.js 25+: npm install -g corepack first)
pnpm install
```

This installs every app, generates the Prisma client (`prisma generate`) and installs the Git hooks
(Husky sets `core.hooksPath`). It refuses Node.js versions outside `engines`, packages published
less than seven days ago, and new install scripts that are not reviewed
([14](#14-when-something-fails) lists the messages).

### 2.4 Create the environment files

```
cp apps/api/.env.example apps/api/.env
openssl rand -hex 32
```

Paste the printed value as `JWT_ACCESS_SECRET=` in `apps/api/.env`. That is the only value the API
needs to start locally; the file documents every other variable. It already points email at the
local Mailpit ([11.5](#115-email)); delete `MAIL_SMTP_URL` and `SIGN_UP_ENABLED` (sign-up needs
email) to run without it. It points the API at the local Redis too ([11.1](#111-redis)); delete
`REDIS_URL`, `RATE_LIMIT_STORE`, `CACHE_STORE` and `REDIS_REQUIRED` to run without it.

The root `.env` is read by Docker Compose. Create it when you need one of its settings:

```
cp .env.example .env
```

- **Port 5442 taken:** the database uses 5442 rather than PostgreSQL's 5432, so it does not collide
  with a PostgreSQL installed on the machine. If 5442 is taken too: `DB_PORT=5443` in the root
  `.env`, and the same port in `DATABASE_URL` of `apps/api/.env`
  (`postgresql://app:app@localhost:5443/app`).
- **The production-like stack** ([2.7](#27-check-that-every-gate-passes)): `JWT_ACCESS_SECRET` in the
  root `.env` too (another `openssl rand -hex 32`).
- **Ports 1035 or 8035 taken** (Mailpit's SMTP and web UI; not its usual 1025 and 8025, which
  another project's Mailpit may hold): `MAILPIT_SMTP_PORT` and `MAILPIT_UI_PORT` in the root
  `.env`, and the SMTP port in `MAIL_SMTP_URL` of `apps/api/.env`.
- **Port 6389 taken, or another Redis password** ([11.1](#111-redis)): Redis uses 6389 rather than
  Redis's 6379, with the password `app`: `REDIS_PORT` and `REDIS_PASSWORD` in the root `.env`, and
  the same in `REDIS_URL` of `apps/api/.env`.

`apps/web/.env.example` and `apps/landing/.env.example` list the optional settings of the web app
and of the landing; none is needed.

Never commit a `.env` file: `.gitignore`, the pre-commit hook and the secret scans refuse them.

### 2.5 Create the database

```
pnpm db:up        # PostgreSQL 18 in Docker, on 127.0.0.1 only, data in the volume db_data
pnpm db:migrate   # applies every migration, regenerates the Prisma client
pnpm db:seed      # development accounts (public passwords; refuses any non-local database)
```

The seed prints the accounts: `admin@example.com` / `admin-password` and `member@example.com` /
`member-password`. It is idempotent: run it again whenever you want them back.

### 2.6 Run it

```
pnpm dev
```

It starts the database, Redis and Mailpit (`pnpm services:up`, if stopped), then the API, the web
app and the landing (the public site) with live reload, and prints these addresses in a box under
their logs, again after every restart:

| What                                        | URL                                             |
| ------------------------------------------- | ----------------------------------------------- |
| The site: the landing, in Spanish at `/es/` | http://localhost:4321                           |
| The web app, through the site               | http://localhost:4321/app/                      |
| API                                         | http://127.0.0.1:3000/api                       |
| API documentation (Swagger)                 | http://localhost:3000/api/docs                  |
| API liveness / readiness                    | http://127.0.0.1:3000/api/health/live, `/ready` |
| Email the API sent                          | http://localhost:8035 (Mailpit)                 |

The landing's server is the site's single entry, as the web image is in production: it forwards
`/app` to the web app's dev server (also reachable on its own at http://localhost:5173/app/) and
`/api` to the API. Open http://localhost:4321, follow **Sign in** and sign in with a seeded account.
The API's first log line says what is on:
`Starting release unversioned in development: tracing and metrics off, error tracking off, Redis on, email on`.

Stop with `Ctrl+C`. `pnpm db:down` removes the database, Redis and Mailpit containers; the data of
the database and of Redis stays in their Docker volumes (Mailpit's messages do not), and the
optional services keep running until `docker compose --profile <profile> down`.

### 2.7 Check that every gate passes

Run once now, so you know the machine is set up like CI:

```
pnpm verify                              # format, lint, types, unit tests + coverage, security, build, budget
pnpm test:integration                    # API against PostgreSQL (and Redis, if configured)
pnpm exec playwright install chromium    # once per machine
pnpm test:e2e                            # browser tests on the built app (needs pnpm build, done by verify)
pnpm test:scripts                        # tests of the repository scripts (Semgrep file selection, Doberman)
pnpm sast                                # Semgrep (Docker; a few minutes, see 14)
pnpm lint:workflows                      # actionlint + zizmor + shellcheck (Docker)
pnpm observability:check                 # dashboards and alert rules, promtool tests (Docker)
pnpm iac:check                           # Terraform, TFLint, Trivy, cloud-init, both roles scripts (Docker)
docker compose --profile stack up --build   # production images: the site at http://localhost:8080, the app at /app/
```

For the last one, the root `.env` needs `JWT_ACCESS_SECRET`. In another terminal:
`pnpm smoke --url http://localhost:8080` should end with `Smoke test passed (public URL only).`
Stop it with `Ctrl+C`, then `docker compose --profile stack down`.

### 2.8 Make it yours (REQUIERE CONFIGURACIÓN)

- UI language, the design system (`apps/web/src/index.css` is a placeholder), the product name.
- Roles: [how-to.md](how-to.md#add-a-role).
- The account lifecycle the product needs beyond password recovery and change and the optional
  public sign-up (`SIGN_UP_ENABLED`): MFA or SSO (docs/security.md#authentication-and-tokens).
- Replace or extend the example `users` module with your domain; keep `auth`, `health`, `common`,
  `observability`, `infrastructure` and `lifecycle`.
- Coverage thresholds and the performance budget stay as floors; adjust them deliberately
  ([testing.md](testing.md#coverage)).
- The license policy for dependencies (`scripts/dependency-policy.json`) if the product's
  distribution needs a stricter or looser one.
- Which optional integrations the project will use ([11](#11-optional-infrastructure)).
- `docs/template/` can be deleted once the project no longer needs its history.

### 2.9 Set up GitHub

First commit and the only direct push to `main` the project ever makes (the pre-push hook refuses
any other):

```
git add -A
git commit -m "chore: start from the project template"
git remote add origin <repository URL>
git push --no-verify -u origin main
```

The first commit runs the pre-commit hook over every file (about 40 seconds).

Then the repository settings (REQUIERE CONFIGURACIÓN), in the web UI or with `gh`:

| Setting                                                                                             | Where / command                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Squash merge only, default message = pull request title, delete branches after merge                | Settings → General → Pull Requests                                                                                                                                         |
| Ruleset for `main`: pull requests, **CI passed** and **Conventions**, code owners, no force push    | `gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/main.json` (public repository or paid plan)                                                       |
| Release tags `v*` immutable                                                                         | `gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/tags.json`                                                                                        |
| Read-only default token for workflows                                                               | Settings → Actions → General → Workflow permissions → Read repository contents; tick "Allow GitHub Actions to create and approve pull requests" (the release pull request) |
| Environments `staging` and `production`, deployment branches "`main` only", reviewers on production | Settings → Environments                                                                                                                                                    |
| Optional token for release pull requests (every pull request workflow runs on them)                 | `gh secret set RELEASE_PLEASE_TOKEN` (a GitHub App token or a fine-grained token: contents, pull requests, issues)                                                         |
| Registry for the images                                                                             | `gh variable set IMAGE_PREFIX --body ghcr.io/OWNER/REPO`                                                                                                                   |
| Passive DAST of staging, once it exists                                                             | `gh variable set DAST_STAGING_URL --body https://<staging host>`                                                                                                           |
| CodeQL, dependency review (public repository or GitHub Advanced Security)                           | `gh variable set ENABLE_CODEQL --body true`, `gh variable set ENABLE_DEPENDENCY_REVIEW --body true`                                                                        |
| Dependabot alerts and security updates, private vulnerability reporting, push protection            | Settings → Code security                                                                                                                                                   |
| Deployment secrets of an environment                                                                | `gh secret set <NAME> --env production` (or the platform's secret store)                                                                                                   |

Details and reasons: [ci-cd.md](ci-cd.md#repository-settings-requiere-configuración).

### 2.10 Before the first production release

Go through [production-readiness.md](production-readiness.md): backups and a restore drill, alerts
and SLOs, the deployment job, the contacts of the incident runbooks. [10](#10-deploying-and-rolling-back)
and [12](#12-running-in-production) below walk through them.

## 3. Daily development

### 3.1 Start the day

```
git switch main
git pull
pnpm install          # when pnpm-lock.yaml changed
pnpm db:migrate       # when apps/api/prisma/migrations/ changed
pnpm dev
```

If `apps/api/.env.example` gained a variable, copy it into your `apps/api/.env`. If the editor shows
old types after a pull, run "TypeScript: Restart TS Server" (VS Code).

### 3.2 Start a change

1. The issue meets the [Definition of Ready](definition-of-ready.md) (the feature template asks for
   each item).
2. A branch from an up-to-date `main`, named `<type>/<description>`:

   ```
   git switch -c feat/ABC-123-user-invitations
   ```

   Types: `feat`, `fix`, `hotfix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`,
   `release`. Check a name with `node scripts/check-branch-name.mjs <name>`.

### 3.3 Make the change

Step-by-step recipes with code that passes every gate, in [how-to.md](how-to.md):

| Change                                        | Recipe                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A table or a column                           | [Add a table or a column](how-to.md#add-a-table-or-a-column)                               |
| A new API resource                            | [Add an API module](how-to.md#add-an-api-module)                                           |
| One more route                                | [Add an endpoint](how-to.md#add-an-endpoint-to-an-existing-module)                         |
| A contract change                             | [Change the API contract](how-to.md#change-the-api-contract)                               |
| A screen                                      | [Add a screen](how-to.md#add-a-screen-to-the-web-app)                                      |
| A browser test                                | [Add an end-to-end test](how-to.md#add-an-end-to-end-test)                                 |
| A configuration value                         | [Add an environment variable](how-to.md#add-an-environment-variable)                       |
| A role                                        | [Add a role](how-to.md#add-a-role)                                                         |
| A dependency                                  | [Add a dependency](how-to.md#add-a-dependency)                                             |
| A cached read                                 | [Cache a read](how-to.md#cache-a-read)                                                     |
| A call to a third-party API                   | [Call an external service](how-to.md#call-an-external-service)                             |
| A job on one instance, a message handled once | [Run a job on one instance](how-to.md#run-a-job-on-one-instance-or-process-a-message-once) |
| Another app or a worker                       | [Add another app](how-to.md#add-another-app-or-a-background-worker)                        |

The rules every change follows: [ENGINEERING_STANDARDS.md](../ENGINEERING_STANDARDS.md).

### 3.4 Change the API contract

Contract first: write the Zod schemas and the controller signatures, then

```
pnpm contract
```

It exports `openapi/openapi.json` from the code and regenerates `apps/web/src/api/schema.d.ts`.
Review the `openapi.json` diff, commit both files, never edit them by hand. Swagger UI shows the
result at http://localhost:3000/api/docs while `pnpm dev` runs ([openapi/README.md](../openapi/README.md)).

### 3.5 Change the database

1. Edit `apps/api/prisma/schema.prisma`.
2. Create and apply the migration, and regenerate the client:

   ```
   pnpm db:migrate --name add_invitations
   ```

3. Read the generated SQL in `apps/api/prisma/migrations/<timestamp>_add_invitations/migration.sql`:
   locks on large tables, defaults, data loss warnings.
4. Keep it compatible with the version running now (expand and contract) and follow the safe
   migration rules: [database.md](database.md#safe-migrations).

Other database commands:

| Command                                        | What it does                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm --filter api exec prisma migrate status` | which migrations are applied to the database in `DATABASE_URL`                 |
| `pnpm --filter api db:deploy`                  | `prisma migrate deploy`: applies pending migrations, never creates one         |
| `pnpm --filter api exec prisma migrate reset`  | **development only**: drops the database, re-applies every migration           |
| `pnpm --filter api exec prisma generate`       | regenerates the client (the dev, lint, typecheck and test commands already do) |
| `pnpm --filter api exec prisma studio`         | a browser UI over the development database                                     |
| `docker compose exec db psql -U app -d app`    | a SQL shell in the development database                                        |

Never edit a migration that reached `main`; fix forward with a new one.

### 3.6 Before you push

```
pnpm verify
```

It runs, in order and stopping at the first failure: format check, lint, typecheck, unit and
component tests with coverage, `pnpm security` (dependency audit, dependency policy, secret scan),
build, performance budget. Also run `pnpm test:integration` when the API changed and
`pnpm test:e2e` when a user flow changed. Quick fixes:

```
pnpm format        # rewrites files to the Prettier style
pnpm lint:fix      # applies ESLint's automatic fixes
```

## 4. Tests

| Kind                    | Command                                                                                            | Needs                                                | Files                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| Unit and component      | `pnpm test`                                                                                        | nothing                                              | `*.spec.ts`, `*.spec.tsx`               |
| With coverage           | `pnpm test:coverage`                                                                               | nothing                                              | reports in `apps/*/coverage/index.html` |
| Watch mode              | `pnpm --filter api test:watch`, `pnpm --filter web test:watch`, `pnpm --filter landing test:watch` | nothing                                              |                                         |
| One file                | `pnpm --filter api exec vitest run src/users/users.service.spec.ts`                                | nothing                                              |                                         |
| Integration             | `pnpm test:integration`                                                                            | `pnpm services:up` (PostgreSQL, Redis, Mailpit)      | `apps/api/src/**/*.int.spec.ts`         |
| End-to-end              | `pnpm test:e2e`                                                                                    | `pnpm services:up`, `pnpm build`, Chromium installed | `e2e/*.e2e.ts`                          |
| End-to-end, interactive | `pnpm exec playwright test --ui`                                                                   | the same                                             |                                         |
| One end-to-end test     | `pnpm exec playwright test --grep "keeps members out"`                                             | the same                                             |                                         |
| Last end-to-end report  | `pnpm exec playwright show-report`                                                                 | a previous run                                       | `playwright-report/`                    |

- **Integration tests** create and migrate `<db>_test` on the server of `DATABASE_URL`, never touch
  the development database, and run one file at a time.
- **Redis specs** run against the development Redis (`REDIS_URL` of `apps/api/.env`, as
  `.env.example` sets it), each run under its own key prefix, or against another one for a run:
  `REDIS_TEST_URL=redis://:<password>@127.0.0.1:<port> pnpm test:integration`. Without a Redis URL
  they are skipped locally; `CI=true` makes them mandatory, as in CI.
- **End-to-end tests** use `<db>_e2e` (reseeded every run), the built API on port 3100, the built
  web app on 4173 and the built landing on 4321: stop anything else on those ports (a running
  `pnpm dev` holds 4321).
- **Landing tests** render its pages the way the build does (Astro's container API) and check both
  languages, the links search engines read and the way into the app; its coverage floor is 100%.

How to write tests, mocks, fixtures and the coverage ratchet: [testing.md](testing.md).

## 5. Commits, pushes and pull requests

### 5.1 Commit

```
git add <files>
git commit -m "feat(api): paginate the user list"
```

The message is a Conventional Commit: `<type>(<optional scope>): <summary>`, types `feat`, `fix`,
`perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`; `!` and a
`BREAKING CHANGE:` footer for breaking changes ([commits.md](commits.md)). Check a message without
committing: `printf 'feat(api): paginate the user list\n' | pnpm exec commitlint`.

The hooks run by themselves:

| Hook         | Runs                                                                                                                             | Takes          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `pre-commit` | on the staged files: refuses `.env` files, secretlint, `eslint --fix`, `prettier --write`, the contract-step check of migrations | seconds        |
| `commit-msg` | commitlint                                                                                                                       | under a second |
| `pre-push`   | refuses pushes to `main`/`master` and badly named branches, then `pnpm typecheck` and `pnpm test`                                | about 30 s     |

`--no-verify` skips them: only for the first push of a new repository or a real emergency, said in
the pull request ([git-hooks.md](git-hooks.md)). CI runs the same checks anyway.

### 5.2 Push and open the pull request

```
git push -u origin HEAD
gh pr create --fill        # or open it on GitHub
```

- Fill in the pull request template; its title is a Conventional Commit (it becomes the commit on
  `main` and the changelog line).
- Wait for **CI passed** and **Conventions** ([8](#8-cicd)); read a failure in the job's log and
  fix it on the branch.
- Get a review ([code-review.md](code-review.md)), answer every comment.
- Squash merge, delete the branch. The change is done when the
  [Definition of Done](../DEFINITION_OF_DONE.md) holds.

## 6. Configuration

### 6.1 Where configuration lives

| File                        | Read by                                                   | Committed |
| --------------------------- | --------------------------------------------------------- | --------- |
| `apps/api/.env`             | the API and the Prisma CLI, development                   | never     |
| `apps/api/.env.example`     | documentation of every API variable                       | yes       |
| `.env` (root)               | Docker Compose: ports, the stack's secret, Redis password | never     |
| `.env.example` (root)       | documentation of the Compose variables                    | yes       |
| `apps/web/.env.example`     | the web app's optional settings                           | yes       |
| `apps/landing/.env.example` | the landing's optional build setting                      | yes       |

Variables set in the environment win over `.env` files; deployments set them from the platform's
secret store. The API validates everything at boot and stops with the variable's name on a bad
value: `Environment variable JWT_ACCESS_SECRET is invalid: ...`.

### 6.2 API variables

Required: `NODE_ENV`, `DATABASE_URL`, `JWT_ACCESS_SECRET`; in production also `TRUST_PROXY`.
Everything else has a safe default. The full table with every rule: [environment.md](environment.md).

| Group               | Variables (default)                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime             | `NODE_ENV` (none), `HOST` (127.0.0.1; every interface in production), `PORT` (3000)                                                                                                                                                                           |
| Database            | `DATABASE_URL` (none), `DB_SLOW_QUERY_MS` (500), `DB_POOL_MAX` (10), `DB_STATEMENT_TIMEOUT_MS` (30000)                                                                                                                                                        |
| Authentication      | `JWT_ACCESS_SECRET` (none), `JWT_ACCESS_SECRET_PREVIOUS` (unset), `AUTH_COOKIE_SAMESITE` (strict)                                                                                                                                                             |
| HTTP                | `CORS_ORIGINS` (empty), `APP_ORIGIN` (unset; set it in production; required with email), `APP_BASE_PATH` (/app: where the web app is served under it), `TRUST_PROXY` (loopback; required in production), `RATE_LIMIT_MAX` (100), `RATE_LIMIT_WINDOW_SEC` (60) |
| Logs and identity   | `LOG_LEVEL` (log), `LOG_FORMAT` (json in production, else text), `APP_ENVIRONMENT` (NODE_ENV), `APP_RELEASE` (from the image, else unversioned)                                                                                                               |
| Error tracking      | `SENTRY_DSN` (unset: off), `SENTRY_SAMPLE_RATE` (1)                                                                                                                                                                                                           |
| Tracing and metrics | `OTEL_EXPORTER_OTLP_ENDPOINT` (unset: off), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SDK_DISABLED` (false), `OTEL_SERVICE_NAME` (api), `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_METRIC_EXPORT_INTERVAL` (60000), `OTEL_RESOURCE_ATTRIBUTES`         |
| Redis               | `REDIS_URL` (unset: off), `REDIS_KEY_PREFIX` (app:), `REDIS_REQUIRED` (false), `REDIS_COMMAND_TIMEOUT_MS` (500), `RATE_LIMIT_STORE` (memory), `CACHE_STORE` (memory); `apps/api/.env.example` turns Redis on for development                                  |
| Email               | `MAIL_SMTP_URL` (unset: off), `MAIL_FROM` (required with it), `MAIL_MAX_ATTEMPTS` (8), `MAIL_DAILY_LIMIT_PER_ADDRESS` (10), `SIGN_UP_ENABLED` (false; requires email)                                                                                         |

### 6.3 Web variables

Set on the web container (the production image), served to the app as `/app/app-config.json`; the
Vite dev and preview servers read the same names from their environment:

`APP_ORIGIN` (required, no default: the site's public origin, written into the landing's absolute
links as nginx serves them; the VPS target derives it from `APP_DOMAIN`), `API_UPSTREAM`
(http://api:3000, the API the web server forwards `/api` to), `APP_ENVIRONMENT`
(production), `APP_RELEASE` (set by the image build), `WEB_SENTRY_DSN` (empty: off),
`WEB_SENTRY_SAMPLE_RATE` (1), `WEB_VITALS_SAMPLE_RATE` (1, share of page loads that report their
Web Vitals; 0: off). Development only: `API_PROXY_TARGET` (http://127.0.0.1:3000).
Anything named `VITE_*` is compiled into the public bundle: never a secret.

The landing reads one variable, when it is built: `PUBLIC_URL` (http://localhost:4321), the public
origin of its canonical and alternate links, its sitemap and its robots.txt (the web image builds it
for a placeholder that `APP_ORIGIN` replaces). Its dev server's forwarding moves with
`API_PROXY_TARGET` (http://127.0.0.1:3000) and `WEB_PROXY_TARGET` (http://localhost:5173)
([environment.md](environment.md#landing-variables)).

### 6.4 Compose variables (root `.env`)

`DB_PORT` (5442), `REDIS_PORT` (6389), `REDIS_PASSWORD` (app), `MAILPIT_SMTP_PORT` (1035),
`MAILPIT_UI_PORT` (8035), `JWT_ACCESS_SECRET` (the stack's API), `WEB_PORT` (8080), `OTLP_HTTP_PORT`
(4318), `GRAFANA_PORT` (3001), `PROMETHEUS_PORT` (9090), `APP_RELEASE` (the stack images' release,
default `local`); the stack's own Redis settings, which default to the compose Redis:
`STACK_REDIS_URL`, `STACK_RATE_LIMIT_STORE`, `STACK_CACHE_STORE`; and its optional integrations:
`STACK_OTEL_EXPORTER_OTLP_ENDPOINT`, `STACK_SENTRY_DSN`, `STACK_WEB_SENTRY_DSN`.

### 6.5 Per environment

| Setting               | development                  | CI                            | staging                                                    | production         |
| --------------------- | ---------------------------- | ----------------------------- | ---------------------------------------------------------- | ------------------ |
| `NODE_ENV`            | `development`                | `test`                        | `production`                                               | `production`       |
| `APP_ENVIRONMENT`     | default                      | default                       | `staging`                                                  | `production`       |
| `TRUST_PROXY`         | default                      | default                       | the real hop count                                         | the real hop count |
| Secrets               | `apps/api/.env`, root `.env` | generated per run             | platform secret store; the VPS target: files on the server | the same           |
| Redis                 | the compose Redis            | a Redis service for its specs | the server's own (VPS target), or a private one            | the same           |
| Optional integrations | off, or local services       | off                           | as decided                                                 | as decided         |

## 7. Command reference

Every command the template ships.

### 7.1 Root scripts (`pnpm <script>`)

| Command                                                           | What it does                                                                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                                    | installs the workspace; runs `prepare` (installs the Git hooks) and the API's `postinstall` (`prisma generate`)                                                             |
| `pnpm dev`                                                        | `pnpm services:up`, then the API (`nest start --watch`), the web app (Vite) and the landing (Astro) in parallel; their URLs in a box under the logs                         |
| `pnpm build`                                                      | builds every app (`apps/*/dist`)                                                                                                                                            |
| `pnpm lint`                                                       | ESLint on the whole repository, zero warnings allowed                                                                                                                       |
| `pnpm lint:fix`                                                   | the same, applying automatic fixes                                                                                                                                          |
| `pnpm format`                                                     | Prettier rewrites every file                                                                                                                                                |
| `pnpm format:check`                                               | Prettier reports unformatted files                                                                                                                                          |
| `pnpm typecheck`                                                  | TypeScript in every app (`astro check` for the landing), the contract types check and the repository scripts                                                                |
| `pnpm test`                                                       | unit and component tests of every app                                                                                                                                       |
| `pnpm test:coverage`                                              | the same with the coverage thresholds                                                                                                                                       |
| `pnpm test:integration`                                           | the API against PostgreSQL (and Redis and Mailpit when configured)                                                                                                          |
| `pnpm test:e2e`                                                   | Playwright on the built app and landing                                                                                                                                     |
| `pnpm test:scripts`                                               | the tests of the repository scripts (`scripts/*.test.mjs`: Semgrep file selection, Doberman's engine)                                                                       |
| `pnpm security`                                                   | `pnpm audit --audit-level=high`, then `pnpm deps:check`, then `pnpm secrets:scan`                                                                                           |
| `pnpm deps:check`                                                 | dependency policy: registry sources with integrity, licenses, and the supply-chain settings of `pnpm-workspace.yaml`                                                        |
| `pnpm secrets:scan`                                               | secretlint over every file git tracks or would add                                                                                                                          |
| `pnpm sast`                                                       | Semgrep with the pinned image (Docker)                                                                                                                                      |
| `pnpm lint:workflows`                                             | actionlint, zizmor and shellcheck with the pinned images (Docker)                                                                                                           |
| `pnpm observability:check`                                        | the dashboards and alert rules of `observability/` (data sources, runbooks, metric names), then promtool and the rules' unit tests (Docker)                                 |
| `pnpm iac:check`                                                  | the checks of `infra/terraform` (fmt, validate, tests, TFLint, Trivy, cloud-init, database roles) and of `deploy/vps/db-init.sh` on PostgreSQL (Docker)                     |
| `pnpm iac:database`                                               | the database roles of a DigitalOcean environment made with Terraform (`deploy-vps.md`)                                                                                      |
| `pnpm sbom:generate`                                              | CycloneDX SBOM of the production dependencies in `dist/sbom/sbom.cdx.json`                                                                                                  |
| `pnpm perf:check`                                                 | gzip size of the built web and landing assets against each app's `performance-budget.json`, and the landing's built pages against the web server's CSP (after `pnpm build`) |
| `pnpm smoke --url <public URL> --api <API URL> [--release <sha>]` | read-only smoke test of a running deployment ([10.3](#103-smoke-test))                                                                                                      |
| `pnpm contract`                                                   | exports `openapi/openapi.json` and regenerates the web client types                                                                                                         |
| `pnpm services:up`                                                | `docker compose up --detach --wait db redis mailpit`: the database, Redis and the mail catcher                                                                              |
| `pnpm db:up`                                                      | `docker compose up --detach --wait db`                                                                                                                                      |
| `pnpm db:down`                                                    | `docker compose down`: removes the database, Redis and Mailpit containers, keeps the data of the database and Redis; optional services stop with their profile              |
| `pnpm db:migrate [--name <name>]`                                 | creates a migration from schema changes, applies pending ones, regenerates the client (development)                                                                         |
| `pnpm db:seed`                                                    | development accounts (local databases only; `--allow-remote-database` for a disposable remote one)                                                                          |
| `pnpm verify`                                                     | `format:check` → `lint` → `typecheck` → `test:coverage` → `security` → `build` → `perf:check`                                                                               |

### 7.2 API scripts (`pnpm --filter api <script>`)

| Script             | What it does                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dev`              | `prisma generate`, then `nest start --watch`                                                                                                                                                                                                                                         |
| `build`            | `prisma generate`, then `nest build` into `apps/api/dist`                                                                                                                                                                                                                            |
| `start`            | `node dist/main.js` (after `build`)                                                                                                                                                                                                                                                  |
| `typecheck`        | `prisma generate`, then `tsc --noEmit`                                                                                                                                                                                                                                               |
| `test`             | Vitest unit tests                                                                                                                                                                                                                                                                    |
| `test:watch`       | Vitest in watch mode                                                                                                                                                                                                                                                                 |
| `test:coverage`    | unit tests with the coverage thresholds of `vitest.config.ts`                                                                                                                                                                                                                        |
| `test:integration` | the integration suite (`vitest.config.int.ts`)                                                                                                                                                                                                                                       |
| `openapi:export`   | builds and writes `openapi/openapi.json` (half of `pnpm contract`)                                                                                                                                                                                                                   |
| `db:migrate`       | `prisma migrate dev` + `prisma generate` (`scripts/migrate.mjs`)                                                                                                                                                                                                                     |
| `db:deploy`        | `prisma migrate deploy`                                                                                                                                                                                                                                                              |
| `db:seed`          | builds and runs the seed                                                                                                                                                                                                                                                             |
| `user:create`      | creates one account in the database of `DATABASE_URL`, any environment, the password from stdin: `printf '%s' "$PASSWORD" \| pnpm --filter api user:create --email <email> --name <name> --role admin` ([deploy-vps.md](deploy-vps.md#9-create-the-first-administrator) on a server) |
| `mail`             | the email outbox's operator commands ([11.5](#115-email)): `mail test --to <address>` (queue a test message, wait for its delivery), `mail status [--to <address>]`, `mail retry --id <id> \| --failed [--kind <kind>]`                                                              |
| `e2e:server`       | prepares `<db>_e2e` and runs the built API for Playwright (started by `pnpm test:e2e`)                                                                                                                                                                                               |

### 7.3 Web scripts (`pnpm --filter web <script>`)

| Script          | What it does                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `dev`           | Vite dev server on http://localhost:5173/app/ (the app is built for `/app/`), `/api` forwarded to the API |
| `build`         | `tsc -b`, then `vite build` into `apps/web/dist`                                                          |
| `preview`       | serves the build on http://localhost:4173/app/, `/api` forwarded                                          |
| `typecheck`     | checks `schema.d.ts` against the contract, then `tsc -b`                                                  |
| `test`          | Vitest component and unit tests                                                                           |
| `test:watch`    | watch mode                                                                                                |
| `test:coverage` | with the coverage thresholds of `vite.config.ts`                                                          |
| `api:types`     | regenerates `src/api/schema.d.ts` from `openapi/openapi.json` (half of `pnpm contract`)                   |

### 7.4 Landing scripts (`pnpm --filter landing <script>`)

| Script          | What it does                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `dev`           | Astro dev server on http://localhost:4321, the site's single entry: `/app` forwarded to the web app's dev server, `/api` to the API |
| `build`         | `astro check`, then `astro build` into `apps/landing/dist`: the pages, sitemap and robots.txt                                       |
| `preview`       | serves the build on http://localhost:4321                                                                                           |
| `typecheck`     | `astro check`: the types of the `.astro` and `.ts` files, failing on warnings too                                                   |
| `test`          | Vitest unit tests and page tests                                                                                                    |
| `test:watch`    | watch mode                                                                                                                          |
| `test:coverage` | with the coverage thresholds of `vitest.config.ts`                                                                                  |

Every script runs the Astro CLI through `apps/landing/scripts/astro.mjs`, which turns Astro's usage
telemetry off and keeps its servers in the foreground, where `pnpm dev` and Playwright stop them.

### 7.5 Repository scripts run directly

| Command                                                                                                         | What it does                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node scripts/check-branch-name.mjs [branch]`                                                                   | checks a branch name (default: the current one)                                                                                                        |
| `node scripts/tool-image.mjs <name>`                                                                            | prints the pinned image of a tool: `actionlint`, `zizmor`, `semgrep`, `gitleaks`, `trivy`, `terraform`, `tflint`, `ubuntu`, `postgres`, `redis`, `zap` |
| `node scripts/smoke-test.mjs ...`                                                                               | the smoke test (`pnpm smoke`)                                                                                                                          |
| `node apps/web/scripts/api-types.mjs [--check]`                                                                 | regenerates, or checks, the web client types                                                                                                           |
| `scripts/git/pre-push.mjs`, `scripts/forbid-env-files.mjs`                                                      | used by the Git hooks                                                                                                                                  |
| `node scripts/check-migrations.mjs [<migration.sql>...]`                                                        | contract steps without a reason in the migrations ([database.md](database.md#expand-and-contract)); `pnpm test:scripts` and the pre-commit hook run it |
| `scripts/check-dependencies.mjs`, `scan-secrets.mjs`, `sast.mjs`, `lint-workflows.mjs`, `check-bundle-size.mjs` | behind the root scripts of the same purpose                                                                                                            |
| `scripts/check-iac.mjs`, `scripts/iac-database.mjs`                                                             | behind `pnpm iac:check` and `pnpm iac:database`                                                                                                        |

### 7.6 Docker Compose

| Command                                                                       | What it starts                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:up`                                                                  | `db`: PostgreSQL 18, `127.0.0.1:${DB_PORT:-5442}`                                                                                                                                                                                                                          |
| `pnpm services:up`                                                            | `db`; `redis`: Redis 8 with a password (`app`), `127.0.0.1:${REDIS_PORT:-6389}`, data in the volume `redis_data`; and `mailpit`: the mail catcher, SMTP on `127.0.0.1:${MAILPIT_SMTP_PORT:-1035}`, web UI on http://localhost:8035 (`MAILPIT_UI_PORT`), messages in memory |
| `docker compose --profile observability up -d`                                | `otel-lgtm`: collector, Prometheus, Tempo, Loki and Grafana with the dashboards and rules of `observability/`; OTLP on 4318, Grafana on http://localhost:3001, Prometheus on 9090                                                                                          |
| `docker compose --profile stack up --build`                                   | `migrate` (runs once), `api`, `web`: the production images, on `db` and `redis`; the site at http://localhost:8080 and the app at `/app/`                                                                                                                                  |
| `docker compose --profile stack --profile observability up --build`           | the stack with every optional service (set the `STACK_*` variables, [6.4](#64-compose-variables-root-env))                                                                                                                                                                 |
| `docker compose ps`                                                           | what runs, with health                                                                                                                                                                                                                                                     |
| `docker compose logs -f <service>`                                            | follows a service's log (`api`, `web`, `db`, `mailpit`, `redis`, `migrate`)                                                                                                                                                                                                |
| `docker compose --profile <profile> down`                                     | stops and removes those containers; volumes stay                                                                                                                                                                                                                           |
| `docker compose down -v`                                                      | **also deletes the volumes**: the development database and Redis data are gone                                                                                                                                                                                             |
| `docker compose exec db psql -U app -d app`                                   | SQL shell                                                                                                                                                                                                                                                                  |
| `docker compose exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli'` | Redis shell (the password stays out of the command line)                                                                                                                                                                                                                   |

### 7.7 Images without Compose

```
docker build -f apps/api/Dockerfile -t api --build-arg APP_RELEASE=$(git rev-parse HEAD) .
docker build -f apps/api/Dockerfile --target migrate -t api-migrate .
docker build -f apps/web/Dockerfile -t web --build-arg APP_RELEASE=$(git rev-parse HEAD) .
```

The build context is the repository root (an allowlist in `.dockerignore`). The migration image
runs `prisma migrate deploy` by default, after refusing a database whose applied migrations were
edited since (`apps/api/scripts/migrate-deploy.mjs`); the same image answers the other migration
commands
([7.8](#78-operations-commands)).

### 7.8 Operations commands

| Command                                                                                                                                                   | Use                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl http://<api>:3000/api/health/ready`                                                                                                                 | readiness of one instance, from inside the platform                                                                                                                             |
| `docker compose ... run --rm -T api node dist/infrastructure/mail/mail.cli.js status` (`test --to <address>`, `retry --failed`)                           | the email outbox: what waits, what failed and why; a delivery check; failed messages sent again ([11.5](#115-email))                                                            |
| `pnpm smoke --url <public URL> --api <API URL> --release <sha>`                                                                                           | after a deployment, a restore, an incident                                                                                                                                      |
| `docker run --rm -e DATABASE_URL=<url> <api-migrate image>`                                                                                               | refuses a database whose applied migrations were edited, then applies the pending ones                                                                                          |
| `docker run --rm -e DATABASE_URL=<url> <api-migrate image> node node_modules/prisma/build/index.js migrate status`                                        | which migrations an environment has                                                                                                                                             |
| `... migrate resolve --rolled-back <migration>` / `--applied <migration>`                                                                                 | records the outcome of a failed migration ([database.md](database.md#when-a-migration-fails))                                                                                   |
| `... migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`                                                                  | compares an environment's schema with the image's, after a restore ([disaster-recovery.md](disaster-recovery.md#restore-procedure))                                             |
| `pg_dump`, `pg_restore`, `createdb`                                                                                                                       | backups and restores ([disaster-recovery.md](disaster-recovery.md#rehearsal-on-a-development-machine))                                                                          |
| `docker compose ... exec backup sh /usr/local/bin/backup.sh now`                                                                                          | a backup at once, on the VPS target's own database ([deploy-vps.md](deploy-vps.md#backups)); its restore: [disaster-recovery.md](disaster-recovery.md#the-servers-own-database) |
| `BEGIN; SELECT id FROM users WHERE id = '<id>' FOR UPDATE; UPDATE sessions SET revoked_at = now() WHERE user_id = '<id>' AND revoked_at IS NULL; COMMIT;` | ends every session of one user (security incident); the user's lock keeps a refresh in flight from outliving it                                                                 |

## 8. CI/CD

### 8.1 Workflows

| Workflow                    | Runs                                                            | Does                                                                                                                            |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml` (**CI**)           | every pull request, every push to `main`, by hand               | dependency review (opt-in), every gate, the images; one check: **CI passed**                                                    |
| `conventions.yml`           | every pull request, again when its title is edited              | branch name and title (Conventional Commits); its check **Conventions** is required                                             |
| `quality-gates.yml`         | called by CI and Deploy                                         | format, lint, types, workflows, Semgrep, infrastructure as code, tests with coverage, integration, security, build, E2E, images |
| `docker-images.yml`         | called by the gates (build and scan) and by a deployment (push) | builds `api`, `api-migrate`, `web`, scans them with Trivy; pushes with SBOM and provenance when asked                           |
| `codeql.yml`                | pull requests, `main`, weekly, when `ENABLE_CODEQL=true`        | cross-file security analysis (ADVISORY)                                                                                         |
| `dast.yml`                  | Mondays 04:41 UTC, by hand                                      | production images on the runner, smoke test, ZAP baseline and API scan; or the passive scan of staging (ADVISORY)               |
| `release.yml`               | pushes to `main`                                                | the release pull request and CI on it; once merged, the tag, the GitHub release and the SBOM                                    |
| `main-guard.yml`            | every push to `main`                                            | checks that each pushed commit is a merged pull request; otherwise fails and opens an issue                                     |
| `dependabot-auto-merge.yml` | an approval of a Dependabot pull request                        | merges a patch or minor update once **CI passed** (checks the approval and CI itself)                                           |
| `deploy.yml` (**Deploy**)   | by hand, from `main`                                            | resolves the ref to a commit on `main`, re-runs the gates, releases (the VPS target, or a job of your own)                      |

Dependabot opens grouped update pull requests every week (npm, GitHub Actions, base images, tool
images, Terraform providers), with the same seven-day delay as the install policy. You approve each
one; a patch or minor update then merges itself once CI passes, and majors or workflow updates you
merge by hand ([ci-cd.md](ci-cd.md#dependency-updates)).

### 8.2 Running and reading them

```
gh run list                              # recent runs
gh run watch                             # follow the current one
gh run view <run id> --log-failed        # the failing steps' logs
gh run rerun <run id> --failed           # re-run only the failed jobs
gh workflow run ci.yml --ref <branch>    # CI by hand
gh workflow run dast.yml -f target=local-stack
gh workflow run dast.yml -f target=staging
```

Reports are attached to the run as artifacts (coverage, Playwright report, ZAP reports). What is
BLOCKING and what is ADVISORY, and why: [ci-cd.md](ci-cd.md#quality-gates-blocking-and-advisory).
Every failure message with its fix: [troubleshooting.md](troubleshooting.md).

The same checks locally: `pnpm verify`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm sast`,
`pnpm lint:workflows`, `pnpm observability:check`, `pnpm iac:check`.

## 9. Releases

1. Merge pull requests with Conventional Commit titles. `fix:`/`perf:` make a patch, `feat:` a
   minor, `!` or `BREAKING CHANGE:` a major (before 1.0.0: a minor).
2. **Release** keeps one release pull request open with the next version and the `CHANGELOG.md`
   entry. Review it like any pull request.
3. Merge it: the workflow tags `vX.Y.Z` (immutable), publishes the GitHub release with the notes and
   attaches `sbom.cdx.json`.
4. Deploy the tag ([10](#10-deploying-and-rolling-back)): releasing and deploying are separate steps.

The version continues from the template's `1.0.0`: the first `fix` makes 1.0.1, the first `feat`
1.1.0; the footer `Release-As: <version>` on a merged commit chooses another. The release workflow
starts CI and **Conventions** on the release pull request itself; with `RELEASE_PLEASE_TOKEN` set,
every pull request workflow runs on it instead ([ci-cd.md](ci-cd.md#release-pull-requests)).

## 10. Deploying and rolling back

### 10.1 Implement the release job once (REQUIERE CONFIGURACIÓN)

**Ready-made target:** one Linux server per environment with Docker, Redis and PostgreSQL on it
(nightly backups included), or a managed PostgreSQL instead. Set the repository variable
`DEPLOY_TARGET=vps` and follow [deploy-vps.md](deploy-vps.md) (step by step:
[step-by-step.md](step-by-step.md#phase-7-production-servers)); nothing below needs writing. On
DigitalOcean, Terraform (`infra/terraform/digitalocean`) can create the servers and managed
databases instead of the manual steps, with the same result
([deploy-vps.md](deploy-vps.md#provision-with-terraform-digitalocean)). For any other platform:

`.github/workflows/deploy.yml` re-runs every gate on the exact commit, then hands over to the
protected environment, where the release job fails on purpose until it is written for your
platform. Implement it in this order (the comments in the file repeat it):

1. Push the images once per commit (`docker-images.yml` with `push: true`, after the registry login
   step marked in that file), scan the digests the push reports and record them; reuse the digests
   staging recorded, so production runs what staging verified, and scan them again before
   production.
2. Deploy `<image>@<digest>` only, with the digests of the build or of that record: never looked up
   from the tag `<image>:<sha>`, which any workflow with `packages: write` can push.
3. Record the digests running before the change: the rollback target.
4. Run the `api-migrate` image against the environment's database; stop on failure.
5. Roll out `api`, then `web`, waiting for readiness.
6. `node scripts/smoke-test.mjs --url <public URL> --api <API URL> --release <sha>`.
7. On failure, redeploy the recorded digests.

The full sequence, the compatibility rules between versions and the rollback table:
[ci-cd.md](ci-cd.md#deployment).

### 10.2 Deploy

```
gh workflow run deploy.yml --ref main -f environment=staging -f ref=v1.4.0
gh run watch
```

Or GitHub → Actions → **Deploy** → Run workflow (from `main`), with the environment and the ref (a
release tag, a branch or a commit SHA on `main`). Staging first; verify; then the same ref to
`production` (the environment asks its reviewers to approve).

### 10.3 Smoke test

```
pnpm smoke --url https://<public host> --api http://<api inside the platform>:3000 --release <sha>
```

| Check                           | Passes when                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web server health               | `/healthz` answers 200                                                                                                                                           |
| landing                         | `/` is the landing, its links and share picture on this deployment's origin (`APP_ORIGIN`), with the CSP and `X-Content-Type-Options` headers; `/es/` in Spanish |
| share picture                   | `/og.png` answers 200 as a PNG                                                                                                                                   |
| not-found page                  | an unknown address answers 404 with the not-found page                                                                                                           |
| app shell                       | `/app/` and a deep link under it are the app                                                                                                                     |
| emailed links of before `/app/` | `/reset-password` redirects to `/app/reset-password`                                                                                                             |
| runtime configuration           | `/app/app-config.json` answers, with the expected release when `--release` is given                                                                              |
| API through the web server      | an unknown `/api/...` route answers the API's JSON 404 with a request id                                                                                         |
| probes not public               | `/api/health/ready` answers 404 through the public URL                                                                                                           |
| API liveness and readiness      | 200 on the API itself (`degraded` is reported, not a failure)                                                                                                    |

It signs nobody in and writes nothing; any failure exits with status 1. Either URL can be left out
to check one side only.

### 10.4 Roll back

- **The application failed** (errors, latency, smoke test): redeploy the digests recorded before the
  deployment. Never rebuild an old commit for a rollback, and never reverse a migration.
- **The migration failed:** the running version keeps serving; repair the database and resolve
  the migration ([incident-response.md](incident-response.md#10-failed-database-migration)).
- **Planned rollback:** run Deploy with the previous tag (it re-runs the gates on that commit).

[ci-cd.md](ci-cd.md#rollback) has the full table.

## 11. Optional infrastructure

Turning each on is configuration, and nothing here is needed to develop, test or deploy. Two are on
by default locally: Redis ([11.1](#111-redis)) and email, against Mailpit ([11.5](#115-email)).

### 11.1 Redis

Shared rate limits across instances, a shared cache, locks and idempotency claims. On by default
locally and on the reference server; the application runs without it.

1. `pnpm services:up` (and `pnpm dev`) starts it with the database: `127.0.0.1:6389`, the password
   `app` (`REDIS_PORT` and `REDIS_PASSWORD` in the root `.env` change them; then the same in
   `REDIS_URL`).
2. `apps/api/.env`, from `.env.example`: `REDIS_URL=redis://:app@localhost:6389`,
   `RATE_LIMIT_STORE=redis`, `CACHE_STORE=redis`, `REDIS_REQUIRED=true`. Without Redis: remove the
   four.
3. Check: the `pnpm dev` box shows `Redis localhost:6389`, the log says
   `Redis connected (redis://localhost:6389)`, readiness shows `"redis": "ok"`. Stop it
   (`docker compose stop redis`) to see the degraded mode (readiness 503, with `REDIS_REQUIRED`),
   start it (`docker compose start redis`) to see the recovery.
4. The reference server runs its own, with an ACL user, on its internal network only
   ([deploy-vps.md](deploy-vps.md#6-the-files-on-the-server)). Elsewhere (REQUIERE
   CONFIGURACIÓN): a private Redis with TLS and an ACL user, `rediss://` from the secret store,
   `REDIS_KEY_PREFIX` per environment; `REDIS_REQUIRED=true` only if the product cannot work
   without it ([security.md](security.md#redis), [architecture.md](architecture.md#redis)).

### 11.2 Error tracking (Sentry)

1. Create two Sentry projects: Node.js (API) and browser JavaScript (web).
2. API: `SENTRY_DSN` (secret store; locally in `apps/api/.env`). Web: `WEB_SENTRY_DSN` on the web
   container (locally in the environment of `pnpm dev`). `APP_ENVIRONMENT` on both.
3. Check: the boot line says `error tracking on`; `/app/app-config.json` shows the DSN; the CSP
   allows Sentry's ingest host.
4. Alert rules in Sentry ([alerting.md](alerting.md)). What is never sent: [security.md](security.md#error-tracking-data).

### 11.3 Tracing and metrics (OpenTelemetry)

1. Locally: `docker compose --profile observability up -d`, then
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in `apps/api/.env`, restart `pnpm dev`.
2. Send a few requests; Grafana at http://localhost:3001: Dashboards → Application ("API service",
   "API SLOs"), Alerting → Alert rules, Explore → Tempo (traces), Prometheus (metrics).
3. Deployed (REQUIERE CONFIGURACIÓN): the collector's or provider's endpoint, its credentials in
   `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and
   `OTEL_TRACES_SAMPLER_ARG=0.1`. Kill switch: `OTEL_SDK_DISABLED=true`.
4. Dashboards and alert rules: the files of `observability/`, imported into your Grafana and loaded
   into your Prometheus or Grafana Cloud
   ([observability.md](observability.md#use-them-with-your-backend)); routing per
   [alerting.md](alerting.md).

### 11.4 The production-like stack with everything

Root `.env`:

```
JWT_ACCESS_SECRET=<openssl rand -hex 32>
STACK_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318
```

```
docker compose --profile stack --profile observability up --build
```

The site at http://localhost:8080 (the app at `/app/`), Grafana at http://localhost:3001; the API
runs on the compose Redis, as on the reference server. Stop with
`docker compose --profile stack --profile observability down`.

### 11.5 Email

The API sends email through an outbox: a feature writes the message in the same transaction as the
change it reports, and a worker inside every API instance delivers it over SMTP, with retries
([architecture.md](architecture.md#email)). Without `MAIL_SMTP_URL` email is off: nothing is
queued, readiness says `checks.mail: "disabled"`, and the rest of the API works.

**Locally**, `pnpm dev` starts Mailpit, a mail catcher: the API sends to it
(`MAIL_SMTP_URL=smtp://localhost:1035`, in `apps/api/.env.example`), nothing leaves the machine,
and every message is at http://localhost:8035. The box `pnpm dev` prints shows it on its `Mail`
row, with what readiness says (`ok`, `degraded`). Check the whole path:

```
pnpm --filter api mail test --to you@example.test   # queued, then sent by the running API
```

and the message appears in Mailpit. Messages live in Mailpit's memory: `pnpm db:down` clears them.

**In production**, any provider's SMTP server works (Amazon SES, Postmark, Resend, Brevo...). In
the API's environment ([deploy-vps.md](deploy-vps.md#6-the-files-on-the-server) on a server):

```
MAIL_SMTP_URL=smtps://<user>:<password, percent-encoded>@<provider host>:465
MAIL_FROM="<Product> <no-reply@<your domain>>"
APP_ORIGIN=https://<your domain>
```

or `smtp://...:587`: production requires STARTTLS on it and refuses a server without TLS (Mailpit
among them), except one on the machine itself (`localhost`, `127.0.0.1`, `[::1]`). `APP_ORIGIN` and
`APP_BASE_PATH` (/app) are where links in messages point: never a request's Host. Before the first
message, authenticate the sending domain at the provider (SPF, DKIM, DMARC): without them messages
land in spam or are refused. Then, from the API image:

```
docker compose ... run --rm -T api node dist/infrastructure/mail/mail.cli.js test --to <you>
```

**Operating it:** `mail status` shows what waits, what failed and why (never an address: messages
are named by id; `--to <address>` finds one address's messages); `mail retry --failed` sends failed
messages again once the cause is fixed, each with a new validity (an outage longer than it does not
drop them; links still start their own validity when they are sent) and its attempts counted from
the retry (the attempt number itself goes on: `attempts=` in `mail status`). Alerts `ApiMailBacklog` and `ApiMailDeliveryFailed`, and
the runbook: [incident-response.md](incident-response.md#16-email-not-delivered). To rotate the SMTP
credentials, create the new ones at the provider, update `MAIL_SMTP_URL`, redeploy, then revoke the
old ones; messages waiting meanwhile go out with their next attempt.

**Password recovery and change.** With email on, the sign-in page offers "Forgot your password?":
the person enters their address, receives a link valid for 30 minutes and once, and chooses a new
password (15 characters or more; the rules: [security.md](security.md#passwords)). Signed in, the
Account page (top menu) changes it with the current one. Either way every other session of the
account is signed out at once, and the owner gets a "your password was changed" message. Try it
locally: `pnpm dev`, sign out, "Forgot your password?" with `member@example.com`, and open the
link from Mailpit (http://localhost:8035). Without email the link is not shown and the reset
routes answer 503; changing it while signed in still works.

**Public sign-up (OPTIONAL).** With `SIGN_UP_ENABLED=true` (and email), the sign-in page offers
"Create an account": the person gives a name, an address and a password, receives a link valid for
24 hours, and confirms it by entering that same password; only then does the account (role
member) exist, and they are signed in. An address that already has an account gets a notice
instead of a link, and the page answers the same either way. `apps/api/.env.example` turns it on
locally; in production it is off unless you set it (accounts are then created with
`user:create`). Try it: `pnpm dev`, "Create an account" with any address, and open the link from
Mailpit. The design and its limits: [security.md](security.md#sign-up).

**Change of email.** With email on, the Account page also offers "Change your email": a new
address and the current password. A link goes to the new address, and nothing changes until it is
opened; then every session is signed out (sign in with the new address), and the previous address
gets a notice with a link that undoes the change for 7 days, asking for a new password. Try it
locally with any two addresses and Mailpit. The design: [security.md](security.md#change-of-email).

**Invitations.** With email on, administrators see "Invitations" in the top menu: an address and
a role (member or admin) send a link valid for 7 days; the person opens it, chooses their name and
password, and is signed in with that role. Pending invitations can be sent again or revoked. Try
it locally: sign in as `admin@example.com`, invite any address, and open the link from Mailpit. The
design: [security.md](security.md#invitations).

## 12. Running in production

| Before and while running               | Where                                                         |
| -------------------------------------- | ------------------------------------------------------------- |
| The checklist before the first release | [production-readiness.md](production-readiness.md)            |
| Backups, restores, RPO and RTO         | [disaster-recovery.md](disaster-recovery.md)                  |
| SLOs, error budget, the alert catalog  | [alerting.md](alerting.md)                                    |
| What each signal means                 | [observability.md](observability.md)                          |
| What to do when an alert fires         | [incident-response.md](incident-response.md): 14 runbooks     |
| Capacity                               | [load-testing.md](load-testing.md) (OPTIONAL)                 |
| Security settings per project          | [security.md](security.md#per-project-requiere-configuración) |

The minimum to have before production traffic (REQUIERE CONFIGURACIÓN): automated backups (on the
VPS target's own database, the nightly ones copied off the server too,
[deploy-vps.md](deploy-vps.md#backups)) with one restore drill done, the deployment job with digests
and the smoke test, uptime checks, the CRITICAL alerts routed to someone, `TRUST_PROXY` for the real
topology, TLS at the edge, and the contacts table of incident-response.md filled in.

Rehearse a restore on your machine (it takes a few minutes; Windows: prefix with
`MSYS_NO_PATHCONV=1`):

```
docker compose exec -T db pg_dump -U app -d app --format=custom --no-owner --no-privileges --file=/tmp/app.dump
docker compose exec -T db createdb -U app app_restore_check
docker compose exec -T db pg_restore -U app -d app_restore_check --no-owner --no-privileges --exit-on-error /tmp/app.dump
DATABASE_URL=postgresql://app:app@localhost:5442/app_restore_check pnpm --filter api exec prisma migrate status
docker compose exec -T db dropdb -U app app_restore_check
docker compose exec -T db rm /tmp/app.dump
```

## 13. Maintenance calendar

| When                                      | What                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every week                                | Review and approve Dependabot's pull requests: patch and minor updates merge themselves once CI passes; majors and workflow updates you merge by hand ([ci-cd.md](ci-cd.md#dependency-updates)). On the VPS target, one that changes `deploy/vps` (the Caddy, PostgreSQL or Redis image) also needs the files copied to each server before its next deployment ([deploy-vps.md](deploy-vps.md#update-the-server-files)). |
| Every week (automatic)                    | DAST runs on Mondays: read the ZAP reports of failed runs.                                                                                                                                                                                                                                                                                                                                                               |
| Every week (VPS target, its own database) | `backup` healthy in `docker compose ps`, and last night's backup copied off the server ([deploy-vps.md](deploy-vps.md#backups)).                                                                                                                                                                                                                                                                                         |
| Every release                             | Staging first, smoke test, then production with the same digests.                                                                                                                                                                                                                                                                                                                                                        |
| Every quarter                             | A restore drill with the [checklist](disaster-recovery.md#checklist); a review of the alerts (noise, gaps) and a test alert through the routing; a look at the error budget policy; what Dependabot never proposes: a Node.js LTS major (each October), pnpm, PostgreSQL and Redis majors ([ci-cd.md](ci-cd.md#keeping-the-stack-current)).                                                                              |
| When coverage rises                       | Raise the thresholds in the same pull request ([testing.md](testing.md#coverage)).                                                                                                                                                                                                                                                                                                                                       |
| When a secret may have leaked             | Rotate it at once ([security.md](security.md#secret-rotation)).                                                                                                                                                                                                                                                                                                                                                          |
| After every incident                      | The postmortem, and updates to the runbook and the alerts it exposed.                                                                                                                                                                                                                                                                                                                                                    |

## 14. When something fails

Search [troubleshooting.md](troubleshooting.md) for a few words of the message: it lists the
messages the tools actually print, with cause and fix, grouped by install, database, API, optional
infrastructure, quality gates, deployment, Git hooks and end-to-end tests. The ones new users meet
first:

| Message                                                            | Fix                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PNPM_UNSUPPORTED_ENGINE`                                      | Node.js 24.15+ ([1.1](#11-install-the-tools))                                                                                           |
| `port is already allocated` on `pnpm db:up`                        | `DB_PORT=5443` in the root `.env` and in `DATABASE_URL`                                                                                 |
| `Environment variable JWT_ACCESS_SECRET is invalid`                | `openssl rand -hex 32` into `apps/api/.env`                                                                                             |
| `Cannot reach PostgreSQL at localhost:5442` (integration tests)    | `pnpm services:up`                                                                                                                      |
| No email in Mailpit (http://localhost:8035)                        | the `Mail` row of the `pnpm dev` box: `off` (set `MAIL_SMTP_URL`), or a warning about its port ([11.5](#115-email))                     |
| `Executable doesn't exist ... playwright install`                  | `pnpm exec playwright install chromium`                                                                                                 |
| `pre-push: Direct pushes to "main" are not allowed`                | push a branch and open a pull request                                                                                                   |
| `Could not start Docker` from `pnpm sast` or `pnpm lint:workflows` | start Docker                                                                                                                            |
| `pnpm sast` takes many minutes                                     | the first run pulls the image; otherwise check Docker's CPU and memory and large untracked files (it takes a few minutes; CI about two) |

## 15. Appendix: ports, accounts, files

### 15.1 Ports and URLs

| Port | What                                                                                               | Started by                                                   |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 3000 | API (development)                                                                                  | `pnpm dev`                                                   |
| 5173 | web app's dev server (`/app/`; `pnpm dev` reaches it through 4321)                                 | `pnpm dev`                                                   |
| 4321 | the site: landing, with `/app` and `/api` forwarded (development); landing alone (`astro preview`) | `pnpm dev`, `pnpm test:e2e`, `pnpm --filter landing preview` |
| 5442 | PostgreSQL (`DB_PORT`)                                                                             | `pnpm db:up`, `pnpm services:up` (and `pnpm dev`)            |
| 6389 | Redis (`REDIS_PORT`)                                                                               | `pnpm services:up` (and `pnpm dev`)                          |
| 1035 | Mailpit SMTP (`MAILPIT_SMTP_PORT`)                                                                 | `pnpm services:up` (and `pnpm dev`)                          |
| 8035 | Mailpit web UI (`MAILPIT_UI_PORT`)                                                                 | `pnpm services:up` (and `pnpm dev`)                          |
| 3100 | API (end-to-end tests)                                                                             | `pnpm test:e2e`                                              |
| 4173 | web app (end-to-end tests, `vite preview`, `/app/`)                                                | `pnpm test:e2e`, `pnpm --filter web preview`                 |
| 8080 | production-like stack (`WEB_PORT`): the site, the app at `/app/`                                   | `docker compose --profile stack up`                          |
| 4318 | OTLP/HTTP (`OTLP_HTTP_PORT`)                                                                       | `docker compose --profile observability up -d`               |
| 3001 | Grafana (`GRAFANA_PORT`)                                                                           | `docker compose --profile observability up -d`               |
| 9090 | Prometheus (`PROMETHEUS_PORT`)                                                                     | `docker compose --profile observability up -d`               |

Every published port listens on 127.0.0.1 only.

### 15.2 Accounts

| Account                                  | Where                                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| `admin@example.com` / `admin-password`   | development database (`pnpm db:seed`), end-to-end database |
| `member@example.com` / `member-password` | the same                                                   |
| PostgreSQL `app` / `app`                 | the development container only                             |
| Redis password `app`                     | the development container only                             |

They are public: never create them anywhere else.

### 15.3 Where things are

```
apps/api/                 NestJS API
  src/main.ts             entry point (crash handlers, telemetry, then the server)
  src/env/                the validated configuration
  src/auth/ users/ health/   features
  src/common/             error filter, request ids, CSRF guard, external HTTP client, pipes
  src/observability/      redaction, error tracking, telemetry, metrics
  src/infrastructure/     Redis, rate limit store, cache, locks and idempotency
  src/lifecycle/          graceful shutdown
  prisma/                 schema.prisma and migrations
  Dockerfile              images api and api-migrate
apps/web/                 React app
  src/api/                the typed client (schema.d.ts is generated)
  src/auth/               session, guards, refresh handling
  src/monitoring/         runtime configuration, error tracking
  nginx/                  production web server configuration
  Dockerfile              image web
apps/landing/             Astro public site: static pages in English and Spanish
  src/pages/              one file per page and language (index.astro, es/index.astro, 404)
  src/components/         the sections; fragments/ draws the app's screens
  src/i18n/               every text of the site, in en.ts and es.ts
  src/styles/global.css   the design tokens (Tailwind CSS)
openapi/openapi.json      the API contract (generated, committed)
e2e/                      Playwright tests
scripts/                  repository tooling (checks, smoke test, tool images)
docs/                     this manual and the guides
infra/terraform/          infrastructure as code: the DigitalOcean server and database (optional)
deploy/vps/               the reference server: its services, deploy and rollback, database roles, backup
.github/                  workflows, rulesets, Dependabot, templates, pinned tool images
docker-compose.yml        database, Redis, Mailpit, optional services, production-like stack
```

### 15.4 The other documents

| Document                                                                                                                                                                                                                                             | Read it for                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [ENGINEERING_STANDARDS.md](../ENGINEERING_STANDARDS.md)                                                                                                                                                                                              | the rules, in one page                 |
| [CONTRIBUTING.md](../CONTRIBUTING.md), [DEFINITION_OF_DONE.md](../DEFINITION_OF_DONE.md), [definition-of-ready.md](definition-of-ready.md)                                                                                                           | how a change reaches `main`            |
| [architecture.md](architecture.md), [api-conventions.md](api-conventions.md), [error-handling.md](error-handling.md), [database.md](database.md)                                                                                                     | how the code is organized              |
| [how-to.md](how-to.md)                                                                                                                                                                                                                               | recipes for the usual changes          |
| [testing.md](testing.md)                                                                                                                                                                                                                             | tests, coverage, budget                |
| [security.md](security.md), [authorization.md](authorization.md), [SECURITY.md](../SECURITY.md)                                                                                                                                                      | controls, limits, per-project settings |
| [environment.md](environment.md)                                                                                                                                                                                                                     | every variable                         |
| [ci-cd.md](ci-cd.md), [branching.md](branching.md), [commits.md](commits.md), [git-hooks.md](git-hooks.md), [code-review.md](code-review.md)                                                                                                         | delivery                               |
| [observability.md](observability.md), [alerting.md](alerting.md), [incident-response.md](incident-response.md), [disaster-recovery.md](disaster-recovery.md), [load-testing.md](load-testing.md), [production-readiness.md](production-readiness.md) | operations                             |
| [troubleshooting.md](troubleshooting.md)                                                                                                                                                                                                             | messages and fixes                     |
| [adr/](adr/)                                                                                                                                                                                                                                         | why the big decisions were made        |
