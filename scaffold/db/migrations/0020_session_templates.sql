-- 0020_session_templates.sql
-- ETR. A template is the form definition. It is NEVER edited in place once used: an author edits a
-- draft version and publishes it, and a published version is immutable. The predecessor saved a
-- template by deleting and reinserting all of its elements, which rewrote every element id under
-- live grades and destroyed any structure the builder had not loaded first.

CREATE TABLE IF NOT EXISTS session_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT        NOT NULL,
  name                TEXT        NOT NULL,
  template_kind       TEXT        NOT NULL
                      CHECK (template_kind IN ('ground','simulator','line','line_check','assessment','other')),
  asset_class_id      UUID        REFERENCES asset_classes(id),  -- NULL = every class
  org_unit_id         UUID        REFERENCES org_units(id),      -- NULL = every unit
  current_version_id  UUID,       -- FK added at the foot of this file: the reference is circular
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_by          UUID        REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS session_template_versions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id               UUID        NOT NULL REFERENCES session_templates(id) ON DELETE CASCADE,
  version                   INT         NOT NULL CHECK (version >= 1),
  status                    TEXT        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','published','retired')),
  framework_id              UUID,       -- FK added in 0042: the framework range runs later
  period                    TEXT,       -- free-form validity label, never parsed by SQL
  effective_from            DATE,
  published_at              TIMESTAMPTZ,
  published_by              UUID        REFERENCES users(id),
  setup                     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- empty array = every assessor role. RE-VALIDATED SERVER-SIDE on session creation: a client
  -- that omits it must not silently widen eligibility.
  allowed_assessor_roles    TEXT[]      NOT NULL DEFAULT '{}',
  hide_record_from_subject  BOOLEAN     NOT NULL DEFAULT false,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ,
  UNIQUE (template_id, version)
);

ALTER TABLE session_templates
  DROP CONSTRAINT IF EXISTS session_templates_current_version_fk;
ALTER TABLE session_templates
  ADD CONSTRAINT session_templates_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES session_template_versions(id);

CREATE UNIQUE INDEX IF NOT EXISTS session_templates_code_live
  ON session_templates (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS session_templates_kind
  ON session_templates (template_kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS session_template_versions_published
  ON session_template_versions (template_id, status) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS session_templates_updated_at ON session_templates;
CREATE TRIGGER session_templates_updated_at BEFORE UPDATE ON session_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS session_template_versions_updated_at ON session_template_versions;
CREATE TRIGGER session_template_versions_updated_at BEFORE UPDATE ON session_template_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE session_templates IS 'Form definitions for graded training events; the mutable identity, whose content lives in versions.';
COMMENT ON TABLE session_template_versions IS 'An immutable-once-published revision of a template, carrying its framework, setup defaults and assessor eligibility.';
