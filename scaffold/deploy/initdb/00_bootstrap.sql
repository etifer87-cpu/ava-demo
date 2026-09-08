-- First-boot bootstrap. Runs ONCE, on an empty data volume, before any migration.
--
-- Extensions and the schema-owning role ONLY. Application schema belongs in
-- scaffold/db/migrations/, run by scripts/migrate.mjs. Anything defined here exists on a
-- fresh volume and nowhere else, so a table created here is a table that silently does not
-- exist on every environment that was created before it was added.
--
-- Idempotent throughout: this file is also safe to run by hand against an existing cluster.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- The role that owns the application schema. Migrations run as this role: the cluster
-- superuser cannot ALTER objects owned by it, and discovering that mid-deploy is expensive.
-- The password is set by the deploy, never here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ava_owner') THEN
    CREATE ROLE ava_owner LOGIN;
  END IF;
END
$$;

ALTER SCHEMA public OWNER TO ava_owner;
GRANT ALL ON SCHEMA public TO ava_owner;

-- Fail fast rather than hang, and make every server-side notice visible to the migration
-- runner (a runner that does not subscribe to notice events drops every RAISE NOTICE).
ALTER DATABASE CURRENT_DATABASE SET client_min_messages TO notice;
