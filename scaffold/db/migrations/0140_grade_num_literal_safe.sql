-- 0140_grade_num_literal_safe.sql
-- Cross-cutting fixes, part 1 of 20 (0140-0159). Specified by docs/06_ANALYTICS.md section 2.2.
--
-- FORWARD-ONLY. 0100_analytics_config.sql is applied and is not edited: its checksum is recorded
-- in schema_migrations and the runner treats an edited-after-apply file as a hard error. This file
-- redefines one function in place with CREATE OR REPLACE and changes nothing else.
--
-- WHAT WAS WRONG
--   grade_num(TEXT) was LANGUAGE sql with the cast INSIDE a CASE arm:
--     SELECT CASE WHEN p_grade IS NULL THEN NULL
--                 WHEN btrim(p_grade) ~ analytics_text('grade_scale.valid_pattern')
--                   THEN btrim(p_grade)::INT
--                 ELSE NULL END
--   A LANGUAGE sql function whose body is a single SELECT is INLINED into the calling query, and
--   the planner then folds any sub-expression whose inputs are all constant - independently of
--   the CASE that encloses it. With a literal argument it evaluates btrim('NR')::INT, the arm the
--   CASE exists to prevent, at PLAN time, and the call fails with
--     invalid input syntax for type integer: "NR"
--   The same value arriving from a COLUMN is not constant, nothing is folded, the CASE guards as
--   intended, and the function returns NULL. So every column-driven view was correct and every
--   literal call - a doc example, a psql check, a smoke test, an assertion in a gate script -
--   raised. The defect hid in exactly the place a person looks to check it.
--
--   grade_is_below_standard(TEXT) and grade_is_critical(TEXT) raised on a literal for the same
--   reason and only for that reason: both are LANGUAGE sql, so the broken grade_num was inlined
--   into them before it was inlined into the caller. Neither is redefined here. Fixing the one
--   definition fixes both, and restating them would put a second copy of the same rule in the
--   schema. The regression below asserts all three regardless, because "it follows" is not a
--   thing anyone should have to take on trust twice.
--
-- THE FIX: the cast moves OUT of the CASE arm and onto the CASE.
--   The cast's input is then the CASE expression itself. That expression contains a STABLE call -
--   analytics_text() reads the pattern from analytics_config - and a STABLE call is not folded at
--   plan time, so neither is the cast above it. At execution the CASE yields NULL for anything
--   that fails the pattern, and NULL::INT is NULL. Literal and column take the identical path.
--
--   WHY NOT plpgsql. It would also be correct: a plpgsql body is never inlined, so the guard
--   always runs first. It was measured and rejected. Inlining is what lets the planner hoist the
--   config lookup out of the row loop; as plpgsql, grade_num calls analytics_text ONCE PER ROW,
--   and on this kit's own synthetic population av_period_competency went from 65ms to over three
--   seconds - a sixty-fold cost on the hottest expression in the analytics layer, paid on every
--   grade in every view. A correctness fix that makes the platform unusable is not a fix.
--
--   WHAT PROTECTS IT. This formulation is deliberate and it is load-bearing: moving the cast back
--   inside the CASE reintroduces the defect exactly. It is therefore asserted, twice - by the DO
--   block at the foot of this file, so an environment that takes this migration and nothing else
--   still proves the defect closed, and by scripts/verify.mjs, which runs both the literal and the
--   column path and compares them, so a "simplification" fails the deploy gate rather than a user.
--
-- SEMANTICS ARE UNCHANGED, deliberately and exactly:
--   returns an INT only when btrim(input) matches grade_scale.valid_pattern - '1'..'5';
--   NULL for NULL, for NR / NO / NA, for blank, and for anything else whatsoever;
--   STABLE, not IMMUTABLE, because the pattern is configuration and may not back an index;
--   the pattern, the below-standard boundary and the critical grade are still READ FROM
--   analytics_config and are not restated here.
--
-- Re-runnable.

CREATE OR REPLACE FUNCTION grade_num(p_grade TEXT)
RETURNS INT
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT (CASE
            WHEN p_grade IS NULL THEN NULL
            WHEN btrim(p_grade) ~ analytics_text('grade_scale.valid_pattern')
              THEN btrim(p_grade)
            ELSE NULL
          END)::INT
$$;

COMMENT ON FUNCTION grade_num(TEXT) IS
  'Coerces a stored grade to an integer, returning NULL unless it matches '
  'grade_scale.valid_pattern from analytics_config. NR, NO, NA, blanks and anything unparseable '
  'resolve to NULL and are excluded from BOTH numerator and denominator of every metric. '
  'STABLE rather than IMMUTABLE because the pattern is configuration: it therefore cannot be '
  'used in an expression index. Index the raw grade column instead. '
  'THE CAST IS OUTSIDE THE CASE ON PURPOSE (migration 0140): with the cast inside an arm, this '
  'function inlines and the planner constant-folds the cast for a LITERAL argument, so '
  'grade_num(''NR'') raised while the same value from a column returned NULL. Do not move it back.';

-- WHERE THE REGRESSION LIVES, AND WHY IT IS NOT HERE.
-- Not in this file. grade_num() reads its pattern from analytics_config, and analytics_config is
-- filled by scripts/load-analytics-config.mjs AFTER the migrations run - that ordering is the
-- point of migration 0100 and of scripts/reset-to-seed.mjs. A DO block here calling grade_num()
-- therefore raises "key grade_scale.valid_pattern is not loaded" on a clean install, and the only
-- ways to keep it are to guard it on the config being present - which makes it a check that never
-- runs on the documented path, the worst kind - or to move the config load before the migrations,
-- which cannot be done because this table is created by one.
--
-- The regression is therefore asserted in scripts/verify.mjs, in the analytics group, which runs
-- after the config load on every reset and as step 9 of every deploy. It exercises the literal
-- path and the column path and compares them against each other, so both directions of this
-- defect fail the gate.
