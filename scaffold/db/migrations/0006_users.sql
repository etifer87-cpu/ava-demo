-- 0006_users.sql
-- Core platform. Login only. No profile fields: those belong to people.
-- users.is_active and people.is_active are deliberately independent - leaving the organisation and
-- losing a login are different events, and they happen in either order.

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             UUID        REFERENCES people(id),  -- NULL for a break-glass account
  username              CITEXT      NOT NULL,
  email                 CITEXT,
  password_hash         TEXT        NOT NULL,   -- bcrypt; cost from app_settings, never below 12
  must_change_password  BOOLEAN     NOT NULL DEFAULT true,
  is_active             BOOLEAN     NOT NULL DEFAULT true,  -- disables login only
  last_login_at         TIMESTAMPTZ,
  failed_login_count    INT         NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_live
  ON users (username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_live
  ON users (email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_person_live
  ON users (person_id) WHERE deleted_at IS NULL AND person_id IS NOT NULL;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No deny_hard_delete trigger here, deliberately: purging login credentials is a legitimate
-- erasure operation that is distinct from purging the roster row, and user_roles cascades from
-- this table. The roster row in people is the one that must never be hard-deleted.

COMMENT ON TABLE users IS 'Login accounts, one per person at most; carries no profile data and no authorisation state beyond its role grants.';
