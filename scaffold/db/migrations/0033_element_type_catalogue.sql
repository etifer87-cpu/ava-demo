-- 0033_element_type_catalogue.sql
-- ETR. Widens element_type to the element catalogue of docs/05_TEMPLATES_AND_BUILDER.md section 2.
--
-- WHY THIS ONE STAYS A CHECK AND DOES NOT BECOME A LOOKUP TABLE.
--
-- Unlike template_kinds (0032), this vocabulary is NOT operator-editable and must not look as
-- though it is. Every element type needs a renderer branch, a builder palette entry, a validation
-- rule and a report block; adding a row to a table would add a type the renderer cannot draw, and
-- the failure would surface as a blank space in a signed record. It is a code vocabulary, so it is
-- constrained by a CHECK that changes when the code changes.
--
-- WHAT CHANGES. 0021 and 0023 allowed six values - section, task, reset, malfunction, text,
-- signature - while docs/05 section 2 defines eight: section, task, setup, event_option, note,
-- field, computed, group. config/policy.yaml bridged the gap by storing each catalogue type as its
-- "nearest legal" element_type with the real one hidden in content.catalogue_type, so a field, a
-- computed panel and a note were all stored as 'text' and the database could not tell them apart.
-- After this migration the column carries the real type and that workaround is deleted from
-- policy.yaml and from scripts/lib/template-publish.mjs.
--
-- FORWARD-ONLY. 0021 and 0023 are not edited, and the four superseded values stay ALLOWED so that
-- rows written before this migration remain valid:
--
--   reset       -> setup          a set-up / reset block
--   malfunction -> event_option   a multi-select option group
--   text        -> note           static instructional prose
--   signature   -> (no successor) the renderer owns the signature blocks natively and no template
--                                 may declare one; docs/05 section 2 is explicit about it
--
-- They are deprecated, not offered by the builder, and rejected by the seeder's publish rules. No
-- data migration rewrites them: 'text' cannot be resolved into note, field or computed without
-- guessing, and a guess here silently changes how a signed record renders.

ALTER TABLE template_elements
  DROP CONSTRAINT IF EXISTS template_elements_element_type_check;
ALTER TABLE template_elements
  ADD CONSTRAINT template_elements_element_type_check
  CHECK (element_type IN (
    -- the catalogue, docs/05 section 2
    'section', 'task', 'setup', 'event_option', 'note', 'field', 'computed', 'group',
    -- superseded, retained for rows written before migration 0033
    'reset', 'malfunction', 'text', 'signature'
  ));

ALTER TABLE element_library
  DROP CONSTRAINT IF EXISTS element_library_element_type_check;
ALTER TABLE element_library
  ADD CONSTRAINT element_library_element_type_check
  CHECK (element_type IN (
    'section', 'task', 'setup', 'event_option', 'note', 'field', 'computed', 'group',
    'reset', 'malfunction', 'text', 'signature'
  ));

COMMENT ON COLUMN template_elements.element_type IS
  'The element catalogue of docs/05_TEMPLATES_AND_BUILDER.md section 2: section, task, setup, event_option, note, field, computed, group. reset, malfunction, text and signature are superseded spellings retained by migration 0033 for rows written before it; the builder does not offer them and the publish rules reject them.';
COMMENT ON COLUMN element_library.element_type IS
  'Same catalogue as template_elements.element_type, so a library element can be copied into a template without translation.';

DO $$
DECLARE n_superseded INT;
BEGIN
  SELECT count(*) INTO n_superseded
    FROM template_elements
   WHERE element_type IN ('reset', 'malfunction', 'text', 'signature');
  IF n_superseded > 0 THEN
    RAISE NOTICE '0033: % template_elements row(s) still carry a superseded element_type. They stay valid and render as before; new authoring uses the catalogue spellings.', n_superseded;
  ELSE
    RAISE NOTICE '0033: element_type widened to the docs/05 catalogue; no superseded rows present.';
  END IF;
END $$;
