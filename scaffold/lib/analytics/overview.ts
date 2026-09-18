import 'server-only';
import { query, queryOne } from '@/lib/db';
import { policy } from '@/lib/config';
import { gradeNum } from './grade-sql';

/**
 * lib/analytics/overview.ts - the figures behind /analytics, the manager's landing page.
 *
 * EVERY NUMBER HERE COMES FROM `records` AND ITS CHILDREN - the frozen, signed evidence - and not
 * from the live session tables. A session being graded right now is work in progress and does not
 * belong in a figure a head of training reads as fact; the moment it is signed and finalised it is
 * in every number on this page. That is also why this page does not need the materialised assessor
 * views to be fresh: it aggregates records directly, so a record finalised a minute ago is counted.
 * The one exception is the bench outlier list, which reads `mv_assessor_adjusted` because the
 * comparison behind it cannot be computed inside a page request (migration 0147) - that list, and
 * only that list, is as fresh as the last `npm run analytics:refresh`.
 *
 * SCOPE IS A PARAMETER, NOT AN AFTERTHOUGHT. Every function takes the caller's visible person set
 * (null = everyone) and filters on it. Counting every row and then hiding some in the render is how
 * a total that contradicts the list underneath it gets shipped.
 *
 * `grade_num(text)` is the database's own grade parser (migration 0140), the SQL twin of
 * lib/grades.ts: a numeral on the scale or NULL. Nothing here re-implements it, so nothing here can
 * disagree with the rest of the analytics about what counts as a grade.
 */

/** null means "every person" - the caller holds an unscoped capability. */
export type Scope = Set<string> | null;

