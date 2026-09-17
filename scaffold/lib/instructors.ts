import { query, queryOne } from '@/lib/db';
import { analyticsConfig, checkKinds, failOutcomes, policy } from '@/lib/config';
import { standardisationIndex, justificationRate, olsSlope, welch, type AnalyticsConfig, type AsiResult, type WelchResult } from '@/lib/analytics';

/**
 * lib/instructors.ts - the instructor bench and one instructor's grading profile.
 *
 * Reads the kit's assessor analytics views (db/migrations/0111-0116, materialised as mv_* by 0147
 * and refreshed by the history seeder / npm run analytics:refresh): every figure here is the
 * SAME figure the views define - the adjusted (shrunk) leniency delta measured against what the
 * same pilots scored with other instructors, the halo and justification habits, the not-observed
 * excess, the monthly residual rollup - and the standardisation index is the pure function in
 * lib/analytics/assessor-fairness.ts fed from those views. Nothing is recomputed here with a
 * different formula, so the list, the profile and any later report agree to the digit.
 *
 * Who is an instructor: a person on the roster with at least one instructor role (TRI, TRE, LTC,
 * SFI, ground...). Someone without a role who has nevertheless signed sessions is still in the
 * views and still shapes every expected grade; they are simply not listed on the bench.
 *
 * Access is the caller's business: pages pass the visible person ids (visiblePersonIds with
 * training.analytics.assessor.view, which excludes the holder) and these functions filter by them.
 */

export interface BenchFilters { q: string; fleet: string; base: string; qual: string; sort: string }

export interface BenchRow {
  id: string; external_id: string; seniority_number: number | null; full_name: string; position: string | null; fleet: string | null; base: string | null;
  instructor_roles: string[];
  sessions_12m: number; sim_12m: number; line_12m: number; ground_12m: number; planned: number;
  last_session: string | null;
  n_records: number | null; n_subjects: number | null; mean_grade: number | null;
  delta_adjusted: number | null; delta_unadjusted: number | null; ci_half_width: number | null; is_provisional: boolean; is_outlier: boolean;
  halo_rate: number | null;
  total: number;
}

export type Leaning = 'lenient' | 'leans_lenient' | 'in_line' | 'leans_strict' | 'strict' | 'provisional' | 'no_data';

/** Where an instructor's adjusted delta sits against the outlier threshold. Half the threshold is "leans". */
export function leaning(delta: number | null, provisional: boolean, cfg: AnalyticsConfig = analyticsConfig<AnalyticsConfig>()): Leaning {
  if (delta === null) return 'no_data';
  if (provisional) return 'provisional';
  const abs = cfg.assessor_fairness.adjusted_delta.outlier_abs;
  if (delta >= abs) return 'lenient';
  if (delta <= -abs) return 'strict';
  if (delta >= abs / 2) return 'leans_lenient';
  if (delta <= -abs / 2) return 'leans_strict';
  return 'in_line';
}

export const LEANING_LABEL: Record<Leaning, string> = {
  lenient: 'Lenient', leans_lenient: 'Leans lenient', in_line: 'In line', leans_strict: 'Leans strict', strict: 'Strict', provisional: 'Provisional', no_data: 'No grades',
};
export const LEANING_TONE: Record<Leaning, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  lenient: 'bad', leans_lenient: 'warn', in_line: 'good', leans_strict: 'warn', strict: 'bad', provisional: 'neutral', no_data: 'neutral',
};

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** The habit quantities the standardisation index is built from, per instructor. */
export interface AsiInputs {
  delta_adjusted: number | null;
  sigma_grade: number | null;
  n_records: number;
  n_halo: number; n_halo_eligible: number;
  n_below: number; n_substantive: number;
  nr_excess: number | null;
  /** One point per month with grades: x in days, y the mean residual. */
  monthly: { x: number; mean_residual: number | null }[];
}

export interface AsiDerived { asi: AsiResult; halo_rate: number | null; justification_rate: number | null; drift: number | null }

/**
 * The index and the three rates behind it, from lib/analytics/assessor-fairness.ts. One function so
 * the bench, the profile and the analysis page cannot disagree: a term is unavailable here exactly
 * where its input cannot exist, which is what makes the rescaling honest (docs/06 §13.5).
 */
export function computeAsi(i: AsiInputs, cfg: AnalyticsConfig): AsiDerived {
  const halo_rate = i.n_halo_eligible > 0 ? i.n_halo / i.n_halo_eligible : null;
  const justification_rate = justificationRate(i.n_substantive, i.n_below);
  const points = i.monthly.filter((m) => m.mean_residual !== null).map((m) => ({ x: m.x, y: m.mean_residual as number }));
  const slope = points.length >= cfg.trend.min_points ? olsSlope(points) : null;
  const drift = slope === null ? null : slope * cfg.trend.slope_interval_days;
  const asi = standardisationIndex({
    delta: i.delta_adjusted, sigma: i.sigma_grade, justificationRate: justification_rate, haloRate: halo_rate,
    drift, notObservedExcess: i.nr_excess, nRecords: i.n_records,
  }, {}, cfg);
  return { asi, halo_rate, justification_rate, drift };
}

interface RawBench {
  id: string; external_id: string; seniority_number: number | null; full_name: string; position: string | null; fleet: string | null; base: string | null; instructor_roles: string[] | null;
  sessions_12m: number; sim_12m: number; line_12m: number; ground_12m: number; planned: number; last_session: string | null;
  n_records: string | null; n_subjects: string | null; mean_grade: string | null; delta_adjusted: string | null; delta_unadjusted: string | null; ci_half_width: string | null;
  is_provisional: boolean; is_outlier: boolean; halo_rate: string | null; total: number;
}

