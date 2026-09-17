import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { resolveAccess, requirePageCapability, can, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import { labels, policy, gradeScale, gradePalette, averageBand, analyticsConfig, competencyDisplayName } from '@/lib/config';
import type { AnalyticsConfig } from '@/lib/analytics';
import {
  overviewTotals, byFleet, competencyAverages, gradeDistribution, monthlyMean, validitySummary,
  openAlerts, benchOutliers,
  competenciesAtGrade,
} from '@/lib/analytics/overview';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import KpiTile from '@/components/charts/KpiTile';
import GradeDistributionRows from '@/components/charts/GradeDistributionRows';
import TrendSparkline from '@/components/charts/TrendSparkline';
import { buildChartTokens } from '@/components/charts/chart-tokens';
import ZoomableChart from '@/components/charts/ZoomableChart';

/**
 * /analytics - the training picture. The manager's landing page, and the first screen of the demo.
 *
 * WHAT THIS PAGE IS FOR. A head of training asks four questions in a meeting: how are we doing, who
 * needs attention, what is about to expire, and are we grading consistently. This page answers those
 * four and then hands off - every figure is a link to the screen that can act on it. It computes
 * nothing a deeper screen computes differently, because every number comes from the same place the
 * deeper screens read: `records` and its children, the frozen signed evidence (lib/analytics/overview.ts).
 *
 * WHAT IT IS NOT. Not a place where numbers are typed, not a place where an AI writes a summary, and
 * not a cache: it aggregates records directly, so a record finalised a minute ago is in every figure.
 * The one exception is the standardisation list, which reads the materialised assessor views and says
 * so where it is rendered.
 *
 * Gate: training.analytics.programme.view. An instructor does not hold it; a fleet manager holds it
 * bound to their fleet, and every figure is scoped to the people they can see.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Training picture' };

const WINDOW_MONTHS = 12;
const TREND_MONTHS = 23;

export default async function AnalyticsOverviewPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requirePageCapability(access, 'training.analytics.programme.view');

  const L = labels();
  const P = policy();
  const scale = gradeScale();
  const cfg = analyticsConfig<AnalyticsConfig>();
  const fair = cfg.assessor_fairness.adjusted_delta;

  /* ?grade=N opens the follow-up question to the distribution: four hundred grades of 2 - in what?
     A search param rather than client state, so the answer is a URL somebody can paste into a
     ticket. Out-of-scale values are dropped rather than queried. */
  const sp = await searchParams;
  const rawGrade = typeof sp.grade === 'string' ? Number(sp.grade) : NaN;
  const openGrade = Number.isInteger(rawGrade) && rawGrade >= scale.min && rawGrade <= scale.max ? rawGrade : null;

  const visibleSet = await visiblePersonIds(access, 'people.view');
  const visible = visibleSet === ALL_PEOPLE ? null : visibleSet;

  const [totals, fleets, comps, dist, months, validity, alerts, outliers] = await Promise.all([
    overviewTotals(visible, scale.below_standard_max),
    byFleet(visible),
    competencyAverages(visible, WINDOW_MONTHS, scale.below_standard_max),
    gradeDistribution(visible, WINDOW_MONTHS),
    monthlyMean(visible, TREND_MONTHS),
    validitySummary(visible),
    openAlerts(session.userId, session.personId ?? null),
    can(access, 'training.analytics.assessor.view')
      ? benchOutliers(fair.outlier_abs, fair.min_records_banded)
      : Promise.resolve([]),
  ]);

  const atGrade = openGrade === null ? [] : await competenciesAtGrade(visible, WINDOW_MONTHS, openGrade, 3);
  const gradeWord = openGrade === null ? null : gradePalette().find((g) => g.grade === openGrade)?.label ?? null;

  const tokens = buildChartTokens({
    competencies: comps.map((c) => ({ competencyId: c.id, code: c.code, name: c.name, colour: c.colour })),
    grades: gradePalette(),
  });

  const pct = (v: number | null) => (v === null ? null : `${(v * 100).toFixed(1)}`);
  /* The tile's band comes from the SCALE, not from matching words in a label: meets_standard_min and
     below_standard_max are the two boundaries analytics.yaml defines, and the label beside it is the
     operator's own wording for the band the mean falls in (brand.yaml average_bands). */
  const meanBand: 'green' | 'amber' | 'red' | null = totals.meanGrade === null ? null
    : totals.meanGrade >= scale.meets_standard_min ? 'green'
    : totals.meanGrade > scale.below_standard_max ? 'amber' : 'red';
  const meanBandLabel = averageBand(totals.meanGrade)?.label ?? null;
  const dueSoon = validity.reduce((s, v) => s + v.warning, 0);
  const expired = validity.reduce((s, v) => s + v.expired, 0);
  const attention = alerts.length + outliers.length + expired;

  return (
    <div className="stack" data-testid="analytics-overview">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Training picture' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Training picture</h1>
        <span className="xs muted">
          every figure computed from signed records · the last {WINDOW_MONTHS} months
          {visible === null ? '' : ' · your fleet'}
        </span>
        <span className="spacer" />
        <Link href="/subjects/status" className="button button-quiet xs" style={{ textDecoration: 'none' }}>Training status</Link>
        {can(access, 'training.analytics.assessor.view')
          ? <Link href="/instructors/analysis" className="button button-quiet xs" style={{ textDecoration: 'none' }}>Standardisation</Link>
          : null}
      </div>

      <div className="grid grid-tiles" data-testid="overview-tiles">
        <KpiTile id="pilots" caption={`Active ${L.subject_plural.toLowerCase()}`} value={String(totals.pilots)}
          context={`${totals.instructors} hold an instructor qualification`} tokens={tokens} />
        <KpiTile id="records" caption="Records signed" value={String(totals.recordsYear)}
          context={`${totals.recordsMonth} this month · ${totals.finalisedWeek} finalised this week`} tokens={tokens} />
        <KpiTile id="mean" caption="Mean competency grade" value={totals.meanGrade === null ? null : totals.meanGrade.toFixed(2)}
          band={meanBand}
          bandLabel={meanBandLabel}
          context={`${totals.scored.toLocaleString('en')} competency grades`}
          reference={`target ${P.grading?.target_grade ?? scale.meets_standard_min}`} tokens={tokens} />
        <KpiTile id="below" caption={`At or below grade ${scale.below_standard_max}`} value={pct(totals.belowStandardRate)} unit="%"
          state={totals.belowStandardRate === null ? 'insufficient' : undefined}
          context={totals.belowStandardRate === null ? 'no grades in the window' : 'of every competency grade'} tokens={tokens} />
        <KpiTile id="open" caption="Sessions open" value={String(totals.sessionsOpen)}
          context="graded but not yet finalised" tokens={tokens} />
        <KpiTile id="due" caption="Validity due or expired" value={String(dueSoon + expired)}
          band={expired > 0 ? 'red' : dueSoon > 0 ? 'amber' : 'green'}
          bandLabel={expired > 0 ? `${expired} expired` : dueSoon > 0 ? 'inside the window' : 'all current'}
          context={`${dueSoon} inside the warning window`} tokens={tokens} />
      </div>

      {/* ---------------------------------------------------------------- what needs a person */}
      <Card
        title={attention === 0 ? 'Nothing is waiting for you' : `${attention} ${attention === 1 ? 'thing needs' : 'things need'} a decision`}
        note="Raised by the system from signed evidence, never typed in. Each line links to the screen that can act on it."
        testId="attention-queue"
      >
        {attention === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            No objection is outstanding, nothing is expired, and no instructor is outside the review threshold.
          </p>
        ) : (
          <div className="stack" style={{ gap: 'var(--space-3)' }}>
            {alerts.length ? (
              <div className="stack" style={{ gap: 'var(--space-2)' }}>
                {alerts.map((a) => (
                  <div key={a.id} className="row" style={{ alignItems: 'baseline', gap: 'var(--space-2)' }}>
                    <Chip tone={a.severity === 'hard' ? 'bad' : 'warn'}>{a.kind.split('.').pop()}</Chip>
                    <span className="small"><strong>{a.title}</strong>{a.body ? <span className="muted"> — “{a.body.slice(0, 140)}{a.body.length > 140 ? '…' : ''}”</span> : null}</span>
                    <span className="spacer" />
                    <span className="xs muted mono">{a.at.slice(0, 10)}</span>
                    {a.sessionId ? <Link href={`/sessions/${a.sessionId}`} className="xs">the session</Link> : null}
                    {a.subjectId ? <Link href={`/subjects/${a.subjectId}`} className="xs">{a.subjectName ?? 'the pilot'}</Link> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {expired > 0 ? (
              <p className="small" style={{ margin: 0 }}>
                <Chip tone="bad">validity</Chip>{' '}
                <strong>{expired}</strong> {expired === 1 ? 'pilot has' : 'pilots have'} an expired item.{' '}
                <Link href="/subjects/status">Open the training status</Link> — the table names which item, per pilot.
              </p>
            ) : null}

            {outliers.length ? (
              <div className="stack" style={{ gap: 'var(--space-1)' }}>
                <p className="small" style={{ margin: 0 }}>
                  <Chip tone="warn">standardisation</Chip>{' '}
                  {outliers.length} {outliers.length === 1 ? 'instructor is' : 'instructors are'} grading outside
                  ±{fair.outlier_abs} of what the same pilots earned with everybody else.
                </p>
                <div className="row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                  {outliers.map((o) => (
                    <Link key={o.id} href={`/instructors/${o.id}/analysis`} className="button button-quiet xs" style={{ textDecoration: 'none' }}>
                      {o.full_name}{o.fleet ? <span className="xs muted"> {o.fleet}</span> : null}{' '}
                      <span className="mono">{o.delta > 0 ? '+' : ''}{o.delta.toFixed(2)}</span>
                    </Link>
                  ))}
                </div>
                <p className="xs muted" style={{ margin: 0 }}>
                  This list is as fresh as the last analytics refresh, because the comparison behind it is
                  pre-computed (migration 0147). Every other figure on this page reads the records directly.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      {/* ---------------------------------------------------------------- competencies */}
      <div className="profile-grid">
        <Card title="Competency averages" note={`Population mean per competency over ${WINDOW_MONTHS} months, with the band it falls in. Band boundaries are configuration, not code.`} testId="competency-averages">
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {comps.map((c) => {
              const b = averageBand(c.mean);
              return (
                <div key={c.id} className="avg-row">
                  <span className="avg-name">
                    <span className="mono" style={{ color: c.colour, fontWeight: 700 }}>{c.code}</span>{' '}
                    {competencyDisplayName(c.code, c.name)}
                  </span>
                  <span className="avg-bar" aria-hidden="true" title={b?.label}>
                    <span style={{
                      width: `${c.mean === null ? 0 : ((c.mean - scale.min) / (scale.max - scale.min)) * 100}%`,
                      background: b?.colour ?? 'var(--brand-accent)',
                    }} />
                  </span>
                  <span className="mono avg-value">{c.mean === null ? '—' : c.mean.toFixed(2)}</span>
                  <span className="xs muted avg-note">{c.n ? `${c.n} graded · ${c.below} below` : 'no grades'}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card
          title="Where the grades sit"
          note={`Every competency grade in the window, one row per grade. Below standard is at or under ${scale.below_standard_max}, from analytics.yaml.`}
        >
          <GradeDistributionRows
            id="population-distribution"
            counts={dist.map((d) => ({ grade: d.grade, count: d.n }))}
            tokens={tokens}
            gradeLabels={Object.fromEntries(gradePalette().map((g) => [g.grade, g.label]))}
            min={scale.min}
            max={scale.max}
            belowStandardMax={scale.below_standard_max}
            label="Competency grades across the population, by grade"
            hrefForGrade={(g) => (g === openGrade ? '/analytics' : `/analytics?grade=${g}`)}
            selectedGrade={openGrade}
          />
          {openGrade === null ? (
            <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>
              Open a grade to see which competencies it was awarded in.
            </p>
          ) : (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <strong className="small">
                  Grade {openGrade}{gradeWord ? ` · ${gradeWord}` : ''} — the three competencies it lands in most
                </strong>
                <span className="spacer" />
                <a href="/analytics" className="xs">Close</a>
              </div>
              {atGrade.length === 0 ? (
                <p className="xs muted" style={{ margin: 'var(--space-1) 0 0' }}>No competency carries this grade in the window.</p>
              ) : (
                <table className="data" style={{ marginTop: 'var(--space-2)' }}>
                  <thead>
                    <tr>
                      <th scope="col">Competency</th>
                      <th scope="col" className="num">At this grade</th>
                      <th scope="col" className="num">Of its own grades</th>
                    </tr>
                  </thead>
                  <tbody>
                    {atGrade.map((c) => (
                      <tr key={c.code}>
                        <td><span className="ccode xs">{c.code}</span> <span className="small">{competencyDisplayName(c.code, c.name, P)}</span></td>
                        <td className="num mono">{c.n.toLocaleString('en-GB')}</td>
                        {/* The share, because a competency graded on every session tops a raw count
                            of 2s simply by being graded more often. */}
                        <td className="num mono xs">{((c.n / c.total_for_competency) * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card title="The trend" note={`Monthly mean of every competency grade, ${TREND_MONTHS + 1} months. A month with no training has no point - it is not a zero.`}>
        <ZoomableChart title="Population mean competency grade, by month">
          <TrendSparkline
            id="population-trend"
            points={months.map((m) => ({ on: m.on, value: m.value, label: `${m.on.slice(0, 7)} · ${m.n} grades` }))}
            tokens={tokens}
            colour={tokens.series.primary}
            min={scale.min}
            max={scale.max}
            width={760}
            height={140}
            label="Population mean competency grade, by month"
            emptyText="Not enough history to draw a trend."
          />
        </ZoomableChart>
      </Card>

      {/* ---------------------------------------------------------------- validity */}
      <Card
        title="Validity"
        note={`Per policy item, for line ${L.subject_plural.toLowerCase()} only — a pilot in initial training is not yet on a recurrent cycle. Derived from the last signed record of that kind plus its validity, never typed in.`}
        testId="validity-summary"
      >
        {validity.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>No validity item is configured in policy.yaml.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="num">Validity</th>
                <th scope="col" className="num">Current</th>
                <th scope="col" className="num">Due soon</th>
                <th scope="col" className="num">Expired</th>
                <th scope="col" className="num">No record</th>
              </tr>
            </thead>
            <tbody>
              {validity.map((v) => (
                <tr key={v.key}>
                  <td><Link href={`/subjects/status?status=warning`}>{v.label}</Link></td>
                  <td className="num mono">{v.months} months</td>
                  <td className="num mono">{v.valid}</td>
                  <td className="num">{v.warning ? <Chip tone="warn">{v.warning}</Chip> : <span className="muted mono">0</span>}</td>
                  <td className="num">{v.expired ? <Chip tone="bad">{v.expired}</Chip> : <span className="muted mono">0</span>}</td>
                  <td className="num mono">{v.missing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>
          &ldquo;Due soon&rdquo; is inside the warning window of {P.training_status?.warning_days ?? 60} days.
          A record whose outcome is INCOMPLETE does not renew validity.
        </p>
      </Card>

      {/* ---------------------------------------------------------------- fleets */}
      <Card title="By fleet" note="Active pilots and the records they hold from the last twelve months.">
        <table className="data">
          <thead><tr><th scope="col">Fleet</th><th scope="col" className="num">{L.subject_plural}</th><th scope="col" className="num">Records · 12 months</th><th scope="col" className="num">Per pilot</th></tr></thead>
          <tbody>
            {fleets.map((f) => (
              <tr key={f.fleet}>
                <td><Link href={`/subjects?asset_class=${encodeURIComponent(f.fleet)}`} className="mono">{f.fleet}</Link></td>
                <td className="num mono">{f.pilots}</td>
                <td className="num mono">{f.records_year}</td>
                <td className="num mono">{f.pilots > 0 ? (f.records_year / f.pilots).toFixed(1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <p className="xs muted" style={{ margin: 0 }}>
        Every figure above is computed from signed, finalised records — nothing on this page was typed in
        and nothing was written by a language model. Sessions still being graded are deliberately absent:
        they become visible here the moment they are signed and frozen. Band boundaries, the
        below-standard line and the warning window are all configuration
        (<span className="mono">analytics.yaml</span>, <span className="mono">policy.yaml</span>).
      </p>
    </div>
  );
}
