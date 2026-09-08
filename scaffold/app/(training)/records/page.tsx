import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { TextFilter, SelectFilter } from '@/components/ui/FilterBar';

/**
 * /records - signed records, from every source.
 *
 * THE RULE THIS SCREEN EXISTS TO HOLD: `source` is a GROUPING, never a filter that a reader can
 * apply without knowing they have. In-app, imported and ingested records live in the same table
 * and this list reads all three by default. The source counts are printed above the table so that
 * "the import produced nothing" is visible here rather than discovered a quarter later.
 *
 * A source filter is offered, but it is an explicit choice in the URL and the caption says so.
 *
 * Filtering, ordering and the date window are all SQL. The date inputs are plain <input type=date>
 * in a GET form: no date picker component, no client state, and the resulting URL carries the
 * window so the same view can be reopened.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Records' };

interface Row {
  id: string;
  person_id: string;
  external_id: string;
  full_name: string;
  title: string;
  record_kind: string | null;
  source: string;
  training_date: string;
  outcome: string | null;
  outcome_override: string | null;
  assessor: string | null;
  competency_count: string;
}

interface SourceCount { source: string; n: string }

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.records.view');

  const sp = await searchParams;
  const q = one(sp.q);
  const source = one(sp.source);
  const kind = one(sp.kind);
  const from = one(sp.from);
  const to = one(sp.to);

  const visible = await visiblePersonIds(access, 'training.records.view');

  const where: string[] = ['r.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (visible !== ALL_PEOPLE) {
    if (visible.size === 0) {
      where.push('false');
    } else {
      params.push([...visible]);
      where.push(`r.person_id = ANY($${params.length}::uuid[])`);
    }
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(r.title ILIKE $${params.length} OR p.full_name ILIKE $${params.length} OR p.external_id ILIKE $${params.length})`);
  }
  if (source) {
    params.push(source);
    where.push(`r.source = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    where.push(`r.record_kind = $${params.length}`);
  }
  // Dates are compared as dates, in SQL. A text comparison on an ISO string happens to work until
  // the first record arrives with a different format.
  if (from) {
    params.push(from);
    where.push(`r.training_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`r.training_date <= $${params.length}::date`);
  }

  const whereSql = where.join(' AND ');

  const [rows, sourceCounts, kinds] = await Promise.all([
    query<Row>(
      `SELECT r.id, r.person_id, p.external_id, p.full_name,
              r.title, r.record_kind, r.source, r.training_date::text AS training_date,
              r.outcome, r.outcome_override,
              COALESCE(a.full_name, r.assessor_label) AS assessor,
              count(rc.id)::text AS competency_count
         FROM records r
         JOIN people p            ON p.id = r.person_id
         LEFT JOIN people a       ON a.id = r.assessor_person_id
         LEFT JOIN record_competencies rc ON rc.record_id = r.id
        WHERE ${whereSql}
        GROUP BY r.id, p.external_id, p.full_name, a.full_name
        ORDER BY r.training_date DESC, p.external_id
        LIMIT 500`,
      params,
    ),
    query<SourceCount>(
      `SELECT r.source, count(*)::text AS n
         FROM records r
         JOIN people p ON p.id = r.person_id
        WHERE ${whereSql}
        GROUP BY r.source
        ORDER BY r.source`,
      params,
    ),
    query<{ kind: string }>(
      `SELECT DISTINCT r.record_kind AS kind
         FROM records r
         JOIN people p ON p.id = r.person_id
        WHERE ${whereSql} AND r.record_kind IS NOT NULL
        ORDER BY 1`,
      params,
    ),
  ]);

  const columns: Column<Row>[] = [
    { key: 'date', head: 'Date', numeric: true, cell: (r) => r.training_date },
    {
      key: 'subject',
      head: 'Subject',
      cell: (r) => (
        <Link href={`/subjects/${r.person_id}`}>
          <span className="mono">{r.external_id}</span> {r.full_name}
        </Link>
      ),
    },
    { key: 'title', head: 'Record', cell: (r) => r.title },
    { key: 'kind', head: 'Kind', cell: (r) => r.record_kind ?? <span className="muted">-</span> },
    { key: 'assessor', head: 'Assessor', cell: (r) => r.assessor ?? <span className="muted">-</span> },
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
    { key: 'graded', head: 'Competencies', numeric: true, cell: (r) => r.competency_count },
    { key: 'source', head: 'Source', cell: (r) => <span className="mono xs">{r.source}</span> },
  ];

  return (
    <div className="stack">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Records' }]} />
      <h1>Records</h1>

      <FilterBar action="/records" resetHref="/records">
        <TextFilter name="q" label="Subject or title" value={q} placeholder="Search" />
        <SelectFilter
          name="source"
          label="Source"
          value={source}
          anyLabel="All sources (default)"
          options={[
            { value: 'app', label: 'Produced in the app' },
            { value: 'import', label: 'Imported' },
            { value: 'ingest', label: 'Ingested from a document' },
          ]}
        />
        <SelectFilter name="kind" label="Kind" value={kind} options={kinds.map((k) => ({ value: k.kind, label: k.kind }))} />
        <div className="field">
          <label htmlFor="f-from">From</label>
          <input id="f-from" name="from" type="date" defaultValue={from} />
        </div>
        <div className="field">
          <label htmlFor="f-to">To</label>
          <input id="f-to" name="to" type="date" defaultValue={to} />
        </div>
      </FilterBar>

      <Card title="By source" note="Counts within the current filters. A source reporting zero is a signal, not a tidy list.">
        <div className="row">
          {sourceCounts.length === 0 ? (
            <span className="muted small">No record matched.</span>
          ) : (
            sourceCounts.map((s) => (
              <Chip key={s.source} srPrefix="Source">
                {s.source}: {s.n}
              </Chip>
            ))
          )}
        </div>
      </Card>

      <DataTable
        testId="record-list"
        caption={source ? `Records - source filtered to "${source}"` : 'Records - every source'}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="No records matched"
        emptyReason="No record in this account's scope matched these filters. Check the date window first: it is the filter that most often excludes everything silently."
        countSuffix={rows.length === 500 ? '(page limit reached - narrow the filters)' : undefined}
      />
    </div>
  );
}
