import 'server-only';
import { query, queryOne } from '@/lib/db';
import { analyticsConfig, gradeScale } from '@/lib/config';
import { screeningIndexForFramework } from './screening-index';
import type { AnalyticsConfig, GradeEvent, ScreeningBand, TrendArrow } from './types';

/**
 * lib/analytics/subject-panel.ts - what a pilot's analysis page shows BEFORE anybody asks a model
 * for anything. docs/06_ANALYTICS.md §7.
 *
 * WHY THIS EXISTS. The analysis page used to be empty until a narrative had been run, which put a
 * model between a training manager and figures that were already computed and already theirs. These
 * four panels are all deterministic SQL and arithmetic: they are right whether or not an inference
 * endpoint is configured, whether or not it is reachable, and whether or not the gate accepted what
 * it wrote.
 *
 * THE INDEX IS THE KIT'S OWN, AND IT IS PER COMPETENCY. lib/analytics/screening-index.ts was
 * written, specified in analytics.yaml and unit-tested, and until now no screen read it. Its header
 * says in as many words why there is no single number per pilot:
 *
 *     "There is deliberately no subject-level rollup: averaging across competencies is exactly the
 *      compensation this index exists to prevent."
 *
 * That is the whole argument against a composite pilot-health score, and it is worth keeping: a
 * composite lets a 5 in Communication cancel a 2 in Flight Path Management, and the first chief
 * pilot who notices that stops trusting the screen. Nine banded rows answer "where do I look"
 * without ever claiming a pilot has one number.
 *
 * THE PEER GROUP IS THE SAME FLEET, not the whole airline: an A320 first officer compared against a
 * B787 captain's grades is a comparison nobody asked for. Where the fleet is unknown the peer group
 * widens to everybody and the label says so, because a silently different denominator is worse than
 * a wide one.
 */

export interface ReliabilityRow {
  readonly competencyId: string;
  readonly code: string;
  readonly name: string;
  readonly colour: string;
  readonly band: ScreeningBand;
  readonly score: number | null;
  readonly trend: TrendArrow;
  readonly n: number;
  /** Events since the last below-standard grade, or null when there has not been one. */
  readonly sinceBelow: number | null;
  readonly recovery: { readonly achieved: number; readonly required: number } | null;
  /**
   * The last few grades in this competency, oldest first. The index is one number and a number
   * hides its own shape: 3,3,3,3,3 and 2,4,2,4,3 can score the same and are not the same pilot.
   */
  readonly recent: readonly number[];
}

export interface PeerRow {
  readonly code: string;
  readonly name: string;
  readonly colour: string;
  readonly subjectMean: number | null;
  readonly subjectN: number;
  readonly peerMean: number | null;
  readonly peerN: number;
}

export interface TrendPoint {
  readonly on: string;
  readonly subject: number | null;
  readonly subjectN: number;
  readonly peer: number | null;
}

export interface SubjectPanel {
  readonly peerLabel: string;
  readonly months: number;
  readonly reliability: readonly ReliabilityRow[];
  readonly peer: readonly PeerRow[];
  readonly trend: readonly TrendPoint[];
  readonly distribution: {
    readonly subject: ReadonlyArray<{ grade: number; count: number }>;
    readonly peer: ReadonlyArray<{ grade: number; count: number }>;
  };
}

