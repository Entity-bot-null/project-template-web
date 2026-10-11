#!/bin/sh
# Puts the release that ran before the last deployment back
# (docs/deploy-vps.md#roll-back). Its images are still on the server: no
# registry access needed. Database migrations are never reversed: the previous
# release runs on the current schema (expand and contract, docs/database.md).
# Like deploy.sh, it waits until the API is ready, and stops at once while a
# deployment or another rollback is running.
#
#   ./rollback.sh
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

compose() {
  docker compose --env-file server.env --env-file release.previous.env "$@"
}

compose up --detach --wait --wait-timeout 180 api web proxy
cp release.env release.failed.env 2>/dev/null || true
cp release.previous.env release.env
release=$(grep '^APP_RELEASE=' release.env | cut -d= -f2)
# Healthy containers only mean the processes answer; ready means the API
# reaches its database (a rollback after a credential change may not).
if ! compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/health/ready', { signal: AbortSignal.timeout(10000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
  echo "rollback: release $release is running, but its API is not ready: docker compose ps, and the API's log" >&2
  exit 1
fi
echo "rollback: running $release"
