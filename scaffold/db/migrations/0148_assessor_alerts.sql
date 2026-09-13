-- 0148_assessor_alerts.sql
-- Decisions on instructor standardisation alerts. docs/06_ANALYTICS.md §13.3, chart 41.
--
-- WHAT IS STORED AND WHAT IS NOT. The NOMINATION is derived, never stored: an alert is whatever the
-- current records satisfy the rule for, computed on read from the materialised grade corpus. Only
-- the HUMAN DECISION lands in this table. That way a record amended after review stops raising its
-- alert without anyone cleaning up a queue, and a rule whose threshold changes in analytics.yaml
-- re-nominates correctly rather than leaving a table full of alerts that no longer follow from the
-- rule that produced them. An alert with no row here is open, by definition.
--
-- A DECISION REQUIRES A NOTE. Enforced twice: by the route and by the CHECK below. "Dismissed" with
-- no reason is indistinguishable from an alert nobody looked at, and the difference is the whole
-- value of the queue in a standardisation conversation six months later.
--
-- `masking` is in the enum and is not raised by this build: docs/06 §13.3 requires the model layer
-- to decide it, and a keyword rule alone must never cap an instructor's band. The column exists so
-- that when the AI pipeline runs, its decisions land in the same place as the deterministic ones.

CREATE TABLE IF NOT EXISTS assessor_remark_audit (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessor_person_id  UUID NOT NULL REFERENCES people(id),
  record_id           UUID NOT NULL REFERENCES records(id),
  -- Null for a record-level alert (halo, outcome mismatch); set for a grade-level one.
  competency_id       UUID REFERENCES competencies(id),
  alert_type          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  reviewer_note       TEXT,
  decided_by          UUID REFERENCES users(id),
  decided_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT assessor_remark_audit_type_known
    CHECK (alert_type IN ('unjustified_low', 'halo_record', 'outcome_mismatch', 'masking')),
  CONSTRAINT assessor_remark_audit_status_known
    CHECK (status IN ('open', 'dismissed', 'confirmed')),
  CONSTRAINT assessor_remark_audit_decision_needs_note
    CHECK (status = 'open'
           OR (reviewer_note IS NOT NULL AND btrim(reviewer_note) <> '' AND decided_at IS NOT NULL))
);

-- One decision per alert. The COALESCE gives record-level alerts a stable key without a second index.
CREATE UNIQUE INDEX IF NOT EXISTS assessor_remark_audit_alert
  ON assessor_remark_audit (record_id, COALESCE(competency_id, '00000000-0000-0000-0000-000000000000'::UUID), alert_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assessor_remark_audit_assessor ON assessor_remark_audit (assessor_person_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE assessor_remark_audit IS
  'Human decisions on instructor standardisation alerts. Nominations are derived on read from the '
  'materialised grade corpus and are NOT stored; a row here is a decision, and an alert with no row '
  'is open. A decision requires a reviewer note, enforced by assessor_remark_audit_decision_needs_note '
  'as well as by the route, and writes an audit_log row.';
COMMENT ON COLUMN assessor_remark_audit.competency_id IS
  'Null for a record-level alert (halo, outcome mismatch); the competency for a grade-level one.';

DROP TRIGGER IF EXISTS assessor_remark_audit_touch ON assessor_remark_audit;
CREATE TRIGGER assessor_remark_audit_touch BEFORE UPDATE ON assessor_remark_audit
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN RAISE NOTICE '0148: assessor_remark_audit added (decisions only; nominations stay derived).'; END $$;
