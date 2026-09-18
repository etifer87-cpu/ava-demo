import 'server-only';
import { query, queryOne } from '@/lib/db';
import { analyticsConfig, gradeScale } from '@/lib/config';
import { halfSplitTrend } from './trend';
import { gradeNum } from './grade-sql';
import type { AnalyticsConfig } from './types';

/**
 * lib/analytics/subject-figures.ts — everything a narrative about one pilot is allowed to say.
 *
 * THIS IS THE DETERMINISTIC HALF, and the whole design rests on it. The model receives this
 * structure and narrates it; `lib/provenance.ts` then checks every number in what it wrote against
 * every number in here, to any depth. So the rule is exact:
 *
 *   A NUMBER THE NARRATIVE MAY USE IS A NUMBER THAT APPEARS HERE.
 *
 * The consequence runs both ways and both ways matter. Omit a figure the model can reasonably
 * infer — a count it could get by adding two others, a percentage of two numbers that are both
 * present — and a CORRECT sentence is rejected by the gate, which teaches operators to lower the
 * threshold, which disables the gate for the incorrect cases too. Include a figure nobody asked
 * for and the prompt gets longer and the narrative wanders. So this set is deliberately the whole
 * of what is worth saying about one pilot, computed once, and nothing else.
 *
 * Every figure is SQL or arithmetic over SQL. Nothing here is a judgement, and nothing here is
 * rounded for presentation: rounding happens where the number is displayed, because a figure that
 * is rounded twice by two different rules stops matching itself.
 */

export interface SubjectFigures {
  readonly subject: {
    readonly staff_number: string;
    readonly full_name: string;
    readonly position: string | null;
    readonly fleet: string | null;
    readonly base: string | null;
  };
  readonly window: {
    readonly months: number;
    readonly from: string;
    readonly to: string;
  };
  readonly totals: {
    readonly records: number;
    readonly competency_grades: number;
    readonly mean_grade: number | null;
    readonly below_standard: number;
    readonly below_standard_percent: number | null;
    readonly critical_grades: number;
    readonly at_boundary_grades: number;
  };
  /**
   * COUNTS OF THINGS, so that nothing has to be counted by the writer.
   *
   * The first passing narrative opened with "downward trends in two competencies" when three were
   * trending down. The gate scored it 100%, correctly and uselessly: "two" IS in the figure set -
   * two competencies were graded twice - so the number had a source, it simply was not a source for
   * the claim being made. A provenance gate proves no figure was invented; it cannot prove a
   * sentence counted the right things, because the counting happened in the model.
   *
   * So the counting happens here instead, and the prompt forbids it there.
   */
  readonly counts: {
    readonly competencies_down: number;
    readonly competencies_up: number;
    readonly competencies_flat: number;
    readonly competencies_too_few_points: number;
    readonly records_with_a_below_standard_grade: number;
  };
  readonly competencies: ReadonlyArray<{
    readonly code: string;
    readonly name: string;
    readonly mean: number | null;
    readonly graded: number;
    readonly below_standard: number;
    /** Newer half minus older half, over this pilot's own series. Null below the configured minimum. */
    readonly trend_delta: number | null;
    readonly trend: 'UP' | 'DOWN' | 'FLAT' | 'NONE';
  }>;
  readonly recent_records: ReadonlyArray<{
    readonly date: string;
    readonly title: string;
    readonly kind: string;
    readonly outcome: string | null;
    readonly assessor: string | null;
    readonly mean_grade: number | null;
    readonly below_standard: number;
  }>;
  readonly scale: {
    readonly min: number;
    readonly max: number;
    readonly below_standard_max: number;
  };
}

interface PersonRow {
  external_id: string; full_name: string; position: string | null;
  fleet: string | null; base: string | null;
}
interface CompRow {
  code: string; name: string; mean: string | null; graded: string; below: string;
}
interface PointRow { code: string; on: string; value: string }
interface TotalsRow {
  records: string; grades: string; mean: string | null;
  below: string; critical: string; boundary: string;
}
interface RecentRow {
  date: string; title: string; kind: string; outcome: string | null;
  assessor: string | null; mean: string | null; below: string;
}

