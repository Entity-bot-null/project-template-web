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
- [Operations](#operations)

## How it works

```
browser ──HTTPS──▶ Caddy (TLS, HSTS) ──▶ web (nginx: the app, /api forwarded) ──▶ api ──▶ PostgreSQL (managed)
                   ports 80/443            edge network only                       edge network only
```

The **Deploy** workflow, with the repository variable `DEPLOY_TARGET=vps`:

1. re-runs every gate on the commit (as for any target);
2. **publish**: builds `api`, `api-migrate` and `web` and pushes them to `ghcr.io` as
   `<IMAGE_PREFIX>/<image>:<sha>`; when staging already published that commit, production reuses
   the same images;
3. **release-vps**, in the protected environment: checks that the server's copy of the deploy
   files is this release's (it stops otherwise, before changing anything,
   [Update the server files](#update-the-server-files)), resolves the three digests, connects to
   the server over SSH and runs `deploy.sh`, which
   - pulls the images by digest with the run's short-lived token (then logs out: the server keeps
     no registry credential),
   - runs the migration (`api-migrate` with the migrator role) and stops there if it fails, the
     running release untouched,
   - starts the new `api` and `web`, waits until both are healthy and the API is ready,
   - on success records it in `release.env` (the release it replaced moves to
     `release.previous.env`, the rollback target; redeploying the running release keeps the
     rollback target as it was); on failure starts the release that was running
     again, by itself;
4. runs the smoke test against the public URL; if it fails, runs `rollback.sh` on the server.

Tested end to end on Docker (a local registry and PostgreSQL standing in for GHCR and the managed
database): first deployment, migration with the two roles, HTTPS and HSTS, the smoke test, the
client address through Caddy, the first administrator, a second release, `rollback.sh`, and a
broken release rolled back automatically.

Nothing in the repository or in GitHub holds a database password or a JWT secret: they live in
files on the server, readable by the deploy user only.

## The files

`deploy/vps/` in the repository, copied to `/srv/app` on the server:

| File                   | What it is                                                                               | Committed        |
| ---------------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| `compose.yaml`         | the services: `proxy` (Caddy), `api`, `web`, `migrate` (run once per deployment)         | yes              |
| `Caddyfile`            | TLS for `APP_DOMAIN`, HSTS, compression, forward to `web`                                | yes              |
| `realip.conf`          | mounted into the web image: the client address comes from Caddy, not from the connection | yes              |
| `deploy.sh`            | one deployment (the steps above)                                                         | yes              |
| `rollback.sh`          | back to the previous release, without the registry                                       | yes              |
| `*.env.example`        | the settings to fill in                                                                  | yes              |
| `server.env`           | `APP_DOMAIN`                                                                             | no (server only) |
| `api.env`              | `DATABASE_URL` (runtime role), `JWT_ACCESS_SECRET`, `APP_ENVIRONMENT`, optional settings | no (server only) |
| `migrate.env`          | `DATABASE_URL` (migrator role)                                                           | no (server only) |
| `web.env`              | `APP_ENVIRONMENT`, optional `WEB_SENTRY_DSN`                                             | no (server only) |
| `release.env`          | the digests and release running now (written by `deploy.sh`)                             | no (server only) |
| `release.previous.env` | the release before it                                                                    | no (server only) |

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
(if the provider has one) allowing TCP 22, 80, 443 and UDP 443. Then the DNS: an `A` record
(and `AAAA` for IPv6) from the domain to the server's address. Check from your machine:

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
sudo ufw enable
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

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
backups and point-in-time recovery on, deletion protection on, access limited to the server's
address or a private network). Then, connected as the provider's administrator (`psql` with the
connection string the console gives):

```sql
CREATE ROLE app_migrator LOGIN PASSWORD '<password 1>';
CREATE DATABASE app OWNER app_migrator;
CREATE ROLE app_runtime LOGIN PASSWORD '<password 2>' CONNECTION LIMIT 50;
```

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
nano api.env         # DATABASE_URL (app_runtime, ?sslmode=require), JWT_ACCESS_SECRET, APP_ENVIRONMENT
nano migrate.env     # DATABASE_URL (app_migrator, ?sslmode=require)
nano web.env         # APP_ENVIRONMENT
```

`JWT_ACCESS_SECRET`: `openssl rand -hex 32`, a different one per environment. Every other API
variable is in [environment.md](environment.md); none is needed to start.

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
  registry access needed).
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
docker compose --env-file server.env --env-file release.env up -d --wait api web
```

Rotating `JWT_ACCESS_SECRET` without signing everyone out: [security.md](security.md#secret-rotation)
(`JWT_ACCESS_SECRET_PREVIOUS`).

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
