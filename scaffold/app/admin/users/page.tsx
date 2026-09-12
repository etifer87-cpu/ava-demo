import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { listDirectory, readFlash, roleOptions, type DirectoryRow } from '@/lib/admin';
import { policy } from '@/lib/config';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { SelectFilter } from '@/components/ui/FilterBar';
import LiveSearch from '@/components/ui/LiveSearch';
import Pager, { pageParams } from '@/components/ui/Pager';
import { query } from '@/lib/db';

/**
 * /admin/users - people and their accounts.
 *
 * One row per person on the roster, in seniority order, with the account that belongs to them
 * when there is one; accounts with no roster row (administrators, service accounts) come last.
 * A pilot without a login shows "Create account", which opens the new-account form filled from
 * the roster row, so the administrator never retypes a name or an employee id. Roles are chips
 * with their fleet/base binding. Filters are a GET form, the search applies while typing, and the
 * list is paged. Gate: platform.users.view.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Users' };

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.users.view');

  const sp = await searchParams;
  const q = one(sp.q);
  const role = one(sp.role);
  const fleet = one(sp.fleet);
  const position = one(sp.position);
  const qual = one(sp.qual);
  const account = one(sp.account) as 'yes' | 'no' | '';
  const status = one(sp.status) || 'active';
  const { page, size } = pageParams(sp);
  const p = policy();

  const [rows, roles, fleets, flash] = await Promise.all([
    listDirectory({ q, role, fleet, position, qual, account, status }, page, size),
    roleOptions(),
    query<{ value: string; label: string }>(`SELECT code AS value, code AS label FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position`),
    readFlash(),
  ]);
  const total = Number(rows[0]?.total ?? 0);
  const canCreate = can(access, 'platform.users.create');
  const carry: Record<string, string> = Object.fromEntries(Object.entries({ q, role, fleet, position, qual, account, status }).filter(([, v]) => v !== ''));

  const columns: Column<DirectoryRow>[] = [
    { key: 'seniority', head: 'Seniority', numeric: true, cell: (r) => r.person_id ? <span className="mono">{r.seniority_number ?? r.external_id}</span> : <span className="muted">-</span> },
    { key: 'name', head: 'Name', cell: (r) => r.person_id ? (r.user_id ? <Link href={`/admin/users/${r.user_id}`}>{r.full_name}</Link> : <span>{r.full_name}</span>) : <span className="muted">no roster row</span> },
    { key: 'position', head: 'Rank', cell: (r) => r.position ?? <span className="muted">{r.roster_status === 'candidate' ? 'candidate' : '-'}</span> },
    { key: 'fleet', head: 'Fleet', cell: (r) => r.fleet ?? <span className="muted">-</span> },
    { key: 'base', head: 'Base', cell: (r) => r.base ?? <span className="muted">-</span> },
    { key: 'qual', head: 'Qualifications', cell: (r) => r.instructor_roles.length ? <span className="mono xs">{r.instructor_roles.join(' ')}</span> : <span className="muted">-</span> },
    {
      key: 'account', head: 'Account',
      cell: (r) => r.user_id
        ? <Link href={`/admin/users/${r.user_id}`} className="mono">{r.username}</Link>
        : canCreate && r.person_id ? <Link href={`/admin/users/new?person=${r.person_id}`} className="button button-quiet xs" style={{ textDecoration: 'none' }}>Create account</Link> : <span className="muted">none</span>,
    },
    {
      key: 'roles', head: 'Roles',
      cell: (r) => (
        <span className="row" style={{ gap: 'var(--space-1)' }}>
          {r.grants.length === 0 ? <span className="muted">{r.user_id ? 'none' : ''}</span> : r.grants.map((g) => (
            <Chip key={`${g.role_code}-${g.asset_class_code ?? ''}-${g.org_unit_code ?? ''}`} tone="info" title={g.role_code}>
              {g.role_name}{g.asset_class_code ? ` · ${g.asset_class_code}` : ''}{g.org_unit_code ? ` · ${g.org_unit_code}` : ''}
            </Chip>
          ))}
        </span>
      ),
    },
    {
      key: 'status', head: 'Status',
      cell: (r) => (
        <span className="row" style={{ gap: 'var(--space-1)' }}>
          {r.user_id ? (r.user_active ? <Chip tone="good">Active</Chip> : <Chip tone="bad">Inactive</Chip>) : <Chip tone="neutral">No login</Chip>}
          {r.locked ? <Chip tone="warn">Locked</Chip> : null}
          {r.must_change_password ? <Chip tone="neutral" title="Temporary password in force">Must change password</Chip> : null}
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Users' }]} />
      <div className="row">
        <h1 style={{ margin: 0 }}>Users</h1>
        <span className="xs muted">people on the roster and their accounts</span>
        <span className="spacer" />
        {canCreate ? <Link href="/admin/users/new" className="button" style={{ textDecoration: 'none' }}>New user</Link> : null}
      </div>

      {flash ? (
        <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : flash.kind === 'warn' ? ' notice-warn' : ''}`} role="status">
          <p style={{ margin: 0 }}>{flash.message}</p>
          {flash.secret ? (
            <p className="mono secret" style={{ marginBottom: 0 }}>
              <span className="xs muted">{flash.secretLabel ?? 'Temporary password'} - shown once: </span>
              <strong>{flash.secret}</strong>
            </p>
          ) : null}
        </div>
      ) : null}

      <FilterBar action="/admin/users" resetHref="/admin/users" carry={{ size: size === 20 ? undefined : String(size) }}>
        <LiveSearch name="q" label="Name, seniority or username" value={q} placeholder="Type to search" />
        <SelectFilter name="position" label="Rank" value={position} options={p.positions.map((x) => ({ value: x, label: x }))} />
        <SelectFilter name="fleet" label="Fleet" value={fleet} options={fleets} />
        <SelectFilter name="qual" label="Qualification" value={qual} options={[{ value: 'any', label: 'Any qualification' }, ...p.instructor_roles.map((x) => ({ value: x, label: x }))]} />
        <SelectFilter name="account" label="Account" value={account} options={[{ value: 'yes', label: 'Has an account' }, { value: 'no', label: 'No account yet' }]} />
        <SelectFilter name="role" label="Role" value={role} options={roles.map((r) => ({ value: r.value, label: r.label }))} />
        <SelectFilter name="status" label="Roster" value={status} anyLabel="Any" options={[{ value: 'active', label: 'Active' }, { value: 'candidate', label: 'Candidate' }, { value: 'left', label: 'Left' }]} />
      </FilterBar>

      <DataTable
        testId="user-list"
        caption="People and accounts"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.person_id ?? r.user_id ?? 'x'}
        emptyTitle="Nobody matched"
        emptyReason="No person or account matched these filters. Reset the filters, or seed the roster."
        countSuffix={total > rows.length ? `of ${total}` : undefined}
      />
      <Pager path="/admin/users" params={carry} page={page} size={size} total={total} noun="people" />
    </div>
  );
}
