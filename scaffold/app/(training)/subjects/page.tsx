import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { TextFilter, SelectFilter } from '@/components/ui/FilterBar';
import { labels, policy } from '@/lib/config';

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

export const metadata = { title: labels().subject_plural };

interface SubjectRow {
  id: string;
  external_id: string;
  full_name: string;
  position: string | null;
  org_unit: string | null;
  asset_class: string | null;
  seniority_number: number | null;
  joined_on: string | null;
  rank_since: string | null;
  total_hours: number | null;
  hours_on_type: number | null;
  instructor_roles: string[];
  roster_status: string;
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
  const L = labels();
  const positions = policy().positions;
  const instructorRoles = policy().instructor_roles;

  const sp = await searchParams;
  const q = one(sp.q);
  const orgUnit = one(sp.org_unit);
  const assetClass = one(sp.asset_class);
  const status = one(sp.status) || 'active';
  const watch = one(sp.watch);
  const position = one(sp.position);
  const instructor = one(sp.instructor);

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
  if (status === 'active' || status === 'candidate' || status === 'left') { params.push(status); where.push(`p.roster_status = $${params.length}`); }
  if (position) { params.push(position); where.push(`p.position = $${params.length}`); }
  if (instructor === 'yes') where.push(`cardinality(p.instructor_roles) > 0`);
  if (instructor && instructor !== 'yes') { params.push(instructor); where.push(`$${params.length} = ANY(p.instructor_roles)`); }
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
              ou.code AS org_unit,
              ac.code AS asset_class,
              p.seniority_number, p.joined_on::text, p.rank_since::text, p.total_hours, p.hours_on_type, p.instructor_roles, p.roster_status,
              p.watch_list,
              p.concern_override,
              count(r.id)::text          AS record_count,
              max(r.training_date)::text AS last_record_on
         FROM people p
         LEFT JOIN org_units ou     ON ou.id = p.org_unit_id
         LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
         LEFT JOIN records r        ON r.person_id = p.id AND r.deleted_at IS NULL
        WHERE ${where.join(' AND ')}
        GROUP BY p.id, ou.code, ac.code
        ORDER BY p.seniority_number NULLS LAST,
                 CASE WHEN p.external_id ~ '^[0-9]+$' THEN lpad(p.external_id, 20, '0') ELSE p.external_id END
        LIMIT 600`,
      params,
    ),
    query<OptionRow>(
      `SELECT id, code AS label FROM org_units WHERE deleted_at IS NULL AND is_active AND kind = 'base' ORDER BY position, name`,
    ),
    query<OptionRow>(
      `SELECT id, code AS label FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position, name`,
    ),
  ]);

  const columns: Column<SubjectRow>[] = [
    {
      key: 'external_id',
      head: 'Seniority',
      numeric: true,
      cell: (r) => (
        <Link href={`/subjects/${r.id}`} className="mono">
          {r.seniority_number ?? r.external_id}
        </Link>
      ),
    },
    { key: 'name', head: 'Name', cell: (r) => <Link href={`/subjects/${r.id}`}>{r.full_name}</Link> },
    { key: 'position', head: 'Rank', cell: (r) => r.position ?? <span className="muted">candidate</span> },
    { key: 'asset_class', head: 'Fleet', cell: (r) => r.asset_class ?? <span className="muted">-</span> },
    { key: 'org_unit', head: 'Base', cell: (r) => r.org_unit ?? <span className="muted">-</span> },
    { key: 'joined', head: 'Joined', numeric: true, cell: (r) => r.joined_on ?? <span className="muted">-</span> },
    { key: 'rank_since', head: 'Rank since', numeric: true, cell: (r) => r.rank_since ?? <span className="muted">-</span> },
    { key: 'hours', head: 'Hours · on type', numeric: true, cell: (r) => r.total_hours === null ? <span className="muted">-</span> : <span className="mono">{r.total_hours.toLocaleString('en-US')} · {(r.hours_on_type ?? 0).toLocaleString('en-US')}</span> },
    { key: 'roles', head: 'Instructor', cell: (r) => r.instructor_roles.length ? <span className="mono xs">{r.instructor_roles.join(' ')}</span> : <span className="muted">-</span> },
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
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: L.subject_plural }]} />
      <h1>{L.subject_plural}</h1>

      <FilterBar action="/subjects" resetHref="/subjects">
        <TextFilter name="q" label="Name or seniority" value={q} placeholder="Search" />
        <SelectFilter name="position" label="Rank" value={position} options={positions.map((p) => ({ value: p, label: p }))} />
        <SelectFilter name="asset_class" label="Fleet" value={assetClass} options={assetClasses.map((o) => ({ value: o.id, label: o.label }))} />
        <SelectFilter name="org_unit" label="Base" value={orgUnit} options={orgUnits.map((o) => ({ value: o.id, label: o.label }))} />
        <SelectFilter name="instructor" label="Instructor" value={instructor} options={[{ value: 'yes', label: 'Any qualification' }, ...instructorRoles.map((r) => ({ value: r, label: r }))]} />
        <SelectFilter
          name="status"
          label="Roster status"
          value={status}
          anyLabel="Any"
          options={[
            { value: 'active', label: 'Active' },
            { value: 'candidate', label: 'Candidate' },
            { value: 'left', label: 'Left' },
          ]}
        />
        <SelectFilter name="watch" label="Watch list" value={watch} options={[{ value: 'yes', label: 'On the watch list' }]} />
      </FilterBar>

      <DataTable
        testId="subject-list"
        caption={`${L.subject_plural} in scope`}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle={`No ${L.subject.toLowerCase()} matched`}
        emptyReason="No roster row matched these filters within the records this account may see. Reset the filters to check whether the scope or the filter is the reason."
        countSuffix={rows.length === 600 ? '(page limit reached - narrow the filters)' : undefined}
      />
    </div>
  );
}
