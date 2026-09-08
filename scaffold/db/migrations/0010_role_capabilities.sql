-- 0010_role_capabilities.sql
-- Core platform. Which role holds which capability, at which scope.
-- A role may hold the same capability at two scopes. The resolver unions the member sets of ALL
-- held scopes; it never collapses to the widest, because 'assigned' and 'team' are not nested and
-- a collapse silently removes access.

CREATE TABLE IF NOT EXISTS role_capabilities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code        TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  capability_code  TEXT NOT NULL REFERENCES capabilities(code) ON DELETE CASCADE,
  scope            TEXT NOT NULL DEFAULT 'own'
                        CHECK (scope IN ('own','assigned','team','org','all')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role_code, capability_code, scope)
);

CREATE INDEX IF NOT EXISTS role_capabilities_role ON role_capabilities (role_code);

COMMENT ON TABLE role_capabilities IS 'Role to capability grants with a scope; the whole permission model is rows in this table and capabilities.';