/** The bench: instructors with their last-12-month activity and their adjusted leniency. */
export async function listInstructors(f: BenchFilters, visible: Set<string> | null, page: number, size: number): Promise<BenchRow[]> {
  const where: string[] = ["p.deleted_at IS NULL AND p.roster_status = 'active' AND cardinality(p.instructor_roles) > 0"];
  const params: unknown[] = [];
  if (visible) { if (visible.size === 0) where.push('false'); else { params.push([...visible]); where.push(`p.id = ANY($${params.length}::uuid[])`); } }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(p.full_name ILIKE $${params.length} OR p.external_id ILIKE $${params.length} OR p.seniority_number::text = $${params.length})`); }
  if (f.fleet) { params.push(f.fleet); where.push(`ac.code = $${params.length}`); }
  if (f.base) { params.push(f.base); where.push(`ou.code = $${params.length}`); }
  if (f.qual) { params.push(f.qual); where.push(`$${params.length} = ANY(p.instructor_roles)`); }
  const order = f.sort === 'lenient' ? 'a.delta_adjusted DESC NULLS LAST' : f.sort === 'strict' ? 'a.delta_adjusted ASC NULLS LAST' : f.sort === 'active' ? 'sessions_12m DESC' : 'p.seniority_number NULLS LAST';
  const rows = await query<RawBench>(`
    WITH given AS (
      SELECT s.assessor_person_id AS id,
             count(*) FILTER (WHERE s.status <> 'in_progress' AND s.session_date >= CURRENT_DATE - INTERVAL '12 months')::int AS sessions_12m,
             count(*) FILTER (WHERE s.status <> 'in_progress' AND s.session_date >= CURRENT_DATE - INTERVAL '12 months' AND s.facility_kind IN ('ffs','other'))::int AS sim_12m,
             count(*) FILTER (WHERE s.status <> 'in_progress' AND s.session_date >= CURRENT_DATE - INTERVAL '12 months' AND s.facility_kind IN ('line','aircraft'))::int AS line_12m,
             count(*) FILTER (WHERE s.status <> 'in_progress' AND s.session_date >= CURRENT_DATE - INTERVAL '12 months' AND s.facility_kind = 'classroom')::int AS ground_12m,
             count(*) FILTER (WHERE s.status = 'in_progress' AND s.session_date >= CURRENT_DATE)::int AS planned,
             max(s.session_date) FILTER (WHERE s.status <> 'in_progress')::text AS last_session
        FROM sessions s WHERE s.deleted_at IS NULL AND s.status <> 'void' GROUP BY s.assessor_person_id)
    SELECT p.id, p.external_id, p.seniority_number, p.full_name, p.position, ac.code AS fleet, ou.code AS base, p.instructor_roles,
           COALESCE(g.sessions_12m, 0) AS sessions_12m, COALESCE(g.sim_12m, 0) AS sim_12m, COALESCE(g.line_12m, 0) AS line_12m, COALESCE(g.ground_12m, 0) AS ground_12m, COALESCE(g.planned, 0) AS planned, g.last_session,
           a.n_records, a.n_subjects, a.mean_grade::text AS mean_grade, a.delta_adjusted::text AS delta_adjusted, a.delta_unadjusted::text AS delta_unadjusted, a.ci_half_width::text AS ci_half_width,
           COALESCE(a.is_provisional, true) AS is_provisional, COALESCE(a.is_outlier, false) AS is_outlier,
           (h.n_halo_records::numeric / NULLIF(h.n_eligible_records, 0))::text AS halo_rate,
           count(*) OVER ()::int AS total
      FROM people p
      LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
      LEFT JOIN org_units ou ON ou.id = p.org_unit_id
      LEFT JOIN given g ON g.id = p.id
      LEFT JOIN mv_assessor_adjusted a ON a.assessor_id = p.id
      LEFT JOIN mv_assessor_halo h ON h.assessor_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}, p.seniority_number NULLS LAST
     LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
  return rows.map((r) => ({
    id: r.id, external_id: r.external_id, seniority_number: num(r.seniority_number), full_name: r.full_name, position: r.position, fleet: r.fleet, base: r.base,
    instructor_roles: r.instructor_roles ?? [],
    sessions_12m: Number(r.sessions_12m), sim_12m: Number(r.sim_12m), line_12m: Number(r.line_12m), ground_12m: Number(r.ground_12m), planned: Number(r.planned), last_session: r.last_session,
    n_records: num(r.n_records), n_subjects: num(r.n_subjects), mean_grade: num(r.mean_grade),
    delta_adjusted: num(r.delta_adjusted), delta_unadjusted: num(r.delta_unadjusted), ci_half_width: num(r.ci_half_width),
    is_provisional: Boolean(r.is_provisional), is_outlier: Boolean(r.is_outlier), halo_rate: num(r.halo_rate), total: Number(r.total),
  }));
}

// ---------------------------------------------------------------------------------- one instructor

export interface InstructorProfile {
  person: { id: string; external_id: string; seniority_number: number | null; full_name: string; position: string | null; fleet: string | null; base: string | null; instructor_roles: string[]; rank_since: string | null; has_login: boolean };
  status: 'current' | 'dormant' | 'former' | 'no_grades';
  activity: { sessions_12m: number; sim_12m: number; line_12m: number; ground_12m: number; planned: number; first_session: string | null; last_session: string | null; pilots_12m: number };
  adjusted: { n_grades: number; n_records: number; n_subjects: number; mean_grade: number | null; sigma_grade: number | null; delta_adjusted: number | null; delta_unadjusted: number | null; ci_half_width: number | null; is_provisional: boolean; is_outlier: boolean; share_above_level_1: number | null } | null;
  groupMean: number | null;
  competencies: { id: string; code: string; name: string; colour: string; n: number; own_mean: number | null; group_mean: number | null; mean_residual: number | null }[];
  distribution: { grade: number; own: number; all: number }[];
  ownGrades: number; allGrades: number;
  habits: { halo_rate: number | null; n_halo: number; n_halo_eligible: number; justification_rate: number | null; n_below: number; n_substantive: number; nr_excess: number | null; actual_nr_rate: number | null; expected_nr_rate: number | null };
  outcomes: { outcome: string; n: number }[]; additionalTraining: number; recordsTotal: number;
  obHabits: { code: string; text: string; competency: string; own_n: number; own_share: number; all_share: number }[];
  monthly: { on: string; value: number | null; label: string }[];
  asi: AsiResult | null;
}