function scoped(column: string, visible: Scope, params: unknown[]): string {
  if (visible === null) return '';
  if (visible.size === 0) return ' AND false';
  params.push([...visible]);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

/* ------------------------------------------------------------------ the tiles */

export interface OverviewTotals {
  readonly pilots: number;
  readonly instructors: number;
  readonly recordsYear: number;
  readonly recordsMonth: number;
  readonly sessionsOpen: number;
  readonly finalisedWeek: number;
  readonly meanGrade: number | null;
  readonly scored: number;
  readonly belowStandardRate: number | null;
}

export async function overviewTotals(visible: Scope, belowStandardMax: number): Promise<OverviewTotals> {
  const params: unknown[] = [belowStandardMax];
  const people = scoped('p.id', visible, params);
  const recs = scoped('r.person_id', visible, params);
  const row = await queryOne<{
    pilots: number; instructors: number; records_year: number; records_month: number;
    sessions_open: number; finalised_week: number; mean_grade: string | null; scored: number; below: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM people p WHERE p.deleted_at IS NULL AND p.roster_status = 'active'${people}) AS pilots,
       (SELECT count(*)::int FROM people p WHERE p.deleted_at IS NULL AND p.roster_status = 'active'
          AND cardinality(COALESCE(p.instructor_roles, '{}')) > 0${people}) AS instructors,
       (SELECT count(*)::int FROM records r WHERE r.deleted_at IS NULL
          AND r.training_date >= CURRENT_DATE - INTERVAL '12 months'${recs}) AS records_year,
       (SELECT count(*)::int FROM records r WHERE r.deleted_at IS NULL
          AND r.training_date >= date_trunc('month', CURRENT_DATE)${recs}) AS records_month,
       (SELECT count(*)::int FROM sessions s WHERE s.deleted_at IS NULL
          AND s.status IN ('in_progress', 'submitted', 'signed')) AS sessions_open,
       (SELECT count(*)::int FROM records r WHERE r.deleted_at IS NULL AND r.source = 'app'
          AND r.created_at >= now() - INTERVAL '7 days'${recs}) AS finalised_week,
       (SELECT avg(${gradeNum('rc.grade')})::numeric(4,2)::text FROM record_competencies rc
          JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         WHERE r.training_date >= CURRENT_DATE - INTERVAL '12 months'${recs}) AS mean_grade,
       (SELECT count(*)::int FROM record_competencies rc
          JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         WHERE ${gradeNum('rc.grade')} IS NOT NULL AND r.training_date >= CURRENT_DATE - INTERVAL '12 months'${recs}) AS scored,
       (SELECT count(*)::int FROM record_competencies rc
          JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         WHERE ${gradeNum('rc.grade')} <= $1 AND r.training_date >= CURRENT_DATE - INTERVAL '12 months'${recs}) AS below`,
    params,
  );
  const scored = row?.scored ?? 0;
  return {
    pilots: row?.pilots ?? 0,
    instructors: row?.instructors ?? 0,
    recordsYear: row?.records_year ?? 0,
    recordsMonth: row?.records_month ?? 0,
    sessionsOpen: row?.sessions_open ?? 0,
    finalisedWeek: row?.finalised_week ?? 0,
    meanGrade: row?.mean_grade === null || row?.mean_grade === undefined ? null : Number(row.mean_grade),
    scored,
    // A rate over nothing is not zero, it is unknown. Every caller must render the difference.
    belowStandardRate: scored > 0 ? (row?.below ?? 0) / scored : null,
  };
}

/* ------------------------------------------------------------------ the population, by fleet */

export interface FleetRow { readonly fleet: string; readonly pilots: number; readonly records_year: number }

export async function byFleet(visible: Scope): Promise<FleetRow[]> {
  const params: unknown[] = [];
  const people = scoped('p.id', visible, params);
  return query<FleetRow>(
    `SELECT ac.code AS fleet,
            count(DISTINCT p.id)::int AS pilots,
            count(r.id)::int AS records_year
       FROM asset_classes ac
       LEFT JOIN people p ON p.asset_class_id = ac.id AND p.deleted_at IS NULL AND p.roster_status = 'active'${people}
       LEFT JOIN records r ON r.person_id = p.id AND r.deleted_at IS NULL
            AND r.training_date >= CURRENT_DATE - INTERVAL '12 months'
      WHERE ac.deleted_at IS NULL AND ac.is_active AND ac.category = 'aircraft'
      GROUP BY ac.code, ac.position
      ORDER BY ac.position, ac.code`,
    params,
  );
}

/* ------------------------------------------------------------------ competencies */

export interface CompetencyAverage {
  readonly id: string; readonly code: string; readonly name: string; readonly colour: string;
  readonly mean: number | null; readonly n: number; readonly below: number;
}

/** The population mean per competency over the window, from frozen records only. */
export async function competencyAverages(visible: Scope, months: number, belowStandardMax: number): Promise<CompetencyAverage[]> {
  const params: unknown[] = [months, belowStandardMax];
  const recs = scoped('r.person_id', visible, params);
  // The window and the scope narrow the GRADES, in a subquery, and the outer join keeps every
  // competency so one with no grades in the window still shows its row. Putting those predicates
  // on the records join instead - which is what this read did first - filtered nothing: the
  // record_competencies row survived with a null record beside it and its grade still reached the
  // average, so this card silently averaged all of history while the distribution beside it
  // averaged twelve months, and the two cards disagreed on the same screen.
  const rows = await query<{ id: string; code: string; name: string; colour: string; mean: string | null; n: number; below: number }>(
    `SELECT c.id, c.code, c.name, c.colour,
            avg(${gradeNum('g.grade')})::numeric(4,2)::text AS mean,
            count(*) FILTER (WHERE ${gradeNum('g.grade')} IS NOT NULL)::int AS n,
            count(*) FILTER (WHERE ${gradeNum('g.grade')} <= $2)::int AS below
       FROM competencies c
       LEFT JOIN (
         SELECT rc.competency_id, rc.grade
           FROM record_competencies rc
           JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
          WHERE r.training_date >= CURRENT_DATE - make_interval(months => $1::int)${recs}
       ) g ON g.competency_id = c.id
      WHERE c.is_active
      GROUP BY c.id, c.code, c.name, c.colour, c.position, c."index"
      ORDER BY c.position, c."index", c.code`,
    params,
  );
  return rows.map((r) => ({ ...r, mean: r.mean === null ? null : Number(r.mean) }));
}

export interface GradeCountRow { readonly grade: number; readonly n: number }

export async function gradeDistribution(visible: Scope, months: number): Promise<GradeCountRow[]> {
  const params: unknown[] = [months];
  const recs = scoped('r.person_id', visible, params);
  return query<GradeCountRow>(
    `SELECT ${gradeNum('rc.grade')}::int AS grade, count(*)::int AS n
       FROM record_competencies rc
       JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
      WHERE ${gradeNum('rc.grade')} IS NOT NULL
        AND r.training_date >= CURRENT_DATE - make_interval(months => $1::int)${recs}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
}

export interface CompetencyAtGradeRow {
  readonly code: string;
  readonly name: string;
  readonly colour: string;
  readonly n: number;
  readonly total_for_competency: number;
}

/**
 * Which competencies a given grade was awarded in, commonest first. The follow-up question to the
 * distribution: "four hundred grades of 2 - in WHAT?".
 *
 * `total_for_competency` travels with each row because the count alone is misleading: a competency
 * graded on every session will top a list of 2s simply by being graded more often, and the share is
 * what says whether it is actually the weak one.
 */
export async function competenciesAtGrade(visible: Scope, months: number, grade: number, limit: number): Promise<CompetencyAtGradeRow[]> {
  const params: unknown[] = [months, grade];
  const recs = scoped('r.person_id', visible, params);
  params.push(limit);
  return query<CompetencyAtGradeRow>(
    `SELECT c.code, c.name, c.colour,
            count(*) FILTER (WHERE ${gradeNum('rc.grade')} = $2)::int AS n,
            count(*)::int AS total_for_competency
       FROM record_competencies rc
       JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
       JOIN competencies c ON c.id = rc.competency_id
      WHERE ${gradeNum('rc.grade')} IS NOT NULL
        AND r.training_date >= CURRENT_DATE - make_interval(months => $1::int)${recs}
      GROUP BY c.code, c.name, c.colour
     HAVING count(*) FILTER (WHERE ${gradeNum('rc.grade')} = $2) > 0
      ORDER BY 4 DESC, c.code
      LIMIT $${params.length}`,
    params,
  );
}

export interface MonthPoint { readonly on: string; readonly value: number | null; readonly n: number }

/** The monthly population mean. The trend a manager is asked about at a board meeting. */
export async function monthlyMean(visible: Scope, months: number): Promise<MonthPoint[]> {
  const params: unknown[] = [months];
  const recs = scoped('r.person_id', visible, params);
  const rows = await query<{ on: string; value: string | null; n: number }>(
    `SELECT date_trunc('month', r.training_date)::date::text AS on,
            avg(${gradeNum('rc.grade')})::numeric(4,2)::text AS value,
            count(*) FILTER (WHERE ${gradeNum('rc.grade')} IS NOT NULL)::int AS n
       FROM records r JOIN record_competencies rc ON rc.record_id = r.id
      WHERE r.deleted_at IS NULL
        AND r.training_date >= date_trunc('month', CURRENT_DATE - make_interval(months => $1::int))${recs}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  return rows.map((r) => ({ on: r.on, value: r.value === null ? null : Number(r.value), n: r.n }));
}

/* ------------------------------------------------------------------ validity */

export interface ValidityRow {
  readonly key: string; readonly label: string; readonly months: number;
  readonly valid: number; readonly warning: number; readonly expired: number; readonly missing: number;
}

/**
 * Per policy item (policy.yaml training_status.items), how many LINE pilots are valid, inside the
 * warning window, expired, or have no such record at all.
 *
 * The same arithmetic as /subjects/status, done in one aggregate instead of per pilot: last record of
 * that kind, plus the item's validity in months, against today and the warning window. A pilot in
 * initial training is excluded - they are not yet held to a recurrent cycle, and counting them as
 * "missing" would put a number on this page that no manager can act on.
 */
export async function validitySummary(visible: Scope): Promise<ValidityRow[]> {
  const cfg = policy().training_status;
  const items = cfg?.items ?? [];
  if (items.length === 0) return [];
  const kindLabel = new Map(policy().template_kinds.map((k) => [k.kind, k.label]));
  const warningDays = cfg?.warning_days ?? 60;

  const params: unknown[] = [warningDays];
  const people = scoped('p.id', visible, params);
  const branches = items.map((it) => {
    params.push(kindLabel.get(it.kind) ?? it.kind, it.validity_months, it.key, it.label);
    const kind = `$${params.length - 3}`;
    const mon = `$${params.length - 2}`;
    const key = `$${params.length - 1}`;
    const label = `$${params.length}`;
    return `
      SELECT ${key}::text AS key, ${label}::text AS label, ${mon}::int AS months,
             count(*) FILTER (WHERE d.expires IS NOT NULL AND d.expires > CURRENT_DATE + make_interval(days => $1::int))::int AS valid,
             count(*) FILTER (WHERE d.expires IS NOT NULL AND d.expires > CURRENT_DATE AND d.expires <= CURRENT_DATE + make_interval(days => $1::int))::int AS warning,
             count(*) FILTER (WHERE d.expires IS NOT NULL AND d.expires <= CURRENT_DATE)::int AS expired,
             count(*) FILTER (WHERE d.expires IS NULL)::int AS missing
        FROM (
          SELECT p.id,
                 (SELECT max(r.training_date) + make_interval(months => ${mon}::int)
                    FROM records r
                   WHERE r.person_id = p.id AND r.deleted_at IS NULL
                     AND r.record_kind = ${kind} AND r.outcome IS DISTINCT FROM 'INCOMPLETE')::date AS expires
            FROM people p
           WHERE p.deleted_at IS NULL AND p.roster_status = 'active' AND p.training_course IS NULL${people}
        ) d`;
  });
  return query<ValidityRow>(branches.join('\n      UNION ALL\n'), params);
}

/* ------------------------------------------------------------------ what needs a person */

export interface AlertRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly at: string;
  readonly severity: string;
  readonly subjectId: string | null;
  readonly subjectName: string | null;
  readonly sessionId: string | null;
}

/**
 * The notices addressed to THIS caller and not yet cleared - today, the objections the ETR raises
 * (lib/program/freeze.ts writes one per holder of the role policy.yaml names).
 *
 * Addressed to this caller, not "every open notice": a notice was created for the people who hold the
 * notified role, which is already the answer to "whose problem is this". A manager reading somebody
 * else's queue would be reading a list they cannot act on.
 */
export async function openAlerts(userId: string, personId: string | null, limit = 12): Promise<AlertRow[]> {
  return query<AlertRow>(
    `SELECT n.id::text AS id, n.event_kind AS kind, n.title, n.body, n.queued_at::text AS at, n.severity,
            n.subject_id::text AS "subjectId", p.full_name AS "subjectName",
            CASE WHEN n.target_kind = 'session' THEN n.target_id END AS "sessionId"
       FROM dispatch_notices n
       LEFT JOIN people p ON p.id = n.subject_id
      WHERE n.deleted_at IS NULL AND n.state IN ('queued', 'delivered')
        AND (n.recipient_user_id = $1::uuid OR ($2::uuid IS NOT NULL AND n.recipient_person_id = $2::uuid))
      ORDER BY (n.severity = 'hard') DESC, n.queued_at DESC
      LIMIT ${Math.max(1, Math.min(50, limit))}`,
    [userId, personId],
  );
}

export interface OutlierRow {
  readonly id: string; readonly full_name: string; readonly fleet: string | null;
  readonly delta: number; readonly records: number;
}

/**
 * Instructors whose adjusted leniency is outside the review threshold, from `mv_assessor_adjusted`.
 *
 * As fresh as the last `npm run analytics:refresh` - the only figure on this page that is not read
 * straight from `records`, because the comparison behind it (every grade against what the same pilots
 * earned with everybody else) cannot be computed inside a page request. The page says so where it is
 * rendered; a stale number that does not admit it is worse than no number.
 */
export async function benchOutliers(threshold: number, minRecords: number, limit = 8): Promise<OutlierRow[]> {
  const rows = await query<{ id: string; full_name: string; fleet: string | null; delta: string; records: number }>(
    `SELECT p.id::text AS id, p.full_name, ac.code AS fleet,
            a.delta_adjusted::numeric(5,3)::text AS delta, a.n_records::int AS records
       FROM mv_assessor_adjusted a
       JOIN people p ON p.id = a.assessor_id AND p.deleted_at IS NULL
       LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
      WHERE a.n_records >= $2 AND abs(a.delta_adjusted) >= $1
      ORDER BY abs(a.delta_adjusted) DESC
      LIMIT ${Math.max(1, Math.min(50, limit))}`,
    [threshold, minRecords],
  );
  return rows.map((r) => ({ ...r, delta: Number(r.delta) }));
}