const n = (v: string | null): number | null => {
  if (v === null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const i = (v: string): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Counts derived from the same rows the rest of the set is built from, computed once. */
function countsOf(
  comps: readonly CompRow[],
  byCode: Map<string, { on: string; value: number }[]>,
  recent: readonly RecentRow[],
  cfg: AnalyticsConfig,
): SubjectFigures['counts'] {
  let down = 0, up = 0, flat = 0, few = 0;
  for (const c of comps) {
    const arrow = halfSplitTrend(byCode.get(c.code) ?? [], cfg).arrow;
    if (arrow === 'DOWN') down++;
    else if (arrow === 'UP') up++;
    else if (arrow === 'FLAT') flat++;
    else few++;
  }
  return {
    competencies_down: down,
    competencies_up: up,
    competencies_flat: flat,
    competencies_too_few_points: few,
    records_with_a_below_standard_grade: recent.filter((r) => i(r.below) > 0).length,
  };
}

/**
 * The figure set for one pilot over the trailing `months`.
 *
 * Scoped by the CALLER: this is the analysis of a person the caller has already been permitted to
 * see. It does not re-check access, and it must never be called from a route that has not.
 */
export async function subjectFigures(personId: string, months = 12): Promise<SubjectFigures | null> {
  const cfg = analyticsConfig<AnalyticsConfig>();
  const scale = gradeScale();
  const below = scale.below_standard_max;

  const person = await queryOne<PersonRow>(
    `SELECT p.external_id, p.full_name, p.position, ac.code AS fleet, ou.code AS base
       FROM people p
       LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
       LEFT JOIN org_units ou     ON ou.id = p.org_unit_id
      WHERE p.id = $1::uuid AND p.deleted_at IS NULL`,
    [personId],
  );
  if (!person) return null;

  // One window expression, used by every query below. A figure computed over a different window
  // from the one the narrative names is the most convincing kind of wrong.
  const since = `(CURRENT_DATE - ($2::int || ' months')::interval)::date`;

  const [totals, comps, points, recent] = await Promise.all([
    queryOne<TotalsRow>(
      `SELECT count(DISTINCT r.id)::text                                   AS records,
              count(${gradeNum('rc.grade')})::text                             AS grades,
              avg(${gradeNum('rc.grade')})::numeric(4,2)::text                 AS mean,
              count(*) FILTER (WHERE ${gradeNum('rc.grade')} <= $3)::text      AS below,
              count(*) FILTER (WHERE ${gradeNum('rc.grade')} = $4)::text       AS critical,
              count(*) FILTER (WHERE ${gradeNum('rc.grade')} = $3)::text       AS boundary
         FROM records r
         JOIN record_competencies rc ON rc.record_id = r.id
        WHERE r.person_id = $1::uuid AND r.deleted_at IS NULL
          AND r.training_date >= ${since}`,
      [personId, months, below, scale.min],
    ),
    query<CompRow>(
      `SELECT c.code, c.name,
              avg(${gradeNum('rc.grade')})::numeric(4,2)::text            AS mean,
              count(${gradeNum('rc.grade')})::text                        AS graded,
              count(*) FILTER (WHERE ${gradeNum('rc.grade')} <= $3)::text AS below
         FROM record_competencies rc
         JOIN competencies c ON c.id = rc.competency_id
         JOIN competency_frameworks f ON f.id = c.framework_id AND f.is_active
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
        WHERE r.person_id = $1::uuid AND r.training_date >= ${since}
        GROUP BY c.code, c.name, c.position, c."index"
        ORDER BY c.position, c."index"`,
      [personId, months, below],
    ),
    query<PointRow>(
      `SELECT c.code, r.training_date::text AS on, ${gradeNum('rc.grade')}::text AS value
         FROM record_competencies rc
         JOIN competencies c ON c.id = rc.competency_id
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
        WHERE r.person_id = $1::uuid AND r.training_date >= ${since}
          AND ${gradeNum('rc.grade')} IS NOT NULL
        ORDER BY r.training_date`,
      [personId, months],
    ),
    query<RecentRow>(
      `SELECT r.training_date::text AS date,
              COALESCE(r.snapshot->'template'->>'name', r.title)        AS title,
              r.record_kind                                             AS kind,
              COALESCE(r.outcome_override, r.outcome)                   AS outcome,
              a.full_name                                               AS assessor,
              avg(${gradeNum('rc.grade')})::numeric(4,2)::text              AS mean,
              count(*) FILTER (WHERE ${gradeNum('rc.grade')} <= $3)::text   AS below
         FROM records r
         LEFT JOIN record_competencies rc ON rc.record_id = r.id
         LEFT JOIN people a ON a.id = r.assessor_person_id
        WHERE r.person_id = $1::uuid AND r.deleted_at IS NULL
          AND r.training_date >= ${since}
        GROUP BY r.id, r.training_date, r.title, r.snapshot, r.record_kind, r.outcome, r.outcome_override, a.full_name
        ORDER BY r.training_date DESC, r.id
        LIMIT 8`,
      [personId, months, below],
    ),
  ]);

  const byCode = new Map<string, { on: string; value: number }[]>();
  for (const p of points) {
    const v = n(p.value);
    if (v === null) continue;
    const list = byCode.get(p.code) ?? [];
    list.push({ on: p.on, value: v });
    byCode.set(p.code, list);
  }

  const grades = i(totals?.grades ?? '0');
  const belowCount = i(totals?.below ?? '0');

  return {
    subject: {
      staff_number: person.external_id,
      full_name: person.full_name,
      position: person.position,
      fleet: person.fleet,
      base: person.base,
    },
    window: {
      months,
      // Both ends are named because "the last 12 months" is not a figure anybody can check.
      from: new Date(Date.now() - months * 30.44 * 86_400_000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
    },
    totals: {
      records: i(totals?.records ?? '0'),
      competency_grades: grades,
      mean_grade: n(totals?.mean ?? null),
      below_standard: belowCount,
      // Supplied rather than left to be inferred: the model WILL want a percentage here, and a
      // percentage it computed itself is a number the gate has never seen.
      below_standard_percent: grades > 0 ? Number(((belowCount / grades) * 100).toFixed(1)) : null,
      critical_grades: i(totals?.critical ?? '0'),
      at_boundary_grades: i(totals?.boundary ?? '0'),
    },
    counts: countsOf(comps, byCode, recent, cfg),
    competencies: comps.map((c) => {
      const t = halfSplitTrend(byCode.get(c.code) ?? [], cfg);
      return {
        code: c.code,
        name: c.name,
        mean: n(c.mean),
        graded: i(c.graded),
        below_standard: i(c.below),
        trend_delta: t.delta === null ? null : Number(t.delta.toFixed(2)),
        trend: t.arrow,
      };
    }),
    recent_records: recent.map((r) => ({
      date: r.date,
      title: r.title,
      kind: r.kind,
      outcome: r.outcome,
      assessor: r.assessor,
      mean_grade: n(r.mean),
      below_standard: i(r.below),
    })),
    scale: { min: scale.min, max: scale.max, below_standard_max: below },
  };
}
