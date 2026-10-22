-- The database roles of docs/deploy-vps.md section 5, for the Terraform path.
-- A psql script, run by `pnpm iac:database` (scripts/iac-database.mjs) on the
-- server, as the cluster's administrator (doadmin), connected to its default
-- database. Checked against PostgreSQL by `pnpm iac:check`.
--
-- The passwords arrive as the psql variables migrator_password and
-- runtime_password, holding SCRAM-SHA-256 verifiers computed on the operator's
-- machine: no password in clear reaches the server, its logs or a process
-- list. Running it again changes nothing but the passwords, which it sets to
-- Terraform's again (after a rotation, docs/deploy-vps.md).

\set ON_ERROR_STOP on

-- The migrator owns the database and its schema; only the migration job uses it.
SELECT 'CREATE ROLE app_migrator'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_migrator') \gexec
ALTER ROLE app_migrator WITH LOGIN PASSWORD :'migrator_password';

-- The API's role: reads and writes data, never changes the schema. The limit
-- covers every API instance together (docs/disaster-recovery.md#backup-strategy).
SELECT 'CREATE ROLE app_runtime'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') \gexec
ALTER ROLE app_runtime WITH LOGIN CONNECTION LIMIT 50 PASSWORD :'runtime_password';

-- Since PostgreSQL 16, an administrator that is not a superuser (doadmin is
-- not) may give a database to a role, or act as it, only as a member of it.
GRANT app_migrator TO CURRENT_USER;

SELECT 'CREATE DATABASE app OWNER app_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'app') \gexec

-- The runtime role's rights, given by the owner, as the guide does connected
-- as app_migrator: tables and sequences the migrator creates later get them
-- too. Never the migration history: run again after the migrations, the
-- grant on every table would give it back, so it is taken back here (a
-- migration does so at the first deployment, apps/api/prisma/migrations).
\connect app
SET ROLE app_migrator;
GRANT CONNECT ON DATABASE app TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
SELECT 'REVOKE ALL ON TABLE public._prisma_migrations FROM app_runtime'
WHERE to_regclass('public._prisma_migrations') IS NOT NULL \gexec
RESET ROLE;