export async function getInstructor(id: string): Promise<InstructorProfile | null> {
  const cfg = analyticsConfig<AnalyticsConfig>();
  const person = await queryOne<InstructorProfile['person']>(`
    SELECT p.id, p.external_id, p.seniority_number, p.full_name, p.position, ac.code AS fleet, ou.code AS base, p.instructor_roles, p.rank_since::text AS rank_since,
           EXISTS (SELECT 1 FROM users u WHERE u.person_id = p.id AND u.is_active) AS has_login
      FROM people p LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id LEFT JOIN org_units ou ON ou.id = p.org_unit_id
     WHERE p.id = $1::uuid AND p.deleted_at IS NULL`, [id]);
  if (!person) return null;

  type Row = Record<string, string | number | boolean | null>;
  const [activity, adjusted, group, comps, dist, halo, just, nr, outcomes, obs, monthly] = await Promise.all([
    queryOne<Row>(`
      SELECT count(*) FILTER (WHERE s.status <> 'in_progress' AND s.session_date >= CURRENT_DATE - INTERVAL '12 months')::int AS sessions_12m,
             count(*) FILTER (WHERE s.status <> 'in_progress' AND s.session_date >= CURRENT_DATE - INTERVAL '12 months' AND s.facility_kind IN ('ffs','other'))::int AS sim_12m,
             count(*) FILTER (WHERE s.status <> 'in_progress' AND s.session_date >= CURRENT_DATE - INTERVAL '12 months' AND s.facility_kind IN ('line','aircraft'))::int AS line_12m,
             count(*) FILTER (WHERE s.status <> 'in_progress' AND s.session_date >= CURRENT_DATE - INTERVAL '12 months' AND s.facility_kind = 'classroom')::int AS ground_12m,
             count(*) FILTER (WHERE s.status = 'in_progress' AND s.session_date >= CURRENT_DATE)::int AS planned,
             min(s.session_date) FILTER (WHERE s.status <> 'in_progress')::text AS first_session,
             max(s.session_date) FILTER (WHERE s.status <> 'in_progress')::text AS last_session,
             (SELECT count(DISTINCT ss.person_id) FROM sessions s2 JOIN session_subjects ss ON ss.session_id = s2.id
               WHERE s2.assessor_person_id = $1::uuid AND s2.deleted_at IS NULL AND s2.status NOT IN ('in_progress','void') AND s2.session_date >= CURRENT_DATE - INTERVAL '12 months')::int AS pilots_12m
        FROM sessions s WHERE s.assessor_person_id = $1::uuid AND s.deleted_at IS NULL AND s.status <> 'void'`, [id]),
    queryOne<Row>(`SELECT n_grades, n_records, n_subjects, mean_grade::text AS mean_grade, sigma_grade::text AS sigma_grade, delta_adjusted::text AS delta_adjusted, delta_unadjusted::text AS delta_unadjusted, ci_half_width::text AS ci_half_width, is_provisional, is_outlier, share_above_level_1::text AS share_above_level_1 FROM mv_assessor_adjusted WHERE assessor_id = $1::uuid`, [id]),
    queryOne<Row>(`SELECT group_mean::text AS m FROM mv_assessor_group WHERE everyone`),
    query<Row>(`
      SELECT c.id, c.code, c.name, c.colour, COALESCE(o.n, 0)::int AS n, o.own_mean::text AS own_mean, o.mean_residual::text AS mean_residual, g.group_mean::text AS group_mean
        FROM competencies c JOIN competency_frameworks f ON f.id = c.framework_id AND f.is_active
        LEFT JOIN mv_assessor_competency_raw o ON o.competency_id = c.id AND o.assessor_id = $1::uuid
        LEFT JOIN mv_assessor_group g ON g.competency_id = c.id AND NOT g.everyone
       WHERE c.is_active ORDER BY c.position, c."index"`, [id]),
    query<Row>(`
      SELECT g.grade, COALESCE(o.n, 0)::int AS own, g.n::int AS "all"
        FROM mv_assessor_distribution g LEFT JOIN mv_assessor_distribution o ON o.grade = g.grade AND o.assessor_id = $1::uuid AND NOT o.everyone
       WHERE g.everyone ORDER BY g.grade`, [id]),
    queryOne<Row>(`SELECT n_eligible_records, n_halo_records FROM mv_assessor_halo WHERE assessor_id = $1::uuid`, [id]),
    queryOne<Row>(`SELECT n_below_standard, n_substantive FROM mv_assessor_justification WHERE assessor_id = $1::uuid`, [id]),
    queryOne<Row>(`SELECT actual_nr_rate::text AS actual_nr_rate, expected_nr_rate::text AS expected_nr_rate, nr_excess::text AS nr_excess FROM mv_assessor_nr_excess WHERE assessor_id = $1::uuid`, [id]),
    query<Row>(`
      SELECT COALESCE(r.outcome_override, r.outcome, 'no outcome') AS outcome, count(*)::int AS n,
             count(*) FILTER (WHERE COALESCE((r.snapshot->>'additional_training')::boolean, false))::int AS additional
        FROM records r WHERE r.assessor_person_id = $1::uuid AND r.deleted_at IS NULL GROUP BY 1 ORDER BY n DESC`, [id]),
    query<Row>(`
      WITH picks AS (
        SELECT r.assessor_person_id AS assessor_id, obid
          FROM records r JOIN record_competencies rc ON rc.record_id = r.id, unnest(rc.observable_behaviour_ids) AS obid
         WHERE r.deleted_at IS NULL),
      own AS (SELECT obid, count(*)::numeric AS n FROM picks WHERE assessor_id = $1::uuid GROUP BY obid),
      own_total AS (SELECT count(*)::numeric AS t FROM picks WHERE assessor_id = $1::uuid),
      all_total AS (SELECT count(*)::numeric AS t FROM picks),
      alln AS (SELECT obid, count(*)::numeric AS n FROM picks GROUP BY obid)
      SELECT ob.code, ob.text, c.code AS competency, own.n::int AS own_n,
             (own.n / NULLIF((SELECT t FROM own_total), 0))::text AS own_share,
             (alln.n / NULLIF((SELECT t FROM all_total), 0))::text AS all_share
        FROM own JOIN alln ON alln.obid = own.obid
        JOIN observable_behaviours ob ON ob.id = own.obid JOIN competencies c ON c.id = ob.competency_id
       ORDER BY own.n DESC, ob.code LIMIT 6`, [id]),
    query<Row>(`SELECT period_month::text AS on, n_grades::int AS n, (sum_r / NULLIF(n_grades, 0))::text AS mean_residual, (sum_x / NULLIF(n_grades, 0))::text AS x
                  FROM mv_assessor_monthly WHERE assessor_id = $1::uuid ORDER BY period_month`, [id]),
  ]);

  const adj = adjusted ? {
    n_grades: Number(adjusted.n_grades), n_records: Number(adjusted.n_records), n_subjects: Number(adjusted.n_subjects),
    mean_grade: num(adjusted.mean_grade as string | null), sigma_grade: num(adjusted.sigma_grade as string | null),
    delta_adjusted: num(adjusted.delta_adjusted as string | null), delta_unadjusted: num(adjusted.delta_unadjusted as string | null), ci_half_width: num(adjusted.ci_half_width as string | null),
    is_provisional: Boolean(adjusted.is_provisional), is_outlier: Boolean(adjusted.is_outlier), share_above_level_1: num(adjusted.share_above_level_1 as string | null),
  } : null;

  const nHalo = Number(halo?.n_halo_records ?? 0); const nHaloEligible = Number(halo?.n_eligible_records ?? 0);
  const nBelow = Number(just?.n_below_standard ?? 0); const nSubstantive = Number(just?.n_substantive ?? 0);
  const nrExcess = num(nr?.nr_excess as string | null);
  const derived = adj ? computeAsi({
    delta_adjusted: adj.delta_adjusted, sigma_grade: adj.sigma_grade, n_records: adj.n_records,
    n_halo: nHalo, n_halo_eligible: nHaloEligible, n_below: nBelow, n_substantive: nSubstantive, nr_excess: nrExcess,
    monthly: monthly.map((m) => ({ x: Number(m.x), mean_residual: m.mean_residual === null ? null : Number(m.mean_residual) })),
  }, cfg) : null;
  const haloRate = derived?.halo_rate ?? null;
  const jRate = derived?.justification_rate ?? null;
  const asi = derived?.asi ?? null;

  const lastGraded = activity?.last_session as string | null;
  const dormantDays = cfg.assessor_fairness.status.dormant_after_days;
  // Status is a display filter only (the views keep everyone's grades in every mean). 'former' needs an account model the demo does not carry.
  const status: InstructorProfile['status'] = !adj ? 'no_grades' : !lastGraded ? 'dormant' : (Date.now() - new Date(lastGraded).getTime()) / 86400000 > dormantDays ? 'dormant' : 'current';

  const ownGrades = dist.reduce((s, d) => s + Number(d.own), 0); const allGrades = dist.reduce((s, d) => s + Number(d.all), 0);
  return {
    person,
    status,
    activity: { sessions_12m: Number(activity?.sessions_12m ?? 0), sim_12m: Number(activity?.sim_12m ?? 0), line_12m: Number(activity?.line_12m ?? 0), ground_12m: Number(activity?.ground_12m ?? 0), planned: Number(activity?.planned ?? 0), first_session: (activity?.first_session as string | null) ?? null, last_session: lastGraded ?? null, pilots_12m: Number(activity?.pilots_12m ?? 0) },
    adjusted: adj,
    groupMean: num(group?.m as string | null),
    competencies: comps.map((c) => ({ id: String(c.id), code: String(c.code), name: String(c.name), colour: String(c.colour), n: Number(c.n), own_mean: num(c.own_mean as string | null), group_mean: num(c.group_mean as string | null), mean_residual: num(c.mean_residual as string | null) })),
    distribution: dist.map((d) => ({ grade: Number(d.grade), own: Number(d.own), all: Number(d.all) })),
    ownGrades, allGrades,
    habits: { halo_rate: haloRate, n_halo: nHalo, n_halo_eligible: nHaloEligible, justification_rate: jRate, n_below: nBelow, n_substantive: nSubstantive, nr_excess: nrExcess, actual_nr_rate: num(nr?.actual_nr_rate as string | null), expected_nr_rate: num(nr?.expected_nr_rate as string | null) },
    outcomes: outcomes.map((o) => ({ outcome: String(o.outcome), n: Number(o.n) })),
    additionalTraining: outcomes.reduce((s, o) => s + Number(o.additional), 0),
    recordsTotal: outcomes.reduce((s, o) => s + Number(o.n), 0),
    obHabits: obs.map((o) => ({ code: String(o.code), text: String(o.text), competency: String(o.competency), own_n: Number(o.own_n), own_share: Number(o.own_share), all_share: Number(o.all_share) })),
    monthly: monthly.map((m) => ({ on: String(m.on), value: m.mean_residual === null ? null : Number(m.mean_residual), label: `${String(m.on).slice(0, 7)} · ${m.n} grades · mean residual ${Number(m.mean_residual).toFixed(2)}` })),
    asi,
  };
}

