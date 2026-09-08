-- 0120_external_refs.sql
-- Integration: the identity bridge between a counterparty's ids and local rows.
-- See docs/10_INTEGRATION.md section 2.

CREATE TABLE IF NOT EXISTS external_refs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  system          TEXT NOT NULL CHECK (system ~ '^[a-z0-9_]{2,40}$'),
  entity_kind     TEXT NOT NULL CHECK (entity_kind IN (
                    'person','user','course','completion','record','session',
                    'document','qualification','duty','sector','org_unit','asset_class','other')),
  external_id     TEXT NOT NULL,
  natural_key     TEXT,

  local_table     TEXT,
  local_id        TEXT,

  payload_hash    TEXT CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  match_method    TEXT NOT NULL DEFAULT 'external_id'
                    CHECK (match_method IN ('external_id','natural_key','manual','unmatched')),
  match_confirmed_by UUID REFERENCES users (id),
  match_confirmed_at TIMESTAMPTZ,

  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_run_id UUID,
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT external_refs_manual_match_attributed
    CHECK (match_method <> 'manual'
           OR (match_confirmed_by IS NOT NULL AND match_confirmed_at IS NOT NULL)),
  CONSTRAINT external_refs_unmatched_has_no_local
    CHECK (match_method <> 'unmatched' OR local_id IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS external_refs_identity_uk
  ON external_refs (system, entity_kind, external_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS external_refs_local_idx
  ON external_refs (local_table, local_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS external_refs_unmatched_idx
  ON external_refs (system, first_seen_at)
  WHERE match_method = 'unmatched' AND deleted_at IS NULL;

COMMENT ON TABLE  external_refs IS
  'Maps a counterparty identifier to a local row. Every inbound record resolves through it and '
  'nothing matches on a display name at write time: two people with one name merge, one person '
  'with a changed name splits, and grades land on the wrong subject. Unmatched rows are held and '
  'reported, never guessed.';
COMMENT ON COLUMN external_refs.system IS
  'A configured counterparty code, not an enum and never a vendor name in the schema. Counterparties '
  'are described by role: the LMS, the crew-scheduling system, the identity provider, the BI tool.';
COMMENT ON COLUMN external_refs.payload_hash IS
  'Hash of the last payload seen for this identity. An unchanged hash lets a feed skip work without '
  'assuming its own cursor was correct.';
COMMENT ON COLUMN external_refs.match_method IS
  'external_id | natural_key | manual | unmatched. A manual match records who confirmed it, because '
  'a human identity decision is exactly the kind of thing an audit asks about.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qualifications_external_ref_fk') THEN
    ALTER TABLE qualifications
      ADD CONSTRAINT qualifications_external_ref_fk
      FOREIGN KEY (external_ref_id) REFERENCES external_refs (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_external_ref_fk') THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_external_ref_fk
      FOREIGN KEY (external_ref_id) REFERENCES external_refs (id);
  END IF;
END
$$;
