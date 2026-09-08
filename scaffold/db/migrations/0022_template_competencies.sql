-- 0022_template_competencies.sql
-- ETR. Which competencies this template version assesses, and in what order.
-- There is no skill_name column and there never will be: the grading UI joins to competencies at
-- read time and displays the name late. Nothing keys on a competency name.

CREATE TABLE IF NOT EXISTS template_competencies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_version_id  UUID    NOT NULL REFERENCES session_template_versions(id) ON DELETE CASCADE,
  framework_id         UUID    NOT NULL,   -- FK added in 0042
  competency_id        UUID    NOT NULL,   -- FK added in 0042
  position             INT     NOT NULL DEFAULT 0,
  is_required          BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_version_id, competency_id)
);

CREATE INDEX IF NOT EXISTS template_competencies_order
  ON template_competencies (template_version_id, position);

DROP TRIGGER IF EXISTS template_competencies_frozen ON template_competencies;
CREATE TRIGGER template_competencies_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON template_competencies
  FOR EACH ROW EXECUTE FUNCTION deny_published_template_change();

COMMENT ON TABLE template_competencies IS 'The competencies a template version assesses, referenced by id and ordered for display.';
