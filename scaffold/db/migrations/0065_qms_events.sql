-- 0065_qms_events.sql
-- QMS: the append-only timeline for types, versions, holdings, approvals and attestations.
-- See docs/08_QMS.md section 7 and docs/17_GOVERNANCE.md section 2.

CREATE TABLE IF NOT EXISTS qms_events (
  id              BIGSERIAL PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL CHECK (kind IN (
                    -- catalogue and versions
                    'type_created','type_updated','type_retired',
                    'version_created','version_updated','version_published','version_retired',
                    -- evaluation
                    'evaluated','condition_met','condition_unmet','rules_satisfied',
                    'alert_raised','alert_cleared',
                    -- approval workflow
                    'approval_opened','approval_step_recorded','approval_granted',
                    'approval_rejected','approval_waived','approval_withdrawn',
                    -- holdings
                    'granted','renewed','superseded','suspended','reactivated',
                    'override_set','override_cleared','expiry_warning','expired',
                    -- evidence and attestations
                    'evidence_linked','evidence_unlinked',
                    'attestation_recorded','attestation_stale','attestation_revoked',
                    -- lifecycle and integration
                    'imported','synced','held','reconciled','deleted','restored')),

  qual_type_code  TEXT REFERENCES qual_types (code),
  version_id      UUID REFERENCES qual_type_versions (id),
  subject_id      UUID REFERENCES people (id),
  qualification_id UUID REFERENCES qualifications (id),
  approval_id     UUID REFERENCES qual_approvals (id),
  attestation_id  UUID REFERENCES attestations (id),

  actor_user_id   UUID REFERENCES users (id),
  actor_label     TEXT NOT NULL DEFAULT 'system',
  severity        TEXT NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('hard','soft','consent','info')),
  reason          TEXT,
  request_id      TEXT,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS qms_events_subject_idx ON qms_events (subject_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS qms_events_type_idx    ON qms_events (qual_type_code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS qms_events_kind_idx    ON qms_events (kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS qms_events_request_idx ON qms_events (request_id);

COMMENT ON TABLE  qms_events IS
  'Append-only module timeline. Read by operators in the module vocabulary; joined to audit_log by '
  'request_id for the cross-cutting who-did-what. Nothing updates or deletes a row - append-only '
  'by convention is not append-only, so UPDATE and DELETE are revoked below.';
COMMENT ON COLUMN qms_events.kind IS
  'The CHECK list is the full event vocabulary of the module and is widened by migration when a '
  'new event is introduced. An unlisted kind must fail loudly rather than be silently coerced.';
COMMENT ON COLUMN qms_events.actor_label IS
  'Resolved at write time and stored, so an entry stays readable after the actor leaves the '
  'organisation. Defaults to system for engine-raised events.';
COMMENT ON COLUMN qms_events.severity IS
  'hard blocks, soft warns and records a reason, consent blocks until a live attestation exists, '
  'info never blocks. A disabled rule is still computed and displayed as info.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON qms_events FROM tms_app';
  END IF;
END
$$;
