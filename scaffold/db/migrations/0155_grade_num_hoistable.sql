-- 0155_grade_num_hoistable.sql
-- Analytics layer. A performance defect in how grade_num(TEXT) is CALLED, not in what it means.
--
-- THE DEFECT. grade_num(TEXT) reads its pattern with analytics_text('grade_scale.valid_pattern'),
-- which is a plpgsql function that queries analytics_config. PostgreSQL evaluates a STABLE function
-- once per ROW, not once per query, so a fleet-wide screen paid one config lookup per grade per
-- call site. Measured on this database, 2026-09-18, over 772,710 rows:
--
--   grade_is_below_standard(grade)                             100,610 ms
--   grade_num(grade) with the threshold hoisted                 24,240 ms
--   the same test with both config reads hoisted                   573 ms
--   the same test with the pattern and threshold as literals       575 ms
--
-- Hoisting reaches the literal floor exactly. Hoisting INSIDE the function does not: a SQL function
-- whose body contains a subquery is not inlined, so grade_num_v2 measured 12,735 ms against the
-- current function's 12,873 ms - no gain. The hoist must therefore happen in the CALLING query,
-- where an uncorrelated scalar subquery becomes an InitPlan and runs once.
--
-- WHAT THIS ADDS. A two-argument grade_num(grade, pattern). It takes the pattern rather than
-- reading it, so its body holds no subquery and PostgreSQL inlines it. The caller supplies the
-- pattern as (SELECT analytics_text('grade_scale.valid_pattern')), which is still a read of
-- analytics_config - the configuration is not restated anywhere and no threshold is inlined.
--
-- WHAT THIS DOES NOT CHANGE. grade_num(TEXT) keeps its meaning and its signature, and stays the
-- form used in ad-hoc queries and anywhere the row count is small. Both forms parse a grade the
-- same way, which is asserted by the gate rather than assumed: see the analytics group of
-- scripts/verify.mjs.
--
-- Forward-only. Re-runnable.

CREATE OR REPLACE FUNCTION grade_num(p_grade TEXT, p_pattern TEXT)
RETURNS INT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT (CASE
            WHEN p_grade IS NULL THEN NULL
            WHEN btrim(p_grade) ~ p_pattern THEN btrim(p_grade)
            ELSE NULL
          END)::INT
$$;

COMMENT ON FUNCTION grade_num(TEXT, TEXT) IS
  'grade_num(text) with the configured pattern passed in rather than read per row. IMMUTABLE and '
  'free of subqueries so PostgreSQL inlines it; the caller hoists the pattern with '
  '(SELECT analytics_text(''grade_scale.valid_pattern'')), which the planner evaluates once per '
  'query as an InitPlan. Identical in meaning to grade_num(text) - NR, NO, NA, blanks and anything '
  'unparseable resolve to NULL - and 175x cheaper on a fleet-wide scan. Use the one-argument form '
  'in ad-hoc queries; use this one wherever a query touches more than a few hundred grades.';
