-- 0024_sessions.sql
-- ETR. One graded training event: one to four assessed subjects, one or two assessors.
-- This is the EDITING surface. Analytics read records, not this table.

CREATE TABLE IF NOT EXISTS sessions (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No ON DELETE CASCADE, deliberately: a template version with sessions must not be removable,
  -- and the correct action is a soft delete anyway.
  template_version_id        UUID        NOT NULL REFERENCES session_template_versions(id),
  framework_id               UUID,       -- copied at creation; FK added in 0042
  org_unit_id                UUID        REFERENCES org_units(id),
  asset_class_id             UUID        REFERENCES asset_classes(id),  -- FROZEN copy, see traps
  session_date               DATE        NOT NULL,
  facility                   TEXT,
  facility_kind              TEXT        CHECK (facility_kind IN ('ffs','ftd','classroom','aircraft','line','other')),
  assessor_person_id         UUID        REFERENCES people(id),
  second_assessor_person_id  UUID        REFERENCES people(id),
  status                     TEXT        NOT NULL DEFAULT 'in_progress'
                             CHECK (status IN ('in_progress','submitted','signed','finalized','void')),
  outcome                    TEXT,       -- assessor-entered
  computed_outcome           TEXT,       -- derived from the grades by the deterministic core;
                                         -- kept beside outcome so a disagreement is visible
  remarks                    TEXT,
  setup                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  assessor_signed_at         TIMESTAMPTZ,
  assessor_signer_id         UUID        REFERENCES users(id),
  created_by                 UUID        REFERENCES users(id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                 TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_date       ON sessions (session_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_assessor   ON sessions (assessor_person_id, session_date DESC);
CREATE INDEX IF NOT EXISTS sessions_template   ON sessions (template_version_id);
CREATE INDEX IF NOT EXISTS sessions_open       ON sessions (status) WHERE status <> 'finalized';

DROP TRIGGER IF EXISTS sessions_updated_at ON sessions;
CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS sessions_no_hard_delete ON sessions;
CREATE TRIGGER sessions_no_hard_delete BEFORE DELETE ON sessions
  FOR EACH ROW EXECUTE FUNCTION deny_hard_delete();

COMMENT ON TABLE sessions IS 'A graded training event while it is being conducted and graded; freezes into records at finalise.';
