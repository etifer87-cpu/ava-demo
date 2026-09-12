import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query, queryOne } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, can, canOnPerson } from '@/lib/access';
import { gradeScale, gradePalette, labels, averageBand, competencyDisplayName } from '@/lib/config';
import { buildChartTokens } from '@/components/charts/chart-tokens';
import { CompetencyRadar } from '@/components/charts/CompetencyRadar';
import { TrendCard } from '@/components/charts/TrendCard';
import { KpiTile } from '@/components/charts/KpiTile';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import AutoSubmitSelect from '@/components/ui/AutoSubmitSelect';
import Pager, { pageParams } from '@/components/ui/Pager';
import RecordsTable, { type RecordListRow } from '@/components/program/RecordDialog';

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
interface PointRow { competency_id: string; on: string; value: string; label: string }
interface TotalsRow { records: string; scored: string; below: string; last_on: string | null }
interface KindRow { record_kind: string; n: string }
const RECORD_PAGE_SIZES = [10, 20, 50] as const;

export default async function SubjectProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const kind = typeof sp.kind === 'string' ? sp.kind.slice(0, 60) : '';
  const { page, size } = pageParams(sp, RECORD_PAGE_SIZES[0], RECORD_PAGE_SIZES);
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
  const below = scale.below_standard_max;

  const competencies = await query<CompetencyRow>(
    `SELECT c.id, c.code, c.name, c.colour
       FROM competencies c
       JOIN competency_frameworks f ON f.id = c.framework_id
      WHERE f.is_active AND c.is_active
      ORDER BY c.position, c."index"`,
  );


  // The kind filter (All / one training or check) narrows the profile, the averages and the trend.
  const [means, points, records, totals, kinds] = await Promise.all([
    query<MeanRow>(
      `SELECT rc.competency_id,
              avg(grade_num(rc.grade))::numeric(4,2)::text AS mean,
              count(grade_num(rc.grade))::text             AS n
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
        WHERE r.person_id = $1::uuid ${kind ? 'AND r.record_kind = $2' : ''}
        GROUP BY rc.competency_id`,
      kind ? [id, kind] : [id],
    ),
    query<PointRow>(
      `SELECT rc.competency_id, r.training_date::text AS on, grade_num(rc.grade)::text AS value,
              COALESCE(r.snapshot->'template'->>'name', r.title) || COALESCE(' · ' || (r.snapshot->'session'->>'check'), '') || COALESCE(' · ' || p.full_name, '') AS label
         FROM record_competencies rc
         JOIN records r ON r.id = rc.record_id AND r.deleted_at IS NULL
         LEFT JOIN people p ON p.id = r.assessor_person_id
        WHERE r.person_id = $1::uuid AND grade_num(rc.grade) IS NOT NULL ${kind ? 'AND r.record_kind = $2' : ''}
        ORDER BY r.training_date, r.id`,
      kind ? [id, kind] : [id],
    ),
    query<RecordListRow & { total: string }>(
      `SELECT r.id, r.title, r.record_kind, r.training_date::text AS training_date,
              r.outcome, r.outcome_override, ac.code AS asset_class, p.full_name AS assessor_name, r.is_hidden_from_subject, r.snapshot,
              (SELECT count(*)::text FROM record_competencies rc WHERE rc.record_id = r.id) AS competency_count,
              count(*) OVER ()::text AS total
         FROM records r
         LEFT JOIN asset_classes ac ON ac.id = r.asset_class_id
         LEFT JOIN people p ON p.id = r.assessor_person_id
        WHERE r.person_id = $1::uuid AND r.deleted_at IS NULL
        ORDER BY r.training_date DESC, r.created_at DESC
        LIMIT ${size} OFFSET ${(page - 1) * size}`,
      [id],
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
    query<KindRow>(`SELECT r.record_kind, count(*)::text AS n FROM records r WHERE r.person_id = $1::uuid AND r.deleted_at IS NULL AND r.record_kind IS NOT NULL GROUP BY r.record_kind ORDER BY r.record_kind`, [id]),
  ]);
  const recordTotal = Number(records[0]?.total ?? 0);

  const tokens = buildChartTokens({
    competencies: competencies.map((c) => ({ competencyId: c.id, code: c.code, name: c.name, colour: c.colour })),
    grades: gradePalette(),
  });

  const meanBy = new Map(means.map((m) => [m.competency_id, m.mean === null ? null : Number(m.mean)]));
  const pointsBy = new Map<string, { on: string; value: number | null; label: string }[]>();
  for (const p of points) {
    const list = pointsBy.get(p.competency_id) ?? [];
    list.push({ on: p.on, value: Number(p.value), label: p.label });
    pointsBy.set(p.competency_id, list);
  }

  const scored = Number(totals?.scored ?? 0);
  const overall = means.length ? (means.reduce((s, m) => s + (m.mean === null ? 0 : Number(m.mean) * Number(m.n)), 0) / Math.max(1, means.reduce((s, m) => s + Number(m.n), 0))).toFixed(2) : null;

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
          <Link className="button button-quiet" href={`/subjects/${person.id}/analysis`} style={{ textDecoration: 'none' }} data-testid="trainee-analysis">Trainee analysis</Link>
        ) : null}
      </div>
      <p className="muted small">
        {[person.position, person.org_unit, person.asset_class].filter(Boolean).join(' · ') || 'No roster detail recorded'}
        {person.joined_on ? ` · joined ${person.joined_on}` : ''}
      </p>

      <div className="grid grid-kpi">
        <KpiTile id="kpi-records" caption="Records" value={String(totals?.records ?? 0)} context="all sources" tokens={tokens} />
        <KpiTile id="kpi-competency-grades" caption="Competency grades" value={String(scored)} context="scored, excludes NR/NO/NA" tokens={tokens} />
        <KpiTile id="kpi-overall" caption="Overall average" value={overall} state={overall === null ? 'insufficient' : 'value'} context={kind ? kind : 'all trainings and checks'} tokens={tokens} />
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
            note="Mean of this pilot's scored grades per competency. Choose a training or check to narrow the profile, the averages and the trend."
          >
            <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
              <AutoSubmitSelect name="kind" label="Show" value={kind} resetParams={['page']} options={[{ value: '', label: 'All trainings and checks' }, ...kinds.map((k) => ({ value: k.record_kind, label: `${k.record_kind} (${k.n})` }))]} />
            </div>
            <div className="profile-grid">
              <div className="profile-panel"><CompetencyRadar
                id={`radar-${person.id}`}
                label={`Competency profile for ${person.full_name}`}
                competencies={competencies.map((c) => ({ competencyId: c.id, code: c.code, name: c.name }))}
                tokens={tokens}
                min={scale.min}
                max={scale.max}
                size={300}
                labelFontSize={8}
                showValues={false}
                showRingLabels
                vertexRadius={2.4}
                series={[
                  { key: 'subject', label: 'This pilot', emphasis: 'primary', values: competencies.map((c) => meanBy.get(c.id) ?? null) },
                ]}
              /></div>
              <div className="profile-panel">
                <ul className="averages" data-testid="competency-averages">
                  {competencies.map((c) => {
                    const m = meanBy.get(c.id) ?? null;
                    return (
                      <li key={c.id}>
                        <span className="avg-name"><span className="mono" style={{ color: c.colour, fontWeight: 700 }}>{c.code}</span> {competencyDisplayName(c.code, c.name)}</span>
                        <span className="avg-bar" aria-hidden="true" title={averageBand(m)?.label}><span style={{ width: `${m === null ? 0 : ((m - scale.min) / (scale.max - scale.min)) * 100}%`, background: averageBand(m)?.colour ?? 'var(--brand-accent)' }} /></span>
                        <span className="avg-value">{m === null ? '—' : m.toFixed(2)}</span>
                      </li>
                    );
                  })}
                  <li className="avg-total">
                    <span className="avg-name"><strong>All competencies</strong></span>
                    <span className="avg-bar" aria-hidden="true" title={averageBand(overall === null ? null : Number(overall))?.label}><span style={{ width: `${overall === null ? 0 : ((Number(overall) - scale.min) / (scale.max - scale.min)) * 100}%`, background: averageBand(overall === null ? null : Number(overall))?.colour ?? 'var(--brand-accent)' }} /></span>
                    <span className="avg-value"><strong>{overall ?? '—'}</strong></span>
                  </li>
                </ul>
              </div>
            </div>
          </Card>

          <Card
            title="Trend by competency"
            note="One point per scored competency grade, in date order. Click a competency to enlarge it; hover a point for the session behind it."
          >
            <div className="grid-trend">
              {competencies.map((c) => (
                <TrendCard key={c.id} code={c.code} name={competencyDisplayName(c.code, c.name)} colour={c.colour} points={pointsBy.get(c.id) ?? []} tokens={tokens} min={scale.min} max={scale.max} />
              ))}
            </div>
          </Card>
        </>
      )}

      <RecordsTable rows={records} subjectLabel={labels().subject} />
      <Pager path={`/subjects/${person.id}`} params={kind ? { kind } : {}} page={page} size={size} total={recordTotal} noun="records" sizes={RECORD_PAGE_SIZES} />
    </div>
  );
}
