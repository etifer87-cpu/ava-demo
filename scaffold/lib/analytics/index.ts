/**
 * lib/analytics/index.ts
 *
 * The deterministic analytics core. Specified by docs/06_ANALYTICS.md.
 *
 * WHAT THIS FOLDER IS
 * -------------------
 * Every figure the platform displays is computed here or in the av_* views
 * (migrations 0100-0119). The split is: SQL counts, TypeScript derives. A view
 * emits numerators, denominators and ordered facts; a module in this folder
 * turns them into an index, a band or a status.
 *
 * INVARIANTS - all four are enforced by review, and all four are testable
 * -----------------------------------------------------------------------
 * 1. PURE. No database handle, no fetch, no filesystem, no globals. Rows in,
 *    values out. Every function in this folder can be called from a test with a
 *    literal array.
 * 2. NO WALL CLOCK. Nothing calls Date.now(). Anything time-relative takes an
 *    injected `asOf`, which is what makes an as-at report reproducible a year
 *    later.
 * 3. NO THRESHOLDS. Every constant arrives in an `AnalyticsConfig` object that
 *    mirrors scaffold/config/analytics.yaml key for key. A literal band
 *    boundary in this folder is a defect, not a shortcut.
 * 4. NO MODEL OUTPUT. No value returned from here may have passed through a
 *    language model. Narration is generated elsewhere and is validated against
 *    the figure set these functions produce before it is stored.
 *
 * GRAIN - stated once, here, because mixing grains is the most expensive
 * mistake available in this layer
 * ----------------------------------------------------------------------
 *   below-standard rate        period x competency x scope, over GRADE EVENTS
 *   adverse-competency rate    period x scope,             over RECORDS
 *   program-level indicator    period x metric x grain x scope, plus a status
 *   screening index            subject x competency
 *   concern level              subject
 *   standardisation index      assessor
 *   currency status            person x qualification type
 *
 * THE TWO INDICES THAT MUST NEVER BE RECONCILED
 * ---------------------------------------------
 * The program-level indicator and the screening index both produce a
 * red/amber/green band, both are built from the same grades, and they answer
 * different questions on different grains against different baselines. The
 * indicator measures the programme against a frozen calendar base, pooled
 * across everyone, counting every event once. The screening index measures one
 * subject in one competency against their own recent window, recency-weighted,
 * asymmetrically scored, assessor-adjusted, with critical grades removed from
 * the arithmetic entirely. Neither number is derivable from the other. A
 * sentence of the form "the programme is amber but only n subjects are red, so
 * the indicator is wrong" is a category error, and any surface that places them
 * adjacent must label them as separate instruments.
 */

export * from './types';
export * from './display';
export * from './statistics';
export * from './screening-index';
export * from './program-indicator';
export * from './assessor-fairness';
export * from './concern';
export * from './trend';
export * from './currency';

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
} from './grades';
