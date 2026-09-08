-- 0008_user_roles.sql
-- Core platform. Role grants, optionally scoped to an org unit and optionally time-limited.

CREATE TABLE IF NOT EXISTS user_roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code    TEXT        NOT NULL REFERENCES roles(code),
  org_unit_id  UUID        REFERENCES org_units(id),   -- NULL = every org unit
  granted_by   UUID        REFERENCES users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ
);

-- A plain UNIQUE would not collide on NULL org_unit_id, so the same global grant could be
-- inserted any number of times. Collapse NULL to a sentinel in a functional index instead.
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_uniq
  ON user_roles (user_id, role_code,
                 COALESCE(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS user_roles_user ON user_roles (user_id);
CREATE INDEX IF NOT EXISTS user_roles_role ON user_roles (role_code);

COMMENT ON TABLE user_roles IS 'Grants of a role to a user, optionally narrowed to an org unit and optionally expiring; cascades from users because a grant has no meaning without its account.';
