import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, canOnPerson } from '@/lib/access';
import { labels, analyticsConfig, gradePalette, averageBand, competencyDisplayName } from '@/lib/config';
import { getInstructor, leaning, LEANING_LABEL, LEANING_TONE } from '@/lib/instructors';
import type { AnalyticsConfig } from '@/lib/analytics';
import { buildChartTokens } from '@/components/charts/chart-tokens';
import { KpiTile } from '@/components/charts/KpiTile';
import { TrendSparkline } from '@/components/charts/TrendSparkline';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import Pager, { pageParams } from '@/components/ui/Pager';
import RecordsTable, { type RecordListRow } from '@/components/program/RecordDialog';

/**
 * /instructors/[id] - one instructor's grading profile.
 *
 * The standardisation conversation on one page: activity, the adjusted leniency delta with its
 * interval, the standardisation index and its terms, each competency's own mean against the group
 * and against what the same pilots earned elsewhere (raw, labelled raw), the grade distribution
 * against everyone's, the habits (same grade everywhere, unjustified low grades, not-observed
 * excess, observable behaviours ticked far more often than the group), outcomes, the monthly
 * residual trend, and the records they signed with the record pop-up.
 *
 * Row access is re-checked here: training.analytics.assessor.view on THIS person, which is false
 * for the holder themselves - an instructor lands on "not found", never on their own page.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const CAP = 'training.analytics.assessor.view';
const PAGE_SIZES = [10, 20, 50];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = /^[0-9a-f-]{36}$/i.test(id) ? (await query<{ full_name: string }>(`SELECT full_name FROM people WHERE id = $1::uuid AND deleted_at IS NULL`, [id]))[0] : undefined;
  return { title: r?.full_name ?? 'Instructor' };
}

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d));
const signed = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const TERM_LABEL: Record<string, string> = { leniency: 'Leniency', spread: 'Grade spread', justification: 'Low grades justified', halo: 'Same grade everywhere', drift: 'Drift over time', not_observed: 'Not observed' };

export default async function InstructorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { page, size } = pageParams(sp, PAGE_SIZES[0], PAGE_SIZES);
  const session = await requireSession();
  const access = await resolveAccess(session);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !(await canOnPerson(access, CAP, id))) notFound();

  const L = labels();
  const cfg = analyticsConfig<AnalyticsConfig>();
  const [prof, records] = await Promise.all([
    getInstructor(id),
    query<RecordListRow & { total: string }>(
      `SELECT r.id, r.title, r.record_kind, r.training_date::text AS training_date, r.outcome, r.outcome_override, ac.code AS asset_class, p.full_name AS assessor_name, r.is_hidden_from_subject, r.snapshot,
              (SELECT count(*)::text FROM record_competencies rc WHERE rc.record_id = r.id) AS competency_count, count(*) OVER ()::text AS total
         FROM records r LEFT JOIN asset_classes ac ON ac.id = r.asset_class_id LEFT JOIN people p ON p.id = r.assessor_person_id
        WHERE r.assessor_person_id = $1::uuid AND r.deleted_at IS NULL
        ORDER BY r.training_date DESC, r.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, [id]),
  ]);
  if (!prof) notFound();
  const recordTotal = Number(records[0]?.total ?? 0);
  const tokens = buildChartTokens({ competencies: prof.competencies.map((c) => ({ competencyId: c.id, code: c.code, name: c.name, colour: c.colour })), grades: gradePalette() });
  const a = prof.adjusted;
  const lean = leaning(a?.delta_adjusted ?? null, a?.is_provisional ?? true, cfg);
  const asi = prof.asi;
  const asiBand = asi?.band === 'green' ? 'green' : asi?.band === 'amber' ? 'amber' : asi?.band === 'red' ? 'red' : 'neutral';
  const statusTone = prof.status === 'current' ? 'good' : prof.status === 'dormant' ? 'warn' : 'neutral';
  const maxDist = Math.max(1, ...prof.distribution.map((d) => Math.max(d.own / Math.max(1, prof.ownGrades), d.all / Math.max(1, prof.allGrades))));
  const residualRange = Math.max(0.5, ...prof.monthly.map((m) => Math.abs(m.value ?? 0)));
  // analytics.yaml assessor_fairness.expected is read by the SQL views; the page reads one threshold from it for the caveat.
  const maxFallback = (cfg.assessor_fairness as { expected?: { max_share_above_level_1_for_banding?: number } }).expected?.max_share_above_level_1_for_banding ?? 0.1;

  return (
    <div className="stack" data-testid="instructor-profile">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: L.assessor_plural, href: '/instructors' }, { label: prof.person.full_name }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{prof.person.full_name}</h1>
        <span className="small muted">{prof.person.position ?? '—'} · {prof.person.fleet ?? '—'} · {prof.person.base ?? '—'} · seniority <span className="mono">{prof.person.seniority_number ?? prof.person.external_id}</span></span>
        <span className="mono xs">{prof.person.instructor_roles.join(' ')}</span>
        <Chip tone={statusTone}>{prof.status === 'no_grades' ? 'No grades yet' : prof.status}</Chip>
        <span className="spacer" />
        <Link href={`/subjects/${prof.person.id}`} className="button button-quiet xs" style={{ textDecoration: 'none' }}>Pilot page</Link>
      </div>

      <div className="grid grid-kpi">
        <KpiTile id="kpi-sessions" caption="Sessions · 12 months" value={String(prof.activity.sessions_12m)} context={`sim ${prof.activity.sim_12m} · line ${prof.activity.line_12m} · ground ${prof.activity.ground_12m}`} tokens={tokens} />
        <KpiTile id="kpi-pilots" caption="Pilots assessed" value={String(prof.activity.pilots_12m)} context="last 12 months" reference={a ? `${a.n_subjects} all time` : null} tokens={tokens} />
        <KpiTile id="kpi-mean" caption="Mean grade" value={fmt(a?.mean_grade)} state={a ? 'value' : 'insufficient'} context={`${a?.n_grades ?? 0} competency grades`} reference={prof.groupMean !== null ? `everyone ${fmt(prof.groupMean)}` : null} tokens={tokens} />
        <KpiTile id="kpi-delta" caption="Adjusted leniency" value={signed(a?.delta_adjusted)} state={a ? 'value' : 'insufficient'} band={LEANING_TONE[lean] === 'good' ? 'green' : LEANING_TONE[lean] === 'warn' ? 'amber' : LEANING_TONE[lean] === 'bad' ? 'red' : 'neutral'} bandLabel={LEANING_LABEL[lean]} context={a?.ci_half_width !== null && a?.ci_half_width !== undefined ? `± ${a.ci_half_width.toFixed(2)} · raw ${signed(a.delta_unadjusted)}` : null} reference={`${a?.n_records ?? 0} records`} tokens={tokens} />
        <KpiTile id="kpi-asi" caption="Standardisation index" value={asi?.score === null || asi?.score === undefined ? null : Math.round(asi.score).toString()} state={asi?.score === null || asi?.score === undefined ? 'insufficient' : 'value'} band={asiBand} bandLabel={asi ? (asi.band === 'not_banded' ? 'provisional' : asi.band) : null} context={`of ${cfg.assessor_fairness.standardisation_index.base}`} tokens={tokens} />
      </div>

      <div className="profile-grid">
        <Card title="Grading by competency" note="Own mean, everyone's mean, and the raw residual against what the same pilots earned with other instructors">
          <table className="data">
            <thead><tr><th scope="col">Competency</th><th scope="col" className="num">n</th><th scope="col" className="num">Own</th><th scope="col" className="num">Everyone</th><th scope="col" className="num">Residual (raw)</th><th scope="col" style={{ width: '30%' }}></th></tr></thead>
            <tbody>{prof.competencies.map((c) => { const band = averageBand(c.own_mean); const r = c.mean_residual; return (
              <tr key={c.id}>
                <td><span className="mono" style={{ color: c.colour }}>{c.code}</span> <span className="small">{competencyDisplayName(c.code, c.name)}</span></td>
                <td className="num mono">{c.n}</td>
                <td className="num mono"><strong>{fmt(c.own_mean)}</strong></td>
                <td className="num mono muted">{fmt(c.group_mean)}</td>
                <td className="num mono">{signed(r)}</td>
                <td><span className="resid" aria-hidden="true"><span className="resid-zero" />{r !== null ? <span className="resid-bar" style={{ left: r < 0 ? `${50 + Math.max(r, -1) * 50}%` : '50%', width: `${Math.min(Math.abs(r), 1) * 50}%`, background: band?.colour ?? 'var(--brand-accent)' }} /> : null}</span></td>
              </tr>
            ); })}</tbody>
          </table>
          <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>Residual: own grade minus the grade the same pilot earned in the same competency from other instructors. Positive is above them. Raw per competency - only the overall figure is shrunk and banded.</p>
        </Card>

        <Card title="Grade distribution" note="Share of competency grades at each grade, this instructor against everyone">
          <table className="data">
            <thead><tr><th scope="col" className="num">Grade</th><th scope="col">This instructor</th><th scope="col">Everyone</th></tr></thead>
            <tbody>{prof.distribution.map((d) => { const own = d.own / Math.max(1, prof.ownGrades); const all = d.all / Math.max(1, prof.allGrades); const g = gradePalette().find((x) => x.grade === d.grade); return (
              <tr key={d.grade}>
                <td className="num mono"><strong>{d.grade}</strong></td>
                <td><span className="dist"><span className="dist-bar" style={{ width: `${(own / maxDist) * 100}%`, background: g?.colour ?? 'var(--brand-accent)' }} /><span className="mono xs">{pct(own)} · {d.own}</span></span></td>
                <td><span className="dist"><span className="dist-bar dist-all" style={{ width: `${(all / maxDist) * 100}%` }} /><span className="mono xs muted">{pct(all)}</span></span></td>
              </tr>
            ); })}</tbody>
          </table>
          <div className="stack" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
            <div className="xs muted" style={{ letterSpacing: '0.04em' }}>OUTCOMES · {prof.recordsTotal} records</div>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              {prof.outcomes.map((o) => <Chip key={o.outcome} tone={/FAIL|NOT|INCOMPLETE/.test(o.outcome) ? 'bad' : o.outcome === 'no outcome' ? 'neutral' : 'good'}>{o.outcome} {o.n}</Chip>)}
              {prof.additionalTraining ? <Chip tone="warn">Additional training {prof.additionalTraining}</Chip> : null}
            </div>
          </div>
        </Card>
      </div>

      <div className="profile-grid">
        <Card title="Habits" note="The terms behind the standardisation index, with the raw quantity behind each">
          <table className="data">
            <thead><tr><th scope="col">Term</th><th scope="col" className="num">Points</th><th scope="col" className="num">Lost</th><th scope="col">Behind it</th></tr></thead>
            <tbody>{(asi?.terms ?? []).map((t) => {
              const h = prof.habits;
              const behind = t.name === 'leniency' ? `adjusted delta ${signed(a?.delta_adjusted)}`
                : t.name === 'spread' ? `σ of grades ${fmt(a?.sigma_grade)} (floor ${cfg.assessor_fairness.spread.sigma_floor}, min ${cfg.assessor_fairness.spread.sigma_min})`
                : t.name === 'justification' ? (h.n_below ? `${h.n_substantive} of ${h.n_below} low grades carry a substantive remark (${pct(h.justification_rate)})` : 'no low grade awarded')
                : t.name === 'halo' ? (h.n_halo_eligible ? `${h.n_halo} of ${h.n_halo_eligible} records with one grade for every competency (${pct(h.halo_rate)})` : 'no eligible record')
                : t.name === 'drift' ? (prof.monthly.length >= 3 ? `slope of the monthly residual over ${prof.monthly.length} months` : 'fewer than 3 months of data')
                : `not observed ${pct(h.actual_nr_rate)} vs ${pct(h.expected_nr_rate)} expected on the same programs`;
              return (
                <tr key={t.name}>
                  <td>{TERM_LABEL[t.name] ?? t.name}</td>
                  <td className="num mono">{t.points}</td>
                  <td className="num mono">{t.available ? <strong>{t.pointsLost.toFixed(1)}</strong> : <span className="muted">n/a</span>}</td>
                  <td className="small">{behind}</td>
                </tr>
              );
            })}</tbody>
          </table>
          {asi ? <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>{Math.round(asi.deductions)} points lost of {asi.availablePoints} measurable{asi.isProvisional ? ' · provisional: not banded until ' + cfg.assessor_fairness.adjusted_delta.min_records_banded + ' records' : ''}{a && a.share_above_level_1 !== null && a.share_above_level_1 > maxFallback ? ` · ${pct(a.share_above_level_1)} of expected grades fell back below level 1, so treat the banding with care` : ''}.</p> : <p className="muted small">No graded record yet.</p>}
        </Card>

        <Card title="Observable behaviours ticked most" note="This instructor's share of ticks against everyone's share of the same behaviour">
          {prof.obHabits.length ? (
            <table className="data">
              <thead><tr><th scope="col">Behaviour</th><th scope="col" className="num">Ticks</th><th scope="col" className="num">Own share</th><th scope="col" className="num">Everyone</th></tr></thead>
              <tbody>{prof.obHabits.map((o) => { const ratio = o.all_share > 0 ? o.own_share / o.all_share : null; return (
                <tr key={o.code}>
                  <td><span className="mono xs">{o.code}</span> <span className="small">{o.text}</span></td>
                  <td className="num mono">{o.own_n}</td>
                  <td className="num mono"><strong>{pct(o.own_share)}</strong>{ratio !== null && ratio >= 2 ? <Chip tone="warn" title="Ticked at least twice as often as the group">×{ratio.toFixed(1)}</Chip> : null}</td>
                  <td className="num mono muted">{pct(o.all_share)}</td>
                </tr>
              ); })}</tbody>
            </table>
          ) : <p className="muted small">No observable behaviour ticked yet.</p>}
          <div style={{ marginTop: 'var(--space-3)' }}>
            <div className="xs muted" style={{ letterSpacing: '0.04em' }}>MONTHLY RESIDUAL · mean of (own grade − expected)</div>
            {prof.monthly.length ? <TrendSparkline id="spark-residual" label="Monthly mean residual" points={prof.monthly} tokens={tokens} colour={tokens.series.primary} min={-residualRange} max={residualRange} width={520} height={120} fontScale={1.3} dotRadius={2.4} /> : <p className="muted small">No month with grades yet.</p>}
          </div>
        </Card>
      </div>

      <Card title="Records signed" note="Most recent first - click a row to open the record">
        <RecordsTable rows={records} subjectLabel={L.assessor} showSubject />
        <Pager path={`/instructors/${id}`} params={{}} page={page} size={size} total={recordTotal} noun="records" sizes={PAGE_SIZES} />
      </Card>
    </div>
  );
}
