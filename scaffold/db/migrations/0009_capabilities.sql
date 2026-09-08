-- 0009_capabilities.sql
-- Core platform. The capability catalogue: dotted keys such as training.templates.configure.
-- Adding a permission is an INSERT here plus a grant in role_capabilities. It is never a schema
-- change and never a deployment.

CREATE TABLE IF NOT EXISTS capabilities (
  code            TEXT PRIMARY KEY
                  CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'),
  module          TEXT        NOT NULL,
  resource        TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  is_scoped       BOOLEAN     NOT NULL DEFAULT false,
  -- false marks a policy hard-gate: a capability no override mechanism may ever confer.
  is_overridable  BOOLEAN     NOT NULL DEFAULT true,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capabilities_module ON capabilities (module, resource, action);

COMMENT ON TABLE capabilities IS 'Catalogue of dotted capability keys; is_overridable=false marks a policy hard-gate that only a role in the published matrix may confer.';
