import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { listPrograms, kindOptions, fleetOptions, type ProgramRow } from '@/lib/templates';
import { readFlash } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { TextFilter, SelectFilter } from '@/components/ui/FilterBar';
import ProgramBatch from '@/components/program/ProgramBatch';

/**
 * /templates - Programs. docs/06_PROGRAM_BUILDER.md section 5.1.
 *
 * One row per program: kind, fleet, module, year, current version and status, when it was last
 * touched. Clicking a row opens the builder on the current version. "Create new program" asks
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

  const [rows, kinds, fleets, flash, archived] = await Promise.all([listPrograms({ q, kind, fleet, status }), kindOptions(), fleetOptions(), readFlash(), listPrograms({ status: 'inactive' })]);
  const canConfigure = can(access, 'training.templates.configure');

  const columns: Column<ProgramRow>[] = [
    ...(canConfigure ? [{ key: 'pick', head: <span className="sr-only">Select</span>, cell: (r: ProgramRow) => <input type="checkbox" name="ids" value={r.id} form="batch" aria-label={`Select ${r.name}`} /> } as Column<ProgramRow>] : []),
    {
      key: 'name', head: 'Program',
      cell: (r) => <Link href={`/templates/${r.id}`}>{r.name}</Link>,
    },
    { key: 'kind', head: 'Kind', cell: (r) => r.kind_label },
    { key: 'fleet', head: 'Fleet', cell: (r) => r.asset_class ?? <span className="muted">every fleet</span> },
    { key: 'module', head: 'Module', cell: (r) => r.program_module ?? <span className="muted">-</span> },
    { key: 'year', head: 'Year', numeric: true, cell: (r) => r.program_year ?? <span className="muted">-</span> },
    { key: 'version', head: 'Version', numeric: true, cell: (r) => r.version === null ? <span className="muted">-</span> : `v${r.version}` },
    { key: 'status', head: 'Status', cell: (r) => <span className="row" style={{ gap: 'var(--space-1)' }}><StatusChip status={r.status} />{!r.is_active ? <Chip tone="bad">Inactive</Chip> : null}</span> },
    { key: 'updated', head: 'Last edited', numeric: true, cell: (r) => <span title={r.updated_by ?? undefined}>{r.updated_at.slice(0, 16).replace('T', ' ')}</span> },
  ];

  return (
    <div className="stack">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Programs' }]} />
      <div className="row">
        <h1 style={{ margin: 0 }}>Programs</h1>
        <span className="spacer" />
        <Link href="/templates/archive" className="button button-quiet" style={{ textDecoration: 'none' }} data-testid="program-archive-link">Archive{archived.length ? ` (${archived.length})` : ''}</Link>
        {canConfigure ? <Link href="/templates/new" className="button" style={{ textDecoration: 'none' }} data-testid="program-create">Create new program</Link> : null}
      </div>

      {flash ? <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : flash.kind === 'warn' ? ' notice-warn' : ''}`} role="status"><p style={{ margin: 0 }}>{flash.message}</p></div> : null}

      <FilterBar action="/templates" resetHref="/templates">
        <TextFilter name="q" label="Name, code or module" value={q} placeholder="Search" />
        <SelectFilter name="kind" label="Kind" value={kind} options={kinds.map((k) => ({ value: k.value, label: k.label }))} />
        <SelectFilter name="fleet" label="Fleet" value={fleet} options={fleets.map((f) => ({ value: f.value, label: f.value }))} />
        <SelectFilter name="status" label="Status" value={status} anyLabel="Any" options={[{ value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'retired', label: 'Retired' }]} />
      </FilterBar>

      {canConfigure ? <ProgramBatch status={status} mode="active" /> : null}

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
