-- 0152_record_pdf.sql
-- The record's PDF, stored beside the record.
--
-- WHY A TABLE OF ITS OWN AND NOT THE DMS. `documents` (0081) is the right long-term home, and
-- `records.document_id` is already there waiting for it. But the DMS module owns folder routing -
-- slots, path_template, period_key, the archive slot, the storage root - and none of that is built
-- yet. Writing a document row now would mean inventing that routing twice. So the bytes live here,
-- keyed one-to-one with the record, and when the DMS module lands it reads this table once to create
-- the document row and fill `records.document_id`; this table is then dropped. That is a scripted
-- migration of a few dozen rows, not a redesign.
--
-- WHY IN THE DATABASE AND NOT ON DISK. This instance has no configured storage root, and `pg_dump`
-- is the whole environment story - "migrate, seed, never copy a database" stays true because the
-- bytes travel with the schema instead of needing a second sync. A record PDF is a few hundred
-- kilobytes, one per FINALISED record, and the seeded history is never re-frozen, so this is dozens
-- of rows in the demo. BYTEA is TOASTed out of line, so no query that does not select it pays for it.
-- Recorded as a deliberate trade in docs/07_PRODUCTION_GAPS.md.
--
-- A separate table rather than a column on `records` for one more reason: nothing that reads a record
-- can accidentally drag the bytes along.

CREATE TABLE IF NOT EXISTS record_pdfs (
  record_id    UUID PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  bytes        BYTEA       NOT NULL,
  byte_size    BIGINT      NOT NULL CHECK (byte_size > 0),
  -- The hash OF THE PDF, which is not the record's content hash: a renderer stamps a creation time
  -- into the file, so two renders of the same record differ byte for byte. This one answers "is this
  -- the file I downloaded", and `records.content_hash` answers "is this what was signed".
  sha256       TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  renderer     TEXT        NOT NULL,
  rendered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rendered_by  UUID        REFERENCES users(id)
);

COMMENT ON TABLE record_pdfs IS
  'The rendered PDF of a finalised record, one row per record. Interim home until the DMS module owns it (see migration comment); the bytes are never read by a query that does not ask for them.';
COMMENT ON COLUMN record_pdfs.sha256 IS
  'Checksum of the PDF file itself. NOT records.content_hash - that is the hash of what the signatures attest to, and a renderer stamps a creation time so the two can never be equal.';
COMMENT ON COLUMN record_pdfs.renderer IS
  'What produced it, e.g. gotenberg/8. A later renderer lays a page out differently; the row says which one made this file.';

DO $$ BEGIN RAISE NOTICE '0152: record_pdfs added.'; END $$;
