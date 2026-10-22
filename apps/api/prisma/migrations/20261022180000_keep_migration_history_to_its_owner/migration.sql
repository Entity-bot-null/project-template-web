-- The migration history is the migrator's alone. The runtime role gets read
-- and write rights on every table the migrator creates, through default
-- privileges (deploy/vps/db-init.sh, infra/terraform/digitalocean/database/roles.sql),
-- and Prisma creates _prisma_migrations as the migrator: the API could then
-- mark a migration as applied (the next deployment would skip it), delete
-- the history or rewrite a checksum. Every role but the table's owner loses
-- its rights on it; nothing to do where none has any (development and CI
-- connect as the owner). No schema change: the application is unaffected.
--
-- `prisma migrate dev` replays every migration on an empty shadow database,
-- which has no _prisma_migrations: there the block does nothing.
DO $$
DECLARE
  grantee regrole;
BEGIN
  IF to_regclass('"_prisma_migrations"') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE "_prisma_migrations" FROM PUBLIC';
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = to_regclass('"_prisma_migrations"')
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE "_prisma_migrations" FROM %s', grantee);
  END LOOP;
END
$$;
