# Step by step: from zero to production

Versión en español: [step-by-step.es.md](step-by-step.es.md). Both versions have the same steps; a
change to one goes to the other in the same pull request.

This is the **instructivo**: what to do, in order, from the information you need to gather before
starting to a product running in production, and then the daily loop. Every step says what to do,
the exact command, what you should see when it worked, and what to do when it did not. The
[manual](manual.md) explains how everything works; this page only tells you what to do next.

How to use it:

- Follow the phases in order. Do not skip a **Check**: each one proves the previous steps worked,
  so a problem shows up where it starts, not three phases later.
- Commands run in a terminal at the project's root folder. On Windows use **Git Bash** (installed
  with Git for Windows).
- `<angle brackets>` are values you replace. Write your values in the
  [worksheet](#the-worksheet) as you go.
- Tick the boxes (`[ ]` → `[x]`) in your own copy if it helps.

## The timeline

| Phase                                                              | What you end up with                                     | Time                             |
| ------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------- |
| [0. Information and decisions](#phase-0-information-and-decisions) | the worksheet filled in, the accounts created            | 1–2 h, plus waiting for accounts |
| [1. Your computer](#phase-1-your-computer)                         | every tool installed and checked                         | 30–60 min                        |
| [2. Create the project](#phase-2-create-the-project)               | your own copy, renamed                                   | 15 min                           |
| [3. Run it locally](#phase-3-run-it-locally)                       | the app running on your machine, signed in               | 20 min                           |
| [4. Prove every gate passes](#phase-4-prove-every-gate-passes)     | the same checks as CI, green on your machine             | 30–45 min                        |
| [5. Put it on GitHub](#phase-5-put-it-on-github)                   | the repository protected, CI green on a pull request     | 1 h                              |
| [6. Make it yours](#phase-6-make-it-yours)                         | your product's name, design and first features           | days to weeks                    |
| [7. Production servers](#phase-7-production-servers)               | staging and production servers, databases, domains ready | 2–3 h per environment            |
| [8. First deployment](#phase-8-first-deployment)                   | the app live on staging, then production; first admin    | 1 h                              |
| [9. Monitoring and alerts](#phase-9-monitoring-and-alerts)         | errors reported, uptime watched, someone gets the alerts | 1–2 h                            |
| [10. Before real users](#phase-10-before-real-users)               | the production readiness checklist signed off            | half a day                       |
| [11. The daily loop](#phase-11-the-daily-loop)                     | how every change goes from idea to production            | every day                        |
| [12. The maintenance calendar](#phase-12-the-maintenance-calendar) | what to do every week, month and quarter                 | recurring                        |

---

## Phase 0. Information and decisions

Nothing to install yet. Gather this first: most delays come from an account or a decision nobody
had when it was needed.

### 0.1 Decide

- [ ] **Product name** (shown to users) and **repository name** (lowercase, dashes: `acme-portal`).
- [ ] **Domains**: one for production (`app.acme.com`) and one for staging (`staging.acme.com`).
      You need access to the domain's DNS settings.
- [ ] **Where it runs.** This guide uses the ready-made target: **one Linux server per
      environment** with Docker and a managed PostgreSQL ([deploy-vps.md](deploy-vps.md)). It suits
      a first product (one instance of the API). For Kubernetes or a container platform, phases
      0–6 are the same and phase 7 is replaced by your platform ([ci-cd.md](ci-cd.md#deployment)).
- [ ] **Who** approves production deployments (at least one person besides the author), who
      reviews code (CODEOWNERS), who receives security reports and alerts.
- [ ] **What the template does not decide for you** (write the answer, even "later"): how users
      get an account (open sign-up, `SIGN_UP_ENABLED`, or only accounts an administrator creates;
      SSO), the roles beyond `member` and `admin`, the UI language and design.

### 0.2 Create the accounts

| Account                                                    | For                                        | Notes                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub (an organization is better than a personal account) | code, CI, images, deployments              | A **private** repository needs **GitHub Team** (organization) or **Pro** (personal): environments with required reviewers and their secrets, rulesets and branch protection depend on it. On the Free plan they exist only for public repositories |
| A cloud or VPS provider                                    | the servers (2 vCPU, 4 GB RAM each)        | any provider with Ubuntu 24.04 and a public IPv4                                                                                                                                                                                                   |
| A managed PostgreSQL                                       | the databases (16 or newer)                | often the same provider; automated backups and point-in-time recovery required                                                                                                                                                                     |
| The domain's DNS                                           | `A` records to the servers                 | the registrar or a DNS service                                                                                                                                                                                                                     |
| Sentry (optional)                                          | error reports from the API and the browser | free tier is enough to start                                                                                                                                                                                                                       |
| An uptime monitor (optional but recommended)               | an alert when the site is down             | any service that checks a URL from several places                                                                                                                                                                                                  |
| A password manager                                         | the secrets of this guide                  | shared vault for the team                                                                                                                                                                                                                          |

### The worksheet

Copy this into your password manager or notes and fill it in as you go. Secrets go only in the
password manager.

| Item                                                            | Value            | Phase |
| --------------------------------------------------------------- | ---------------- | ----- |
| Product name                                                    |                  | 0     |
| GitHub owner / repository                                       | `OWNER/REPO`     | 0     |
| Production domain / staging domain                              |                  | 0     |
| Production server IP / staging server IP                        |                  | 7     |
| Database host (production / staging)                            |                  | 7     |
| `app_migrator` password (per environment)                       | password manager | 7     |
| `app_runtime` password (per environment)                        | password manager | 7     |
| `JWT_ACCESS_SECRET` (per environment, and one for your machine) | password manager | 3, 7  |
| Deploy SSH key (per environment)                                | password manager | 7     |
| `RELEASE_PLEASE_TOKEN` (optional)                               | password manager | 5     |
| Sentry DSNs (API, web)                                          |                  | 9     |
| First administrator's email                                     |                  | 8     |

**Check:** every account above exists and you can sign in to each one; the decisions of 0.1 have
an answer.

---

## Phase 1. Your computer

### 1.1 Install the tools

| Tool                | Install                                                                                                                                                                      | Check command            | Expected                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| Git                 | Windows: [Git for Windows](https://git-scm.com/download/win) (includes Git Bash and `openssl`); macOS: `xcode-select --install`; Linux: your package manager                 | `git --version`          | any current version                                          |
| Node.js 24          | [nvm](https://github.com/nvm-sh/nvm) (macOS/Linux): `nvm install 24`; Windows: [fnm](https://github.com/Schniz/fnm) or the [official installer](https://nodejs.org) (24 LTS) | `node --version`         | `v24.15.0` or later                                          |
| pnpm                | `corepack enable` (once; Node.js 24 includes Corepack, from Node.js 25 install it first: `npm install -g corepack`)                                                          | `pnpm --version`         | `12.5.1` (inside the project)                                |
| Docker              | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS) or Docker Engine (Linux)                                                                  | `docker compose version` | `Docker Compose version v2` or later                         |
| GitHub CLI          | [cli.github.com](https://cli.github.com)                                                                                                                                     | `gh --version`           | any current version                                          |
| VS Code (suggested) | [code.visualstudio.com](https://code.visualstudio.com)                                                                                                                       |                          | it offers the project's recommended extensions on first open |

**Check:** each check command prints the expected value. Docker Desktop is running (its icon shows
"Docker Desktop is running").

**If it fails:**

- `node` prints an older version: `nvm use 24` / `fnm use 24`, then open a new terminal.
- `pnpm` is not found: run `corepack enable` again in a terminal opened as administrator
  (Windows) or with `sudo` (macOS/Linux). `corepack` is not found (Node.js 25 or later):
  `npm install -g corepack`, or `npm install -g pnpm@12.5.1`.
- `docker compose version` fails: start Docker Desktop and wait until it says it is running.

### 1.2 Sign in to GitHub from the terminal

```
gh auth login
```

Choose GitHub.com, HTTPS, and sign in with the browser.

**Check:** `gh auth status` says `Logged in to github.com account <you>`.

### 1.3 Configure Git (once per computer)

```
git config --global user.name "<Your Name>"
git config --global user.email "<you@acme.com>"
git config --global init.defaultBranch main
```

**Check:** `git config --global --list` shows the three values.

---

## Phase 2. Create the project

### 2.1 Create your repository from the template

Easiest: on GitHub, open the template repository, **Use this template → Create a new repository**,
owner `OWNER`, name `REPO`, **Private**. Then clone it:

```
gh repo clone OWNER/REPO
cd REPO
```

Without GitHub's template feature (a copy of the folder without its history):

```
git clone --depth 1 <template repository URL> REPO
cd REPO
rm -rf .git
git init -b main
```

**Check:** `ls` shows `apps`, `docs`, `package.json`, `docker-compose.yml`.

### 2.2 Rename the template's placeholders

Open the project in your editor (`code .`) and change:

| File                              | Change                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `package.json` (root)             | `"name"` → `REPO`, `"description"` → one sentence about the product          |
| `README.md`                       | the title and the first paragraph                                            |
| `apps/web/index.html`             | `<title>`, `<meta name="description">`, `<html lang="…">` (your UI language) |
| `apps/api/src/openapi/openapi.ts` | `.setTitle('API')` → `.setTitle('<Product> API')`                            |
| `SECURITY.md`                     | `security@example.com` → your security contact                               |
| `.github/CODEOWNERS`              | replace `@your-org/...` with real users or teams and remove the `#`          |
| `CHANGELOG.md`                    | keep only the `# Changelog` heading: the template's history is not yours     |

The packages `apps/api` and `apps/web` keep their names (`api`, `web`): they are private.

**Check:** searching the project for `example.com` finds only examples and placeholders for later:
the `.env.example` files (those of `deploy/vps` too), tests, the development seed accounts, comments
and documentation, and the defaults of `infra/`, `dast.yml` and the smoke test (phases 7 to 9);
searching for `REQUIERE CONFIGURACIÓN` lists the items still open (most are in later phases).

---

## Phase 3. Run it locally

### 3.1 Install the dependencies

```
corepack enable
pnpm install
pnpm contract
```

`pnpm contract` writes the API's new title (2.2) into the committed contract, `openapi/openapi.json`,
and the web client's types: until then the contract drift test of 4.1 fails.

**Check:** `pnpm install` ends with `Done in …`, and `git config core.hooksPath` prints `.husky/_`
(the Git hooks are installed); `pnpm contract` ends without errors.

**If it fails:** `ERR_PNPM_UNSUPPORTED_ENGINE` → Node.js is older than 24.15 (phase 1).
`ERR_PNPM_NO_MATURE_MATCHING_VERSION` → a dependency is younger than seven days (the supply-chain
policy): wait a day or see [troubleshooting.md](troubleshooting.md).

### 3.2 Create your local configuration

```
cp apps/api/.env.example apps/api/.env
openssl rand -hex 32
```

Open `apps/api/.env` and paste the printed value after `JWT_ACCESS_SECRET=`. Nothing else is needed
locally.

**Check:** `grep -cE '^JWT_ACCESS_SECRET=[0-9a-f]{64}$' apps/api/.env` prints `1` (the secret is
set, without printing it). `git status` does **not** list `apps/api/.env` (it is ignored: never
commit it).

### 3.3 Start the database

```
pnpm db:up
pnpm db:migrate
pnpm db:seed
```

**Check:** `db:up` ends with `Container … Healthy`; `db:migrate` says the migrations were applied;
`db:seed` prints the two development accounts:

```
admin   admin@example.com / admin-password
member  member@example.com / member-password
```

**If it fails:** `port is already allocated` (port 5442 taken or, on Windows, reserved) → create
the root `.env` with `cp .env.example .env`, set `DB_PORT=5443` in it, change the port in
`DATABASE_URL` of `apps/api/.env` to `5443`, and repeat.

### 3.4 Start the app

```
pnpm dev
```

**Check**, in your browser:

| Open                                                          | You should see                           |
| ------------------------------------------------------------- | ---------------------------------------- |
| http://localhost:5173                                         | the sign-in page                         |
| sign in as `admin@example.com` / `admin-password`             | the app, signed in as Admin              |
| sign out, sign in as `member@example.com` / `member-password` | the app as Member, without admin screens |
| http://localhost:3000/api/docs                                | the API documentation (Swagger)          |
| http://127.0.0.1:3000/api/health/ready                        | a JSON answer with `"status":"ok"`       |
| http://localhost:8035                                         | Mailpit, where the app's email lands     |

The terminal shows the API's first line:
`Starting release unversioned in development: … error tracking off, Redis off, email on`, and a
box with these addresses under the logs. `pnpm --filter api mail test --to you@example.test`
queues a test message: it appears in Mailpit within seconds.

Stop with `Ctrl+C`. Tomorrow, `pnpm dev` is enough.

---

## Phase 4. Prove every gate passes

Run once now: if your machine passes what CI runs, a red CI later means a real problem in a change,
not a setup problem.

### 4.1 The main gate

```
pnpm verify
```

It runs, in order: formatting, lint, types, unit and component tests with coverage, the security
checks (vulnerabilities, licenses, secrets), the build and the performance budget. It takes a few
minutes.

**Check:** it ends without errors; the coverage summary appears and the budget lines say `ok`.

### 4.2 Integration and browser tests

```
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

**Check:** both report their tests passed (`passed`, no `failed`); the integration run also lists
the Redis adapter suite as skipped, which runs where `REDIS_TEST_URL` is set (CI). The end-to-end
tests use ports 3100 and 4173: stop `pnpm dev` first.

### 4.3 The Docker-based checks

```
pnpm sast
pnpm lint:workflows
pnpm observability:check
```

**Check:** Semgrep ends with `0 findings`; the workflow check prints `No findings to report`; the
observability check prints a line starting with `ok` (dashboards, alerts, metric names), then
promtool's `SUCCESS` for each of its steps. `pnpm sast` takes a few minutes (it scans a temporary
copy of the files git tracks); the first run also pulls the Semgrep image.

### 4.4 The production images on your machine

Set a secret for the local production stack in the root `.env` (create it with
`cp .env.example .env` if you have not): open it and paste the value the first command prints after
`JWT_ACCESS_SECRET=`, then start the stack:

```
openssl rand -hex 32
docker compose --profile stack up --build
```

In a second terminal:

```
pnpm smoke --url http://localhost:8080
```

**Check:** the smoke test ends with `Smoke test passed (public URL only).` and http://localhost:8080
shows the app. The stack uses the development database (the same `db` service and volume), so the
accounts of 3.3 sign in there too.

Stop: `Ctrl+C`, then `docker compose --profile stack down`.

---

## Phase 5. Put it on GitHub

### 5.1 First commit and push

If you created the repository with **Use this template**, it already has a remote. Otherwise:

```
gh repo create OWNER/REPO --private --source . --remote origin
```

Then:

```
git add -A
git commit -m "chore: start from the project template"
git push --no-verify -u origin main
```

The first commit runs the pre-commit checks over every file (about a minute). `--no-verify` is
only for this first push: from now on the hook refuses pushes to `main`.

**Check:** the repository on GitHub shows your files; the **Actions** tab shows a **CI** run on
`main` (it should end green).

### 5.2 Repository settings

In GitHub → **Settings**:

1. **General → Pull Requests**: allow only **squash merging**; default commit message
   "**Pull request title**"; tick **Automatically delete head branches**.
2. **Actions → General → Workflow permissions**: **Read repository contents and packages
   permissions**, and tick **Allow GitHub Actions to create and approve pull requests** (the
   **Release** workflow opens the release pull request with the workflow's token).
3. **Environments → New environment** `staging`: **Deployment branches and tags → Selected
   branches and tags → Add rule `main`**.
4. **Environments → New environment** `production`: the same rule for `main`, and **Required
   reviewers** (the people of 0.1; tick **Prevent self-review**).
5. **Code security**: enable **Dependabot alerts**, **Dependabot security updates**, **Secret
   scanning** with **Push protection** (if your plan offers them), **Private vulnerability
   reporting**.
6. **Rules → Rulesets**: import both files, or with the CLI:

   ```
   gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/main.json
   gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/tags.json
   ```

   Rulesets need a public repository or GitHub Team. With GitHub Pro (a personal account), use
   **Branches → Add branch protection rule** for `main` instead: require a pull request with one
   approval and the status checks **CI passed** and **Conventions**. On the Free plan with a
   private repository none of this (and no environment of steps 3–4) is available: make the
   repository public or upgrade before going on; otherwise the protections of this guide exist only
   on paper. Two workflows make up for part of it on any plan: `main-guard.yml` reports a push to
   `main` that is not a merged pull request, and `dependabot-auto-merge.yml` checks the approval and
   CI itself. Nothing replaces the required reviewers of a deployment
   ([ci-cd.md](ci-cd.md#required-check)).

**Check:** **Settings → Environments** lists `staging` and `production`, both limited to `main`;
**Rules** (or branch protection) shows the rule for `main`.

### 5.3 The token for release pull requests

Optional, the release token: without it, the **Release** workflow starts CI on the release pull
request itself, and the conventions check (**CI passed** and **Conventions**, the two checks the
ruleset requires). With a GitHub App token or a **fine-grained personal access token**, saved as
`RELEASE_PLEASE_TOKEN`, the release pull request runs every pull request workflow, like a person's
([ci-cd.md](ci-cd.md#release-pull-requests)). The fine-grained token:

1. GitHub → your avatar → **Settings → Developer settings → Personal access tokens → Fine-grained
   tokens → Generate new token**.
2. Resource owner `OWNER`; **Only select repositories** → `REPO`; expiration as your policy says.
3. Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**,
   **Issues: Read and write**.
4. Generate, copy, then:

   ```
   gh secret set RELEASE_PLEASE_TOKEN
   ```

   and paste it when asked.

**Check:** if you set the release token, `gh secret list` shows `RELEASE_PLEASE_TOKEN`; write its
expiration date in the [maintenance calendar](#phase-12-the-maintenance-calendar).

### 5.4 Prove the pull request flow

```
git switch -c chore/check-pipeline
printf '\nBuilt from the web template.\n' >> README.md
git commit -am "docs: check the pipeline"
git push -u origin HEAD
gh pr create --fill
gh pr checks --watch
```

**Check:** the pull request shows **CI passed** green (about 15 minutes the first time) and, with
the ruleset, cannot be merged without an approval. Merge it (**Squash and merge**).

A `docs` or `chore` change releases nothing, so no release pull request appears yet: the
**Release** workflow opens one when the first `feat` or `fix` reaches `main`, and starts CI and
Conventions on it (**CI passed** and **Conventions** green on that pull request a few minutes
later). Leave it open: merge it when you want to cut your first release (phase 8).

---

## Phase 6. Make it yours

From here on, every change follows [the daily loop](#phase-11-the-daily-loop): a branch, a pull
request, CI, review, merge. The first ones usually are:

1. **Design and language.** `apps/web/src/index.css` holds placeholder styles; the copy of the
   screens is in `apps/web/src`. Replace them with the product's.
2. **Your domain.** Add your tables and API modules next to `users`, following the recipes:
   [how-to.md](how-to.md) (add a table, an API module, an endpoint, a screen, a role, an
   environment variable).
3. **How accounts are created.** The template has sign-in, sessions, roles, password recovery and
   change, and an optional public sign-up confirmed by email (`SIGN_UP_ENABLED`, off by default),
   but no invitations: adjust it to what 0.1 decided. Administrators, and every account while
   sign-up is off, are created with the `create-user` command
   ([phase 8](#84-create-the-first-administrator)).
4. **Optional services**, only if needed: Redis (more than one API instance), OpenTelemetry
   (traces and metrics): [manual.md](manual.md#11-optional-infrastructure).

**Check, for each change:** `pnpm verify` passes locally and **CI passed** is green on its pull
request.

You can deploy to staging long before the product is finished: do phases 7 and 8 early, so every
merged change can be tried on a real server.

---

## Phase 7. Production servers

Do this phase twice: once for **staging**, once for **production**. The commands use
`app.acme.com`; use the domain of the environment you are setting up.

Steps 7.1 to 7.5 build the server and the database by hand, with any provider. On DigitalOcean,
Terraform can build the same ones instead: do 7.0, skip 7.1 to 7.5, and go on at 7.6.

### 7.0 On DigitalOcean, 7.1 to 7.5 with Terraform (optional)

What Terraform creates, what it costs and why:
[deploy-vps.md](deploy-vps.md#provision-with-terraform-digitalocean). You need Terraform 1.16.5 or a
later 1.16 ([developer.hashicorp.com/terraform/install](https://developer.hashicorp.com/terraform/install);
`terraform version` prints `Terraform v1.16.` and a patch number of 5 or more) and a DigitalOcean API token
that can write (**API → Tokens**).

On your computer, the deploy key of this environment (as in 7.4), then the settings file:

```
ssh-keygen -t ed25519 -N "" -C "github-deploy-production" -f deploy_production
cd infra/terraform/digitalocean
cp terraform.tfvars.example production.tfvars
```

Edit `production.tfvars`: `project_name`, `environment`, `domain`, your SSH public key
(`admin_ssh_public_key`, the content of your `~/.ssh/id_ed25519.pub`), the content of
`deploy_production.pub` (`deploy_ssh_public_key`) and `alert_emails` (verified members of your
DigitalOcean team). Keep `admin_cidrs = ["0.0.0.0/0"]`: GitHub's runners connect over SSH from
addresses that change. Then (paste the token when `read` waits, then Enter):

```
read -rs DIGITALOCEAN_TOKEN && export DIGITALOCEAN_TOKEN
terraform init
terraform workspace new production
terraform plan -var-file=production.tfvars -out=production.tfplan
terraform apply production.tfplan
rm production.tfplan
ssh "$(terraform output -raw ssh_admin)" cloud-init status --wait
```

The first SSH connection asks whether to trust the server's key: compare its fingerprint with the
one the server shows in DigitalOcean's **Droplet Console** (log in as `ops`, run
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Then point the domain at the server, unless
`manage_dns = true` did it: the record `terraform output dns_record` shows, at your DNS provider.
Last, the database roles and the server's key for GitHub:

```
cd ../../..
pnpm iac:database
ssh-keyscan -t ed25519 app.acme.com > known_hosts_production
```

**Check:** `cloud-init status --wait` ends with `status: done`; `pnpm iac:database` ends with
`Done: the database app (owner app_migrator) and the role app_runtime.`;
`ssh -i deploy_production deploy@app.acme.com 'docker ps'` prints an empty table (headers only);
`ssh-keygen -lf known_hosts_production` shows the fingerprint you compared.

**If it fails:**

| Message                                              | Cause and fix                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401`, `Unable to authenticate you`                  | `DIGITALOCEAN_TOKEN` is not exported in this terminal, or the token cannot write                                                                                                                                       |
| `Invalid value for variable`                         | the value it names in `production.tfvars`; `variables.tf` says what each one accepts                                                                                                                                   |
| `SSH Key is already in use on your account`          | this deploy key is in DigitalOcean already (another environment, an earlier attempt): one deploy key per environment, or remove the old one there (**Settings → Security**)                                            |
| `Provider produced inconsistent result after apply`  | the new reserved IP showed late in DigitalOcean's API: `terraform import -var-file=production.tfvars digitalocean_reserved_ip.app <address>` (the address in **Networking → Reserved IPs**), then plan and apply again |
| `The workspace (...) is not the environment (...)`   | `terraform workspace select production`                                                                                                                                                                                |
| `status: error`                                      | `/var/log/cloud-init-output.log` on the server says which command failed                                                                                                                                               |
| `pnpm iac:database`: `Permission denied (publickey)` | your SSH key is not the one in `admin_ssh_public_key`                                                                                                                                                                  |

### 7.1 Create the server

In your provider's console: a server with **Ubuntu 24.04 LTS**, 2 vCPU and 4 GB RAM or more, a
public IPv4, your personal SSH public key for the first login. If the provider has a firewall,
allow TCP 22, 80 and 443, and UDP 443.

**Check:** `ssh root@<server IP>` (or the user the provider names) opens a shell on the server.

### 7.2 Point the domain at it

At your DNS provider: an **A** record `app.acme.com` → the server's IPv4. No **AAAA** record: the
deployment serves IPv4 only ([deploy-vps.md](deploy-vps.md#2-create-the-server) says why).

**Check**, after a few minutes: `nslookup app.acme.com` answers the server's address.

### 7.3 Install Docker and close the firewall

Connected to the server, copy these lines one block at a time:

```
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

```
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

**Check:** `docker compose version` prints `Docker Compose version v2` or later; `sudo ufw status` lists
OpenSSH, 80 and 443 as `ALLOW`.

### 7.4 Create the deploy user

On the server:

```
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo install -d -m 755 -o deploy -g deploy /srv/app
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
```

On **your computer**, a key for GitHub to connect with (one per environment; no passphrase):

```
ssh-keygen -t ed25519 -N "" -C "github-deploy-production" -f deploy_production
scp deploy_production.pub <your user>@app.acme.com:/tmp/deploy.pub
ssh <your user>@app.acme.com 'sudo install -m 600 -o deploy -g deploy /tmp/deploy.pub /home/deploy/.ssh/authorized_keys && rm /tmp/deploy.pub'
ssh-keyscan -t ed25519 app.acme.com > known_hosts_production
```

**Check:** `ssh -i deploy_production deploy@app.acme.com 'docker ps'` prints an empty table
(headers only). Compare the key in `known_hosts_production` with the host key your provider's
console shows (or run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server and
`ssh-keygen -lf known_hosts_production` on your computer: the fingerprints must match).

### 7.5 Create the database

In your provider's console, a managed **PostgreSQL 16 or newer**: same region as the server,
**automated backups** and **point-in-time recovery** on, **deletion protection** on, access only
from the server's IP (or a private network). Note its host name.

Generate two passwords (`openssl rand -hex 24`, twice) and save them in the password manager. Then,
connected as the provider's administrator (`psql "<admin connection string>"`):

```sql
CREATE ROLE app_migrator LOGIN PASSWORD '<migrator password>';
GRANT app_migrator TO CURRENT_USER;
CREATE DATABASE app OWNER app_migrator;
CREATE ROLE app_runtime LOGIN PASSWORD '<runtime password>' CONNECTION LIMIT 50;
```

Then connected **as `app_migrator`** to the database `app`
(`psql "postgresql://app_migrator:<migrator password>@<host>:5432/app?sslmode=require"`):

```sql
GRANT CONNECT ON DATABASE app TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
```

**Check:** each statement answers `CREATE ROLE`, `GRANT ROLE`, `CREATE DATABASE`, `GRANT` or
`ALTER DEFAULT PRIVILEGES`, without errors. Without `GRANT app_migrator TO CURRENT_USER`,
PostgreSQL 16 and later refuse `CREATE DATABASE` (`must be able to SET ROLE "app_migrator"`): the
providers' administrators are not superusers. The migrator will own and change the schema; the
API connects as `app_runtime`, which reads and writes data only.

### 7.6 Put the deployment files on the server

From the project folder on your computer:

```
scp deploy/vps/* deploy@app.acme.com:/srv/app/
```

Later, when a release changes one of these files (Dependabot updates the Caddy image in
`deploy/vps`), the Deploy workflow stops at **Check the server's deploy files** until you copy them
again ([deploy-vps.md](deploy-vps.md#update-the-server-files)).

On the server, as `deploy` (`ssh -i deploy_production deploy@app.acme.com`):

```
cd /srv/app
chmod 755 deploy.sh rollback.sh
cp server.env.example server.env
cp api.env.example api.env
cp migrate.env.example migrate.env
cp web.env.example web.env
chmod 600 api.env migrate.env
openssl rand -hex 32
```

Edit each file (`nano <file>`, save with `Ctrl+O`, exit with `Ctrl+X`):

| File          | Set                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.env`  | `APP_DOMAIN=app.acme.com`                                                                                                                                                                                                      |
| `api.env`     | `DATABASE_URL=postgresql://app_runtime:<runtime password>@<db host>:5432/app?sslmode=require`, `JWT_ACCESS_SECRET=<the value openssl printed>`, `APP_ENVIRONMENT=production` (or `staging`), `APP_ORIGIN=https://app.acme.com` |
| `migrate.env` | `DATABASE_URL=postgresql://app_migrator:<migrator password>@<db host>:5432/app?sslmode=require`                                                                                                                                |
| `web.env`     | `APP_ENVIRONMENT=production` (or `staging`)                                                                                                                                                                                    |

With Terraform (7.0), the two `DATABASE_URL` values are complete already: in
`infra/terraform/digitalocean` on your computer, `terraform output -raw database_runtime_url`
(`api.env`) and `terraform output -raw database_migrator_url` (`migrate.env`).

On DigitalOcean or Amazon RDS, whose certificates come from the provider's own CA, end both URLs
with `?sslmode=require&uselibpqcompat=true` instead (the Terraform outputs already do): the API
would otherwise refuse the certificate (a certificate error such as
`self-signed certificate in certificate chain`,
[deploy-vps.md](deploy-vps.md#6-the-files-on-the-server)).

**Email** (optional; without it the app runs, and features that need email are unavailable): in
`api.env`, `MAIL_SMTP_URL=smtps://<user>:<password, percent-encoded>@<provider host>:465` and
`MAIL_FROM="Acme <no-reply@acme.com>"` from your email provider (Amazon SES, Postmark, Resend,
Brevo...), and at the provider, SPF, DKIM and DMARC for `acme.com`
([manual](manual.md#115-email)). After the first deployment (phase 8),
`docker compose --env-file server.env --env-file release.env run --rm -T api node dist/infrastructure/mail/mail.cli.js test --to <you>`
must print `Delivered`.

**Check:** `ls -l /srv/app` shows `api.env` and `migrate.env` as `-rw-------` (only `deploy` can
read them), and `grep -c '<' *.env` prints `0` for each file (no placeholder left).

### 7.7 Tell GitHub about the server

Once for the repository:

```
gh variable set DEPLOY_TARGET --body vps
gh variable set IMAGE_PREFIX --body ghcr.io/<owner>/<repo>
```

(`IMAGE_PREFIX` in lowercase: `ghcr.io/acme/acme-portal`.)

For the environment you are setting up (`production` here; `staging` the other time):

```
gh variable set DEPLOY_HOST --env production --body app.acme.com
gh variable set PUBLIC_URL --env production --body https://app.acme.com
gh secret set DEPLOY_SSH_KEY --env production < deploy_production
gh secret set DEPLOY_KNOWN_HOSTS --env production < known_hosts_production
```

Save `deploy_production` in the password manager, then delete it and `known_hosts_production` from
your computer.

**Check:** **Settings → Environments → production** lists the variables `DEPLOY_HOST`,
`PUBLIC_URL` and the secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`; **Settings → Secrets and
variables → Actions → Variables** lists `DEPLOY_TARGET` and `IMAGE_PREFIX`.

Now repeat the phase for the other environment: 7.0 or 7.1–7.5, then 7.6 and 7.7.

---

## Phase 8. First deployment

### 8.1 Deploy to staging

```
gh workflow run deploy.yml --ref main -f environment=staging -f ref=main
gh run watch
```

It takes 15–25 minutes the first time. The jobs, in order: Resolve the commit → Gates → Publish
api / api-migrate / web → Release to staging (server).

**Check:** the run ends green; its summary lists the three image digests; the last step prints
`Smoke test passed (public URL only).`; https://staging.acme.com opens the sign-in page with a
valid certificate (the padlock).

**If it fails:**

| Failing step                                                | Cause and fix                                                                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gates                                                       | the same as a red CI: open the failing job's log ([troubleshooting.md](troubleshooting.md))                                                                                 |
| Publish: "The registry is ghcr.io"                          | `IMAGE_PREFIX` must be `ghcr.io/<owner>/<repo>` in lowercase (7.7)                                                                                                          |
| Publish: "Scan the pushed image"                            | a fixable HIGH or CRITICAL advisory in the pushed image, as in the gates' image scan: update the base image or the dependency ([security.md](security.md#container-images)) |
| Environment settings                                        | a variable or secret of the environment is missing (7.7)                                                                                                                    |
| Deploy on the server: `Permission denied (publickey)`       | the public key is not in `/home/deploy/.ssh/authorized_keys`, or the wrong private key in `DEPLOY_SSH_KEY` (7.4)                                                            |
| `Host key verification failed`                              | `DEPLOY_KNOWN_HOSTS` does not match the server (7.4)                                                                                                                        |
| Check the server's deploy files: "Server files out of date" | a release changed a file in `deploy/vps`: copy the files again ([deploy-vps.md](deploy-vps.md#update-the-server-files))                                                     |
| `server.env is missing`                                     | 7.6 not done on that server                                                                                                                                                 |
| The migration failed                                        | `migrate.env`: wrong password, host, or the database is not reachable from the server (7.5)                                                                                 |
| The rollout failed                                          | the step's log ends with the new containers' last log lines, then the previous release starts again; usually `api.env` (`DATABASE_URL`, `JWT_ACCESS_SECRET`)                |
| Smoke test, certificate errors                              | DNS does not point at the server yet, or ports 80/443 are closed (7.2, 7.3)                                                                                                 |

### 8.2 Look at it

Open https://staging.acme.com. The sign-in page loads; nobody can sign in yet: production databases
have no accounts.

### 8.3 Cut the first release and deploy it to production

1. Merge the release pull request, "chore(main): release <version>" (5.4: it exists once a `feat`
   or `fix` reached `main`). The version follows from the commits since the template's `1.0.0`:
   the first `fix` makes it 1.0.1, the first `feat` 1.1.0. To choose the first version instead,
   first merge a pull request with the footer `Release-As: <version>` added to its commit message in
   the **Squash and merge** dialog. If the release pull request offers **Update branch**, press it
   first ([ci-cd.md](ci-cd.md#release-pull-requests)). The **Release** workflow creates the tag
   `v<version>` and the GitHub release.
2. Deploy that tag to staging, then to production:

   ```
   gh workflow run deploy.yml --ref main -f environment=staging -f ref=v<version>
   gh run watch
   gh workflow run deploy.yml --ref main -f environment=production -f ref=v<version>
   ```

3. The production run stops at **Release to production (server)** waiting for approval: a
   reviewer opens the run on GitHub → **Review deployments** → **Approve and deploy**.

**Check:** both runs end green; production builds nothing (its summary lists the three digests of
the staging run, "built and scanned by run <its id>"); https://app.acme.com opens the sign-in page.

### 8.4 Create the first administrator

On each server (staging and production), as `deploy`:

```
cd /srv/app
read -rs PASSWORD
```

Type the password (15 characters or more, a few words work well; nothing is shown), press
Enter, then:

```
printf '%s' "$PASSWORD" | docker compose --env-file server.env --env-file release.env \
  run --rm -T api node dist/users/create-user.cli.js \
  --email <first admin email> --name "<Name>" --role admin
unset PASSWORD
```

**Check:** it prints `Created the admin account <email> (<id>).`; sign in at the site with that
email and password; the admin screens are there.

Other accounts: the same command with `--role member`, until the product has its own sign-up or
invitations (phase 6).

### 8.5 Rehearse a rollback (staging)

Staging runs `v<version>` (8.3) and keeps the build of 8.1 as the release before it: that one is what
a rollback puts back. On the staging server:

```
cd /srv/app
./rollback.sh
```

**Check:** it prints `rollback: running <commit of 8.1>`; https://staging.acme.com/app-config.json
shows that commit as `release`; the site still works.

Then bring staging back to the release through the workflow, as for any deployment:

```
gh workflow run deploy.yml --ref main -f environment=staging -f ref=v<version>
gh run watch
```

**Check:** the run ends green and `app-config.json` shows the commit of `v<version>` again. Rolling
back is now something you have done, not something you read about.

---

## Phase 9. Monitoring and alerts

### 9.1 Error reports (Sentry)

1. In Sentry, create two projects: **Node.js** (the API) and **Browser JavaScript** (the web app).
   Copy each project's DSN.
2. On each server, add `SENTRY_DSN=<API DSN>` to `api.env` and `WEB_SENTRY_DSN=<web DSN>` to
   `web.env`, then:

   ```
   cd /srv/app
   docker compose --env-file server.env --env-file release.env up -d --wait api web
   ```

**Check:** `https://app.acme.com/app-config.json` shows the web DSN; the API's log line
`Starting release … error tracking on` (`docker compose --env-file server.env --env-file release.env logs api | head`).
In Sentry, set alert rules: [alerting.md](alerting.md).

### 9.2 Uptime

In your uptime monitor, add two checks every minute from several regions:

- `https://app.acme.com/healthz` (the web server),
- `https://app.acme.com/app-config.json` (the app's configuration is served).

Send the alerts to the people of 0.1 (email and a phone notification).

**Check:** both checks show "up"; send the monitor's test notification and confirm that every
person on the list received it.

### 9.3 Logs

The containers' logs stay on the server (`docker compose … logs`), rotated: five files of 10 MB
per container. For more than one server, or
to search them, send them to a log service ([observability.md](observability.md)).

---

## Phase 10. Before real users

Go through [production-readiness.md](production-readiness.md) with the team and tick each line
with its evidence. The ones this guide has not covered yet:

1. **A restore drill** of the database: restore the latest backup into a new instance with your
   provider's tool and check the data ([disaster-recovery.md](disaster-recovery.md#checklist)).
   Write down how long it took.
2. **Alerts and SLOs** agreed ([alerting.md](alerting.md)).
3. **The contacts table** of [incident-response.md](incident-response.md) filled in.
4. **Legal**: privacy policy, terms, cookie notice, as your market requires.
5. **The production approval** in GitHub has at least one reviewer who is not the author.

**Check:** the sign-off block at the end of production-readiness.md is filled in.

---

## Phase 11. The daily loop

Every change, the same way:

| Step                     | Do                                                                                                                                 | Check                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1. Start                 | `git switch main && git pull && pnpm install && pnpm db:migrate && pnpm dev`                                                       | the app runs locally             |
| 2. Branch                | `git switch -c feat/<short-description>` (or `fix/…`, `chore/…`)                                                                   | `git branch` shows it            |
| 3. Change                | code and tests together ([how-to.md](how-to.md)); a schema change: `pnpm db:migrate --name <name>`; an API change: `pnpm contract` | the app does what the issue asks |
| 4. Verify                | `pnpm verify` (and `pnpm test:integration` for API changes, `pnpm test:e2e` for user flows)                                        | all green                        |
| 5. Commit                | `git add -A && git commit -m "feat(<area>): <what>"`                                                                               | the hooks pass                   |
| 6. Push and pull request | `git push -u origin HEAD && gh pr create --fill`                                                                                   | **CI passed** green              |
| 7. Review                | a teammate reviews; answer every comment                                                                                           | approved                         |
| 8. Merge                 | **Squash and merge**                                                                                                               | the release pull request updates |
| 9. Release               | merge the release pull request when you want a version                                                                             | a tag `vX.Y.Z`                   |
| 10. Deploy               | Deploy the tag to staging, try it, then to production (approval)                                                                   | smoke test green on both         |
| 11. Watch                | Sentry and the uptime monitor during the next hour                                                                                 | no new errors                    |

If production misbehaves after a deployment: `./rollback.sh` on the server, then fix forward with a
new pull request ([deploy-vps.md](deploy-vps.md#roll-back)).

---

## Phase 12. The maintenance calendar

| When                          | Do                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every week                    | Approve Dependabot's update pull requests: patch and minor ones merge themselves once CI is green; majors and workflow updates you merge by hand.                                                                                                              |
| Every week                    | Read the DAST results (the **DAST** workflow runs on Mondays).                                                                                                                                                                                                 |
| Every month                   | On each server: `docker image prune`, and `docker image rm` the release images not named in `release.env` or `release.previous.env` (docs/deploy-vps.md#keep-the-server-healthy); reboot if `/var/run/reboot-required` exists.                                 |
| Every quarter                 | A database restore drill; review the alerts; check `RELEASE_PLEASE_TOKEN`'s expiration, if you set it; what Dependabot never proposes: a Node.js LTS major (each October), pnpm, PostgreSQL and Redis majors ([ci-cd.md](ci-cd.md#keeping-the-stack-current)). |
| When a secret may have leaked | Rotate it at once ([security.md](security.md#secret-rotation)).                                                                                                                                                                                                |
| After every incident          | A short postmortem; update the runbook and the alerts.                                                                                                                                                                                                         |

---

## When something is not in this guide

| Situation                                         | Where                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An error message                                  | [troubleshooting.md](troubleshooting.md) (search a few words of it)                                                                                                                                                                                              |
| How something works                               | [manual.md](manual.md)                                                                                                                                                                                                                                           |
| A kind of change (table, endpoint, screen, role…) | [how-to.md](how-to.md)                                                                                                                                                                                                                                           |
| The server deployment in detail                   | [deploy-vps.md](deploy-vps.md)                                                                                                                                                                                                                                   |
| An incident                                       | [incident-response.md](incident-response.md)                                                                                                                                                                                                                     |
| A mobile app for the same product                 | the mobile template's step-by-step guide (`docs/STEP_BY_STEP.md`), whose API contract expects sign-in and token renewal endpoints with the refresh token in the request body (this API uses an HTTP-only cookie for browsers): add them when you connect the app |
