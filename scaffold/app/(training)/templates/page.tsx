import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { listPrograms, kindOptions, fleetOptions, type ProgramRow } from '@/lib/templates';
import { readFlash } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { TextFilter, SelectFilter } from '@/components/ui/FilterBar';

/**
 * /templates - Programs. docs/06_PROGRAM_BUILDER.md section 5.1.
 *
 * One row per program: its kind, fleet, current version and status, what it holds, who last
 * touched it. Clicking a row opens the builder on the current version. "Create new program" asks
 * for the four things that freeze at creation and lands in the builder on an empty draft.
 *
 * Gate: training.templates.view to read the list; the create button and the builder's write
 * path check training.templates.configure.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Programs' };

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function StatusChip({ status }: { status: string | null }) {
  if (status === 'published') return <Chip tone="good">Published</Chip>;
  if (status === 'retired') return <Chip tone="neutral">Retired</Chip>;
  if (status === 'draft') return <Chip tone="warn">Draft</Chip>;
  return <Chip tone="bad">No version</Chip>;
}

export default async function ProgramsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.view');

  const sp = await searchParams;
  const q = one(sp.q);
  const kind = one(sp.kind);
  const fleet = one(sp.fleet);
  const status = one(sp.status);

  const [rows, kinds, fleets, flash] = await Promise.all([listPrograms({ q, kind, fleet, status }), kindOptions(), fleetOptions(), readFlash()]);
  const canConfigure = can(access, 'training.templates.configure');

  const columns: Column<ProgramRow>[] = [
    {
      key: 'name', head: 'Program',
      cell: (r) => (
        <span className="stack" style={{ gap: 2 }}>
          <Link href={`/templates/${r.id}`}>{r.name}</Link>
          <span className="xs muted mono">{r.code}{r.program_code ? ` · ${r.program_code}${r.program_day ? ` · day ${r.program_day}` : ''}` : ''}</span>
        </span>
      ),
    },
    { key: 'kind', head: 'Kind', cell: (r) => r.kind_label },
    { key: 'fleet', head: 'Fleet', cell: (r) => r.asset_class ?? <span className="muted">every fleet</span> },
    { key: 'version', head: 'Version', numeric: true, cell: (r) => r.version === null ? <span className="muted">-</span> : `v${r.version}` },
    { key: 'status', head: 'Status', cell: (r) => <span className="row" style={{ gap: 'var(--space-1)' }}><StatusChip status={r.status} />{!r.is_active ? <Chip tone="bad">Inactive</Chip> : null}</span> },
    {
      key: 'holds', head: 'Holds',
      cell: (r) => r.element_count === 0
        ? <span className="muted">empty</span>
        : <span className="small">{r.task_count} task{r.task_count === 1 ? '' : 's'} · {r.element_count} element{r.element_count === 1 ? '' : 's'} · {r.competency_count} competenc{r.competency_count === 1 ? 'y' : 'ies'}</span>,
    },
    { key: 'updated', head: 'Last edited', numeric: true, cell: (r) => <span title={r.updated_by ?? undefined}>{r.updated_at.slice(0, 16).replace('T', ' ')}</span> },
  ];

  return (
    <div className="stack">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Programs' }]} />
      <div className="row">
        <h1 style={{ margin: 0 }}>Programs</h1>
        <span className="spacer" />
        {canConfigure ? <Link href="/templates/new" className="button" style={{ textDecoration: 'none' }} data-testid="program-create">Create new program</Link> : null}
      </div>

      {flash ? <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : flash.kind === 'warn' ? ' notice-warn' : ''}`} role="status"><p style={{ margin: 0 }}>{flash.message}</p></div> : null}

      <FilterBar action="/templates" resetHref="/templates">
        <TextFilter name="q" label="Name, code or program" value={q} placeholder="Search" />
        <SelectFilter name="kind" label="Kind" value={kind} options={kinds.map((k) => ({ value: k.value, label: k.label }))} />
        <SelectFilter name="fleet" label="Fleet" value={fleet} options={fleets.map((f) => ({ value: f.value, label: f.value }))} />
        <SelectFilter name="status" label="Status" value={status} anyLabel="Active" options={[{ value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'retired', label: 'Retired' }, { value: 'inactive', label: 'Inactive' }, { value: 'any', label: 'Everything' }]} />
      </FilterBar>

      <DataTable
        testId="template-list"
        caption="Programs"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="No program yet"
        emptyReason={canConfigure ? 'Nothing matched these filters, or no program has been created. Create the first one: it opens empty, in the builder, as a draft.' : 'Nothing matched these filters, or no program has been created yet.'}
        countSuffix={rows.length === 500 ? '(page limit reached - narrow the filters)' : undefined}
      />
    </div>
  );
}
