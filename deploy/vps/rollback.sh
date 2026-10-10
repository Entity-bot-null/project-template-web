#!/bin/sh
# Puts the release that ran before the last deployment back
# (docs/deploy-vps.md#roll-back). Its images are still on the server: no
# registry access needed. Database migrations are never reversed: the previous
# release runs on the current schema (expand and contract, docs/database.md).
#
#   ./rollback.sh
set -eu

cd "$(dirname "$0")"

if [ ! -f release.previous.env ]; then
  echo "rollback: no previous release recorded (release.previous.env)" >&2
  exit 1
fi

docker compose --env-file server.env --env-file release.previous.env \
  up --detach --wait --wait-timeout 180 api web proxy
cp release.env release.failed.env 2>/dev/null || true
cp release.previous.env release.env
echo "rollback: running $(grep '^APP_RELEASE=' release.env | cut -d= -f2)"
