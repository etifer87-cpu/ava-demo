-- 0001_extensions.sql
-- Core platform. Extensions only; nothing that is not used by a later migration belongs here.
-- Forward-only. Run by scripts/migrate.mjs inside a transaction.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive username / email uniqueness

DO $$ BEGIN
  RAISE NOTICE 'extensions ready: pgcrypto, citext';
END $$;