// ------------------------------------------------------------------- the bench, analysed together

export interface AnalysisRow {
  id: string; external_id: string; seniority_number: number | null; full_name: string; position: string | null;
  fleet: string | null; base: string | null; instructor_roles: string[];
  n_grades: number; n_records: number; n_subjects: number;
  mean_grade: number | null; sigma_grade: number | null;
  delta_adjusted: number | null; delta_unadjusted: number | null; ci_half_width: number | null;
  is_provisional: boolean; is_outlier: boolean; share_above_level_1: number | null;
  asi: AsiResult | null; halo_rate: number | null; justification_rate: number | null; drift: number | null;
  /** Own mean per competency id, and the raw residual, for the bias heatmap. */
  cells: Record<string, { n: number; own_mean: number | null; mean_residual: number | null }>;
}

export interface BenchAnalysis {
  rows: AnalysisRow[];
  competencies: { id: string; code: string; name: string; colour: string; group_mean: number | null; n: number }[];
  groupMean: number | null;
  /** Median adjusted delta over the instructors that are banded; the reference rule on every chart. */
  peerMedianDelta: number | null;
  totals: { instructors: number; banded: number; provisional: number; outliers: number; grades: number; fellBack: number };
}

/**
 * The whole bench with its standardisation figures, for /instructors/analysis.
 *
 * Reads the materialised assessor views only (migration 0147), so this is a handful of indexed
 * scans rather than the expected-grade join. Every instructor's ASI is computed by computeAsi, the
 * same function the individual profile uses.
 *
 * Baselines - the peer mean per competency, the group mean, the median delta - are computed over
 * EVERY instructor, including one the caller cannot see: excluding them would give each viewer a
 * different baseline, which is the distinction docs/06 §13.7 requires the surface to state. The
 * ROWS honour the caller's scope, which for this capability excludes the caller themselves.
 */
