import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query, queryOne } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, can, canOnPerson } from '@/lib/access';
import { labels, gradeScale, gradePalette } from '@/lib/config';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import type { SubjectFigures } from '@/lib/analytics/subject-figures';
import type { SubjectNarrative } from '@/lib/analytics/subject-narrative';
import type { ProvenanceReport } from '@/lib/provenance';
import { subjectPanel } from '@/lib/analytics/subject-panel';
import { buildChartTokens } from '@/components/charts/chart-tokens';
import GradeDistributionRows from '@/components/charts/GradeDistributionRows';
import PeerCompare from '@/components/charts/PeerCompare';
import TrendScrubber from '@/components/charts/TrendScrubber';
import ZoomableChart from '@/components/charts/ZoomableChart';
import GradeChip from '@/components/ui/GradeChip';

/**
 * /subjects/[id]/analysis - the generated analysis of one pilot, and the check on it.
 *
 * WHAT THIS PAGE IS FOR, and it is not "showing the AI output". It is showing the SEPARATION:
 * the figures the deterministic core computed, the findings a model wrote about them, and the
 * gate's verdict on whether every number in those findings came from those figures. All three on
 * one screen, because the claim being made to an airline is only worth anything if the evidence
 * for it is in the same place.
 *
 * So a REJECTED run is not hidden. It is the most persuasive thing here: a narrative that was
 * written, checked, found to contain a figure nobody computed, and refused. A page that quietly
 * dropped those would be making the opposite claim - that the model is always right.
 *
 * Gate: training.analysis.view, and people.view row-checked on this pilot.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Analysis' };

/* The screening index's own vocabulary, turned into words a training manager reads. RED is not
   "fail" and ABOVE is not "good": the index decides WHERE TO LOOK and never decides an outcome. */
const BAND_WORD: Record<string, string> = {
  RED: 'look now', AMBER: 'watch', STANDARD: 'at standard', ABOVE: 'above', INSUFFICIENT: 'too few grades',
};
const BAND_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'info'> = {
  RED: 'bad', AMBER: 'warn', STANDARD: 'good', ABOVE: 'info', INSUFFICIENT: 'neutral',
};
const TREND_WORD: Record<string, string> = {
  UP: 'improving', DOWN: 'falling', FLAT: 'level', NONE: '—',
};
/** How many recent grades the strip shows. Matches what subject-panel.ts keeps. */
const RECENT_GRADES = 5;

interface RunRow {
  id: string;
  status: string;
  requested_at: string;
  completed_at: string | null;
  narrative_model: string | null;
  error: string | null;
  figures: SubjectFigures | null;
  narrative: SubjectNarrative | null;
  provenance: ProvenanceReport | null;
  requested_by_name: string | null;
}

const TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  complete: 'good',
  rejected: 'bad',
  failed: 'warn',
  running: 'info',
  queued: 'neutral',
};

/** The word an operator needs, not the enum. "failed" and "rejected" mean opposite things here. */
const STATUS_WORD: Record<string, string> = {
  complete: 'Complete',
  rejected: 'Rejected by the gate',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
};

