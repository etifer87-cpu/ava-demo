-- 0041_seed_framework.sql
-- Framework. SEED-LOADING PLACEHOLDER. This migration creates no tables and inserts no framework
-- rows. The seed is data: it lives in scaffold/db/seed/competency_framework.json and is loaded by
-- scripts/seed-framework.mjs, so that re-seeding after a wording change does not require a new
-- migration number and does not rewrite history.
--
-- What this file provides is the assertion the seeder calls afterwards. It is the same list as
-- docs/03_COMPETENCY_FRAMEWORK.md section 6, and it fails loudly rather than leaving a half-loaded
-- vocabulary in place.
--
-- TODO(kit): scripts/seed-framework.mjs calls framework_seed_verify() as its last statement and
-- aborts the transaction on any raised exception. See docs/03_COMPETENCY_FRAMEWORK.md section 6.

CREATE OR REPLACE FUNCTION framework_seed_verify(p_framework_id UUID)
RETURNS TABLE (check_name TEXT, detail TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  n_comp      INT;
  n_ob        INT;
  bad_code    INT;
  ob_counts   INT[];
  expected    INT[] := ARRAY[7,7,10,6,7,11,9,7,9];
BEGIN
  SELECT count(*) INTO n_comp FROM competencies WHERE framework_id = p_framework_id;
  IF n_comp <> 9 THEN
    RAISE EXCEPTION 'framework seed: expected 9 competencies, found %', n_comp;
  END IF;

  SELECT count(*) INTO n_ob FROM observable_behaviours WHERE framework_id = p_framework_id;
  IF n_ob <> 73 THEN
    RAISE EXCEPTION 'framework seed: expected 73 observable behaviours, found %', n_ob;
  END IF;

  SELECT array_agg(c::INT ORDER BY idx) INTO ob_counts
  FROM (
    SELECT c."index" AS idx, count(o.id) AS c
    FROM competencies c
    LEFT JOIN observable_behaviours o ON o.competency_id = c.id
    WHERE c.framework_id = p_framework_id
    GROUP BY c."index"
  ) s;

  IF ob_counts IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'framework seed: OB counts per competency are %, expected %', ob_counts, expected;
  END IF;

  SELECT count(*) INTO bad_code
  FROM observable_behaviours
  WHERE framework_id = p_framework_id AND code !~ '^OB [0-8]\.[0-9]{1,2}$';
  IF bad_code > 0 THEN
    RAISE EXCEPTION 'framework seed: % observable behaviour codes are malformed', bad_code;
  END IF;

  RAISE NOTICE 'framework % verified: 9 competencies, 73 observable behaviours', p_framework_id;

  RETURN QUERY
    SELECT 'competencies'::TEXT, n_comp::TEXT
    UNION ALL SELECT 'observable_behaviours'::TEXT, n_ob::TEXT
    UNION ALL SELECT 'ob_counts'::TEXT, ob_counts::TEXT;
END $$;

COMMENT ON FUNCTION framework_seed_verify(UUID) IS 'Post-seed assertion: 9 competencies, OB counts 7,7,10,6,7,11,9,7,9 totalling 73, all codes well formed. Raises on any mismatch.';

DO $$ BEGIN
  RAISE NOTICE 'framework seed placeholder in place; run scripts/seed-framework.mjs to load the vocabulary';
END $$;
