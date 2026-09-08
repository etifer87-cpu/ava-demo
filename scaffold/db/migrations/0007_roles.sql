-- 0007_roles.sql
-- Core platform. The role catalogue, keyed by code TEXT. Roles are MODULE-SCOPED: administrative
-- rights in one module confer nothing in another. See docs/12_ROLES_AND_PERMISSIONS.md.

CREATE TABLE IF NOT EXISTS roles (
  code        TEXT PRIMARY KEY,
  name        TEXT        NOT NULL,
  module      TEXT        NOT NULL
                          CHECK (module IN ('platform','training','qms','dms','planning','integration')),
  description TEXT,
  is_system   BOOLEAN     NOT NULL DEFAULT true,
  position    INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS roles_module ON roles (module, position);

COMMENT ON TABLE roles IS 'Module-scoped role catalogue keyed by a stable text code; a role grants capabilities through role_capabilities.';
