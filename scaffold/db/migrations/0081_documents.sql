-- 0081_documents.sql
-- DMS: the document row. Metadata and a relative storage key; the bytes live on the storage root.
-- See docs/09_DMS.md sections 3 to 7.

CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind        TEXT NOT NULL CHECK (owner_kind IN ('subject','library')),
  subject_id        UUID REFERENCES people (id) ON DELETE RESTRICT,
  org_unit_id       UUID REFERENCES org_units (id),
  folder_id         UUID NOT NULL REFERENCES doc_folders (id),

  doc_type          TEXT NOT NULL,
  record_class      TEXT NOT NULL CHECK (record_class IN (
                      'training','competency','medical','licence','certificate',
                      'report','correspondence','submission','other')),
  title             TEXT NOT NULL,
  qual_type_code    TEXT REFERENCES qual_types (code),
  record_id         UUID,

  issuing_authority TEXT,
  certificate_number TEXT,
  issued_on         DATE,
  event_date        DATE,
  valid_from        DATE,
  valid_until       DATE,
  limitations       TEXT,

  file_name         TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  mime_type         TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size         BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  checksum_sha256   TEXT CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  version_no        INTEGER NOT NULL DEFAULT 1 CHECK (version_no >= 1),

  review_state      TEXT NOT NULL DEFAULT 'draft'
                      CHECK (review_state IN ('draft','pending','approved','rejected','superseded')),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       UUID REFERENCES users (id),
  reject_reason     TEXT,

  -- Paired status and count. The invariant is enforced by a deferrable constraint trigger in
  -- 0086_dms_status_count.sql, in both directions. See docs/09_DMS.md section 8.
  finding_state     TEXT NOT NULL DEFAULT 'clear' CHECK (finding_state IN ('clear','open')),
  open_finding_count INTEGER NOT NULL DEFAULT 0 CHECK (open_finding_count >= 0),

  is_restricted     BOOLEAN NOT NULL DEFAULT FALSE,
  legal_hold_at     TIMESTAMPTZ,
  legal_hold_by     UUID REFERENCES users (id),
  legal_hold_reason TEXT,

  retention_rule_id UUID,
  retain_until      DATE,

  source            TEXT NOT NULL DEFAULT 'app'
                      CHECK (source IN ('app','import','ingest','external')),
  external_ref_id   UUID,
  is_ocr            BOOLEAN NOT NULL DEFAULT FALSE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users (id),
  deleted_at        TIMESTAMPTZ,
  deleted_by        UUID REFERENCES users (id),
  delete_reason     TEXT,
  retained_key      TEXT,

  CONSTRAINT documents_owner_exclusive
    CHECK ((owner_kind = 'subject' AND subject_id IS NOT NULL)
        OR (owner_kind = 'library' AND subject_id IS NULL)),
  CONSTRAINT documents_storage_key_relative
    CHECK (storage_key !~ '^/' AND storage_key !~ '\.\.'),
  CONSTRAINT documents_validity_order
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CONSTRAINT documents_reject_reason
    CHECK (review_state <> 'rejected' OR reject_reason IS NOT NULL),
  CONSTRAINT documents_approved_complete
    CHECK (review_state <> 'approved' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  CONSTRAINT documents_legal_hold_complete
    CHECK (legal_hold_at IS NULL OR (legal_hold_by IS NOT NULL AND legal_hold_reason IS NOT NULL)),
  -- A delete is a move: the row records where the bytes went and why.
  CONSTRAINT documents_soft_delete_complete
    CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND retained_key IS NOT NULL)),
  -- Nothing under legal hold may be deleted, in any code path.
  CONSTRAINT documents_hold_blocks_delete
    CHECK (deleted_at IS NULL OR legal_hold_at IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS documents_storage_key_uk
  ON documents (storage_key) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS documents_certificate_number_uk
  ON documents (certificate_number)
  WHERE certificate_number IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS documents_subject_idx
  ON documents (subject_id, doc_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_expiry_idx
  ON documents (valid_until) WHERE deleted_at IS NULL AND review_state = 'approved';
CREATE INDEX IF NOT EXISTS documents_queue_idx
  ON documents (created_at) WHERE review_state = 'pending' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_hold_idx
  ON documents (legal_hold_at) WHERE legal_hold_at IS NOT NULL;

COMMENT ON TABLE  documents IS
  'The evidence store. Metadata plus a relative storage_key; bytes live under DMS_STORAGE_ROOT. '
  'storage_key never reaches a client - files are served only through a route that resolves the '
  'path server-side from the document id. Deletion is always a move to the retention store.';
COMMENT ON COLUMN documents.file_name IS
  'Canonical name built server-side at ingestion from the document''s own facts, never supplied by '
  'a client or an automation workflow. The date component is the event date, not the upload date.';
COMMENT ON COLUMN documents.storage_key IS
  'Relative to DMS_STORAGE_ROOT, forward slashes, no leading slash, no traversal segment. Excluded '
  'from every select list that serves a client.';
COMMENT ON COLUMN documents.finding_state IS
  'Paired with open_finding_count: clear means exactly zero open findings, open means at least '
  'one. A deferrable constraint trigger enforces both directions; never repair a contradiction by '
  'trusting one column, recount from the source rows in the same transaction.';
COMMENT ON COLUMN documents.is_restricted IS
  'Hidden from the subject and from assessors on every surface including the tablet API, and from '
  'any figure derived from it. Completion certificates default to restricted.';
COMMENT ON COLUMN documents.legal_hold_at IS
  'While set, nothing may be purged or deleted and retain_until is ignored. Setting and clearing '
  'both require a reason and are audited. A hold on a subject propagates to their documents.';
COMMENT ON COLUMN documents.retain_until IS
  'Frozen at approval from the matching retention rule. Never derived at read time - editing a '
  'rule must not retroactively move the disposal date of records approved under the previous one.';
COMMENT ON COLUMN documents.retained_key IS
  'Where the bytes were moved on soft delete. The row and every foreign key remain valid.';
