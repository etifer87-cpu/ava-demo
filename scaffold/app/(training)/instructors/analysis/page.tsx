import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import { labels, policy, analyticsConfig, gradePalette, residualScale, leniencyZones } from '@/lib/config';
import { benchAnalysis, leaning, LEANING_LABEL, LEANING_TONE } from '@/lib/instructors';
import type { AnalyticsConfig } from '@/lib/analytics';
import { buildChartTokens } from '@/components/charts/chart-tokens';
import { KpiTile } from '@/components/charts/KpiTile';
import { AsiHistogram } from '@/components/charts/AsiHistogram';
import { DeltaScatter } from '@/components/charts/DeltaScatter';
import { BiasHeatmap } from '@/components/charts/BiasHeatmap';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { SelectFilter } from '@/components/ui/FilterBar';
import LiveSearch from '@/components/ui/LiveSearch';

/**
 * /instructors/analysis - how the whole bench grades, side by side.
 *
 * The comparison surface of docs/06_ANALYTICS.md §13: the standardisation index across the bench
 * (chart 32), every instructor's adjusted leniency against the evidence it rests on with the review
 * threshold drawn (33), and the per-competency bias grid labelled RAW (34), plus the list of
 * instructors currently outside the band.
 *
 * The two peer groups §13.7 requires to be stated are stated on the page: the baselines here - the
 * peer mean per competency, the median delta - are computed over EVERY instructor including one this
 * caller cannot see, because a baseline that changed per viewer would make no two screens agree.
 * The rows obey the caller's scope, and this capability excludes the caller's own row.
 *
 * Gate: training.analytics.assessor.view. Reads the materialised views only (migration 0147).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Instructor analysis' };

function one(v: string | string[] | undefined): string { return typeof v === 'string' ? v.trim() : ''; }
const CAP = 'training.analytics.assessor.view';
const fmt = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
const signed = (v: number | null, d = 2) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

export default async function InstructorAnalysisPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, CAP);
  const L = labels();
  const P = policy();
  const cfg = analyticsConfig<AnalyticsConfig>();
  const si = cfg.assessor_fairness.standardisation_index;
  const outlierAbs = cfg.assessor_fairness.adjusted_delta.outlier_abs;

  const sp = await searchParams;
  const f = { q: one(sp.q), fleet: one(sp.fleet), base: one(sp.base), qual: one(sp.qual), sort: '' };
  const visible = await visiblePersonIds(access, CAP);
  const [a, fleets, bases] = await Promise.all([
    benchAnalysis(f, visible === ALL_PEOPLE ? null : visible),
    query<{ code: string }>(`SELECT code FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position`),
    query<{ code: string }>(`SELECT code FROM org_units WHERE deleted_at IS NULL AND is_active AND kind = 'base' ORDER BY position`),
  ]);

  const tokens = buildChartTokens({
    competencies: a.competencies.map((c) => ({ competencyId: c.id, code: c.code, name: c.name, colour: c.colour })),
    grades: gradePalette(),
  });
  const scale = residualScale();
  const zones = leniencyZones();
  const banded = a.rows.filter((r) => !r.is_provisional && r.asi?.score !== null && r.asi?.score !== undefined);
  const scores = banded.map((r) => r.asi!.score as number);
  const meanAsi = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : null;
  const outliers = a.rows.filter((r) => r.is_outlier).sort((x, y) => Math.abs(y.delta_adjusted ?? 0) - Math.abs(x.delta_adjusted ?? 0));
  const carry: Record<string, string> = Object.fromEntries(Object.entries({ q: f.q, fleet: f.fleet, base: f.base, qual: f.qual }).filter(([, v]) => v !== ''));

  const outlierColumns: Column<(typeof outliers)[number]>[] = [
    { key: 'name', head: 'Instructor', cell: (r) => <Link href={`/instructors/${r.id}`}>{r.full_name}</Link> },
    { key: 'roles', head: 'Qualifications', cell: (r) => <span className="mono xs">{r.instructor_roles.join(' ')}</span> },
    { key: 'fleet', head: 'Fleet', cell: (r) => r.fleet ?? '—' },
    { key: 'base', head: 'Base', cell: (r) => r.base ?? '—' },
    {
      key: 'delta', head: 'Adjusted leniency', numeric: true,
      cell: (r) => { const l = leaning(r.delta_adjusted, r.is_provisional, cfg); return (
        <span className="stack" style={{ gap: 2 }}>
          <span className="mono"><strong>{signed(r.delta_adjusted)}</strong>{r.ci_half_width !== null ? <span className="xs muted"> ± {r.ci_half_width.toFixed(2)}</span> : null}</span>
          <Chip tone={LEANING_TONE[l]}>{LEANING_LABEL[l]}</Chip>
        </span>
      ); },
    },
    { key: 'raw', head: 'Raw delta', numeric: true, cell: (r) => <span className="mono xs muted">{signed(r.delta_unadjusted)}</span> },
    { key: 'evidence', head: 'Evidence', numeric: true, cell: (r) => <span className="mono xs">{r.n_grades} grades · {r.n_records} records · {r.n_subjects} pilots</span> },
    {
      key: 'asi', head: 'Index', numeric: true,
      cell: (r) => r.asi?.score === null || r.asi?.score === undefined
        ? <span className="muted">—</span>
        : <Chip tone={r.asi.band === 'green' ? 'good' : r.asi.band === 'amber' ? 'warn' : r.asi.band === 'red' ? 'bad' : 'neutral'}>{Math.round(r.asi.score)}</Chip>,
    },
  ];

  return (
    <div className="stack" data-testid="instructor-analysis">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: L.assessor_plural, href: '/instructors' }, { label: 'Analysis' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Instructor analysis</h1>
        <span className="xs muted">grading standardisation across the bench</span>
        <span className="spacer" />
        <Link href="/instructors" className="button button-quiet" style={{ textDecoration: 'none' }}>Back to the bench</Link>
      </div>

      <FilterBar action="/instructors/analysis" resetHref="/instructors/analysis">
        <LiveSearch name="q" label="Name" value={f.q} placeholder="Type to search" />
        <SelectFilter name="fleet" label="Fleet" value={f.fleet} options={fleets.map((x) => ({ value: x.code, label: x.code }))} />
        <SelectFilter name="base" label="Base" value={f.base} options={bases.map((x) => ({ value: x.code, label: x.code }))} />
        <SelectFilter name="qual" label="Qualification" value={f.qual} options={P.instructor_roles.map((x) => ({ value: x, label: x }))} />
      </FilterBar>

      <div className="grid grid-kpi">
        <KpiTile id="kpi-bench" caption="Instructors grading" value={String(a.totals.instructors)} context={`${a.totals.grades.toLocaleString('en-GB')} competency grades`} reference={`${a.totals.provisional} provisional`} tokens={tokens} />
        <KpiTile id="kpi-asi-mean" caption="Mean index" value={meanAsi === null ? null : Math.round(meanAsi).toString()} state={meanAsi === null ? 'insufficient' : 'value'} band={meanAsi === null ? null : meanAsi >= si.bands.green_min ? 'green' : meanAsi >= si.bands.amber_min ? 'amber' : 'red'} context={`over ${banded.length} banded`} tokens={tokens} />
        <KpiTile id="kpi-median" caption="Median leniency" value={signed(a.peerMedianDelta)} state={a.peerMedianDelta === null ? 'insufficient' : 'value'} context="grade points, banded instructors" reference={`group mean grade ${fmt(a.groupMean)}`} tokens={tokens} />
        <KpiTile id="kpi-outliers" caption="Outside the band" value={String(a.totals.outliers)} band={a.totals.outliers ? 'red' : 'green'} bandLabel={a.totals.outliers ? 'for review' : 'none'} context={`beyond ±${outlierAbs} grade points`} tokens={tokens} />
      </div>

      <Card title="Standardisation index across the bench" note="One bar per index bucket, coloured by band. Instructors below the banding minimum are counted beside the chart, never inside it.">
        <AsiHistogram id="asi-hist" scores={scores} notBanded={a.totals.provisional} bands={si.bands} tokens={tokens} width={900} height={210} />
      </Card>

      <Card
        title="Adjusted leniency against the evidence behind it"
        note="Zero is agreement with what the same pilots earned from other instructors. The bands step outward from zero, so how far an instructor sits from the bench is read from the band as well as the position; vertical height is how many grades the figure rests on."
      >
        <DeltaScatter
          id="delta-scatter"
          points={a.rows.filter((r) => r.delta_adjusted !== null).map((r) => ({ id: r.id, label: r.full_name, x: r.delta_adjusted as number, y: r.n_grades, provisional: r.is_provisional, outlier: r.is_outlier }))}
          outlierAbs={outlierAbs} peerMedian={a.peerMedianDelta} zones={zones} tokens={tokens}
        />
      </Card>

      <Card
        title="Outside the band"
        note={`Adjusted leniency beyond ±${outlierAbs} grade points, on at least ${cfg.assessor_fairness.adjusted_delta.min_records_banded} records. These are the standardisation conversations, listed worst first - not findings against anyone.`}
      >
        {outliers.length === 0 ? (
          <p className="muted small">Nobody on this bench sits outside ±{outlierAbs} grade points once their roster is accounted for.</p>
        ) : (
          <DataTable testId="outlier-list" caption="For a standardisation conversation" columns={outlierColumns} rows={outliers} rowKey={(r) => r.id} />
        )}
      </Card>

      <Card title="Grading by competency" note="Where a leaning comes from: the competencies an instructor grades above or below the rest of the bench.">
        <BiasHeatmap
          rows={a.rows.map((r) => ({ id: r.id, label: r.full_name, sublabel: [r.fleet, r.instructor_roles.join(' ')].filter(Boolean).join(' · ') || null, provisional: r.is_provisional, cells: r.cells }))}
          competencies={a.competencies}
          scale={scale}
          href={(id) => `/instructors/${id}`}
        />
      </Card>

      <Card title="How to read this page" note="Written on the surface because an unlabelled benchmark is a bug report waiting to happen.">
        <ul className="small" style={{ margin: 0, paddingLeft: '1.2em' }}>
          <li><strong>Adjusted leniency</strong> is this instructor&apos;s grades minus what the same pilots earned in the same competencies from <em>other</em> instructors, shrunk toward zero by n / (n + {cfg.assessor_fairness.adjusted_delta.k_shrink}) so a small sample cannot reach the extremes. The raw own-mean-minus-group-mean delta is shown beside it and is never used to band or flag.</li>
          <li><strong>Baselines include everyone.</strong> The peer mean per competency, the group mean and the median leniency are computed over every instructor who has graded, including any whose row you cannot open and including dormant ones - removing them would change every other instructor&apos;s number. The rows you can see exclude your own.</li>
          <li><strong>Provisional</strong> means fewer than {cfg.assessor_fairness.adjusted_delta.min_records_banded} records: never banded, never flagged, drawn hollow. {a.totals.fellBack > 0 ? <>For {a.totals.fellBack} instructor{a.totals.fellBack === 1 ? '' : 's'} more than {pct(cfg.assessor_fairness.expected.max_share_above_level_1_for_banding)} of expected grades came from a fallback rather than a same-pilot comparison; treat their banding with care.</> : 'Every instructor here has enough same-pilot comparisons for the banding to hold.'}</li>
          <li>The competency grid is <strong>raw</strong>: own mean against peer mean, with the roster effect still in it. Only the adjusted figures remove that.</li>
        </ul>
      </Card>
    </div>
  );
}
