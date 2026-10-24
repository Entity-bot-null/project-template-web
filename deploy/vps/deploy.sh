#!/bin/sh
# Deploys one release on this server (docs/deploy-vps.md). Run by the Deploy
# workflow over SSH, or by hand:
#
#   ./deploy.sh <api image@digest> <api-migrate image@digest> <web image@digest> <release>
#
# 1. pulls the new images by digest, and the pinned images of the data
#    services;
# 2. starts the data services, or leaves them running: Redis, and PostgreSQL
#    with its nightly backup when this server runs the database
#    (COMPOSE_PROFILES=db in server.env);
# 3. migrates the database (stops here on failure: the running release keeps
#    serving);
# 4. rolls out the API, then the web image, waiting until they are healthy
#    and the API is ready;
# 5. on success, records it in release.env (the one it replaced moves to
#    release.previous.env, the target of rollback.sh); on failure, starts
#    the release of release.env again.
#
# One deployment or rollback at a time: a second deploy.sh or rollback.sh
# started meanwhile stops at once, before changing anything.
#
# Registry login: when REGISTRY_TOKEN is set (the workflow passes its short
# lived token on stdin), the server logs in for this run only.
set -eu

cd "$(dirname "$0")"

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <api image@digest> <api-migrate image@digest> <web image@digest> <release>" >&2
  exit 2
fi
for image in "$1" "$2" "$3"; do
  case "$image" in
    *@sha256:*) ;;
    *)
      echo "deploy: $image is not pinned by digest (<image>@sha256:<digest>)" >&2
      exit 2
      ;;
  esac
done
for file in server.env api.env migrate.env web.env redis.env; do
  if [ ! -f "$file" ]; then
    echo "deploy: $file is missing next to compose.yaml (copy $file.example and fill it in)" >&2
    exit 2
  fi
done

# Two runs at once (the workflow and a person, or two people) would share
# release.next.env and move the release pointers under each other: the server
# would run one release while release.env names another, or none. The lock is
# the kernel's, on an open file: it goes with this process, however it ends.
exec 9> .deploy.lock
if ! flock -n 9; then
  echo "deploy: another deployment or rollback is running on this server; run this again once it has finished" >&2
  exit 1
fi

compose() {
  docker compose --env-file server.env --env-file "$release_file" "$@"
}

# The services a release does not replace: Redis, and PostgreSQL with its
# nightly backup when this server runs the database. Their images are pinned
# in compose.yaml.
pull_data() {
  if [ "$with_database" = yes ]; then
    compose pull redis db backup
  else
    compose pull redis
  fi
}

# Redis and PostgreSQL healthy before the migration needs them. The backup is
# started, not waited for: a failed backup shows in `docker compose ps` (and
# the alerts) and must not hold a deployment back, which may be its fix.
start_data() {
  if [ "$with_database" = yes ]; then
    compose up --detach --wait --wait-timeout 180 redis db && compose up --detach backup
  else
    compose up --detach --wait --wait-timeout 180 redis
  fi
}

# The API answers readiness (its database reachable), not only liveness, which
# is all the containers' health checks ask.
api_ready() {
  compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/health/ready', { signal: AbortSignal.timeout(10000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

logout_registry() {
  docker logout "$registry" > /dev/null 2>&1 || true
  trap - EXIT
}

if [ -n "${REGISTRY_TOKEN:-}" ]; then
  registry=${1%%/*}
  # Logged out right after the pull, and on any exit before it (a failed
  # pull included): the server keeps no registry credential.
  trap logout_registry EXIT
  printf '%s' "$REGISTRY_TOKEN" | docker login "$registry" --username "${REGISTRY_USER:-deploy}" --password-stdin
fi

{
  echo "API_IMAGE=$1"
  echo "MIGRATE_IMAGE=$2"
  echo "WEB_IMAGE=$3"
  echo "APP_RELEASE=$4"
} > release.next.env

release_file=release.next.env
# The profiles server.env enables: the database here, or a managed one.
if compose config --services | grep -qx db; then
  with_database=yes
  for file in db.env backup.env; do
    if [ ! -f "$file" ]; then
      rm -f release.next.env
      echo "deploy: $file is missing next to compose.yaml (COMPOSE_PROFILES=db: copy $file.example and fill it in)" >&2
      exit 2
    fi
  done
else
  with_database=no
fi

echo "deploy: pulling release $4"
# By digest: Docker refuses content whose digest is not the one asked for.
if ! compose --profile migrate pull migrate api web proxy || ! pull_data; then
  rm -f release.next.env
  echo "deploy: could not pull release $4; nothing changed" >&2
  exit 1
fi
if [ -n "${REGISTRY_TOKEN:-}" ]; then
  logout_registry
fi

echo "deploy: starting the data services"
# Already running and unchanged: left as they are. A new pinned image (an
# update of PostgreSQL or Redis) restarts that service here, before the
# migration.
if ! start_data; then
  rm -f release.next.env
  echo "deploy: the data services did not start; the running release keeps serving: docker compose ps, and their logs" >&2
  exit 1
fi

echo "deploy: migrating the database"
if ! compose --profile migrate run --rm migrate; then
  rm -f release.next.env
  echo "deploy: the migration failed; the running release keeps serving" >&2
  exit 1
fi

echo "deploy: rolling out"
if compose up --detach --wait --wait-timeout 180 api web proxy && api_ready; then
  # Only a release that went live moves the pointers: the one it replaces
  # becomes the rollback target of rollback.sh. Redeploying the running
  # release changes nothing, so the rollback target stays the one before it,
  # and release.redeployed tells rollback.sh so: a rollback now would start
  # that older release, not the one that was running before this deployment.
  if [ -f release.env ] && cmp -s release.env release.next.env; then
    touch release.redeployed
  else
    if [ -f release.env ]; then mv release.env release.previous.env; fi
    rm -f release.redeployed
  fi
  mv release.next.env release.env
  echo "deploy: release $4 is live"
  exit 0
fi

echo "deploy: the rollout failed; the new containers' last log lines:" >&2
compose logs --no-color --tail 60 api web >&2 || true
if [ -f release.env ]; then
  release_file=release.env
  if compose up --detach --wait --wait-timeout 180 api web proxy && api_ready; then
    echo "deploy: back to the release that was running" >&2
  else
    echo "deploy: the release that was running did not come back ready either: docker compose ps, and the API's log" >&2
  fi
fi
rm -f release.next.env
exit 1
