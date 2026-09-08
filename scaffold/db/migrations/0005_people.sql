-- 0005_people.sql
-- Core platform. The roster: one row per human the platform trains, assesses or reports on.
-- Subjects and assessors live in the same table because the same person is routinely both.

CREATE TABLE IF NOT EXISTS people (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id       TEXT        NOT NULL,   -- the operator's own person id; every scope check
                                            -- and every import mapping keys on this, never on id
  full_name         TEXT        NOT NULL,
  position          TEXT,
  org_unit_id       UUID        REFERENCES org_units(id),
  asset_class_id    UUID        REFERENCES asset_classes(id),  -- CURRENT class; see docs/02 Traps
  instructor_role   TEXT,                   -- highest assessor qualification held, or NULL
  is_active         BOOLEAN     NOT NULL DEFAULT true,  -- false = no longer on the roster
  joined_on         DATE,
  watch_list        BOOLEAN     NOT NULL DEFAULT false,
  concern_override  TEXT,                   -- manual concern level; wins over the derived value
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS people_external_id_live
  ON people (external_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS people_org_asset_live
  ON people (org_unit_id, asset_class_id) WHERE deleted_at IS NULL AND is_active;
CREATE INDEX IF NOT EXISTS people_watch_list ON people (watch_list) WHERE watch_list;

DROP TRIGGER IF EXISTS people_updated_at ON people;
CREATE TRIGGER people_updated_at BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS people_no_hard_delete ON people;
CREATE TRIGGER people_no_hard_delete BEFORE DELETE ON people
  FOR EACH ROW EXECUTE FUNCTION deny_hard_delete();

COMMENT ON TABLE people IS 'Roster of every person the platform trains, assesses or reports on; keyed externally by external_id, soft-delete only.';
