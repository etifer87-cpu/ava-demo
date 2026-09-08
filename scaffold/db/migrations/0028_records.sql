-- 0028_records.sql
-- ETR. The frozen, signed output: one row per assessed subject per session, and the SAME row shape
-- for anything imported or ingested.
--
-- source IN ('app','import','ingest') is the whole point of this table. The predecessor kept
-- in-app grades in one set of tables and ingested-document grades in another; every aggregate that
-- read one source silently reported zeros for the other, and an entire import was invisible on the
-- dashboard. Here there is one table to read, and source is a grouping, not a filter.

CREATE TABLE IF NOT EXISTS records (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              UUID        REFERENCES sessions(id),   -- NULL for import and ingest
  person_id               UUID        NOT NULL REFERENCES people(id),
  source                  TEXT        NOT NULL CHECK (source IN ('app','import','ingest')),
  record_kind             TEXT,       -- a label, not an enum
  title                   TEXT        NOT NULL,
  template_version_id     UUID        REFERENCES session_template_versions(id),
  framework_id            UUID,       -- FK added in 0042
  org_unit_id             UUID        REFERENCES org_units(id),
  asset_class_id          UUID        REFERENCES asset_classes(id),  -- frozen at the event
  training_date           DATE        NOT NULL,
  assessor_person_id      UUID        REFERENCES people(id),
  assessor_label          TEXT,       -- the raw assessor string from an imported document
  outcome                 TEXT,
  outcome_override        TEXT,       -- an administrative correction; the original is never lost
  remarks                 TEXT,
  is_hidden_from_subject  BOOLEAN     NOT NULL DEFAULT false,
  document_id             UUID,       -- the DMS document; FK added by the 0080 range
  -- Everything the report needs, as it was: competency names, OB texts, element titles, template
  -- name and version, config version, computed figures. A record must still render correctly after
  -- its template is retired and its competency names re-worded.
  snapshot                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  external_ref            TEXT,
  ingested_at             TIMESTAMPTZ,
  created_by              UUID        REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS records_person_date
  ON records (person_id, training_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS records_source_date  ON records (source, training_date DESC);
CREATE INDEX IF NOT EXISTS records_framework    ON records (framework_id);
CREATE INDEX IF NOT EXISTS records_assessor     ON records (assessor_person_id, training_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS records_external_uniq
  ON records (person_id, external_ref) WHERE external_ref IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS records_session_person_uniq
  ON records (session_id, person_id) WHERE session_id IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS records_updated_at ON records;
CREATE TRIGGER records_updated_at BEFORE UPDATE ON records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS records_no_hard_delete ON records;
CREATE TRIGGER records_no_hard_delete BEFORE DELETE ON records
  FOR EACH ROW EXECUTE FUNCTION deny_hard_delete();

COMMENT ON TABLE records IS 'The frozen output of a training event: one row per assessed subject, for app-produced, imported and ingested records alike, with a snapshot that keeps it renderable forever.';