const pct = (x: number | null | undefined): string =>
  x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`;
const num = (x: number | null | undefined): string =>
  x === null || x === undefined ? '—' : String(x);

export default async function SubjectAnalysisPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const wanted = typeof sp.run === 'string' ? sp.run : '';
  const problem = typeof sp.problem === 'string' ? sp.problem : '';

  const session = await requireSession();
  const access = await resolveAccess(session);
  const L = labels();

  // Same answer for "may not see" and "does not exist", as everywhere else a person id appears.
  if (!(await canOnPerson(access, 'people.view', id))) notFound();
  if (!can(access, 'training.analysis.view')) notFound();

  const person = await queryOne<{ full_name: string; external_id: string }>(
    `SELECT full_name, external_id FROM people WHERE id = $1::uuid AND deleted_at IS NULL`,
    [id],
  );
  if (!person) notFound();

  const runs = await query<RunRow>(
    `SELECT a.id, a.status, a.requested_at::text, a.completed_at::text, a.narrative_model, a.error,
            a.figures, a.narrative_html::jsonb AS narrative, a.provenance,
            u.username AS requested_by_name
       FROM analysis_runs a
       LEFT JOIN users u ON u.id = a.requested_by
      WHERE a.person_id = $1::uuid AND a.deleted_at IS NULL
      ORDER BY a.requested_at DESC
      LIMIT 10`,
    [id],
  );

  /* The four panels below are computed whether or not a narrative has ever been run. Everything on
     them is SQL and arithmetic, so they are right when the inference endpoint is unset, unreachable,
     or has just had a report refused by the gate - which is the point. */
  const panel = await subjectPanel(id);
  const scale = gradeScale();
  const tokens = buildChartTokens({
    competencies: (panel?.reliability ?? []).map((c) => ({ competencyId: c.competencyId, code: c.code, name: c.name, colour: c.colour })),
    grades: gradePalette(),
  });

  const selected = runs.find((r) => r.id === wanted) ?? runs[0] ?? null;
  const canRun = can(access, 'training.analysis.run');
  const figures = selected?.figures ?? null;
  const report = selected?.provenance ?? null;

  return (
    <div className="stack" data-testid="subject-analysis">
      <Breadcrumbs items={[
        { label: 'Overview', href: '/' },
        { label: L.subject_plural, href: '/subjects' },
        { label: person.full_name, href: `/subjects/${id}` },
        { label: 'Analysis' },
      ]} />

      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Analysis</h1>
        <span className="xs muted">{person.full_name} · <span className="mono">{person.external_id}</span></span>
        <span className="spacer" />
        {canRun ? (
          <form method="post" action={`/api/subjects/${id}/analysis`}>
            <button type="submit" className="button">Run the analysis</button>
          </form>
        ) : null}
      </div>

      {problem ? <div className="notice notice-bad" role="status"><p style={{ margin: 0 }}>{problem}</p></div> : null}

      <Card
        title="How this is made"
        note="The separation is the product, so it is on the page rather than in a brochure."
      >
        <p className="small" style={{ margin: 0 }}>
          Every figure below is computed from signed records in SQL. The model receives those
          figures and writes findings about them — it is never asked for a number. What it writes is
          then checked back against the figures, number by number: a report that names a figure the
          core did not produce is <strong>rejected</strong> and never shown as a report.
        </p>
      </Card>

      {panel ? (
        <>
          <Card
            title="Competency reliability"
            note={`One index per competency over the last ${panel.months} months, never one number for the pilot: a single score would let a 5 in one competency cancel a 2 in another, which is the compensation this index exists to prevent. Bands, window and weights are in analytics.yaml.`}
            testId="panel-reliability"
          >
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Competency</th><th scope="col">Band</th>
                  <th scope="col" className="num">Index</th><th scope="col">Trend</th>
                  <th scope="col" className="num">Grades</th><th scope="col">Since below standard</th>
                  <th scope="col">Last {RECENT_GRADES}</th>
                </tr>
              </thead>
              <tbody>
                {panel.reliability.map((r) => (
                  <tr key={r.competencyId}>
                    <td><span className="ccode xs">{r.code}</span> <span className="small">{r.name}</span></td>
                    <td>
                      <Chip tone={BAND_TONE[r.band]} srPrefix="band">{BAND_WORD[r.band]}</Chip>
                      {r.recovery ? <span className="xs muted"> · {r.recovery.achieved} of {r.recovery.required} clean</span> : null}
                    </td>
                    <td className="num mono">{r.score === null ? <span className="muted">—</span> : r.score.toFixed(2)}</td>
                    <td className="xs muted">{TREND_WORD[r.trend]}</td>
                    <td className="num mono xs">{r.n}</td>
                    <td className="xs muted">
                      {r.sinceBelow === null ? 'never below standard'
                        : r.sinceBelow === 0 ? <strong>the last grade was below standard</strong>
                        : `${r.sinceBelow} grade${r.sinceBelow === 1 ? '' : 's'} since`}
                    </td>
                    <td>
                      {r.recent.length === 0 ? <span className="xs muted">none</span> : (
                        <span className="grade-strip" title={`Oldest to newest: ${r.recent.join(', ')}`}>
                          {r.recent.map((g, i) => <GradeChip key={`${r.competencyId}-${i}`} value={g} />)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>
              The last {RECENT_GRADES} grades run oldest to newest, and are the grades as awarded — the
              index adjusts for instructor leniency and recency, these do not. A grade of {scale.critical_grade} is
              non-compensatory: it never scores, and it holds the band until a clean run clears it.
            </p>
          </Card>

          <div className="grid-half">
            <Card
              title="Against the fleet"
              note={`Mean competency grade over ${panel.months} months, this pilot against ${panel.peerLabel}. The axis is the whole ${scale.min}-${scale.max} scale, not the range of the data.`}
              testId="panel-peer"
            >
              <ZoomableChart
                title={`Competency means — this pilot against ${panel.peerLabel}`}
                /* Same chart, wider dialog: 560 units in 1502px is a ratio of 2.68 against 0.98
                   inline, so without this its labels render at 34px. */
                dialogChildren={(
                  <PeerCompare
                    id="subject-peer" rows={panel.peer} tokens={tokens} pxPerUnit={2.68}
                    min={scale.min} max={scale.max} peerLabel={panel.peerLabel}
                    label="Competency means, this pilot against the peer group"
                  />
                )}
              >
                <PeerCompare
                  id="subject-peer" rows={panel.peer} tokens={tokens}
                  min={scale.min} max={scale.max} peerLabel={panel.peerLabel}
                  label="Competency means, this pilot against the peer group"
                />
              </ZoomableChart>
            </Card>

            <Card
              title="Where their grades sit"
              note={`Every competency grade in the ${panel.months}-month window. Below standard is at or under ${scale.below_standard_max}.`}
              testId="panel-distribution"
            >
              <ZoomableChart
                title="Where their grades sit"
                dialogChildren={(
                  <GradeDistributionRows
                    id="subject-distribution" counts={panel.distribution.subject} tokens={tokens} pxPerUnit={2.68}
                    gradeLabels={Object.fromEntries(gradePalette().map((g) => [g.grade, g.label]))}
                    min={scale.min} max={scale.max} belowStandardMax={scale.below_standard_max}
                    label="This pilot's competency grades, by grade"
                    emptyText="No competency grade in this window."
                  />
                )}
              >
                <GradeDistributionRows
                  id="subject-distribution" counts={panel.distribution.subject} tokens={tokens}
                  gradeLabels={Object.fromEntries(gradePalette().map((g) => [g.grade, g.label]))}
                  min={scale.min} max={scale.max} belowStandardMax={scale.below_standard_max}
                  label="This pilot's competency grades, by grade"
                  emptyText="No competency grade in this window."
                />
              </ZoomableChart>
            </Card>
          </div>

          <Card
            title="The trend, against the fleet"
            note={`Mean competency grade in the months this pilot trained, against ${panel.peerLabel}. The whole career is on the slider; the window opens on the most recent two years.`}
            testId="panel-trend"
          >
            {/* Not wrapped in ZoomableChart: the slider is the interaction here, and a chart that
                opens a dialog when you press its own control is a trap. */}
            <TrendScrubber
              points={panel.trend} tokens={tokens}
              min={scale.min} max={scale.max} peerLabel={panel.peerLabel}
              label="Mean competency grade by month, this pilot against the peer group"
            />
          </Card>
        </>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          title="No analysis has been run for this pilot"
          reason={canRun
            ? 'Running one reads the last twelve months of signed records, computes the figures, and asks for findings about them.'
            : 'Your account can read an analysis but not request one.'}
          testId="analysis-empty"
        />
      ) : (
        <>
          <Card title="Runs" note="Every request is kept, including the ones the gate refused.">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Requested</th><th scope="col">By</th><th scope="col">Status</th>
                  <th scope="col">Provenance</th><th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={r.id === selected?.id ? 'row-selected' : undefined}>
                    <td className="mono xs">{r.requested_at.slice(0, 16).replace('T', ' ')}</td>
                    <td className="xs">{r.requested_by_name ?? '—'}</td>
                    <td><Chip tone={TONE[r.status] ?? 'neutral'} srPrefix="status">{STATUS_WORD[r.status] ?? r.status}</Chip></td>
                    <td className="mono xs">{pct(r.provenance?.provenanceScore)}</td>
                    {/* A plain <a>, NOT a <Link>. The App Router's client cache keys by ROUTE, not by
                        search params, so a <Link> from /subjects/x/analysis?run=A to the same path with
                        ?run=B is a cache hit and the page does not change - the link looks dead. The
                        same bug was fixed on the grading screen's pilot tabs. Do not "optimise" this
                        back into a <Link>. */}
                    <td><a href={`/subjects/${id}/analysis?run=${r.id}`}>Open</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {selected ? (
            <>
              {selected.status === 'rejected' ? (
                <Card title="This report was refused" testId="analysis-rejected">
                  <p className="small" style={{ margin: 0 }}>{selected.error}</p>
                  {report && report.unsourced.length > 0 ? (
                    <table className="data" style={{ marginTop: 'var(--space-2)' }}>
                      <thead><tr><th scope="col">Figure written</th><th scope="col">Where it appeared</th></tr></thead>
                      <tbody>
                        {report.unsourced.map((u, idx) => (
                          <tr key={`${u.value}-${idx}`}>
                            <td className="mono"><strong>{u.text}</strong></td>
                            <td className="small">…{u.context.trim()}…</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>
                    The text it wrote is kept so the prompt or the figure set can be corrected. It is
                    not published, and no part of it reaches the pilot&apos;s record.
                  </p>
                </Card>
              ) : null}

              {selected.status === 'failed' ? (
                <Card title="This run did not finish">
                  <p className="small" style={{ margin: 0 }}>{selected.error ?? 'The run failed.'}</p>
                  <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>
                    A failure is the machinery breaking, not the gate refusing — those are different
                    events and they are never shown as the same one.
                  </p>
                </Card>
              ) : null}

              {selected.narrative && selected.status === 'complete' ? (
                <Card
                  title="Findings"
                  note="Written from the figures below, and checked against them before it was published."
                  testId="analysis-narrative"
                  actions={report ? <Chip tone="good" srPrefix="provenance">Every figure sourced · {pct(report.provenanceScore)}</Chip> : null}
                >
                  <p style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{selected.narrative.headline}</p>
                  <div className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                    {selected.narrative.findings.map((f, idx) => (
                      <div key={idx}>
                        <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{f.title}</h3>
                        <p className="small" style={{ margin: '2px 0 0' }}>{f.detail}</p>
                      </div>
                    ))}
                  </div>
                  {selected.narrative.watch.length > 0 ? (
                    <>
                      <h3 style={{ margin: 'var(--space-3) 0 0', fontSize: 'var(--text-sm)' }}>To watch</h3>
                      <ul className="small" style={{ margin: '2px 0 0' }}>
                        {selected.narrative.watch.map((w, idx) => <li key={idx}>{w}</li>)}
                      </ul>
                    </>
                  ) : null}
                </Card>
              ) : null}

              {selected.status === 'complete' && !selected.narrative ? (
                <Card title="Figures only" note="No inference endpoint answered, which is a supported state.">
                  <p className="small" style={{ margin: 0 }}>
                    {selected.error ?? 'Narration was unavailable.'} Every figure below is unaffected:
                    they are computed from records and never depended on a model.
                  </p>
                </Card>
              ) : null}

              {report ? (
                <Card title="The check" note="What the gate did, on this run, with these thresholds." testId="analysis-provenance">
                  <dl className="report-meta">
                    <div><dt>Numbers in the narrative</dt><dd className="mono">{num(report.numbersFound)}</dd></div>
                    <div><dt>Traced to a computed figure</dt><dd className="mono">{num(report.numbersMatched)}</dd></div>
                    <div><dt>Provenance</dt><dd className="mono">{pct(report.provenanceScore)} <span className="xs muted">required {pct(report.thresholds.minProvenance)}</span></dd></div>
                    <div><dt>Records named</dt><dd className="mono">{num(report.sourcesCited)} of {num(report.sourcesAvailable)} <span className="xs muted">required {pct(report.thresholds.minCoverage)}</span></dd></div>
                  </dl>
                </Card>
              ) : null}

              {figures ? (
                <>
                  <Card title="The figures it was given" note={`Computed in SQL over the last ${figures.window.months} months, ${figures.window.from} to ${figures.window.to}.`} testId="analysis-figures">
                    <dl className="report-meta">
                      <div><dt>Records</dt><dd className="mono">{num(figures.totals.records)}</dd></div>
                      <div><dt>Competency grades</dt><dd className="mono">{num(figures.totals.competency_grades)}</dd></div>
                      <div><dt>Mean grade</dt><dd className="mono">{num(figures.totals.mean_grade)}</dd></div>
                      <div><dt>At or below {figures.scale.below_standard_max}</dt><dd className="mono">{num(figures.totals.below_standard)} <span className="xs muted">{num(figures.totals.below_standard_percent)}%</span></dd></div>
                    </dl>
                  </Card>

                  <Card title="By competency" note="Mean, count, and the newer half of this pilot's own series against the older half.">
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Competency</th><th scope="col">Mean</th>
                          <th scope="col">Graded</th><th scope="col">At or below {figures.scale.below_standard_max}</th>
                          <th scope="col">Trend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {figures.competencies.map((c) => (
                          <tr key={c.code}>
                            <td><span className="ccode">{c.code}</span> {c.name}</td>
                            <td className="mono">{num(c.mean)}</td>
                            <td className="mono">{num(c.graded)}</td>
                            <td className="mono">{num(c.below_standard)}</td>
                            <td className="xs">{c.trend === 'NONE' ? <span className="muted">too few</span> : `${c.trend} ${c.trend_delta === null ? '' : c.trend_delta > 0 ? `+${c.trend_delta}` : c.trend_delta}`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>

                  <Card title="Records read" note="The most recent eight in the window. These are the titles the narrative is expected to name.">
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Date</th><th scope="col">Record</th><th scope="col">Outcome</th>
                          <th scope="col">Instructor</th><th scope="col">Mean</th>
                        </tr>
                      </thead>
                      <tbody>
                        {figures.recent_records.map((r, idx) => (
                          <tr key={`${r.date}-${idx}`}>
                            <td className="mono xs">{r.date}</td>
                            <td>{r.title}</td>
                            <td>{r.outcome ?? '—'}</td>
                            <td className="xs">{r.assessor ?? '—'}</td>
                            <td className="mono">{num(r.mean_grade)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
