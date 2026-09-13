import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, can, canOnPerson } from '@/lib/access';
import { labels, analyticsConfig, gradePalette, leniencyZones } from '@/lib/config';
import { getInstructor, getInstructorAnalysis, leaning, alertLabel, LEANING_LABEL, LEANING_TONE, type AlertRow, type AlertType } from '@/lib/instructors';
import type { AnalyticsConfig } from '@/lib/analytics';
import { buildChartTokens } from '@/components/charts/chart-tokens';
import { KpiTile } from '@/components/charts/KpiTile';
import { LeniencyInterval } from '@/components/charts/LeniencyInterval';
import { TrendSparkline } from '@/components/charts/TrendSparkline';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';

/**
 * /instructors/[id]/analysis - one instructor's standardisation analysis.
 *
 * Four sections, in the order a standardisation conversation actually runs:
 *
 *   Adjusted leniency          chart 35 - the delta, its interval, the bench distribution behind it
 *   Check versus training      the same residuals split by whether the template kind is a check
 *   Standardisation index      chart 39 - "why not green", every term and every point lost
 *   Alert queue                chart 41 - grouped, and a decision needs a reviewer note
 *
 * Row access is re-checked: training.analytics.assessor.view on THIS person, which the resolver makes
 * false for the holder, so an instructor reaches "not found" on their own analysis rather than a page.
 * Deciding an alert additionally needs training.records.amend, which the assessment manager holds.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const CAP = 'training.analytics.assessor.view';
const UUID = /^[0-9a-f-]{36}$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = UUID.test(id) ? (await query<{ full_name: string }>(`SELECT full_name FROM people WHERE id = $1::uuid AND deleted_at IS NULL`, [id]))[0] : undefined;
  return { title: r ? `${r.full_name} · analysis` : 'Instructor analysis' };
}

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d));
const signed = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const TERM_LABEL: Record<string, string> = { leniency: 'Adjusted leniency', spread: 'Grade spread', justification: 'Low grades justified', halo: 'Same grade everywhere', drift: 'Drift over time', not_observed: 'Not observed' };
const ORDER: AlertType[] = ['unjustified_low', 'outcome_mismatch', 'halo_record', 'masking'];

export default async function InstructorAnalysisPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const done = typeof sp.done === 'string' ? sp.done : '';
  const problem = typeof sp.problem === 'string' ? sp.problem : '';
  const session = await requireSession();
  const access = await resolveAccess(session);
  if (!UUID.test(id) || !(await canOnPerson(access, CAP, id))) notFound();

  const L = labels();
  const cfg = analyticsConfig<AnalyticsConfig>();
  const si = cfg.assessor_fairness.standardisation_index;
  const outlierAbs = cfg.assessor_fairness.adjusted_delta.outlier_abs;
  const [prof, an] = await Promise.all([getInstructor(id), getInstructorAnalysis(id)]);
  if (!prof) notFound();

  const tokens = buildChartTokens({ competencies: prof.competencies.map((c) => ({ competencyId: c.id, code: c.code, name: c.name, colour: c.colour })), grades: gradePalette() });
  const zones = leniencyZones();
  const a = prof.adjusted;
  const lean = leaning(a?.delta_adjusted ?? null, a?.is_provisional ?? true, cfg);
  const asi = prof.asi;
  const cvt = an.checkVsTraining;
  const canDecide = can(access, 'training.records.amend');
  const residualRange = Math.max(0.5, ...prof.monthly.map((m) => Math.abs(m.value ?? 0)));
  const openTotal = ORDER.reduce((s, k) => s + an.counts[k].open, 0);

  const verdictText = {
    insufficient: `Not enough evidence on one side: ${cvt.checks.n} grades in checks and ${cvt.training.n} in training, against a minimum of ${cvt.minPerSide} a side. This is "we cannot tell", not "no difference".`,
    no_difference: 'The interval spans zero: this instructor grades a check the way they grade training, as far as this evidence can tell.',
    harder_in_checks: 'Grades a check harder than training, by more than the interval allows for.',
    softer_in_checks: 'Grades a check more softly than training, by more than the interval allows for.',
  }[cvt.verdict];

  const alertGroups = ORDER.map((k) => ({ type: k, rows: an.alerts.filter((r) => r.alert_type === k) })).filter((g) => g.rows.length > 0);

  const decisionForm = (r: AlertRow) => (
    <form method="post" action={`/api/instructors/${id}/alerts`} className="alert-decide">
      <input type="hidden" name="record_id" value={r.record_id} />
      {r.competency_id ? <input type="hidden" name="competency_id" value={r.competency_id} /> : null}
      <input type="hidden" name="alert_type" value={r.alert_type} />
      {r.status === 'open' ? (
        <>
          <label className="sr-only" htmlFor={`note-${r.key}`}>Reviewer note</label>
          <input id={`note-${r.key}`} name="reviewer_note" type="text" required minLength={3} placeholder="Why - required" className="alert-note" />
          <button type="submit" name="status" value="confirmed" className="button xs">Confirm</button>
          <button type="submit" name="status" value="dismissed" className="button button-quiet xs">Dismiss</button>
        </>
      ) : (
        <button type="submit" name="status" value="open" className="button button-quiet xs">Reopen</button>
      )}
    </form>
  );

  return (
    <div className="stack" data-testid="instructor-analysis-detail">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: L.assessor_plural, href: '/instructors' }, { label: prof.person.full_name, href: `/instructors/${id}` }, { label: 'Analysis' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{prof.person.full_name}</h1>
        <span className="small muted">{prof.person.position ?? '—'} · {prof.person.fleet ?? '—'} · {prof.person.base ?? '—'}</span>
        <span className="mono xs">{prof.person.instructor_roles.join(' ')}</span>
        <span className="spacer" />
        <Link href={`/instructors/${id}`} className="button button-quiet" style={{ textDecoration: 'none' }}>Profile</Link>
        <Link href="/instructors/analysis" className="button button-quiet" style={{ textDecoration: 'none' }}>Bench analysis</Link>
      </div>

      {done ? <div className="notice" role="status"><p style={{ margin: 0 }}>{done}</p></div> : null}
      {problem ? <div className="notice notice-bad" role="status"><p style={{ margin: 0 }}>{problem}</p></div> : null}

      <div className="grid grid-kpi">
        <KpiTile id="an-delta" caption="Adjusted leniency" value={signed(a?.delta_adjusted)} state={a ? 'value' : 'insufficient'}
          band={LEANING_TONE[lean] === 'good' ? 'green' : LEANING_TONE[lean] === 'warn' ? 'amber' : LEANING_TONE[lean] === 'bad' ? 'red' : 'neutral'}
          bandLabel={LEANING_LABEL[lean]} context={a?.ci_half_width != null ? `± ${a.ci_half_width.toFixed(2)} at 95%` : null}
          reference={`bench median ${signed(an.peerMedianDelta)}`} tokens={tokens} />
        <KpiTile id="an-asi" caption="Standardisation index" value={asi?.score == null ? null : Math.round(asi.score).toString()} state={asi?.score == null ? 'insufficient' : 'value'}
          band={asi?.band === 'green' ? 'green' : asi?.band === 'amber' ? 'amber' : asi?.band === 'red' ? 'red' : 'neutral'}
          bandLabel={asi ? (asi.band === 'not_banded' ? 'provisional' : asi.band) : null} context={`of ${si.base}, over ${asi?.availablePoints ?? 0} measurable points`} tokens={tokens} />
        <KpiTile id="an-cvt" caption="Check versus training" value={cvt.welch ? signed(cvt.welch.diff) : null} state={cvt.verdict === 'insufficient' ? 'insufficient' : 'value'}
          band={cvt.verdict === 'no_difference' ? 'green' : cvt.verdict === 'insufficient' ? 'neutral' : 'amber'}
          bandLabel={cvt.verdict === 'harder_in_checks' ? 'harder in checks' : cvt.verdict === 'softer_in_checks' ? 'softer in checks' : cvt.verdict === 'no_difference' ? 'no difference' : 'insufficient'}
          context="residual difference, grade points" tokens={tokens} />
        <KpiTile id="an-alerts" caption="Alerts open" value={String(openTotal)} band={openTotal ? 'amber' : 'green'} bandLabel={openTotal ? 'to review' : 'clear'}
          context={`${an.alerts.length} nominated in total`} tokens={tokens} />
      </div>

      <Card
        title="Adjusted leniency"
        note="This instructor's grades minus what the same pilots earned in the same competencies from other instructors, shrunk toward zero for sample size. The interval is the reading, not the point: a delta whose interval spans zero is not a finding."
      >
        <LeniencyInterval id="lenint" delta={a?.delta_adjusted ?? null} ciHalfWidth={a?.ci_half_width ?? null} rawDelta={a?.delta_unadjusted ?? null}
          provisional={a?.is_provisional ?? true} outlierAbs={outlierAbs} peerMedian={an.peerMedianDelta} peers={an.peerDeltas} zones={zones} tokens={tokens} />
        <div className="row" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-4)' }}>
          <span className="small"><strong>{a?.n_grades ?? 0}</strong> grades <span className="muted">over {a?.n_records ?? 0} records and {a?.n_subjects ?? 0} pilots</span></span>
          <span className="small">Mean grade <strong>{fmt(a?.mean_grade)}</strong> <span className="muted">bench {fmt(prof.groupMean)}</span></span>
          <span className="small">Spread σ <strong>{fmt(a?.sigma_grade)}</strong> <span className="muted">floor {cfg.assessor_fairness.spread.sigma_floor}, minimum {cfg.assessor_fairness.spread.sigma_min}</span></span>
          {a?.is_provisional ? <Chip tone="neutral">Provisional — under {cfg.assessor_fairness.adjusted_delta.min_records_banded} records, never banded</Chip> : null}
        </div>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <div className="xs muted" style={{ letterSpacing: '0.04em' }}>MONTHLY MEAN RESIDUAL · gaps are months with no grading, never zeros</div>
          {prof.monthly.length ? <TrendSparkline id="an-resid" label="Monthly mean residual" points={prof.monthly} tokens={tokens} colour={tokens.series.primary} min={-residualRange} max={residualRange} width={900} height={110} fontScale={1.2} dotRadius={2.4} /> : <p className="muted small">No month with grades yet.</p>}
        </div>
      </Card>

      <Card
        title="Check versus training"
        note={`The same residuals split by whether the program is a check. Checks are the template kinds the operator marks as such in policy.yaml; everything else is training. Compared with a Welch interval because the two sides have different sizes and different variances.`}
      >
        <table className="data">
          <thead><tr><th scope="col">Context</th><th scope="col" className="num">Grades</th><th scope="col" className="num">Records</th><th scope="col" className="num">Mean grade</th><th scope="col" className="num">Mean residual</th><th scope="col" className="num">σ residual</th></tr></thead>
          <tbody>
            <tr>
              <td><strong>Checks</strong> <span className="xs muted">OPC / LPC, line check</span></td>
              <td className="num mono">{cvt.checks.n}</td><td className="num mono">{cvt.checks.records}</td>
              <td className="num mono">{fmt(cvt.checks.mean_grade)}</td><td className="num mono"><strong>{signed(cvt.checks.mean_residual)}</strong></td><td className="num mono">{fmt(cvt.checks.sd_residual)}</td>
            </tr>
            <tr>
              <td><strong>Training</strong> <span className="xs muted">everything else</span></td>
              <td className="num mono">{cvt.training.n}</td><td className="num mono">{cvt.training.records}</td>
              <td className="num mono">{fmt(cvt.training.mean_grade)}</td><td className="num mono"><strong>{signed(cvt.training.mean_residual)}</strong></td><td className="num mono">{fmt(cvt.training.sd_residual)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Difference <span className="xs muted">checks − training</span></th>
              <td className="num" colSpan={5}>
                {cvt.welch ? (
                  <span className="row" style={{ gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
                    <span className="mono"><strong>{signed(cvt.welch.diff)}</strong> <span className="xs muted">95% {signed(cvt.welch.ciLo)} to {signed(cvt.welch.ciHi)}</span></span>
                    <Chip tone={cvt.verdict === 'no_difference' ? 'good' : cvt.verdict === 'insufficient' ? 'neutral' : 'warn'}>
                      {cvt.verdict === 'insufficient' ? 'insufficient' : cvt.verdict === 'no_difference' ? 'no difference' : cvt.verdict === 'harder_in_checks' ? 'harder in checks' : 'softer in checks'}
                    </Chip>
                  </span>
                ) : <span className="muted">insufficient evidence on one side</span>}
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="small" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>{verdictText}</p>
        {cvt.byKind.length ? (
          <table className="data" style={{ marginTop: 'var(--space-3)' }}>
            <caption>By program kind</caption>
            <thead><tr><th scope="col">Kind</th><th scope="col">Context</th><th scope="col" className="num">Grades</th><th scope="col" className="num">Records</th><th scope="col" className="num">Mean grade</th><th scope="col" className="num">Mean residual</th></tr></thead>
            <tbody>{cvt.byKind.map((k) => (
              <tr key={k.kind}>
                <td>{k.label}</td>
                <td>{k.is_check ? <Chip tone="info">Check</Chip> : <span className="muted small">Training</span>}</td>
                <td className="num mono">{k.n}</td><td className="num mono">{k.records}</td>
                <td className="num mono">{fmt(k.mean_grade)}</td><td className="num mono">{signed(k.mean_residual)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </Card>

      <Card title="Standardisation index — breakdown" note={`Base ${si.base} less six deductions, rescaled over the terms whose inputs exist. A term that cannot be measured is not free credit: it leaves the denominator.`}>
        {asi ? (
          <>
            <table className="data">
              <thead><tr><th scope="col">Term</th><th scope="col" className="num">Max</th><th scope="col" className="num">Scaled</th><th scope="col" className="num">Points lost</th><th scope="col">What it is measuring</th></tr></thead>
              <tbody>{asi.terms.map((t) => {
                const h = prof.habits;
                const behind = t.name === 'leniency' ? `adjusted delta ${signed(a?.delta_adjusted)}, full deduction at ${si.terms.leniency.scale_full ?? 0.5}`
                  : t.name === 'spread' ? `σ of grades ${fmt(a?.sigma_grade)}; penalised above ${cfg.assessor_fairness.spread.sigma_floor} and below ${cfg.assessor_fairness.spread.sigma_min}`
                  : t.name === 'justification' ? (h.n_below ? `${h.n_substantive} of ${h.n_below} low grades carry a remark of ${cfg.assessor_fairness.justification.min_words}+ words (${pct(h.justification_rate)})` : 'no grade below standard awarded, so nothing to justify')
                  : t.name === 'halo' ? (h.n_halo_eligible ? `${h.n_halo} of ${h.n_halo_eligible} eligible records carry one grade throughout (${pct(h.halo_rate)})` : `no record with ${cfg.assessor_fairness.habits.halo.min_competencies_graded}+ competencies graded`)
                  : t.name === 'drift' ? (prof.monthly.length >= cfg.trend.min_points ? `slope of the monthly residual over ${prof.monthly.length} months, per ${cfg.trend.slope_interval_days} days` : `fewer than ${cfg.trend.min_points} months with grades`)
                  : `not observed ${pct(h.actual_nr_rate)} against ${pct(h.expected_nr_rate)} expected on the same programs and fleet`;
                return (
                  <tr key={t.name}>
                    <td>{TERM_LABEL[t.name] ?? t.name}</td>
                    <td className="num mono">{t.points}</td>
                    <td className="num mono">{t.available && t.scaled.ok ? t.scaled.value.toFixed(2) : <span className="muted">n/a</span>}</td>
                    <td className="num mono">{t.available ? <strong>{t.pointsLost.toFixed(1)}</strong> : <span className="muted">—</span>}</td>
                    <td className="small">{behind}</td>
                  </tr>
                );
              })}</tbody>
              <tfoot>
                <tr>
                  <th scope="row">Score</th>
                  <td className="num mono">{asi.availablePoints}</td>
                  <td className="num"></td>
                  <td className="num mono"><strong>{asi.deductions.toFixed(1)}</strong></td>
                  <td>
                    <span className="row" style={{ gap: 'var(--space-2)' }}>
                      <strong>{asi.score === null ? '—' : Math.round(asi.score)}</strong>
                      <Chip tone={asi.band === 'green' ? 'good' : asi.band === 'amber' ? 'warn' : asi.band === 'red' ? 'bad' : 'neutral'}>{asi.band === 'not_banded' ? 'not banded' : asi.band}</Chip>
                      <span className="xs muted">{si.base} × (1 − {asi.deductions.toFixed(1)} / {asi.availablePoints})</span>
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
            <p className="small" style={{ margin: 'var(--space-3) 0 0' }}>
              {asi.isProvisional ? <>Not banded: under {cfg.assessor_fairness.adjusted_delta.min_records_banded} records. </> : null}
              {asi.caps.length ? <>Capped by: {asi.caps.join(', ')}. </> : <>No cap active. </>}
              Green at {si.bands.green_min} and above, amber from {si.bands.amber_min}.
              {a?.share_above_level_1 != null && a.share_above_level_1 > 0 ? <> {pct(a.share_above_level_1)} of the expected grades behind these figures came from a fallback rather than a same-pilot comparison.</> : null}
            </p>
          </>
        ) : <p className="muted small">No graded record yet, so there is nothing to index.</p>}
      </Card>

      <Card
        title="Mismatch alert queue"
        note="Nominated by rule from the records this instructor signed, and recomputed every time this page loads - an amended record stops raising its alert on its own. A decision needs a note, and is logged."
      >
        {!canDecide ? <p className="xs muted">You can read this queue but not decide on it; that needs the record-amendment capability.</p> : null}
        {alertGroups.length === 0 ? (
          <p className="muted small">No rule fired on any record this instructor signed.</p>
        ) : alertGroups.map((g) => (
          <div key={g.type} style={{ marginBottom: 'var(--space-5)' }}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <h3 className="card-title" style={{ margin: 0, fontSize: 'var(--text-base)' }}>{alertLabel(g.type)}</h3>
              <Chip tone={an.counts[g.type].open ? 'warn' : 'good'}>{an.counts[g.type].open} open</Chip>
              {an.counts[g.type].confirmed ? <Chip tone="bad">{an.counts[g.type].confirmed} confirmed</Chip> : null}
              {an.counts[g.type].dismissed ? <Chip tone="neutral">{an.counts[g.type].dismissed} dismissed</Chip> : null}
            </div>
            <p className="xs muted" style={{ margin: 'var(--space-1) 0 var(--space-2)' }}>
              {g.type === 'unjustified_low' ? `Rule: a grade at or below ${cfg.assessor_fairness.justification.grade_max} with a remark shorter than ${cfg.assessor_fairness.justification.min_words} words. Definitional - a low grade with no substantive remark is unjustified whatever the text says.`
                : g.type === 'halo_record' ? `Rule: every graded competency on one record carries the identical grade, on a record with at least ${cfg.assessor_fairness.habits.halo.min_competencies_graded} competencies graded.`
                : g.type === 'outcome_mismatch' ? 'Rule: below-standard grades with a passing outcome and no additional training recommended, or a failing outcome with nothing graded below standard.'
                : 'Rule: the remark reads worse than the grade awarded. Requires the model layer, which this build does not run.'}
            </p>
            <table className="data">
              <thead><tr><th scope="col" className="num">Date</th><th scope="col">Pilot</th><th scope="col">Record</th><th scope="col">What the rule found</th><th scope="col">Status</th><th scope="col">{canDecide ? 'Decision' : ''}</th></tr></thead>
              <tbody>{g.rows.map((r) => (
                <tr key={r.key}>
                  <td className="num mono xs">{r.training_date}</td>
                  <td><Link href={`/subjects/${r.subject_id}`}>{r.subject_name}</Link></td>
                  <td className="small">{r.template_name}{r.competency_code ? <span className="xs muted"> · <span className="mono">{r.competency_code}</span></span> : null}</td>
                  <td className="small">{r.detail}{r.remark ? <div className="xs muted">“{r.remark}”</div> : null}</td>
                  <td>
                    <Chip tone={r.status === 'open' ? 'warn' : r.status === 'confirmed' ? 'bad' : 'neutral'}>{r.status}</Chip>
                    {r.reviewer_note ? <div className="xs muted">{r.decided_by_name ?? 'reviewer'}: “{r.reviewer_note}”</div> : null}
                  </td>
                  <td>{canDecide ? decisionForm(r) : null}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ))}
        <p className="xs muted" style={{ margin: 0 }}>
          Masking - a remark that reads worse than the grade awarded - is not nominated here. It requires the model layer to decide, and a keyword rule alone must never cap an instructor&apos;s band: a single ambiguous word produces mostly false positives, and those hold instructors below the band their evidence supports.
        </p>
      </Card>
    </div>
  );
}
