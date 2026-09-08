-- 0023_element_library.sql
-- ETR. Reusable elements the builder offers when authoring.
-- Copying a library element into a template COPIES its content; it does not reference it. A library
-- edit must never change the meaning of a template that is already published.

CREATE TABLE IF NOT EXISTS element_library (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT        NOT NULL,
  element_type    TEXT        NOT NULL
                  CHECK (element_type IN ('section','task','reset','malfunction','text','signature')),
  title           TEXT,
  external_ref    TEXT,
  asset_class_id  UUID        REFERENCES asset_classes(id),
  tags            TEXT[]      NOT NULL DEFAULT '{}',
  content         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_by      UUID        REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS element_library_code_live
  ON element_library (code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS element_library_tags ON element_library USING GIN (tags);

DROP TRIGGER IF EXISTS element_library_updated_at ON element_library;
CREATE TRIGGER element_library_updated_at BEFORE UPDATE ON element_library
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE element_library IS 'Reusable element definitions offered by the template builder; copied into a template, never referenced by one.';
