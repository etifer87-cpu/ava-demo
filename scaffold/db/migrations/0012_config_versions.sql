-- 0012_config_versions.sql
-- Core platform. Where scaffold/config/*.yaml lands at boot.
-- No threshold, band boundary or weight is ever a table default, a CHECK or a constant in code.
-- Retuning is a new row here plus an activation, not a migration and not a redeploy.

CREATE TABLE IF NOT EXISTS config_versions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,   -- analytics | policy | grading | ingestion
  version    TEXT        NOT NULL,
  checksum   TEXT        NOT NULL,   -- of the source file, so drift between file and row is visible
  payload    JSONB       NOT NULL,
  loaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  loaded_by  UUID        REFERENCES users(id),
  is_active  BOOLEAN     NOT NULL DEFAULT false,
  notes      TEXT,
  UNIQUE (name, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS config_versions_one_active
  ON config_versions (name) WHERE is_active;


COMMENT ON TABLE config_versions IS 'Versioned, checksummed policy and analytics configuration loaded from scaffold/config; every analysis run records the config version it was computed under.';