export async function benchAnalysis(f: BenchFilters, visible: Set<string> | null): Promise<BenchAnalysis> {
  const cfg = analyticsConfig<AnalyticsConfig>();
  const where: string[] = ["p.deleted_at IS NULL AND p.roster_status = 'active' AND cardinality(p.instructor_roles) > 0"];
  const params: unknown[] = [];
  if (visible) { if (visible.size === 0) where.push('false'); else { params.push([...visible]); where.push(`p.id = ANY($${params.length}::uuid[])`); } }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(p.full_name ILIKE $${params.length} OR p.external_id ILIKE $${params.length})`); }
  if (f.fleet) { params.push(f.fleet); where.push(`ac.code = $${params.length}`); }
  if (f.base) { params.push(f.base); where.push(`ou.code = $${params.length}`); }
  if (f.qual) { params.push(f.qual); where.push(`$${params.length} = ANY(p.instructor_roles)`); }

  type R = Record<string, string | number | boolean | string[] | null>;
  const people = await query<R>(`
    SELECT p.id, p.external_id, p.seniority_number, p.full_name, p.position, ac.code AS fleet, ou.code AS base, p.instructor_roles,
           a.n_grades, a.n_records, a.n_subjects, a.mean_grade::text AS mean_grade, a.sigma_grade::text AS sigma_grade,
           a.delta_adjusted::text AS delta_adjusted, a.delta_unadjusted::text AS delta_unadjusted, a.ci_half_width::text AS ci_half_width,
           a.is_provisional, a.is_outlier, a.share_above_level_1::text AS share_above_level_1,
           h.n_halo_records, h.n_eligible_records, j.n_below_standard, j.n_substantive, nr.nr_excess::text AS nr_excess
      FROM people p
      LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
      LEFT JOIN org_units ou ON ou.id = p.org_unit_id
      JOIN mv_assessor_adjusted a ON a.assessor_id = p.id
      LEFT JOIN mv_assessor_halo h ON h.assessor_id = p.id
      LEFT JOIN mv_assessor_justification j ON j.assessor_id = p.id
      LEFT JOIN mv_assessor_nr_excess nr ON nr.assessor_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY a.delta_adjusted DESC NULLS LAST`, params);
  const ids = people.map((r) => String(r.id));

  const [monthly, cells, comps] = await Promise.all([
    ids.length ? query<R>(`SELECT assessor_id, (sum_x / NULLIF(n_grades, 0))::text AS x, (sum_r / NULLIF(n_grades, 0))::text AS mean_residual
                             FROM mv_assessor_monthly WHERE assessor_id = ANY($1::uuid[]) ORDER BY period_month`, [ids]) : [],
    ids.length ? query<R>(`SELECT assessor_id, competency_id, n, own_mean::text AS own_mean, mean_residual::text AS mean_residual
                             FROM mv_assessor_competency_raw WHERE assessor_id = ANY($1::uuid[])`, [ids]) : [],
    query<R>(`
      SELECT c.id, c.code, c.name, c.colour, g.group_mean::text AS group_mean, COALESCE(g.n, 0) AS n
        FROM competencies c JOIN competency_frameworks fr ON fr.id = c.framework_id AND fr.is_active
        LEFT JOIN mv_assessor_group g ON g.competency_id = c.id AND NOT g.everyone
       WHERE c.is_active ORDER BY c.position, c."index"`),
  ]);
  const overall = await queryOne<R>(`SELECT group_mean::text AS m FROM mv_assessor_group WHERE everyone`);

  const monthsBy = new Map<string, { x: number; mean_residual: number | null }[]>();
  for (const m of monthly) {
    const k = String(m.assessor_id);
    if (!monthsBy.has(k)) monthsBy.set(k, []);
    monthsBy.get(k)!.push({ x: Number(m.x), mean_residual: num(m.mean_residual as string | null) });
  }
  const cellsBy = new Map<string, AnalysisRow['cells']>();
  for (const c of cells) {
    const k = String(c.assessor_id);
    if (!cellsBy.has(k)) cellsBy.set(k, {});
    cellsBy.get(k)![String(c.competency_id)] = { n: Number(c.n), own_mean: num(c.own_mean as string | null), mean_residual: num(c.mean_residual as string | null) };
  }

  const rows: AnalysisRow[] = people.map((r) => {
    const id = String(r.id);
    const delta_adjusted = num(r.delta_adjusted as string | null);
    const sigma_grade = num(r.sigma_grade as string | null);
    const n_records = Number(r.n_records);
    const derived = computeAsi({
      delta_adjusted, sigma_grade, n_records,
      n_halo: Number(r.n_halo_records ?? 0), n_halo_eligible: Number(r.n_eligible_records ?? 0),
      n_below: Number(r.n_below_standard ?? 0), n_substantive: Number(r.n_substantive ?? 0),
      nr_excess: num(r.nr_excess as string | null),
      monthly: monthsBy.get(id) ?? [],
    }, cfg);
    return {
      id, external_id: String(r.external_id), seniority_number: num(r.seniority_number as number | null), full_name: String(r.full_name),
      position: r.position as string | null, fleet: r.fleet as string | null, base: r.base as string | null,
      instructor_roles: (r.instructor_roles as string[] | null) ?? [],
      n_grades: Number(r.n_grades), n_records, n_subjects: Number(r.n_subjects),
      mean_grade: num(r.mean_grade as string | null), sigma_grade,
      delta_adjusted, delta_unadjusted: num(r.delta_unadjusted as string | null), ci_half_width: num(r.ci_half_width as string | null),
      is_provisional: Boolean(r.is_provisional), is_outlier: Boolean(r.is_outlier),
      share_above_level_1: num(r.share_above_level_1 as string | null),
      asi: derived.asi, halo_rate: derived.halo_rate, justification_rate: derived.justification_rate, drift: derived.drift,
      cells: cellsBy.get(id) ?? {},
    };
  });

  const banded = rows.filter((r) => !r.is_provisional && r.delta_adjusted !== null);
  const sorted = banded.map((r) => r.delta_adjusted as number).sort((a, b) => a - b);
  const peerMedianDelta = sorted.length === 0 ? null
    : sorted.length % 2 ? sorted[(sorted.length - 1) / 2]!
    : ((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2);

  return {
    rows,
    competencies: comps.map((c) => ({ id: String(c.id), code: String(c.code), name: String(c.name), colour: String(c.colour), group_mean: num(c.group_mean as string | null), n: Number(c.n) })),
    groupMean: num(overall?.m as string | null),
    peerMedianDelta,
    totals: {
      instructors: rows.length,
      banded: banded.length,
      provisional: rows.filter((r) => r.is_provisional).length,
      outliers: rows.filter((r) => r.is_outlier).length,
      grades: rows.reduce((s, r) => s + r.n_grades, 0),
      fellBack: rows.filter((r) => (r.share_above_level_1 ?? 0) > (cfg.assessor_fairness.expected.max_share_above_level_1_for_banding)).length,
    },
  };
}

// ------------------------------------------------------- one instructor, analysed (chart 35, 39, 41)

export interface Side { n: number; records: number; mean_residual: number | null; sd_residual: number | null; mean_grade: number | null }

export interface CheckVsTraining {
  checks: Side;
  training: Side;
  welch: WelchResult | null;
  minPerSide: number;
  /** 'insufficient' whenever either side is under comparison.min_n_per_side - never "no difference". */
  verdict: 'insufficient' | 'no_difference' | 'harder_in_checks' | 'softer_in_checks';
  byKind: { kind: string; label: string; is_check: boolean; n: number; records: number; mean_residual: number | null; mean_grade: number | null }[];
}

export type AlertType = 'unjustified_low' | 'halo_record' | 'outcome_mismatch' | 'masking';
export type AlertStatus = 'open' | 'dismissed' | 'confirmed';

export interface AlertRow {
  key: string;
  alert_type: AlertType;
  record_id: string;
  competency_id: string | null;
  training_date: string;
  subject_id: string;
  subject_name: string;
  template_name: string;
  competency_code: string | null;
  grade: string | null;
  remark: string | null;
  remark_words: number | null;
  /** One line naming what the rule found, for the row itself. */
  detail: string;
  status: AlertStatus;
  reviewer_note: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
}

export interface InstructorAnalysis {
  peerMedianDelta: number | null;
  peerDeltas: number[];
  checkVsTraining: CheckVsTraining;
  alerts: AlertRow[];
  counts: Record<AlertType, { open: number; confirmed: number; dismissed: number }>;
}

const ALERT_LABEL: Record<AlertType, string> = {
  unjustified_low: 'Low grade with no substantive remark',
  halo_record: 'One grade across the whole record',
  outcome_mismatch: 'Outcome disagrees with the grades',
  masking: 'Remark reads worse than the grade',
};
export function alertLabel(t: AlertType): string { return ALERT_LABEL[t]; }

/**
 * The individual analysis surface: the peer distribution this instructor is read against, how they
 * grade in checks versus in training, and the alert queue.
 *
 * The comparison unit is the RESIDUAL, not the raw grade (docs/06 §13.2): "did this instructor mark
 * the same pilots differently in a check than in training" is answerable, where "are their check
 * grades lower" is mostly a statement about who gets sent to a check.
 *
 * Nominations are derived here, every time, from the materialised corpus - migration 0148 stores
 * only decisions. `masking` is never nominated: §13.3 requires the model layer for it and forbids a
 * keyword rule from capping a band on its own, and this build runs no model.
 */
export async function getInstructorAnalysis(id: string): Promise<InstructorAnalysis> {
  const cfg = analyticsConfig<AnalyticsConfig>();
  const P = policy();
  const checks = checkKinds(P);
  const kindLabel = new Map(P.template_kinds.map((k) => [k.kind, k.label]));
  const minPerSide = cfg.comparison.min_n_per_side;
  const gradeMax = cfg.assessor_fairness.justification.grade_max;
  const minWords = cfg.assessor_fairness.justification.min_words;
  const haloMin = cfg.assessor_fairness.habits.halo.min_competencies_graded;
  // Advisory threshold, owned by the operator. One below-standard grade with a PASS is ordinary in a
  // check; nominating every one of them buried this queue (145 open on 301 records) and a queue nobody
  // can work is a queue nobody reads. Default 1 keeps the old behaviour for a config without the key.
  const mismatchMinBelow = Math.max(1, cfg.grade_scale.outcome_standard?.warn_at ?? 1);
  const fails = failOutcomes(P);

  type R = Record<string, string | number | boolean | null>;
  const [peers, sides, byKind, low, halo, mismatch, decisions] = await Promise.all([
    query<R>(`SELECT delta_adjusted::text AS d FROM mv_assessor_adjusted WHERE NOT is_provisional AND delta_adjusted IS NOT NULL`),
    query<R>(`
      SELECT (g.template_kind = ANY($2::text[])) AS is_check,
             count(*)::int AS n, count(DISTINCT r.record_id)::int AS records,
             avg(r.residual)::text AS mean_residual, stddev_samp(r.residual)::text AS sd_residual, avg(r.grade_value)::text AS mean_grade
        FROM mv_assessor_residual r
        JOIN mv_assessor_grades g ON g.record_id = r.record_id AND g.competency_id = r.competency_id AND g.grade_kind = 'competency'
       WHERE r.assessor_id = $1::uuid AND g.template_kind IS NOT NULL
       GROUP BY 1`, [id, checks]),
    query<R>(`
      SELECT g.template_kind AS kind, count(*)::int AS n, count(DISTINCT r.record_id)::int AS records,
             avg(r.residual)::text AS mean_residual, avg(r.grade_value)::text AS mean_grade
        FROM mv_assessor_residual r
        JOIN mv_assessor_grades g ON g.record_id = r.record_id AND g.competency_id = r.competency_id AND g.grade_kind = 'competency'
       WHERE r.assessor_id = $1::uuid AND g.template_kind IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC`, [id]),
    query<R>(`
      SELECT g.record_id, g.competency_id, c.code AS competency_code, g.grade, g.remark, g.remark_words,
             r.training_date::text AS training_date, g.subject_id, s.full_name AS subject_name,
             COALESCE(r.snapshot->'template'->>'name', r.title) AS template_name
        FROM mv_assessor_grades g
        JOIN records r ON r.id = g.record_id AND r.deleted_at IS NULL
        JOIN people s ON s.id = g.subject_id
        LEFT JOIN competencies c ON c.id = g.competency_id
       WHERE g.assessor_id = $1::uuid AND g.grade_kind = 'competency'
         AND g.grade_value IS NOT NULL AND g.grade_value <= $2 AND COALESCE(g.remark_words, 0) < $3
       ORDER BY r.training_date DESC LIMIT 250`, [id, gradeMax, minWords]),
    query<R>(`
      WITH per_record AS (
        SELECT g.record_id, g.subject_id,
               count(*) FILTER (WHERE g.grade_value IS NOT NULL)::int AS graded,
               count(DISTINCT g.grade_value)::int AS distinct_grades,
               max(g.grade) AS the_grade
          FROM mv_assessor_grades g
         WHERE g.assessor_id = $1::uuid AND g.grade_kind = 'competency'
         GROUP BY 1, 2)
      SELECT pr.record_id, pr.subject_id, pr.graded, pr.the_grade AS grade,
             r.training_date::text AS training_date, s.full_name AS subject_name,
             COALESCE(r.snapshot->'template'->>'name', r.title) AS template_name
        FROM per_record pr
        JOIN records r ON r.id = pr.record_id AND r.deleted_at IS NULL
        JOIN people s ON s.id = pr.subject_id
       WHERE pr.graded >= $2 AND pr.distinct_grades = 1
       ORDER BY r.training_date DESC LIMIT 250`, [id, haloMin]),
    query<R>(`
      WITH per_record AS (
        SELECT g.record_id, g.subject_id,
               count(*) FILTER (WHERE g.is_below_standard)::int AS below,
               count(*) FILTER (WHERE g.grade_value IS NOT NULL)::int AS graded
          FROM mv_assessor_grades g
         WHERE g.assessor_id = $1::uuid AND g.grade_kind = 'competency'
         GROUP BY 1, 2)
      SELECT pr.record_id, pr.subject_id, pr.below, pr.graded,
             COALESCE(r.outcome_override, r.outcome) AS outcome,
             COALESCE((r.snapshot->>'additional_training')::boolean, false) AS additional_training,
             r.training_date::text AS training_date, s.full_name AS subject_name,
             COALESCE(r.snapshot->'template'->>'name', r.title) AS template_name
        FROM per_record pr
        JOIN records r ON r.id = pr.record_id AND r.deleted_at IS NULL
        JOIN people s ON s.id = pr.subject_id
       WHERE pr.graded > 0 AND COALESCE(r.outcome_override, r.outcome) IS NOT NULL
         AND ( (pr.below >= $3 AND NOT (COALESCE(r.outcome_override, r.outcome) = ANY($2::text[]))
                             AND NOT COALESCE((r.snapshot->>'additional_training')::boolean, false))
            OR (pr.below = 0 AND COALESCE(r.outcome_override, r.outcome) = ANY($2::text[])) )
       ORDER BY r.training_date DESC LIMIT 250`, [id, fails, mismatchMinBelow]),
    query<R>(`
      SELECT a.record_id, a.competency_id, a.alert_type, a.status, a.reviewer_note, a.decided_at::text AS decided_at,
             COALESCE(dp.full_name, u.username) AS decided_by_name
        FROM assessor_remark_audit a
        LEFT JOIN users u ON u.id = a.decided_by
        LEFT JOIN people dp ON dp.id = u.person_id
       WHERE a.assessor_person_id = $1::uuid AND a.deleted_at IS NULL`, [id]),
  ]);

  const side = (isCheck: boolean): Side => {
    const r = sides.find((x) => Boolean(x.is_check) === isCheck);
    return {
      n: Number(r?.n ?? 0), records: Number(r?.records ?? 0),
      mean_residual: num(r?.mean_residual as string | null), sd_residual: num(r?.sd_residual as string | null),
      mean_grade: num(r?.mean_grade as string | null),
    };
  };
  const c = side(true); const tr = side(false);
  const w = c.mean_residual !== null && c.sd_residual !== null && tr.mean_residual !== null && tr.sd_residual !== null
    ? welch({ mean: c.mean_residual, sd: c.sd_residual, n: c.n }, { mean: tr.mean_residual, sd: tr.sd_residual, n: tr.n }, cfg.comparison.ci_z)
    : null;
  const verdict: CheckVsTraining['verdict'] =
    c.n < minPerSide || tr.n < minPerSide || w === null ? 'insufficient'
    : w.ciLo <= 0 && w.ciHi >= 0 ? 'no_difference'
    : w.diff < 0 ? 'harder_in_checks' : 'softer_in_checks';

  const decided = new Map(decisions.map((d) => [`${d.record_id}:${d.competency_id ?? ''}:${d.alert_type}`, d]));
  const rows: AlertRow[] = [];
  const push = (alert_type: AlertType, r: R, competency_id: string | null, detail: string) => {
    const key = `${String(r.record_id)}:${competency_id ?? ''}:${alert_type}`;
    const d = decided.get(key);
    rows.push({
      key, alert_type, record_id: String(r.record_id), competency_id,
      training_date: String(r.training_date), subject_id: String(r.subject_id), subject_name: String(r.subject_name),
      template_name: String(r.template_name ?? '—'), competency_code: (r.competency_code as string | null) ?? null,
      grade: (r.grade as string | null) ?? null, remark: (r.remark as string | null) ?? null,
      remark_words: r.remark_words === null || r.remark_words === undefined ? null : Number(r.remark_words),
      detail,
      status: (d?.status as AlertStatus | undefined) ?? 'open',
      reviewer_note: (d?.reviewer_note as string | null) ?? null,
      decided_at: (d?.decided_at as string | null) ?? null,
      decided_by_name: (d?.decided_by_name as string | null) ?? null,
    });
  };
  for (const r of low) push('unjustified_low', r, String(r.competency_id), `Grade ${r.grade} with ${Number(r.remark_words ?? 0)} word${Number(r.remark_words ?? 0) === 1 ? '' : 's'} of remark; ${minWords} is the minimum for a substantive one.`);
  for (const r of halo) push('halo_record', r, null, `All ${Number(r.graded)} graded competencies carry ${r.grade}.`);
  for (const r of mismatch) push('outcome_mismatch', r, null, Number(r.below) > 0
    ? `${Number(r.below)} competency grade${Number(r.below) === 1 ? '' : 's'} below standard, outcome ${r.outcome}, no additional training recommended.`
    : `Outcome ${r.outcome} with no competency graded below standard.`);
  rows.sort((a, b) => (a.status === b.status ? b.training_date.localeCompare(a.training_date) : a.status === 'open' ? -1 : b.status === 'open' ? 1 : 0));

  const counts = { unjustified_low: { open: 0, confirmed: 0, dismissed: 0 }, halo_record: { open: 0, confirmed: 0, dismissed: 0 }, outcome_mismatch: { open: 0, confirmed: 0, dismissed: 0 }, masking: { open: 0, confirmed: 0, dismissed: 0 } };
  for (const r of rows) counts[r.alert_type][r.status] += 1;

  const deltas = peers.map((p) => Number(p.d)).sort((a, b) => a - b);
  const median = deltas.length === 0 ? null
    : deltas.length % 2 ? deltas[(deltas.length - 1) / 2]!
    : (deltas[deltas.length / 2 - 1]! + deltas[deltas.length / 2]!) / 2;

  return {
    peerMedianDelta: median,
    peerDeltas: deltas,
    checkVsTraining: { checks: c, training: tr, welch: w, minPerSide, verdict, byKind: byKind.map((k) => ({ kind: String(k.kind), label: kindLabel.get(String(k.kind)) ?? String(k.kind), is_check: checks.includes(String(k.kind)), n: Number(k.n), records: Number(k.records), mean_residual: num(k.mean_residual as string | null), mean_grade: num(k.mean_grade as string | null) })) },
    alerts: rows,
    counts,
  };
}
