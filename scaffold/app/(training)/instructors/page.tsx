import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import { labels, policy, analyticsConfig } from '@/lib/config';
import { listInstructors, leaning, LEANING_LABEL, LEANING_TONE } from '@/lib/instructors';
import type { AnalyticsConfig } from '@/lib/analytics';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { SelectFilter } from '@/components/ui/FilterBar';
import LiveSearch from '@/components/ui/LiveSearch';
import Pager, { pageParams } from '@/components/ui/Pager';

/**
 * /instructors - the bench, and how each instructor grades.
 *
 * One row per pilot with an instructor role, in seniority order: qualifications, what they gave in
 * the last twelve months (simulator / line / ground), the pilots they assessed, and their grading
 * leaning - the adjusted leniency delta from av_assessor_adjusted, i.e. how far their grades sit
 * from what the SAME pilots earned with OTHER instructors, shrunk toward zero for small samples.
 * An instructor below min_records_banded is provisional and never banded.
 *
 * Gate: training.analytics.assessor.view, which excludes the holder: an instructor never reads
 * their own residual here. Filters are a GET form, search applies while typing, the list is paged.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Instructors' };

function one(v: string | string[] | undefined): string { return typeof v === 'string' ? v.trim() : ''; }
const CAP = 'training.analytics.assessor.view';

export default async function InstructorsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, CAP);
  const L = labels();
  const P = policy();
  const cfg = analyticsConfig<AnalyticsConfig>();

  const sp = await searchParams;
  const f = { q: one(sp.q), fleet: one(sp.fleet), base: one(sp.base), qual: one(sp.qual), sort: one(sp.sort) };
  const { page, size } = pageParams(sp);
  const visible = await visiblePersonIds(access, CAP);
  const [rows, fleets, bases] = await Promise.all([
    listInstructors(f, visible === ALL_PEOPLE ? null : visible, page, size),
    query<{ code: string }>(`SELECT code FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position`),
    query<{ code: string }>(`SELECT code FROM org_units WHERE deleted_at IS NULL AND is_active AND kind = 'base' ORDER BY position`),
  ]);
  const total = rows[0]?.total ?? 0;
  const carry: Record<string, string> = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
  const sortHref = (key: string) => `/instructors?${new URLSearchParams({ ...carry, sort: f.sort === key ? '' : key })}`;
  const fmt = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
  const signed = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);

  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'sen', head: 'Seniority', numeric: true, cell: (r) => <Link href={`/instructors/${r.id}`} className="mono">{r.seniority_number ?? r.external_id}</Link> },
    { key: 'name', head: 'Name', cell: (r) => <Link href={`/instructors/${r.id}`}>{r.full_name}</Link> },
    { key: 'rank', head: 'Rank', cell: (r) => r.position ?? '—' },
    { key: 'fleet', head: 'Fleet', cell: (r) => r.fleet ?? '—' },
    { key: 'base', head: 'Base', cell: (r) => r.base ?? '—' },
    { key: 'qual', head: 'Qualifications', cell: (r) => <span className="mono xs">{r.instructor_roles.join(' ')}</span> },
    { key: 'given', head: 'Sessions · 12 months', numeric: true, sortHref: sortHref('active'), cell: (r) => <span className="mono">{r.sessions_12m}<span className="xs muted"> · sim {r.sim_12m} · line {r.line_12m} · ground {r.ground_12m}</span></span> },
    { key: 'pilots', head: 'Pilots', numeric: true, cell: (r) => <span className="mono">{r.n_subjects ?? 0}</span> },
    { key: 'last', head: 'Last session', numeric: true, cell: (r) => r.last_session ? <span className="mono xs">{r.last_session}{r.planned ? <span className="muted"> · {r.planned} planned</span> : null}</span> : <span className="muted">—</span> },
    { key: 'mean', head: 'Mean grade', numeric: true, cell: (r) => <span className="mono">{fmt(r.mean_grade)}</span> },
    {
      key: 'delta', head: 'Leaning', sortHref: sortHref('lenient'),
      cell: (r) => { const l = leaning(r.delta_adjusted, r.is_provisional, cfg); return (
        <span className="stack" style={{ gap: 2 }}>
          <Chip tone={LEANING_TONE[l]}>{LEANING_LABEL[l]}</Chip>
          <span className="xs muted mono">{r.delta_adjusted === null ? 'no grades yet' : `${signed(r.delta_adjusted)}${r.ci_half_width !== null ? ` ± ${r.ci_half_width.toFixed(2)}` : ''} · ${r.n_records ?? 0} records`}</span>
        </span>
      ); },
    },
    { key: 'halo', head: 'Same grade everywhere', numeric: true, cell: (r) => r.halo_rate === null ? <span className="muted">—</span> : <span className={`mono${r.halo_rate >= cfg.assessor_fairness.habits.halo.scale_full ? ' chip chip-warn' : ''}`}>{Math.round(r.halo_rate * 100)}%</span> },
  ];

  return (
    <div className="stack" data-testid="assessor-analytics">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: L.assessor_plural }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{L.assessor_plural}</h1>
        <span className="xs muted">the bench, and how each instructor grades against what the same pilots earned with others</span>
        <span className="spacer" />
        <Link href="/instructors/analysis" className="button" style={{ textDecoration: 'none' }}>Analysis</Link>
      </div>

      <FilterBar action="/instructors" resetHref="/instructors" carry={{ size: size === 20 ? undefined : String(size), sort: f.sort || undefined }}>
        <LiveSearch name="q" label="Name or seniority" value={f.q} placeholder="Type to search" />
        <SelectFilter name="fleet" label="Fleet" value={f.fleet} options={fleets.map((x) => ({ value: x.code, label: x.code }))} />
        <SelectFilter name="base" label="Base" value={f.base} options={bases.map((x) => ({ value: x.code, label: x.code }))} />
        <SelectFilter name="qual" label="Qualification" value={f.qual} options={P.instructor_roles.map((x) => ({ value: x, label: x }))} />
        <SelectFilter name="sort" label="Order" value={f.sort} anyLabel="Seniority" options={[{ value: 'lenient', label: 'Most lenient first' }, { value: 'strict', label: 'Most strict first' }, { value: 'active', label: 'Most sessions first' }]} />
      </FilterBar>

      <DataTable
        testId="instructor-list"
        caption={`${L.assessor_plural} on the bench`}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="Nobody matched"
        emptyReason="No instructor matched these filters, or none is in your scope."
        countSuffix={total > rows.length ? `of ${total}` : undefined}
      />
      <Pager path="/instructors" params={carry} page={page} size={size} total={total} noun="instructors" />
      <p className="xs muted" style={{ margin: 0 }}>
        Leaning is the adjusted leniency delta: this instructor&apos;s grades minus what the same pilots earned in the same competencies with other instructors, shrunk toward zero by n / (n + {cfg.assessor_fairness.adjusted_delta.k_shrink}). Outside ±{cfg.assessor_fairness.adjusted_delta.outlier_abs} is lenient or strict; under {cfg.assessor_fairness.adjusted_delta.min_records_banded} records is provisional and never banded. &ldquo;Same grade everywhere&rdquo; is the share of records where every competency got one grade.
      </p>
    </div>
  );
}
