-- 0021_template_elements.sql
-- ETR. One element of a template version: a section, a graded task, a reset, a malfunction, a
-- block of text, a signature block.
--
-- element_key is the load-bearing column. It is author-assigned, stable across edits and across
-- versions of the same template, and it is what a grade points at. The row's own id is an internal
-- handle for the editor and nothing outside the editor stores it.

CREATE TABLE IF NOT EXISTS template_elements (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_version_id  UUID        NOT NULL REFERENCES session_template_versions(id) ON DELETE CASCADE,
  element_key          TEXT        NOT NULL
                       CHECK (element_key ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  parent_key           TEXT,       -- the element_key of the containing section; a key, not an id
  element_type         TEXT        NOT NULL
                       CHECK (element_type IN ('section','task','reset','malfunction','text','signature')),
  title                TEXT,
  -- The syllabus item number from the source curriculum. An IMPORT MAPPING KEY, never an identity:
  -- curricula renumber between editions, and a renumber must not split one task across buckets.
  external_ref         TEXT,
  position             INT         NOT NULL DEFAULT 0,
  is_mandatory         BOOLEAN     NOT NULL DEFAULT false,
  is_graded            BOOLEAN     NOT NULL DEFAULT true,
  max_attempts         INT         CHECK (max_attempts IS NULL OR max_attempts >= 1),
  -- { time, total_time, pf_role, notes, resets, position, environment, text,
  --   performance_criteria, grid_options: [{ key, name, trigger }] }
  -- Each grid option carries its own key, so a multi-select answer is also key-addressed.
  content              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_version_id, element_key),
  CONSTRAINT template_elements_parent_not_self CHECK (parent_key IS DISTINCT FROM element_key)
);

CREATE INDEX IF NOT EXISTS template_elements_order
  ON template_elements (template_version_id, position);
CREATE INDEX IF NOT EXISTS template_elements_external_ref
  ON template_elements (external_ref) WHERE external_ref IS NOT NULL;

DROP TRIGGER IF EXISTS template_elements_updated_at ON template_elements;
CREATE TRIGGER template_elements_updated_at BEFORE UPDATE ON template_elements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Immutability of a published version is a trigger, not a convention.
CREATE OR REPLACE FUNCTION deny_published_template_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status TEXT; v_version UUID;
BEGIN
  v_version := COALESCE(NEW.template_version_id, OLD.template_version_id);
  SELECT status INTO v_status FROM session_template_versions WHERE id = v_version;
  IF v_status = 'published' THEN
    RAISE EXCEPTION 'template version % is published and immutable; clone it to a new draft', v_version
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS template_elements_frozen ON template_elements;
CREATE TRIGGER template_elements_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON template_elements
  FOR EACH ROW EXECUTE FUNCTION deny_published_template_change();

COMMENT ON TABLE template_elements IS 'Elements of one template version, addressed by a stable author-assigned element_key; frozen once the version is published.';
COMMENT ON FUNCTION deny_published_template_change() IS 'Blocks any write to the children of a published template version.';
