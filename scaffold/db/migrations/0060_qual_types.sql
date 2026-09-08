-- 0060_qual_types.sql
-- QMS: the qualification catalogue. Identity only; every rule lives in qual_type_versions.
-- See docs/08_QMS.md section 2.

CREATE TABLE IF NOT EXISTS qual_types (
  code            TEXT PRIMARY KEY
                    CHECK (code ~ '^[a-z0-9_]{2,64}$'),
  name            TEXT NOT NULL,
  category        TEXT NOT NULL
                    CHECK (category IN (
                      'licence','medical','rating','route','authority',
                      'ground','lms','simulator','recency')),
  description     TEXT,
  regulatory_ref  TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INTEGER NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users (id),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS qual_types_active_idx
  ON qual_types (category, sort_order)
  WHERE deleted_at IS NULL AND is_active;

COMMENT ON TABLE  qual_types IS
  'QMS catalogue of qualification types. Identity and taxonomy only: no rules, no windows, no '
  'approval settings. Everything evaluable lives in qual_type_versions.definition so that adding '
  'or changing a qualification is an INSERT, never a migration. Soft delete only.';
COMMENT ON COLUMN qual_types.code IS
  'Stable, filename-safe primary key. Immutable after the first published version; the builder '
  'locks it. Referenced by qualifications, qual_approvals and every definition body.';
COMMENT ON COLUMN qual_types.category IS
  'Taxonomy for grouping and reporting only. Never used to decide evaluation behaviour.';
COMMENT ON COLUMN qual_types.regulatory_ref IS
  'Free-text reference to the requirement this type implements. Framework-generic; the operator '
  'fills it in. No jurisdiction is encoded in the schema.';
COMMENT ON COLUMN qual_types.is_active IS
  'False retires the type from the builder and from applicability matching. Existing holdings are '
  'unaffected and remain readable.';
