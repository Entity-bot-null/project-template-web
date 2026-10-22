#!/bin/sh
# Puts the release that ran before the last deployment back
# (docs/deploy-vps.md#roll-back). Its images are still on the server: no
# registry access needed. Database migrations are never reversed: the previous
# release runs on the current schema (expand and contract, docs/database.md).
# Like deploy.sh, it starts the data services first (or leaves them running),
# waits until the API is ready, and stops at once while a deployment or
# another rollback is running.
#
# When the last successful deployment redeployed the release that was already
# running, nothing ran before it but that same release: it refuses (exit 2) rather than
# start the older release recorded before it. --previous starts that one
# anyway.
#
#   ./rollback.sh [--previous]
set -eu

cd "$(dirname "$0")"

if [ ! -f release.previous.env ]; then
  echo "rollback: no previous release recorded (release.previous.env)" >&2
  exit 1
fi

# The lock of deploy.sh: never two of them at once on this server.
exec 9> .deploy.lock
if ! flock -n 9; then
  echo "rollback: another deployment or rollback is running on this server; run this again once it has finished" >&2
  exit 1
fi

# Read under the lock: a deployment running meanwhile may change it.
if [ -f release.redeployed ] && [ "${1:-}" != "--previous" ]; then
  running=$(grep '^APP_RELEASE=' release.env | cut -d= -f2)
  previous=$(grep '^APP_RELEASE=' release.previous.env | cut -d= -f2)
  echo "rollback: the last successful deployment redeployed release $running, which was already running: there is no earlier deployment of it to go back to. ./rollback.sh --previous starts release $previous, the one before it." >&2
  exit 2
fi

compose() {
  docker compose --env-file server.env --env-file release.previous.env "$@"
}

# The data services, as deploy.sh leaves them: Redis, and PostgreSQL with its
# nightly backup when this server runs the database. Running ones stay as
# they are; a stopped one starts before the release that needs it.
start_data() {
  if compose config --services | grep -qx db; then
    compose up --detach --wait --wait-timeout 180 redis db && compose up --detach backup
  else
    compose up --detach --wait --wait-timeout 180 redis
  fi
}

if ! start_data; then
  echo "rollback: the data services did not start: docker compose ps, and their logs" >&2
  exit 1
fi
compose up --detach --wait --wait-timeout 180 api web proxy
cp release.env release.failed.env 2>/dev/null || true
cp release.previous.env release.env
rm -f release.redeployed
release=$(grep '^APP_RELEASE=' release.env | cut -d= -f2)
# Healthy containers only mean the processes answer; ready means the API
# reaches its database (a rollback after a credential change may not).
if ! compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/health/ready', { signal: AbortSignal.timeout(10000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
  echo "rollback: release $release is running, but its API is not ready: docker compose ps, and the API's log" >&2
  exit 1
fi
echo "rollback: running $release"
