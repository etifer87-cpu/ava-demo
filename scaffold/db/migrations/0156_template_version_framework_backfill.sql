-- 0156_template_version_framework_backfill.sql
-- Data fixed FORWARD, per rule 3 of scripts/verify.mjs: the release carries the migration that makes
-- the invariant hold, and the check is never narrowed to fit the rows that exist.
--
-- THE DEFECT. `scripts/seed-program.mjs` inserted session_template_versions without framework_id,
-- while scripts/lib/template-publish.mjs always set it. On 2026-09-19 that left 48 PUBLISHED versions
-- with a NULL framework_id. A published version with no framework cannot be read against any
-- competency vocabulary, so it is invisible to every av_* view rather than wrong in a way anyone
-- would notice. The seeder is fixed; this repairs what it already wrote.
--
-- WHY THE VALUE IS NOT GUESSED. template_competencies.framework_id is NOT NULL (migration 0022) and
-- every competency on a version belongs to one framework, so the version's framework is derivable
-- from its own rows rather than assumed from whichever framework happens to be active today. A
-- version whose competency rows disagree is a different defect and is deliberately left alone here
-- for the gate to keep reporting.
--
-- Forward-only. Re-runnable: it touches only rows that are still NULL.

UPDATE session_template_versions stv
   SET framework_id = src.framework_id,
       updated_at   = now()
  FROM (
    -- array_agg, not min(): PostgreSQL has no min() for uuid. The HAVING below already
    -- guarantees the version names exactly one framework, so the first element IS the value.
    SELECT tc.template_version_id, (array_agg(DISTINCT tc.framework_id))[1] AS framework_id
      FROM template_competencies tc
     GROUP BY tc.template_version_id
    HAVING count(DISTINCT tc.framework_id) = 1
  ) AS src
 WHERE src.template_version_id = stv.id
   AND stv.framework_id IS NULL;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n
    FROM session_template_versions
   WHERE framework_id IS NULL AND status = 'published' AND deleted_at IS NULL;
  IF n > 0 THEN
    RAISE NOTICE '% published template version(s) still carry no framework_id: their competency rows '
      'name more than one framework, or they carry none at all. The gate will keep reporting them.', n;
  END IF;
END $$;
