-- 0062_qualifications.sql
-- QMS: per-subject holdings. Effective status is derived on read, never stored.
-- See docs/08_QMS.md sections 2 and 6.

CREATE TABLE IF NOT EXISTS qualifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id            UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
  qual_type_code        TEXT NOT NULL REFERENCES qual_types (code) ON DELETE RESTRICT,
  qual_type_version_id  UUID REFERENCES qual_type_versions (id),
  approval_id           UUID,
  org_unit_id           UUID REFERENCES org_units (id),
  asset_class_id        UUID REFERENCES asset_classes (id),
  parent_qualification_id UUID REFERENCES qualifications (id),

  valid_from            DATE,
  valid_until           DATE,
  anchor_date           DATE,
  granted_at            TIMESTAMPTZ,
  granted_by            UUID REFERENCES users (id),

  status_override       TEXT
                          CHECK (status_override IN ('suspended','inactive')),
  override_reason       TEXT,
  override_set_at       TIMESTAMPTZ,
  override_set_by       UUID REFERENCES users (id),

  evidence              JSONB NOT NULL DEFAULT '[]'::jsonb,
  source                TEXT NOT NULL DEFAULT 'app'
                          CHECK (source IN ('app','import','ingest','external')),
  external_ref_id       UUID,
  notes                 TEXT,

  superseded_at         TIMESTAMPTZ,
  superseded_by_id      UUID REFERENCES qualifications (id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES users (id),
  deleted_at            TIMESTAMPTZ,

  CONSTRAINT qualifications_validity_order
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CONSTRAINT qualifications_override_reason
    CHECK (status_override IS NULL OR override_reason IS NOT NULL),
  CONSTRAINT qualifications_no_self_parent
    CHECK (parent_qualification_id IS NULL OR parent_qualification_id <> id),
  CONSTRAINT qualifications_granted_by_human
    CHECK (granted_at IS NULL OR granted_by IS NOT NULL OR source <> 'app')
);

-- One live holding per subject per type. A renewal supersedes; it does not add a second live row.
CREATE UNIQUE INDEX IF NOT EXISTS qualifications_live_uk
  ON qualifications (subject_id, qual_type_code)
  WHERE deleted_at IS NULL AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS qualifications_subject_idx
  ON qualifications (subject_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS qualifications_expiry_idx
  ON qualifications (valid_until)
  WHERE deleted_at IS NULL AND superseded_at IS NULL AND status_override IS NULL;

COMMENT ON TABLE  qualifications IS
  'Per-subject qualification holdings. There is no status column: effective status is derived on '
  'read from valid_until, the type version windows and status_override, so nothing goes stale '
  'because a nightly job failed. Instructor authorities live here too - an authority is a '
  'qualification with an expiry, not a role.';
COMMENT ON COLUMN qualifications.qual_type_version_id IS
  'The definition version this holding was granted under. Pinned, so publishing a newer version '
  'never retroactively invalidates a compliant grant. Migration to a new version happens at renewal.';
COMMENT ON COLUMN qualifications.approval_id IS
  'The qual_approvals row that authorised this grant. A holding with no approval is a defect: '
  'qualifications are never auto-granted.';
COMMENT ON COLUMN qualifications.anchor_date IS
  'The date the validity window was computed from - the last condition met, the approval, the '
  'earliest evidence, or a fixed date, per the definition. Stored so an expiry can be explained '
  'years later without re-running the engine.';
COMMENT ON COLUMN qualifications.status_override IS
  'Manual only: suspended (a fail, not-completed or no-show outcome, or a management decision) or '
  'inactive (not currently required of this subject). Wins over every derived status. Requires a '
  'reason.';
COMMENT ON COLUMN qualifications.evidence IS
  'Immutable pointers to what supported the grant: record ids, document ids, condition keys and '
  'their met_at dates. Pointers only - the evidence itself stays in ETR and DMS.';
COMMENT ON COLUMN qualifications.source IS
  'app | import | ingest | external. Manual and imported rows are never overwritten by a later '
  'sync; conflicts go to reconciliation.';
