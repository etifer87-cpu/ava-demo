-- 0004_asset_classes.sql
-- Core platform. The aircraft type / type-class / simulator class a person and a session are
-- bucketed by. A table, never an enum: a new class is an INSERT, and an enum value cannot be
-- retired once any row uses it.

CREATE TABLE IF NOT EXISTS asset_classes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  category     TEXT        NOT NULL DEFAULT 'aircraft'
                           CHECK (category IN ('aircraft','simulator','other')),
  org_unit_id  UUID        REFERENCES org_units(id),
  position     INT         NOT NULL DEFAULT 0,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_classes_code_live
  ON asset_classes (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS asset_classes_org_unit ON asset_classes (org_unit_id);

DROP TRIGGER IF EXISTS asset_classes_updated_at ON asset_classes;
CREATE TRIGGER asset_classes_updated_at BEFORE UPDATE ON asset_classes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE asset_classes IS 'Aircraft types, type-classes and simulator classes; sessions and records freeze a copy of the class so historical grades do not follow a person to a new type.';
