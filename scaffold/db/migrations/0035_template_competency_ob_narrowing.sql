-- 0035_template_competency_ob_narrowing.sql
-- ETR. template_competencies.allowed_ob_ids, from docs/05_TEMPLATES_AND_BUILDER.md section 1.
--
-- docs/05 section 1 gives the model as:
--
--   template_competencies    competency_id, position, allowed_ob_ids (empty = all)
--
-- and section 3 lists "pick the competencies this form grades and narrow OB lists" as a builder
-- tab. 0022 carried no such column, so the builder had a tab with nowhere to save to and every
-- seeded template silently offered every observable behaviour of every competency it selected.
--
-- EMPTY MEANS ALL, and that is deliberate rather than convenient. The alternative - materialising
-- every OB id of every selected competency into the array at publish - freezes the framework
-- edition into the template: adding an OB in a later framework edition would leave every existing
-- template narrowed to the old list, invisibly, and nobody would look for it there.
--
-- NO FOREIGN KEY, because an array cannot carry one - the same reason and the same treatment as
-- record_competencies.observable_behaviour_ids in 0029. Referential integrity is asserted where the
-- ids are written: the publish rules in scripts/lib/template-rules.mjs reject an observable
-- behaviour code that is not in the active framework, and reject it rather than substituting a
-- default. Grades themselves reference observable_behaviour_id through competency_grade_obs, which
-- does carry a foreign key; this column narrows a PICK-LIST, it does not record a selection.
--
-- Forward-only: 0022 is not edited. Existing rows default to '{}', which is what they already meant.

ALTER TABLE template_competencies
  ADD COLUMN IF NOT EXISTS allowed_ob_ids UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS template_competencies_allowed_obs
  ON template_competencies USING GIN (allowed_ob_ids);

COMMENT ON COLUMN template_competencies.allowed_ob_ids IS
  'Narrows the observable-behaviour pick-list this template version offers for this competency. EMPTY MEANS EVERY OB OF THE COMPETENCY, resolved from the framework at read time - never materialised, or a later framework edition would leave the template silently narrowed to the old list. Ids, never codes and never text. No foreign key is possible on an array; the publish rules reject unknown codes instead.';

DO $$
DECLARE n_narrowed INT;
BEGIN
  SELECT count(*) INTO n_narrowed
    FROM template_competencies WHERE cardinality(allowed_ob_ids) > 0;
  RAISE NOTICE '0035: allowed_ob_ids added to template_competencies; % row(s) currently narrow their OB list.', n_narrowed;
END $$;
