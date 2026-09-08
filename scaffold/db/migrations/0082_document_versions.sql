-- 0082_document_versions.sql
-- DMS: append-only version history. A replacement is a supersede, never an overwrite.
-- See docs/09_DMS.md section 4.

CREATE TABLE IF NOT EXISTS document_versions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id           UUID NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  version_no            INTEGER NOT NULL CHECK (version_no >= 1),
  supersedes_version_id UUID REFERENCES document_versions (id),

  file_name             TEXT NOT NULL,
  storage_key           TEXT NOT NULL,
  mime_type             TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size             BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  checksum_sha256       TEXT CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  page_count            INTEGER,

  is_current            BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at           TIMESTAMPTZ,
  archived_storage_key  TEXT,
  change_reason         TEXT,

  chunk_count           INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  chunked_at            TIMESTAMPTZ,
  chunks_retired_at     TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES users (id),
  deleted_at            TIMESTAMPTZ,

  CONSTRAINT document_versions_storage_key_relative
    CHECK (storage_key !~ '^/' AND storage_key !~ '\.\.'),
  CONSTRAINT document_versions_archived_complete
    CHECK (archived_at IS NULL OR archived_storage_key IS NOT NULL),
  CONSTRAINT document_versions_no_self_supersede
    CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS document_versions_no_uk
  ON document_versions (document_id, version_no) WHERE deleted_at IS NULL;

-- Exactly one current version per document.
CREATE UNIQUE INDEX IF NOT EXISTS document_versions_one_current_uk
  ON document_versions (document_id)
  WHERE is_current AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS document_versions_document_idx
  ON document_versions (document_id, version_no DESC);

COMMENT ON TABLE  document_versions IS
  'Append-only byte-stream history. Approving a replacement adds a row on the same documents row, '
  'moves the previous bytes to the folder archive slot, and updates any backing qualification in '
  'place. Previous versions are never deleted.';
COMMENT ON COLUMN document_versions.chunk_count IS
  'Retrieval chunks belong to a VERSION, not to a document, and carry this row''s checksum. A '
  'supersede re-chunks and retires the previous set, so a superseded manual can never keep '
  'answering queries with a citation that looks current.';
COMMENT ON COLUMN document_versions.chunks_retired_at IS
  'Set when the version''s chunks are withdrawn from the retrieval index. The index itself is a '
  'rebuildable cache keyed on checksum_sha256; a checksum mismatch invalidates rather than serves.';
COMMENT ON COLUMN document_versions.archived_storage_key IS
  'Where the superseded bytes were moved. Still under DMS_STORAGE_ROOT, still relative.';
