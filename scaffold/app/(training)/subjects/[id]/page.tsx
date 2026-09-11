import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query, queryOne } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, can, canOnPerson, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import { analyticsConfig, gradeScale, gradePalette, labels } from '@/lib/config';
import { buildChartTokens } from '@/components/charts/chart-tokens';
import { CompetencyRadar } from '@/components/charts/CompetencyRadar';
import { TrendSparkline } from '@/components/charts/TrendSparkline';
import { KpiTile } from '@/components/charts/KpiTile';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import EmptyState from '@/components/ui/EmptyState';

/**
 * /subjects/[id] - one subject's profile.
 *
 * The end-to-end proof: seeded database -> scoped SQL -> deterministic figures -> the same SVG
 * components the PDF renderer uses. Nothing on this page is computed by a model, and nothing is
 * hardcoded that belongs in configuration:
 *
 *   - the competencies, their codes, names, ORDER and COLOURS come from the framework tables. The
 *     radar has as many spokes as the active framework has competencies. Nothing here counts nine
 *     of anything;
 *   - "below standard" comes from config/analytics.yaml (grade_scale.below_standard_max) and is
 *     passed into SQL as a parameter, so the page and the views cannot drift;
 *   - the display denominator and its unit come from the same file, and the unit is printed with
 *     the number always.
 *
 * Row-level access is re-checked here even though /subjects already filtered: a link, a bookmark
 * or a guessed id reaches this page without passing through the list.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PersonRow {
  id: string;
  external_id: string;
  full_name: string;
  position: string | null;
  org_unit: string | null;
  asset_class: string | null;
  is_active: boolean;
  watch_list: boolean;
  concern_override: string | null;
  joined_on: string | null;
}

interface CompetencyRow { id: string; code: string; name: string; colour: string }
interface MeanRow { competency_id: string; mean: string | null; n: string }
interface PointRow { competency_id: string; on: string; value: string }
interface RecordRow {
  id: string;
  title: string;
  record_kind: string | null;
  source: string;
  training_date: string;
  outcome: string | null;
  outcome_override: string | null;
  asset_class: string | null;
  competency_count: string;
  below_count: string;
}
interface TotalsRow { records: string; scored: string; below: string; last_on: string | null }

export default async function SubjectProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();
  const access = await resolveAccess(session);

  // Not "403": a caller who may not see this subject is told the same thing as a caller who used a
  // dead id. Distinguishing the two turns this page into an id oracle.
  if (!(await canOnPerson(access, 'people.view', id))) notFound();

  const person = await queryOne<PersonRow>(
    `SELECT p.id, p.external_id, p.full_name, p.position,
            ou.name AS org_unit, ac.name AS asset_class,
            p.is_active, p.watch_list, p.concern_override, p.joined_on::text
       FROM people p
       LEFT JOIN org_units ou     ON ou.id = p.org_unit_id
       LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
      WHERE p.id = $1::uuid AND p.deleted_at IS NULL`,
    [id],
  );
  if (!person) notFound();

  const scale = gradeScale();
  const cfg = analyticsConfig<{ rate_display: Record<string, { denominator: number; unit: string; axis_label: string }> }>();
  const rateCfg = cfg.rate_display?.below_standard_rate ?? { denominator: 1000, unit: 'per_1000_grades', axis_label: 'per 1000 grades' };
  const below = scale.below_standard_max;

  const competencies = await query<CompetencyRow>(
    `SELECT c.id, c.code, c.name, c.colour
       FROM competencies c
       JOIN competency_frameworks f ON f.id = c.framework_id
      WHERE f.is_active AND c.is_active
      ORDER BY c.position, c."index"`,
  );

  // The peer group is the set this caller may see. A comparison against people the caller cannot
  // open is a comparison they cannot check.
  const visible = await visiblePersonIds(access, 'people.view');
  const peerFilter = visible === ALL_PEOPLE ? null : [...visible];

  const [means, peerMeans, points, records, totals] = await Promise.all([
    query<MeanRow>(
      `SELECT rc.competency_id,
              avg(grade_num(rc.grade))::numeric(4,2)::text AS mean,
              count(grade_num(rc.grade))::text             AS n
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
        WHERE r.person_id = $1::uuid
        GROUP BY rc.competency_id`,
      [id],
    ),
    query<MeanRow>(
      `SELECT rc.competency_id,
              avg(grade_num(rc.grade))::numeric(4,2)::text AS mean,
              count(grade_num(rc.grade))::text             AS n
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
        WHERE r.person_id <> $1::uuid
          AND ($2::uuid[] IS NULL OR r.person_id = ANY($2::uuid[]))
        GROUP BY rc.competency_id`,
      [id, peerFilter],
    ),
    query<PointRow>(
      `SELECT rc.competency_id, r.training_date::text AS on, grade_num(rc.grade)::text AS value
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
        WHERE r.person_id = $1::uuid AND grade_num(rc.grade) IS NOT NULL
        ORDER BY r.training_date`,
      [id],
    ),
    query<RecordRow>(
      `SELECT r.id, r.title, r.record_kind, r.source, r.training_date::text AS training_date,
              r.outcome, r.outcome_override, ac.name AS asset_class,
              count(rc.id)::text AS competency_count,
              count(*) FILTER (WHERE grade_num(rc.grade) <= $2)::text AS below_count
         FROM records r
         LEFT JOIN asset_classes ac      ON ac.id = r.asset_class_id
         LEFT JOIN record_competencies rc ON rc.record_id = r.id
        WHERE r.person_id = $1::uuid AND r.deleted_at IS NULL
        GROUP BY r.id, ac.name
        ORDER BY r.training_date DESC
        LIMIT 200`,
      [id, below],
    ),
    queryOne<TotalsRow>(
      `SELECT count(DISTINCT r.id)::text                                     AS records,
              count(grade_num(rc.grade))::text                               AS scored,
              count(*) FILTER (WHERE grade_num(rc.grade) <= $2)::text        AS below,
              max(r.training_date)::text                                     AS last_on
         FROM records r
         LEFT JOIN record_competencies rc ON rc.record_id = r.id
        WHERE r.person_id = $1::uuid AND r.deleted_at IS NULL`,
      [id, below],
    ),
  ]);

  const tokens = buildChartTokens({
    competencies: competencies.map((c) => ({ competencyId: c.id, code: c.code, name: c.name, colour: c.colour })),
    grades: gradePalette(),
  });

  const meanBy = new Map(means.map((m) => [m.competency_id, m.mean === null ? null : Number(m.mean)]));
  const peerBy = new Map(peerMeans.map((m) => [m.competency_id, m.mean === null ? null : Number(m.mean)]));
  const pointsBy = new Map<string, { on: string; value: number | null }[]>();
  for (const p of points) {
    const list = pointsBy.get(p.competency_id) ?? [];
    list.push({ on: p.on, value: Number(p.value) });
    pointsBy.set(p.competency_id, list);
  }

  const scored = Number(totals?.scored ?? 0);
  const belowN = Number(totals?.below ?? 0);
  const rate = scored > 0 ? (belowN / scored) * rateCfg.denominator : null;

  const columns: Column<RecordRow>[] = [
    { key: 'date', head: 'Date', numeric: true, cell: (r) => r.training_date },
    { key: 'title', head: 'Record', cell: (r) => r.title },
    { key: 'kind', head: 'Kind', cell: (r) => r.record_kind ?? <span className="muted">-</span> },
    { key: 'asset', head: 'Asset class', cell: (r) => r.asset_class ?? <span className="muted">-</span> },
    {
      key: 'outcome',
      head: 'Outcome',
      cell: (r) =>
        r.outcome_override ? (
          <Chip tone="info" srPrefix="Outcome, administratively corrected">
            {r.outcome_override} (amended)
          </Chip>
        ) : (
          r.outcome ?? <span className="muted">-</span>
        ),
    },
    { key: 'graded', head: 'Competencies graded', numeric: true, cell: (r) => r.competency_count },
    {
      key: 'below',
      head: 'Below standard',
      numeric: true,
      cell: (r) => (Number(r.below_count) > 0 ? <strong>{r.below_count}</strong> : r.below_count),
    },
    // `source` is shown as a column and never as a filter: a surface that reads one source reports
    // zero for the others.
    { key: 'source', head: 'Source', cell: (r) => <span className="mono xs">{r.source}</span> },
  ];

  return (
    <div className="stack" data-testid="subject-profile">
      <Breadcrumbs
        items={[
          { label: 'Overview', href: '/' },
          { label: labels().subject_plural, href: '/subjects' },
          { label: person.external_id },
        ]}
      />

      <div className="row">
        <h1>{person.full_name}</h1>
        <span className="mono muted">{person.external_id}</span>
        {!person.is_active ? <Chip srPrefix="Roster status">Off roster</Chip> : null}
        {person.watch_list ? <Chip tone="warn" srPrefix="Flag">Watch list</Chip> : null}
        {person.concern_override ? (
          <Chip tone="info" srPrefix="Concern set manually">{person.concern_override}</Chip>
        ) : null}
        <span className="spacer" />
        {can(access, 'training.analysis.view') ? (
          <Link className="small" href={`/subjects/${person.id}/analysis`}>Analysis runs</Link>
        ) : null}
      </div>
      <p className="muted small">
        {[person.position, person.org_unit, person.asset_class].filter(Boolean).join(' · ') || 'No roster detail recorded'}
        {person.joined_on ? ` · joined ${person.joined_on}` : ''}
      </p>

      <div className="grid grid-kpi">
        <KpiTile id="kpi-records" caption="Records" value={String(totals?.records ?? 0)} context="all sources" tokens={tokens} />
        <KpiTile id="kpi-competency-grades" caption="Competency grades" value={String(scored)} context="scored, excludes NR/NO/NA" tokens={tokens} />
        <KpiTile
          id="kpi-below-standard"
          caption="Below standard"
          value={rate === null ? null : rate.toFixed(1)}
          unit={rateCfg.axis_label}
          state={rate === null ? 'insufficient' : 'value'}
          context={`grade <= ${below}`}
          tokens={tokens}
        />
        <KpiTile
          id="kpi-last-record"
          caption="Last record"
          value={totals?.last_on ?? null}
          state={totals?.last_on ? 'value' : 'not_captured'}
          tokens={tokens}
        />
      </div>

      {competencies.length === 0 ? (
        <EmptyState
          title="No competency framework is active"
          reason="Seed one with npm run seed:framework. Every chart on this page derives its axes from the framework tables."
        />
      ) : (
        <>
          <Card
            title="Competency profile"
            note={`Mean of scored grades per competency, against the peer group this account can see. Spokes come from the active framework: ${competencies.length} competencies.`}
          >
            <CompetencyRadar
              id={`radar-${person.id}`}
              label={`Competency profile for ${person.full_name}`}
              competencies={competencies.map((c) => ({ competencyId: c.id, code: c.code, name: c.name }))}
              tokens={tokens}
              min={scale.min}
              max={scale.max}
              series={[
                {
                  key: 'subject',
                  label: 'This subject',
                  emphasis: 'primary',
                  values: competencies.map((c) => meanBy.get(c.id) ?? null),
                },
                {
                  key: 'peers',
                  label: 'Peer group',
                  emphasis: 'secondary',
                  values: competencies.map((c) => peerBy.get(c.id) ?? null),
                },
              ]}
            />
          </Card>

          <Card
            title="Trend by competency"
            note="One point per scored competency grade, in date order. Gaps are breaks in the line, never zeros: a missing grade plotted at the axis draws a failure that never happened."
          >
            <div className="grid grid-spark">
              {competencies.map((c) => (
                <div key={c.id}>
                  <div className="xs muted">
                    <span className="mono">{c.code}</span> {c.name}
                  </div>
                  <TrendSparkline
                    id={`spark-${c.id}`}
                    label={`${c.code} trend`}
                    points={pointsBy.get(c.id) ?? []}
                    tokens={tokens}
                    colour={c.colour}
                    min={scale.min}
                    max={scale.max}
                  />
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      <DataTable
        testId="subject-record-list"
        caption="Records, most recent first"
        columns={columns}
        rows={records}
        rowKey={(r) => r.id}
        emptyTitle="No records"
        emptyReason={`Nothing has been recorded for this ${labels().subject.toLowerCase()} from any source yet.`}
      />
    </div>
  );
}
