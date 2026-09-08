import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { TextFilter, SelectFilter } from '@/components/ui/FilterBar';

/**
 * /subjects - the roster.
 *
 * FOUR THINGS THIS SCREEN DEMONSTRATES, and they are the reason it is a real page rather than a
 * stub (docs/13_DESIGN_SYSTEM.md section 8, app/ROUTES.md):
 *
 * 1. FILTERS ARE A PLAIN GET FORM. Every filtered view is therefore a URL: bookmarkable, pasteable
 *    into a ticket, fetchable by the smoke run, and reproducible by whoever reads the ticket.
 *
 * 2. FILTERING HAPPENS IN SQL. Not in the render, not in the client. A page that fetches the whole
 *    roster and filters in JavaScript silently truncates as soon as the roster outgrows a page.
 *
 * 3. ORDERING IS NUMERIC WHERE THE ID IS NUMERIC. external_id is TEXT because an operator's person
 *    id is not necessarily a number; ordering it as text puts 10 before 9. The CASE below sorts
 *    all-digit ids by value and everything else lexically, in one indexed-friendly expression.
 *
 * 4. SCOPE IS APPLIED BEFORE SERIALISATION, through lib/access.ts, as a single uuid[] parameter.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Subjects' };

interface SubjectRow {
  id: string;
  external_id: string;
  full_name: string;
  position: string | null;
  org_unit: string | null;
  asset_class: string | null;
  watch_list: boolean;
  concern_override: string | null;
  record_count: string;
  last_record_on: string | null;
}

interface OptionRow { id: string; label: string }

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function SubjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'people.view');

  const sp = await searchParams;
  const q = one(sp.q);
  const orgUnit = one(sp.org_unit);
  const assetClass = one(sp.asset_class);
  const status = one(sp.status) || 'active';
  const watch = one(sp.watch);

  const visible = await visiblePersonIds(access, 'people.view');

  const where: string[] = ['p.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (visible !== ALL_PEOPLE) {
    if (visible.size === 0) {
      where.push('false');   // fail closed: an empty scope is no rows, never every row
    } else {
      params.push([...visible]);
      where.push(`p.id = ANY($${params.length}::uuid[])`);
    }
  }
  if (status === 'active') where.push('p.is_active');
  if (status === 'inactive') where.push('NOT p.is_active');
  if (watch === 'yes') where.push('p.watch_list');
  if (q) {
    params.push(`%${q}%`);
    where.push(`(p.full_name ILIKE $${params.length} OR p.external_id ILIKE $${params.length})`);
  }
  if (orgUnit) {
    params.push(orgUnit);
    where.push(`p.org_unit_id = $${params.length}::uuid`);
  }
  if (assetClass) {
    params.push(assetClass);
    where.push(`p.asset_class_id = $${params.length}::uuid`);
  }

  const [rows, orgUnits, assetClasses] = await Promise.all([
    query<SubjectRow>(
      `SELECT p.id,
              p.external_id,
              p.full_name,
              p.position,
              ou.name AS org_unit,
              ac.name AS asset_class,
              p.watch_list,
              p.concern_override,
              count(r.id)::text          AS record_count,
              max(r.training_date)::text AS last_record_on
         FROM people p
         LEFT JOIN org_units ou     ON ou.id = p.org_unit_id
         LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
         LEFT JOIN records r        ON r.person_id = p.id AND r.deleted_at IS NULL
        WHERE ${where.join(' AND ')}
        GROUP BY p.id, ou.name, ac.name
        ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$'
                      THEN lpad(p.external_id, 20, '0')
                      ELSE p.external_id END
        LIMIT 500`,
      params,
    ),
    query<OptionRow>(
      `SELECT id, name AS label FROM org_units WHERE deleted_at IS NULL AND is_active ORDER BY position, name`,
    ),
    query<OptionRow>(
      `SELECT id, name AS label FROM asset_classes WHERE deleted_at IS NULL AND is_active ORDER BY position, name`,
    ),
  ]);

  const columns: Column<SubjectRow>[] = [
    {
      key: 'external_id',
      head: 'Id',
      cell: (r) => (
        <Link href={`/subjects/${r.id}`} className="mono">
          {r.external_id}
        </Link>
      ),
    },
    { key: 'name', head: 'Name', cell: (r) => <Link href={`/subjects/${r.id}`}>{r.full_name}</Link> },
    { key: 'position', head: 'Position', cell: (r) => r.position ?? <span className="muted">-</span> },
    { key: 'org_unit', head: 'Org unit', cell: (r) => r.org_unit ?? <span className="muted">-</span> },
    { key: 'asset_class', head: 'Asset class', cell: (r) => r.asset_class ?? <span className="muted">-</span> },
    { key: 'records', head: 'Records', numeric: true, cell: (r) => r.record_count },
    {
      key: 'last',
      head: 'Last record',
      numeric: true,
      cell: (r) => r.last_record_on ?? <span className="muted">none</span>,
    },
    {
      key: 'flags',
      head: 'Flags',
      cell: (r) => (
        <span className="row" style={{ gap: 'var(--space-1)' }}>
          {r.watch_list ? <Chip tone="warn" srPrefix="Flag">Watch list</Chip> : null}
          {r.concern_override ? (
            <Chip tone="info" srPrefix="Concern set manually">{r.concern_override}</Chip>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Subjects' }]} />
      <h1>Subjects</h1>

      <FilterBar action="/subjects" resetHref="/subjects">
        <TextFilter name="q" label="Name or id" value={q} placeholder="Search" />
        <SelectFilter name="org_unit" label="Org unit" value={orgUnit} options={orgUnits.map((o) => ({ value: o.id, label: o.label }))} />
        <SelectFilter name="asset_class" label="Asset class" value={assetClass} options={assetClasses.map((o) => ({ value: o.id, label: o.label }))} />
        <SelectFilter
          name="status"
          label="Roster status"
          value={status}
          anyLabel="Any"
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />
        <SelectFilter name="watch" label="Watch list" value={watch} options={[{ value: 'yes', label: 'On the watch list' }]} />
      </FilterBar>

      <DataTable
        testId="subject-list"
        caption="Subjects in scope"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="No subject matched"
        emptyReason="No roster row matched these filters within the records this account may see. Reset the filters to check whether the scope or the filter is the reason."
        countSuffix={rows.length === 500 ? '(page limit reached - narrow the filters)' : undefined}
      />
    </div>
  );
}
