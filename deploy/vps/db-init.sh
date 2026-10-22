#!/bin/sh
# Runs once, the first time the database's volume is empty: the PostgreSQL
# image runs /docker-entrypoint-initdb.d/* as the superuser after initdb
# (compose.yaml, service db). Creates the database `app` and its roles, the
# same ones a managed database gets by hand (docs/deploy-vps.md#5-the-database)
# or from Terraform (infra/terraform/digitalocean/database/roles.sql):
#
#   app_migrator  owns the database and its schema; the migration job only
#   app_runtime   reads and writes data, never changes the schema; the API
#   app_backup    reads everything, writes nothing; the nightly backup
#
# Their passwords come from db.env. They reach psql as variables on its
# standard input, never on a command line. Running it on a volume that already
# has a database is impossible: the image skips this directory then. A
# password changed later is changed in PostgreSQL too
# (docs/deploy-vps.md#change-a-setting-or-a-secret).
set -eu

# Generated (openssl rand -hex 24): long, and nothing psql must escape.
check() {
  if ! printf '%s' "$2" | grep -Eq '^[A-Za-z0-9._~-]{24,}$'; then
    echo "db-init: $1 in db.env must be 24 or more letters and digits (openssl rand -hex 24)" >&2
    exit 1
  fi
}
check APP_MIGRATOR_PASSWORD "${APP_MIGRATOR_PASSWORD:-}"
check APP_RUNTIME_PASSWORD "${APP_RUNTIME_PASSWORD:-}"
check APP_BACKUP_PASSWORD "${APP_BACKUP_PASSWORD:-}"

{
  printf '\\set migrator_password %s\n' "$APP_MIGRATOR_PASSWORD"
  printf '\\set runtime_password %s\n' "$APP_RUNTIME_PASSWORD"
  printf '\\set backup_password %s\n' "$APP_BACKUP_PASSWORD"
  cat <<'SQL'
\set ON_ERROR_STOP on

CREATE ROLE app_migrator LOGIN PASSWORD :'migrator_password';
-- The limit covers every API instance together
-- (docs/disaster-recovery.md#backup-strategy).
CREATE ROLE app_runtime LOGIN CONNECTION LIMIT 50 PASSWORD :'runtime_password';
-- pg_read_all_data: SELECT on every table and USAGE on every schema, now and
-- later; nothing else.
CREATE ROLE app_backup LOGIN CONNECTION LIMIT 2 PASSWORD :'backup_password' IN ROLE pg_read_all_data;
CREATE DATABASE app OWNER app_migrator;

-- The runtime role's rights, given by the owner: tables and sequences the
-- migrator creates later get them too (the migration history excepted: a
-- migration takes them back from it, apps/api/prisma/migrations).
\connect app
SET ROLE app_migrator;
GRANT CONNECT ON DATABASE app TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
RESET ROLE;
GRANT CONNECT ON DATABASE app TO app_backup;
SQL
} | psql --no-psqlrc --quiet --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"

echo "db-init: created the database app and the roles app_migrator, app_runtime and app_backup"
