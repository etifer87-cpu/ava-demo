-- 0003_org_units.sql
-- Core platform. Org sub-units: operator, AOC, brand, base, department. Self-referencing, so a
-- base under a brand under an AOC is three rows and not three columns.

CREATE TABLE IF NOT EXISTS org_units (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  kind        TEXT        NOT NULL DEFAULT 'department'
                          CHECK (kind IN ('operator','aoc','brand','base','department')),
  parent_id   UUID        REFERENCES org_units(id),
  position    INT         NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT org_units_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE UNIQUE INDEX IF NOT EXISTS org_units_code_live
  ON org_units (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS org_units_parent ON org_units (parent_id);

DROP TRIGGER IF EXISTS org_units_updated_at ON org_units;
CREATE TRIGGER org_units_updated_at BEFORE UPDATE ON org_units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE org_units IS 'Organisational sub-units (operator, AOC, brand, base, department), hierarchical via parent_id; the source of the team and org permission scopes.';
