#!/bin/sh
# The nightly backup of the database `app`, when this server runs it
# (compose.yaml, service backup; docs/deploy-vps.md#backups): pg_dump as
# app_backup, a read-only role, in PostgreSQL's custom format (compressed,
# restored with pg_restore), kept BACKUP_KEEP_DAYS days on the volume
# db_backups. The connection comes from PGHOST, PGUSER, PGDATABASE and
# PGPASSWORD (backup.env), never a command line.
#
#   backup.sh        runs for ever: one now when the newest is over a day old,
#                    then one every day at BACKUP_AT (UTC)
#   backup.sh now    one backup, at once (before an upgrade, a rehearsal)
#
# These copies live on the server: they protect from a mistake, not from
# losing the server. Copy them elsewhere too (REQUIERE CONFIGURACIÓN,
# docs/disaster-recovery.md).
set -eu

dir=${BACKUP_DIR:-/var/lib/postgresql/backups}
keep_days=${BACKUP_KEEP_DAYS:-7}
at=${BACKUP_AT:-03:00}
: "${PGPASSWORD:?set PGPASSWORD in backup.env (the password of app_backup)}"
case "$keep_days" in '' | *[!0-9]* | 0) echo "backup: BACKUP_KEEP_DAYS must be a number of days, 1 or more" >&2; exit 1 ;; esac
case "$at" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "backup: BACKUP_AT must be HH:MM (UTC)" >&2; exit 1 ;; esac

umask 077
mkdir -p "$dir"

backup() {
  name="app-$(date -u +%Y%m%dT%H%M%SZ).dump"
  partial="$dir/.$name.partial"
  if ! pg_dump --format=custom --no-owner --no-privileges --file="$partial"; then
    rm -f "$partial"
    echo "backup: pg_dump failed; the earlier backups are kept" >&2
    return 1
  fi
  # Renamed only once complete: a dump in the list is a whole one.
  mv "$partial" "$dir/$name"
  echo "backup: wrote $name ($(du -k "$dir/$name" | cut -f1) kB)"
  # Older than BACKUP_KEEP_DAYS days. Never the last one, whatever its age.
  find "$dir" -name 'app-*.dump' -type f -mtime +"$((keep_days - 1))" ! -name "$name" -print -delete |
    sed 's|^.*/|backup: deleted |'
}

if [ "${1:-}" = now ]; then
  # Interrupted: a failure, and no partial dump left behind.
  trap 'rm -f "${partial:-}"; exit 1' TERM INT
  backup
  exit
fi

# As the container's first process, sh would ignore docker stop's SIGTERM:
# stop at once instead, also in the middle of a sleep.
trap 'rm -f "${partial:-}"; exit 0' TERM INT

# A dump cut short (the container killed during one) is never a backup. Only
# here, when the service starts: `backup.sh now` may run beside a nightly one.
rm -f "$dir"/.app-*.partial

# A server that just started (a first deployment, a reboot) gets its backup
# now when the newest one is over a day old.
if [ -z "$(find "$dir" -name 'app-*.dump' -type f -mmin -1440 2>/dev/null)" ]; then
  backup || true
fi
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$at" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  sleep "$((next - now))" &
  wait "$!"
  backup || true
done