interface CompetencyRow { id: string; code: string; name: string; colour: string }
interface EventRow {
  record_id: string; competency_id: string; on: string; grade_value: number;
  assessor_id: string | null; assessor_delta: string | null; assessor_n_records: number | null;
}
interface MeanRow { code: string; name: string; colour: string; n: string; mean: string | null }
interface PeerMeanRow { code: string; n: string; mean: string | null }
interface MonthRow { on: string; n: string; mean: string | null }
interface DistRow { grade: number; n: string }

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function subjectPanel(personId: string, months = 12): Promise<SubjectPanel | null> {
  const cfg = analyticsConfig<AnalyticsConfig>();
  const scale = gradeScale();
  const minSessions = cfg.screening_index.leniency.min_sessions;

  const person = await queryOne<{ fleet: string | null; asset_class_id: string | null }>(
    `SELECT ac.code AS fleet, p.asset_class_id
       FROM people p LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
      WHERE p.id = $1::uuid AND p.deleted_at IS NULL`,
    [personId],
  );
  if (!person) return null;

  // The peer predicate, built once and reused, so every panel on this page shares one denominator.
  // A page whose four charts quietly compare against four different populations is a page that
  // cannot be reasoned about.
  const peerJoin = person.asset_class_id
    ? `JOIN people pp ON pp.id = r.person_id AND pp.deleted_at IS NULL AND pp.asset_class_id = $2::uuid AND pp.id <> $1::uuid`
    : `JOIN people pp ON pp.id = r.person_id AND pp.deleted_at IS NULL AND pp.id <> $1::uuid`;
  const peerParams: unknown[] = person.asset_class_id ? [personId, person.asset_class_id] : [personId];
  const peerLabel = person.fleet ? `other ${person.fleet} pilots` : 'every other pilot';
  const m = String(peerParams.length + 1);

  const [comps, events, own, peer, ownMonths, peerMonths, ownDist, peerDist] = await Promise.all([
    query<CompetencyRow>(
      `SELECT c.id, c.code, c.name, c.colour
         FROM competencies c
         JOIN competency_frameworks f ON f.id = c.framework_id AND f.is_active
        WHERE c.is_active ORDER BY c.position, c."index"`),

    /* EVERY event, not the last twelve months: the critical flag is evaluated over the full history
       on purpose - a grade of 1 does not stop mattering because time passed, only because the pilot
       has posted a clean run since. The window lives inside the index, in events. */
    query<EventRow>(
      `SELECT rc.record_id, rc.competency_id, r.training_date::text AS "on",
              grade_num(rc.grade)::int AS grade_value,
              r.assessor_person_id AS assessor_id,
              a.delta_unadjusted::text AS assessor_delta,
              a.n_records::int AS assessor_n_records
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         LEFT JOIN mv_assessor_adjusted a ON a.assessor_id = r.assessor_person_id
        WHERE r.person_id = $1::uuid AND grade_num(rc.grade) IS NOT NULL
        ORDER BY r.training_date, rc.record_id`,
      [personId]),

    query<MeanRow>(
      `SELECT c.code, c.name, c.colour, count(*)::text AS n, avg(grade_num(rc.grade))::text AS mean
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         JOIN competencies c ON c.id = rc.competency_id
        WHERE r.person_id = $1::uuid AND grade_num(rc.grade) IS NOT NULL
          AND r.training_date >= CURRENT_DATE - make_interval(months => $2::int)
        GROUP BY c.code, c.name, c.colour`,
      [personId, months]),

    query<PeerMeanRow>(
      `SELECT c.code, count(*)::text AS n, avg(grade_num(rc.grade))::text AS mean
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         ${peerJoin}
         JOIN competencies c ON c.id = rc.competency_id
        WHERE grade_num(rc.grade) IS NOT NULL
          AND r.training_date >= CURRENT_DATE - make_interval(months => $${m}::int)
        GROUP BY c.code`,
      [...peerParams, months]),

    query<MonthRow>(
      `SELECT to_char(date_trunc('month', r.training_date), 'YYYY-MM-01') AS "on",
              count(*)::text AS n, avg(grade_num(rc.grade))::text AS mean
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
        WHERE r.person_id = $1::uuid AND grade_num(rc.grade) IS NOT NULL
          AND r.training_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int)
        GROUP BY 1 ORDER BY 1`,
      [personId, months]),

    query<MonthRow>(
      `SELECT to_char(date_trunc('month', r.training_date), 'YYYY-MM-01') AS "on",
              count(*)::text AS n, avg(grade_num(rc.grade))::text AS mean
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         ${peerJoin}
        WHERE grade_num(rc.grade) IS NOT NULL
          AND r.training_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $${m}::int)
        GROUP BY 1 ORDER BY 1`,
      [...peerParams, months]),

    query<DistRow>(
      `SELECT grade_num(rc.grade)::int AS grade, count(*)::text AS n
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
        WHERE r.person_id = $1::uuid AND grade_num(rc.grade) IS NOT NULL
          AND r.training_date >= CURRENT_DATE - make_interval(months => $2::int)
        GROUP BY 1 ORDER BY 1`,
      [personId, months]),

    query<DistRow>(
      `SELECT grade_num(rc.grade)::int AS grade, count(*)::text AS n
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         ${peerJoin}
        WHERE grade_num(rc.grade) IS NOT NULL
          AND r.training_date >= CURRENT_DATE - make_interval(months => $${m}::int)
        GROUP BY 1 ORDER BY 1`,
      [...peerParams, months]),
  ]);

  const gradeEvents: GradeEvent[] = events.map((e) => ({
    recordId: e.record_id,
    competencyId: e.competency_id,
    occurredOn: e.on,
    gradeValue: e.grade_value,
    assessorId: e.assessor_id,
    assessorDelta: num(e.assessor_delta),
    // The sample test is the assessor's, not this pilot's: below it the assessor's mean is dominated
    // by WHICH subjects they happened to assess, so the index keeps the event at reduced weight
    // rather than adjusting it. screening_index.leniency in analytics.yaml.
    assessorQualifies: (e.assessor_n_records ?? 0) >= minSessions,
  }));

  const RECENT = 5;
  const recentByComp = new Map<string, number[]>();
  for (const e of gradeEvents) {
    const list = recentByComp.get(e.competencyId) ?? [];
    list.push(e.gradeValue);
    recentByComp.set(e.competencyId, list);
  }

  const results = screeningIndexForFramework(comps.map((c) => c.id), gradeEvents, cfg);
  const byId = new Map(comps.map((c) => [c.id, c]));
  const eventsPerComp = new Map<string, number>();
  for (const e of gradeEvents) eventsPerComp.set(e.competencyId, (eventsPerComp.get(e.competencyId) ?? 0) + 1);

  const reliability: ReliabilityRow[] = results.map((r) => {
    const c = byId.get(r.competencyId)!;
    return {
      competencyId: r.competencyId, code: c.code, name: c.name, colour: c.colour,
      band: r.band,
      score: r.score.ok ? r.score.value : null,
      trend: r.trend,
      n: eventsPerComp.get(r.competencyId) ?? 0,
      sinceBelow: r.sinceBelow,
      recovery: r.recovery,
      recent: (recentByComp.get(r.competencyId) ?? []).slice(-RECENT),
    };
  });

  const peerByCode = new Map(peer.map((p) => [p.code, p]));
  const ownByCode = new Map(own.map((o) => [o.code, o]));
  const peerRows: PeerRow[] = comps.map((c) => {
    const o = ownByCode.get(c.code); const p = peerByCode.get(c.code);
    return {
      code: c.code, name: c.name, colour: c.colour,
      subjectMean: num(o?.mean ?? null), subjectN: Number(o?.n ?? 0),
      peerMean: num(p?.mean ?? null), peerN: Number(p?.n ?? 0),
    };
  });

  // A month with no training is a GAP, never a zero: the pilot did not score nought that month,
  // they did not fly. Both series are keyed off the peer months so the two lines share an axis.
  const ownMonthByKey = new Map(ownMonths.map((r) => [r.on, r]));
  const keys = [...new Set([...peerMonths.map((r) => r.on), ...ownMonths.map((r) => r.on)])].sort();
  const trend: TrendPoint[] = keys.map((on) => {
    const o = ownMonthByKey.get(on);
    const p = peerMonths.find((x) => x.on === on);
    return { on, subject: num(o?.mean ?? null), subjectN: Number(o?.n ?? 0), peer: num(p?.mean ?? null) };
  });

  const toCounts = (rows: DistRow[]) => {
    const out: { grade: number; count: number }[] = [];
    for (let g = scale.min; g <= scale.max; g += 1) {
      out.push({ grade: g, count: Number(rows.find((r) => r.grade === g)?.n ?? 0) });
    }
    return out;
  };

  return {
    peerLabel, months, reliability, peer: peerRows, trend,
    distribution: { subject: toCounts(ownDist), peer: toCounts(peerDist) },
  };
}
