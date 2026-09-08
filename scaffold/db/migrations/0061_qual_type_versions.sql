-- 0061_qual_type_versions.sql
-- QMS: the versioned rule definition. Immutable once published.
-- See docs/08_QMS.md sections 3 and 8.1.

CREATE TABLE IF NOT EXISTS qual_type_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qual_type_code  TEXT NOT NULL REFERENCES qual_types (code) ON DELETE RESTRICT,
  version_no      INTEGER NOT NULL CHECK (version_no >= 1),
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','retired')),
  definition      JSONB NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(definition) = 'object'),
  schema_version  INTEGER NOT NULL DEFAULT 1,
  framework_id    UUID REFERENCES competency_frameworks (id),
  effective_from  DATE,
  retired_at      TIMESTAMPTZ,
  change_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users (id),
  published_at    TIMESTAMPTZ,
  published_by    UUID REFERENCES users (id),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT qual_type_versions_published_complete
    CHECK (status <> 'published'
           OR (published_at IS NOT NULL AND published_by IS NOT NULL
               AND effective_from IS NOT NULL AND change_reason IS NOT NULL)),
  CONSTRAINT qual_type_versions_retired_complete
    CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS qual_type_versions_no_uk
  ON qual_type_versions (qual_type_code, version_no)
  WHERE deleted_at IS NULL;

-- One published version per code per effective date. Two versions taking effect on the same day
-- makes "which rule was in force" unanswerable, which is the question an audit asks first.
CREATE UNIQUE INDEX IF NOT EXISTS qual_type_versions_published_effective_uk
  ON qual_type_versions (qual_type_code, effective_from)
  WHERE status = 'published' AND deleted_at IS NULL;

-- At most one draft per type: the builder edits in place rather than forking.
CREATE UNIQUE INDEX IF NOT EXISTS qual_type_versions_single_draft_uk
  ON qual_type_versions (qual_type_code)
  WHERE status = 'draft' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS qual_type_versions_definition_gin
  ON qual_type_versions USING gin (definition jsonb_path_ops);

COMMENT ON TABLE  qual_type_versions IS
  'Versioned qualification rule definitions. A published row is immutable: a change is a new '
  'version with a diff and a mandatory reason. Holdings pin the version they were granted under, '
  'so republishing never re-evaluates history.';
COMMENT ON COLUMN qual_type_versions.definition IS
  'The whole rule: identity, applicability, requirements (one grouping level), constraints '
  '(AFTER/WITHIN), validity (anchor, end_of_month, early_renewal_days, expiry_grace_days) and '
  'approval mode. Schema in docs/08_QMS.md section 3. Publish invariants are enforced server-side '
  'before status becomes published; the CHECKs here are the last line, not the only one.';
COMMENT ON COLUMN qual_type_versions.schema_version IS
  'Definition-document schema version. An engine older than the document must degrade to '
  '"not evaluable", never to "met".';
COMMENT ON COLUMN qual_type_versions.framework_id IS
  'Required whenever any condition names a competency or an observable behaviour. Grades key on '
  'ids, never on names.';
COMMENT ON COLUMN qual_type_versions.effective_from IS
  'The date this version starts governing new grants and renewals. Never in the past at publish.';
