-- 0064_attestations.sql
-- QMS: named human agreements that gate an action, with staleness against an attested figure.
-- See docs/08_QMS.md section 7 and docs/10_INTEGRATION.md section 3.8 (severity 'consent').

CREATE TABLE IF NOT EXISTS attestations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id        UUID NOT NULL REFERENCES people (id) ON DELETE RESTRICT,
  attestation_key   TEXT NOT NULL CHECK (attestation_key ~ '^[a-z0-9_.]{2,80}$'),
  scope_kind        TEXT NOT NULL DEFAULT 'subject'
                      CHECK (scope_kind IN ('subject','org_unit','asset_class','global')),
  scope_id          UUID,

  statement         TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  attested_figure   NUMERIC,
  figure_unit       TEXT,

  attested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attested_by       UUID NOT NULL REFERENCES users (id),
  capability_used   TEXT,
  reauthenticated   BOOLEAN NOT NULL DEFAULT FALSE,
  valid_until       DATE,

  is_stale          BOOLEAN NOT NULL DEFAULT FALSE,
  stale_at          TIMESTAMPTZ,
  stale_reason      TEXT,
  observed_figure   NUMERIC,

  revoked_at        TIMESTAMPTZ,
  revoked_by        UUID REFERENCES users (id),
  revoke_reason     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,

  CONSTRAINT attestations_stale_complete
    CHECK (NOT is_stale OR (stale_at IS NOT NULL AND stale_reason IS NOT NULL)),
  CONSTRAINT attestations_revoked_complete
    CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT attestations_figure_unit
    CHECK (attested_figure IS NULL OR figure_unit IS NOT NULL)
);

-- One live attestation per subject per key. Live means not stale, not revoked, not deleted.
-- Re-attesting supersedes by marking the previous row stale in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS attestations_one_live_uk
  ON attestations (subject_id, attestation_key)
  WHERE is_stale = FALSE AND revoked_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS attestations_key_idx
  ON attestations (attestation_key, subject_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE  attestations IS
  'A named human agreement that blocks an action until it exists - the consent severity, which is '
  'neither soft (publishing past it silently would be wrong) nor hard (it is permitted with '
  'agreement). Referenced by the attestation_present condition type and by publish gates.';
COMMENT ON COLUMN attestations.attested_figure IS
  'The figure the attester agreed to, if any, with its unit. If a later change pushes the observed '
  'figure above it, the attestation goes stale and blocks again until re-attested. Attesting at '
  'one figure must never silently authorise a higher one.';
COMMENT ON COLUMN attestations.is_stale IS
  'Set by the recomputation that detected the drift, with a reason and the observed figure. A '
  'stale attestation is retained, never edited: it is evidence of what was agreed and when.';
COMMENT ON COLUMN attestations.scope_kind IS
  'subject | org_unit | asset_class | global. subject_id is always populated for the addressee; '
  'scope_id carries the wider scope where one applies.';
