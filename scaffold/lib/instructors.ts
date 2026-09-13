import { query, queryOne } from '@/lib/db';
import { analyticsConfig } from '@/lib/config';
import { standardisationIndex, justificationRate, olsSlope, type AnalyticsConfig, type AsiResult } from '@/lib/analytics';

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
  const haloRate = nHaloEligible > 0 ? nHalo / nHaloEligible : null;
  const jRate = justificationRate(nSubstantive, nBelow);
  const nrExcess = num(nr?.nr_excess as string | null);

  // Drift: OLS slope of the monthly mean residual over time, expressed per slope interval.
  const slopeDays = cfg.trend.slope_interval_days;
  const monthPoints = monthly.filter((m) => m.mean_residual !== null).map((m) => ({ x: Number(m.x), y: Number(m.mean_residual) }));
  const slope = monthPoints.length >= 3 ? olsSlope(monthPoints) : null;
  const drift = slope === null ? null : slope * slopeDays;

  const asi = adj ? standardisationIndex({
    delta: adj.delta_adjusted, sigma: adj.sigma_grade, justificationRate: jRate, haloRate, drift, notObservedExcess: nrExcess, nRecords: adj.n_records,
  }, {}, cfg) : null;

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
