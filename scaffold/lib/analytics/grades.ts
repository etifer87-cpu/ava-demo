/**
 * lib/analytics/grades.ts
 *
 * Re-export shim. The grade primitives are defined ONCE, in `lib/grades.ts`,
 * because they are shared with the grading UI and the report renderer as well
 * as with analytics. Two copies of "below standard" is precisely the defect
 * docs/06_ANALYTICS.md §2.3 forbids.
 *
 * Import from here inside lib/analytics so that the dependency is visible; the
 * implementation stays in one place.
 */

export {
  parseGrade,
  gradeNum,
  isScored,
  isNonScoring,
  isBelowStandard,
  meetsStandard,
  isCritical,
  aggregateGrades,
  belowStandardRate,
} from '../grades';

export type {
  GradeScaleConfig,
  AnalyticsConfigSlice,
  RawGrade,
  GradeKind,
  ParsedGrade,
  GradeAggregate,
} from '../grades';
