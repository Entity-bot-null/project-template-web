# Deploying to a Linux server (reference target)

One ready-made deployment target: a Linux server (a VPS or a dedicated machine) running Docker,
with a managed PostgreSQL. It is the simplest setup that keeps every rule of
[ci-cd.md](ci-cd.md#deployment): images built once per commit and deployed by digest, migrations
before the rollout, the smoke test after it, and an automatic rollback. For a container platform
(Kubernetes, ECS, Cloud Run, Render, Fly.io…), implement the generic `release` job of
`deploy.yml` instead, following the same steps.

The step-by-step setup, with what to check after each step, is in
[step-by-step.md](step-by-step.md#phase-7-production-servers) (Spanish:
[step-by-step.es.md](step-by-step.es.md)). This page describes the pieces and the operations.

On DigitalOcean, Terraform can set up sections 2 to 5 instead (the server, its firewalls, Docker,
the deploy user, the database and its roles), and the same server results:
[Provision with Terraform (DigitalOcean)](#provision-with-terraform-digitalocean).

- [How it works](#how-it-works)
- [The files](#the-files)
- [1. What you need](#1-what-you-need)
- [2. Create the server](#2-create-the-server)
- [3. Install Docker and close the firewall](#3-install-docker-and-close-the-firewall)
- [4. The deploy user and its SSH key](#4-the-deploy-user-and-its-ssh-key)
- [5. The database](#5-the-database)
- [6. The files on the server](#6-the-files-on-the-server)
- [7. GitHub settings](#7-github-settings)
- [8. The first deployment](#8-the-first-deployment)
- [9. Create the first administrator](#9-create-the-first-administrator)
- [Provision with Terraform (DigitalOcean)](#provision-with-terraform-digitalocean)
- [Operations](#operations)

## How it works

```
browser ──HTTPS──▶ Caddy (TLS, HSTS) ──▶ web (nginx: the app, /api forwarded) ──▶ api ──▶ PostgreSQL (managed)
                   ports 80/443            edge network only                       edge network only
```

The **Deploy** workflow, with the repository variable `DEPLOY_TARGET=vps`:

1. re-runs every gate on the commit (as for any target);
2. **publish**: builds `api`, `api-migrate` and `web`, pushes them to `ghcr.io` as
   `<IMAGE_PREFIX>/<image>:<sha>`, scans each digest it pushed with Trivy and records it in the run
   (the artifacts `image-<image>-<sha>`, listed in the run's summary); when an earlier deployment
   of that commit recorded its images (staging, before production), it reuses those digests
   instead of building, and scans them again: an advisory published since staging stops production
   too. Digests never come from the tag, which any workflow of the repository with
   `packages: write` can push ([ci-cd.md](ci-cd.md#deployment)). A record lasts 90 days (or the
   repository's shorter artifact retention); a commit deployed after that is built again;
3. **release-vps**, in the protected environment: checks that the server's copy of the deploy
   files is this release's (it stops otherwise, before changing anything,
   [Update the server files](#update-the-server-files)), takes the three digests this run
   recorded, connects to the server over SSH and runs `deploy.sh`, which
   - stops at once if another `deploy.sh` or `rollback.sh` is running on the server (a person's,
     say): two at once would move the release pointers under each other,
   - pulls the images by digest with the run's short-lived token (then logs out: the server keeps
     no registry credential); Docker refuses content whose digest is not the one asked for,
   - runs the migration (`api-migrate` with the migrator role) and stops there if it fails, the
     running release untouched,
   - starts the new `api` and `web`, waits until both are healthy and the API is ready,
   - on success records it in `release.env` (the release it replaced moves to
     `release.previous.env`, the rollback target; redeploying the running release keeps the
     rollback target as it was); on failure starts the release that was running
     again, by itself, and checks that it is ready;
4. runs the smoke test against the public URL; if it fails, runs `rollback.sh` on the server,
   which fails in turn when the release it puts back is not ready.

Tested end to end on Docker (a local registry and PostgreSQL standing in for GHCR and the managed
database): first deployment, migration with the two roles, HTTPS and HSTS, the smoke test, the
client address through Caddy, the first administrator, a second release, `rollback.sh`, a broken
release rolled back automatically, a failed migration (the running release untouched), two
deployments at once (the second refused) and a registry serving content that does not match its
digest (the pull refused). In CI, `scripts/deploy-vps.test.mjs` runs both scripts against a
stand-in for Docker.

Nothing in the repository or in GitHub holds a database password or a JWT secret: they live in
files on the server, readable by the deploy user only.

## The files

`deploy/vps/` in the repository, copied to `/srv/app` on the server:

| File                   | What it is                                                                                                                         | Committed        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `compose.yaml`         | the services: `proxy` (Caddy), `api`, `web`, `migrate` (run once per deployment)                                                   | yes              |
| `Caddyfile`            | TLS for `APP_DOMAIN`, HSTS, compression, forward to `web`                                                                          | yes              |
| `realip.conf`          | mounted into the web image: the client address comes from Caddy, not from the connection                                           | yes              |
| `deploy.sh`            | one deployment (the steps above)                                                                                                   | yes              |
| `rollback.sh`          | back to the previous release, without the registry                                                                                 | yes              |
| `*.env.example`        | the settings to fill in                                                                                                            | yes              |
| `server.env`           | `APP_DOMAIN`                                                                                                                       | no (server only) |
| `api.env`              | `DATABASE_URL` (runtime role), `JWT_ACCESS_SECRET`, `APP_ENVIRONMENT`, `APP_ORIGIN`, optional `MAIL_SMTP_URL` and `MAIL_FROM`, ... | no (server only) |
| `migrate.env`          | `DATABASE_URL` (migrator role)                                                                                                     | no (server only) |
| `web.env`              | `APP_ENVIRONMENT`, optional `WEB_SENTRY_DSN`, `WEB_VITALS_SAMPLE_RATE`                                                             | no (server only) |
| `release.env`          | the digests and release running now (written by `deploy.sh`)                                                                       | no (server only) |
| `release.previous.env` | the release before it                                                                                                              | no (server only) |
| `.deploy.lock`         | held by `deploy.sh` or `rollback.sh` while it runs: one at a time                                                                  | no (server only) |

Why `realip.conf`: the web image replaces `X-Forwarded-For` with the address that connected to it
(so a client cannot choose its own address). Behind Caddy that address would be Caddy's, and the
API's per-IP rate limits and logs would see every user as one. The mounted file makes nginx take
the address from Caddy, and only from Caddy's network.

## 1. What you need

| Item                                                                                                  | Example                                  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A server per environment, Ubuntu 24.04 LTS, public IPv4, at least 2 vCPU and 4 GB RAM                 | staging and production                   |
| A domain per environment, its DNS editable                                                            | `staging.example.com`, `app.example.com` |
| A managed PostgreSQL per environment (16 or newer), with automated backups and point-in-time recovery | the cloud provider's                     |
| The GitHub repository, with the CI passing                                                            |                                          |

## 2. Create the server

In the provider's console: Ubuntu 24.04 LTS, your SSH public key for the first login, a firewall
(if the provider has one) allowing TCP 22, 80, 443 and UDP 443. Then the DNS: an `A` record from
the domain to the server's IPv4 address, and no `AAAA` record. The deployment serves IPv4 only:
its Docker network (`compose.yaml`) has no IPv6, so Docker would hand every IPv6 visitor to Caddy
from one internal address, and the API's per-IP rate limits would count them all as one client.
Check from your machine:

```
nslookup app.example.com          # the server's address
ssh root@app.example.com          # or the provider's default user
```

## 3. Install Docker and close the firewall

On the server, Docker Engine from Docker's own repository (the official procedure):

```
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker --version && docker compose version
```

Firewall and automatic security updates:

```
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

`--force` skips `ufw`'s confirmation prompt, which would otherwise take the next pasted line as its
answer and leave the firewall off; OpenSSH is allowed first, so the current session stays open.
Docker publishes container ports around `ufw`: only `proxy` publishes any (80 and 443), so nothing
else is reachable from outside.

## 4. The deploy user and its SSH key

A user that may run Docker and nothing else is needed for the workflow. Membership of the `docker`
group is equivalent to root on that machine: the key below belongs only in the GitHub environment.

```
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo install -d -m 755 -o deploy -g deploy /srv/app
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
```

On **your machine**, a key pair for the workflow, one per environment, without a passphrase (the
workflow cannot type one):

```
ssh-keygen -t ed25519 -N "" -C "github-deploy-production" -f deploy_production
```

Copy the public key to the server, then check the login and the server's host key:

```
scp deploy_production.pub <you>@app.example.com:/tmp/deploy.pub
ssh <you>@app.example.com 'sudo install -m 600 -o deploy -g deploy /tmp/deploy.pub /home/deploy/.ssh/authorized_keys && rm /tmp/deploy.pub'
ssh -i deploy_production deploy@app.example.com 'docker ps'      # an empty list
ssh-keyscan -t ed25519 app.example.com > known_hosts_production
```

Compare the key in `known_hosts_production` with the one the provider's console shows for the
server (or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server): this is what stops
the workflow from talking to an impostor.

## 5. The database

Create the PostgreSQL instance in the provider's console (same region as the server, automated
backups and point-in-time recovery on, deletion protection on where the provider has it, access
limited to the server's address or a private network). Then, connected as the provider's
administrator (`psql` with the connection string the console gives):

```sql
CREATE ROLE app_migrator LOGIN PASSWORD '<password 1>';
GRANT app_migrator TO CURRENT_USER;
CREATE DATABASE app OWNER app_migrator;
CREATE ROLE app_runtime LOGIN PASSWORD '<password 2>' CONNECTION LIMIT 50;
```

The `GRANT` is needed from PostgreSQL 16: an administrator that is not a superuser (a managed
service's never is) may give a database only to a role it is a member of. Without it,
`CREATE DATABASE` fails with `must be able to SET ROLE "app_migrator"`.

Then connected **as `app_migrator`** to the database `app`, the runtime role's rights
([disaster-recovery.md](disaster-recovery.md#backup-strategy)):

```sql
GRANT CONNECT ON DATABASE app TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
```

Generate each password with `openssl rand -hex 24`. The migrator owns the schema and is used only by
the migration job; the API connects as `app_runtime`, which can read and write data but cannot
change the schema.

## 6. The files on the server

From the repository, on your machine:

```
scp deploy/vps/* deploy@app.example.com:/srv/app/
```

On the server, as `deploy`, in `/srv/app`:

```
cd /srv/app
chmod 755 deploy.sh rollback.sh
cp server.env.example server.env
cp api.env.example api.env
cp migrate.env.example migrate.env
cp web.env.example web.env
chmod 600 api.env migrate.env
nano server.env      # APP_DOMAIN=app.example.com
nano api.env         # DATABASE_URL (app_runtime, ?sslmode=require), JWT_ACCESS_SECRET, APP_ENVIRONMENT, APP_ORIGIN; email: MAIL_SMTP_URL, MAIL_FROM
nano migrate.env     # DATABASE_URL (app_migrator, ?sslmode=require)
nano web.env         # APP_ENVIRONMENT
```

`JWT_ACCESS_SECRET`: `openssl rand -hex 32`, a different one per environment. Every other API
variable is in [environment.md](environment.md); none is needed to start. Email is off until
`MAIL_SMTP_URL` and `MAIL_FROM` name your provider's SMTP server and sender (encrypted: `smtps://`,
or `smtp://` with STARTTLS); after the first deployment,
`docker compose ... run --rm -T api node dist/infrastructure/mail/mail.cli.js test --to <you>`
checks the whole path ([manual](manual.md#115-email)).

The API's database driver (node-postgres) reads `sslmode=require` as `verify-full`: it refuses a
certificate signed by the provider's own CA (DigitalOcean, Amazon RDS), and the rollout stops with
a certificate error in the API's log (`self-signed certificate in certificate chain`). With such a
provider, end both URLs with `?sslmode=require&uselibpqcompat=true`: TLS as libpq means `require`,
encrypted without checking the certificate, on a network where the database admits only this
server. The Terraform outputs are written that way.

## 7. GitHub settings

Repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable        | Value                                        |
| --------------- | -------------------------------------------- |
| `DEPLOY_TARGET` | `vps`                                        |
| `IMAGE_PREFIX`  | `ghcr.io/<owner>/<repository>`, in lowercase |

Environment variables and secrets, for **each** of `staging` and `production` (Settings →
Environments → the environment):

| Name                 | Kind     | Value                                            |
| -------------------- | -------- | ------------------------------------------------ |
| `DEPLOY_HOST`        | variable | the server's host name (`app.example.com`)       |
| `PUBLIC_URL`         | variable | `https://app.example.com`                        |
| `DEPLOY_USER`        | variable | optional, default `deploy`                       |
| `DEPLOY_PATH`        | variable | optional, default `/srv/app`                     |
| `DEPLOY_SSH_KEY`     | secret   | the whole private key file (`deploy_production`) |
| `DEPLOY_KNOWN_HOSTS` | secret   | the content of `known_hosts_production`          |

With the GitHub CLI:

```
gh variable set DEPLOY_TARGET --body vps
gh variable set IMAGE_PREFIX --body ghcr.io/<owner>/<repository>
gh variable set DEPLOY_HOST --env production --body app.example.com
gh variable set PUBLIC_URL --env production --body https://app.example.com
gh secret set DEPLOY_SSH_KEY --env production < deploy_production
gh secret set DEPLOY_KNOWN_HOSTS --env production < known_hosts_production
```

Then delete the private key from your machine (or keep it in a password manager): GitHub holds it.

## 8. The first deployment

```
gh workflow run deploy.yml --ref main -f environment=staging -f ref=main
gh run watch
```

The run shows, in order: Resolve the commit, Gates, Publish api / api-migrate / web, Release to
staging (server). The first publish makes the three packages private in `ghcr.io`; nothing to do.
At the end, the smoke test prints `Smoke test passed (public URL only).` and the site answers at
`PUBLIC_URL` with a valid certificate (Caddy obtains it on the first request; port 80 must be open
for that).

## 9. Create the first administrator

The template has no sign-up (each product decides its own account lifecycle), and the development
seed never runs in production. The first account is created on the server with the API image, the
password read from standard input so it never appears in the shell history or the process list:

```
cd /srv/app
read -rs PASSWORD          # type the password (12 characters or more), then Enter
printf '%s' "$PASSWORD" | docker compose --env-file server.env --env-file release.env \
  run --rm -T api node dist/users/create-user.cli.js \
  --email owner@your-company.com --name "Owner" --role admin
unset PASSWORD
```

It prints `Created the admin account owner@your-company.com (<id>).` and refuses an email that
already has an account. Sign in at `PUBLIC_URL` with it.

## Provision with Terraform (DigitalOcean)

`infra/terraform/digitalocean/` builds on DigitalOcean what sections 2 to 5 build by hand: the
same server, firewall, users, Docker and database roles. Choose one path per environment. Sections
6 to 9 (the files and their secrets, GitHub, the first deployment, the first administrator) are the
same for both.

### What it creates

| What                                                                                                                                                     | File                                                 | Instead of                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| A Droplet: Ubuntu 24.04 LTS, `s-2vcpu-4gb`, the metrics agent, weekly backups, IPv4 only; the deploy key in the account, so no root password is emailed  | `main.tf`                                            | section 2                                                       |
| A reserved IP (the address survives a new server), and the `A` record to it with `manage_dns`                                                            | `main.tf`                                            | section 2                                                       |
| A cloud firewall: SSH from `admin_cidrs` only; TCP 80 and 443, UDP 443 from anywhere                                                                     | `main.tf`                                            | section 2                                                       |
| Docker Engine from Docker's repository, its signing key checked by fingerprint; the `ufw` rules; automatic security updates                              | `cloud-init.yaml.tftpl`                              | section 3                                                       |
| The `deploy` user (Docker, the Deploy workflow's key) and `/srv/app`; an administrator, `ops` (sudo, your key); SSH with keys only, root refused         | `cloud-init.yaml.tftpl`                              | section 4                                                       |
| A private network (VPC) for the server and its database                                                                                                  | `main.tf`                                            | section 5 (private network)                                     |
| Managed PostgreSQL 18 in that network: daily backups, 7 days of point-in-time recovery, the server as its only trusted source; never destroyed by a plan | `database.tf`                                        | section 5                                                       |
| `app_migrator`, the database `app` it owns, and `app_runtime` (50 connections), with generated passwords                                                 | `database/roles.sql`, applied by `pnpm iac:database` | section 5 (SQL)                                                 |
| Email alerts: CPU, memory and disk of the server and of the database; the site down from every region; its certificate expiring within 14 days           | `monitoring.tf`                                      | [observability.md](observability.md#uptime-monitoring), by hand |
| A DigitalOcean project that groups them, and tags                                                                                                        | `main.tf`                                            |                                                                 |

Where it goes further than the manual steps, on purpose:

- **SSH**: no root login, no password login, and only `ops` and `deploy` may log in. People work as
  `ops` (with `sudo`), never as root.
- **Passwords**: the roles' passwords reach PostgreSQL as SCRAM verifiers computed on your machine,
  never in clear.
- **Uptime**: the check probes `https://<domain>/healthz`, the web server's public health check.
  The API's readiness (`/api/health/ready`) answers 404 from outside on purpose (the deploy smoke
  test checks that it does), and DigitalOcean counts any answer outside 2xx as down, so readiness
  cannot be probed from outside: the database alerts and DigitalOcean's own notices about the
  cluster (sent to the team's contact email) cover the database.

**IPv6 is off, by choice** (section 2 says why): the Droplet has no IPv6 address, the cloud
firewall opens IPv4 only, and Terraform creates no `AAAA` record. Served over IPv6 today, every IPv6
visitor would reach the API as the edge network's gateway and share one rate-limit bucket (audit
finding U1). Turning it on takes the edge network of `compose.yaml` carrying IPv6 and `realip.conf`
trusting its IPv6 range first; then `ipv6 = true` on the Droplet, IPv6 sources in the firewall and
an `AAAA` record.

Backups are DigitalOcean's: daily, with 7 days of point-in-time recovery, the low end of
[disaster-recovery.md](disaster-recovery.md#backup-strategy). They go with the cluster when it is
deleted, so a copy outside it (another account or region) is the project's to add.

### What it costs

The monthly drivers, at DigitalOcean's prices of October 2026 (its pricing pages have today's):

| Item                                              | Default                    | Per month                                                                                          |
| ------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| Droplet                                           | `s-2vcpu-4gb`              | $24                                                                                                |
| Droplet backups                                   | weekly (`droplet_backups`) | 20 % of the Droplet ($4.80); daily, 30 %                                                           |
| PostgreSQL                                        | `db-s-1vcpu-1gb`, one node | about $15; standby nodes (`database_node_count`) need `db-s-1vcpu-2gb` or larger, about $30 a node |
| Uptime check                                      | one                        | an account's first check is free, then $1 each                                                     |
| Remote state in Spaces (optional)                 |                            | the Spaces subscription                                                                            |
| Reserved IP, VPC, firewalls, DNS, alerts, project |                            | nothing (a reserved IP is billed only while no Droplet holds it)                                   |

Outbound traffic beyond the Droplet's included allowance is billed too.

### Before you start

- Terraform 1.16 on your machine (`terraform version`).
- A DigitalOcean team, and an API token that can write (API → Tokens). It lives in your shell's
  environment only, never in a file or a variable: `read -rs DIGITALOCEAN_TOKEN` (paste it, then
  Enter), then `export DIGITALOCEAN_TOKEN`.
- Your SSH public key, and the deploy key pair of section 4, generated the same way
  (`ssh-keygen -t ed25519 -N "" -C "github-deploy-production" -f deploy_production`): a new one
  per environment. Terraform registers its public half in the DigitalOcean account (a Droplet
  created without an account key gets a root password by email), and an account refuses a key it
  holds already.
- With `manage_dns = true`: the domain's zone in DigitalOcean (Networking → Domains), the
  registrar pointing at DigitalOcean's name servers.
- For the alerts: email addresses of verified members of the team (DigitalOcean refuses others).

### Create an environment

In `infra/terraform/digitalocean`, once per environment (`production` here; `staging` the other
time):

```
cd infra/terraform/digitalocean
cp terraform.tfvars.example production.tfvars    # fill it in; variables.tf explains every value
read -rs DIGITALOCEAN_TOKEN && export DIGITALOCEAN_TOKEN
terraform init
terraform workspace new production                # later: terraform workspace select production
terraform plan -var-file=production.tfvars -out=production.tfplan
terraform apply production.tfplan
rm production.tfplan
```

Read the plan before applying it: the first one only adds, about twenty resources. The apply takes
about ten minutes, most of them the database. Each environment has its own workspace, and so its
own state: applying production's values in the staging workspace is refused.

If the first apply stops with `Provider produced inconsistent result after apply` on
`digitalocean_reserved_ip.app`, the address exists but the state does not know it (a race between
DigitalOcean's API and provider versions before 2.104.0). Bring it in, then apply again:
`terraform import -var-file=production.tfvars digitalocean_reserved_ip.app <address>`, with the
address from the control panel (Networking → Reserved IPs).

`admin_cidrs` must include where the Deploy workflow connects from. GitHub-hosted runners have no
fixed addresses, so with them it is `["0.0.0.0/0"]`, as in the manual setup (SSH with keys only,
no root, no passwords); narrow it when every SSH client, the runner included, has a fixed address
(a self-hosted runner, a VPN).

Then, in order:

1. **Wait for cloud-init**, and check the server's host key. The first connection asks whether to
   trust it: compare its fingerprint with the one the server shows in the control panel's Droplet
   Console (log in as `ops`, run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). The console
   connects over SSH from DigitalOcean's network, so it needs `admin_cidrs` open, as by default.

   ```
   ssh "$(terraform output -raw ssh_admin)" cloud-init status --wait
   ```

   It ends with `status: done` once sections 3 and 4 are complete and the Docker daemon answers;
   the server then reboots once if an update needs it. `status: error`: read
   `/var/log/cloud-init-output.log` on the server.

2. **DNS**, without `manage_dns`: create the record that `terraform output dns_record` shows, at
   your DNS provider, and check it with `nslookup` (section 2).

3. **The database roles**, from the repository root, the workspace still selected:

   ```
   cd ../../..
   pnpm iac:database
   ```

   It runs `database/roles.sql` from the server, the only machine the database accepts, and ends
   with `Done: the database app (owner app_migrator) and the role app_runtime.` Running it again is
   safe.

4. **Sections 6 to 9** as written. From section 4, only the checks remain (the deploy key is on the
   server already): `ssh -i deploy_production deploy@app.example.com 'docker ps'` and
   `known_hosts_production`. The values Terraform gives:

   | Where                                     | Value                                           |
   | ----------------------------------------- | ----------------------------------------------- |
   | `api.env`: `DATABASE_URL` (section 6)     | `terraform output -raw database_runtime_url`    |
   | `migrate.env`: `DATABASE_URL` (section 6) | `terraform output -raw database_migrator_url`   |
   | `DEPLOY_HOST`, `PUBLIC_URL` (section 7)   | `terraform output github_environment_variables` |

What stays manual on both paths: the GitHub settings (section 7), the DNS record unless
`manage_dns`, the files and secrets on the server (section 6), the first deployment (section 8)
and the first administrator (section 9).

### State

Terraform's state is local by default, in `terraform.tfstate.d/<workspace>/` in that directory,
and never committed (`.gitignore`). It holds every password of the environment, the cluster
administrator's and both roles': keep the disk encrypted and the file out of shared folders. For a
team, or to apply from more than one machine, keep it in DigitalOcean Spaces:
`backend.hcl.example` says how (a private bucket with versioning, the Spaces key in
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, then
`terraform init -backend-config=backend.hcl -migrate-state`; locking included).

### Later changes

- `terraform plan` shows what a change does before `terraform apply`. A larger `droplet_size`
  resizes the server (it is off for a few minutes); `database_size` and `database_node_count`
  resize the cluster.
- cloud-init runs at the first boot only, and Terraform ignores later changes to the user data and
  to the Droplet's account key: either would mean a new server, which would lose the files of
  `/srv/app`. Rotate a key on the server itself (`~/.ssh/authorized_keys` of `ops` or `deploy`;
  for `deploy`, then `DEPLOY_SSH_KEY` in GitHub).
- To rebuild the server on purpose: copy `/srv/app/*.env` off it (the release pointers included),
  run `terraform apply -replace=digitalocean_droplet.app -var-file=production.tfvars`, put the
  files back (section 6), replace `DEPLOY_KNOWN_HOSTS` (a new server has new host keys), then
  deploy. The address stays the same.
- To rotate a database password, for example the runtime role's:
  `terraform apply -replace=random_password.runtime -var-file=production.tfvars`, then
  `pnpm iac:database`, then the new `terraform output -raw database_runtime_url` in `api.env` and
  `docker compose --env-file server.env --env-file release.env up -d --wait api`. The API's open
  connections keep working, new ones need the new password: do the last two steps right away.
- Terraform's and the providers' versions are pinned; `versions.tf` says how to update them.

### Teardown

`terraform destroy -var-file=production.tfvars` stops before it changes anything: the database
cluster has `prevent_destroy`, because deleting a DigitalOcean cluster deletes its backups with it.
DigitalOcean's API and its Terraform provider have no deletion protection for clusters, so this
guard covers Terraform only: limit who can delete resources in the team. To remove an environment
for good:

1. If the data matters, keep a copy first: a `pg_dump` taken from the server
   ([disaster-recovery.md](disaster-recovery.md#rehearsal-on-a-development-machine)).
2. In your working copy only, set `prevent_destroy = false` in `database.tf`.
3. `terraform destroy -var-file=production.tfvars`, then restore `database.tf`
   (`git checkout database.tf`) and delete the workspace
   (`terraform workspace select default && terraform workspace delete production`).

## Operations

### Deploy a release

Staging first, then the same ref to production (the environment asks its reviewers):

```
gh workflow run deploy.yml --ref main -f environment=staging -f ref=v1.4.0
gh workflow run deploy.yml --ref main -f environment=production -f ref=v1.4.0
```

### Update the server files

The server runs its own copy of `compose.yaml`, `Caddyfile`, `realip.conf`, `deploy.sh` and
`rollback.sh` (section 6). A release that changes one of them (a Dependabot update of the Caddy
image, a fix to `deploy.sh`) must not run with the old copy, so the Deploy workflow compares the
server's files with the release's before it changes anything, and stops with **Server files out of
date** when they differ. Copy them from a checkout of the ref you deploy, then run Deploy again:

```
git switch --detach v1.4.0
scp deploy/vps/compose.yaml deploy/vps/Caddyfile deploy/vps/realip.conf deploy/vps/deploy.sh   deploy/vps/rollback.sh deploy@app.example.com:/srv/app/
```

The deployment then pulls and starts a new Caddy image by itself, and `web`, which reads
`realip.conf`, is recreated by every deployment. A change to the `Caddyfile` alone takes effect
when the proxy restarts (a few seconds without the site):

```
cd /srv/app
docker compose --env-file server.env --env-file release.env up -d --force-recreate --wait proxy
```

`rollback.sh` runs the previous release with the files now on the server: a change to
`compose.yaml` that the previous release cannot run with needs the same care as a migration
(expand first, contract in a later release).

### Roll back

- **Automatic**: a failed rollout or smoke test puts the previous release back.
- **By hand**, on the server: `cd /srv/app && ./rollback.sh` (uses the images already there; no
  registry access needed). It ends once the API is ready, and fails, saying so, when the release it
  put back is not (a database credential changed since, for example). While a deployment runs it
  stops at once: a failed deployment puts the running release back by itself.
- **Planned**: run Deploy with the previous tag.

Migrations are never reversed: the previous release runs on the current schema
([database.md](database.md#safe-migrations)). A failed migration stops the deployment before
anything changes ([incident-response.md](incident-response.md#10-failed-database-migration)).

### Look at it

```
cd /srv/app
cat release.env                                            # what runs now
docker compose --env-file server.env --env-file release.env ps
docker compose --env-file server.env --env-file release.env logs -f api
docker compose --env-file server.env --env-file release.env exec api \
  node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(async (r) => console.log(r.status, await r.text()))"
```

### Change a setting or a secret

Edit the `.env` file on the server, then recreate the service:

```
cp api.env api.env.previous      # the way back: rollback.sh puts back images, never settings
docker compose --env-file server.env --env-file release.env up -d --wait api web
```

To undo the change, copy the previous file back and recreate the service again.

Rotating `JWT_ACCESS_SECRET` without signing everyone out: [security.md](security.md#secret-rotation)
(`JWT_ACCESS_SECRET_PREVIOUS`).

### Recover a lost server

The server holds the only copy of its settings (the `*.env` files) and of the release pointers;
the database, the images and the code live elsewhere. A server that is gone (deleted, its disk
lost) or compromised comes back like this; never reuse a compromised one: keep it off for the
investigation ([incident-response.md](incident-response.md#11-authentication-or-security-attack)).

1. **A new server**: `terraform apply -replace=digitalocean_droplet.app -var-file=production.tfvars`
   (the reserved IP and the DNS record stay), or sections 2 to 4 by hand. A Droplet backup
   (`droplet_backups`) brings `/srv/app` back as it was on that day, settings included: fine
   after a lost disk, not after a compromise.
2. **The files**, section 6, from a checkout of the release that was running (the last successful
   Deploy run of the environment names it). The settings are made again, not copied from a
   compromised server:
   - `DATABASE_URL` of `api.env` and `migrate.env`: `terraform output -raw database_runtime_url`
     and `database_migrator_url`; by hand, the URLs of section 5. After a compromise, new
     passwords first ([Later changes](#later-changes); by hand, `ALTER ROLE ... PASSWORD` as the
     administrator).
   - `JWT_ACCESS_SECRET`: a new one (`openssl rand -hex 32`). Nobody is signed out: sessions live
     in the database, and an access token signed with the old secret is refused and renewed by the
     next refresh ([security.md](security.md#secret-rotation)).
   - `server.env`, `web.env`, `APP_ENVIRONMENT`, `APP_ORIGIN`: as in section 6; the optional
     settings (`SENTRY_DSN`, `MAIL_SMTP_URL` and `MAIL_FROM`, ...) from their services. Email still
     waiting in the outbox is sent once the API runs again.
3. **GitHub**: `DEPLOY_KNOWN_HOSTS` with the new server's host key (section 4).
   `DEPLOY_SSH_KEY` stays when the new server has the same deploy key (Terraform registers it);
   after a compromise, a new key pair, on the server and in the environment.
4. **The release**: run Deploy with the ref that was running. It reuses the digests recorded by
   that run (90 days; later it builds them again), pulls them, migrates (nothing to do) and starts
   them; Caddy obtains the certificates at the first request. `release.previous.env` starts
   empty: the next release makes this one the rollback target.
5. **Check**: the smoke test of the run, a sign-in, and `ApiMetricsAbsent` and the uptime checks
   back to normal.

### Keep the server healthy

- Security updates install by themselves (`unattended-upgrades`); reboot when
  `/var/run/reboot-required` exists, during a quiet hour (the containers restart by themselves).
- Old images pile up. Once a month, `docker image prune` removes the dangling layers, and
  `docker image rm <image>` the release images that neither `release.env` nor
  `release.previous.env` names (the running release and the rollback target). Never
  `docker image prune -a --filter "until=..."`: the filter goes by when an image was built, so it
  removes the rollback target once that release is old enough.
- Container logs rotate by themselves (`compose.yaml`: five files of 10 MB per container), so they
  never fill the disk.
- Caddy renews the certificates; the uptime checks of [observability.md](observability.md) tell you
  if it ever fails.
- Backups are the database provider's: schedule and rehearse a restore
  ([disaster-recovery.md](disaster-recovery.md)).

### Moving to more than one server

This target runs one instance of each service. Before adding a second server behind a load
balancer: Redis for the shared rate limits and cache ([architecture.md](architecture.md#redis)),
and `TRUST_PROXY` for the extra hop; or move to a container platform with the generic `release`
job.
