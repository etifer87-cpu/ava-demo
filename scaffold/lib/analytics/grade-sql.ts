/**
 * lib/analytics/grade-sql.ts - the SQL fragment for parsing a grade in a query that touches many.
 *
 * WHY THIS EXISTS. `grade_num(text)` reads its pattern from analytics_config, and PostgreSQL
 * evaluates a STABLE function once per ROW. On a fleet-wide screen that is one configuration
 * lookup per grade per call site, and it dominated every unfiltered query: the manager's landing
 * page carried about thirteen seconds of it. Passing the pattern in instead lets the planner hoist
 * the single config read into an InitPlan - evaluated once for the whole query - and lets it inline
 * the parse itself. Measured 2026-09-18: 100,610 ms to 573 ms over 772,710 rows, which is the same
 * number the equivalent query with hard-coded literals produces. See migration 0155.
 *
 * WHAT IS NOT HAPPENING HERE. The pattern is not restated, defaulted or cached in TypeScript. This
 * fragment reads `grade_scale.valid_pattern` from analytics_config exactly as `grade_num(text)`
 * does; it only moves the read out of the per-row path. A missing key still raises.
 *
 * WHEN NOT TO USE IT. A query filtered to one person touches a handful of rows and gains nothing -
 * the one-argument `grade_num(rc.grade)` is clearer and stays correct. Reach for this where the row
 * count is unbounded: anything fleet-wide, any peer comparison, any view input.
 */

/**
 * The configured grade pattern as an uncorrelated scalar subquery, which is what makes the planner
 * evaluate it once per query rather than once per row.
 */
export const GRADE_PATTERN_SQL = "(SELECT analytics_text('grade_scale.valid_pattern'))";

/**
 * `grade_num()` over `column`, with the pattern hoisted.
 *
 * @param column the SQL expression holding the stored grade, e.g. `rc.grade`
 */
export function gradeNum(column: string): string {
  return `grade_num(${column}, ${GRADE_PATTERN_SQL})`;
}
