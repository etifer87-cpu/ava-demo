-- 0080_doc_folders.sql
-- DMS: the folder taxonomy. Subject-scoped and library-scoped trees in one table.
-- See docs/09_DMS.md section 2.

CREATE TABLE IF NOT EXISTS doc_folders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind      TEXT NOT NULL CHECK (owner_kind IN ('subject','library')),
  subject_id      UUID REFERENCES people (id) ON DELETE RESTRICT,
  org_unit_id     UUID REFERENCES org_units (id),
  parent_id       UUID REFERENCES doc_folders (id),

  slot_key        TEXT NOT NULL CHECK (slot_key ~ '^[a-z0-9_]{2,64}$'),
  label           TEXT NOT NULL,
  path_template   TEXT NOT NULL,
  storage_prefix  TEXT NOT NULL,
  period_key      TEXT,
  is_archive      BOOLEAN NOT NULL DEFAULT FALSE,
  is_inbox        BOOLEAN NOT NULL DEFAULT FALSE,
  is_retention    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order      INTEGER NOT NULL DEFAULT 100,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users (id),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT doc_folders_owner_exclusive
    CHECK ((owner_kind = 'subject' AND subject_id IS NOT NULL)
        OR (owner_kind = 'library' AND subject_id IS NULL)),
  CONSTRAINT doc_folders_no_self_parent
    CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT doc_folders_prefix_relative
    CHECK (storage_prefix !~ '^/' AND storage_prefix !~ '\.\.')
);

CREATE UNIQUE INDEX IF NOT EXISTS doc_folders_subject_slot_uk
  ON doc_folders (subject_id, slot_key, COALESCE(period_key, ''))
  WHERE owner_kind = 'subject' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS doc_folders_library_slot_uk
  ON doc_folders (COALESCE(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
                  slot_key, COALESCE(period_key, ''))
  WHERE owner_kind = 'library' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS doc_folders_parent_idx ON doc_folders (parent_id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE  doc_folders IS
  'Folder taxonomy for both scopes. A subject tree is created idempotently from the seeded '
  'skeleton when a person record is created, never by ad hoc mkdir at upload time. Year and period '
  'folders are created on demand from the document event date, never the ingestion date.';
COMMENT ON COLUMN doc_folders.slot_key IS
  'Stable machine key for the slot. Routing, retention and access rules reference the slot key, '
  'never the display label, so a rename is an UPDATE.';
COMMENT ON COLUMN doc_folders.storage_prefix IS
  'Path relative to DMS_STORAGE_ROOT. Always relative, never containing a traversal segment - the '
  'CHECK enforces both. No absolute path exists anywhere in the platform except the env var.';
COMMENT ON COLUMN doc_folders.is_inbox IS
  'The single destination for anything unrouted. Unrouted documents land here and raise a warning; '
  'they are never dropped and never filed silently.';
COMMENT ON COLUMN doc_folders.is_retention IS
  'The retention store: the only destination of a delete. Bytes are moved here, never unlinked.';
