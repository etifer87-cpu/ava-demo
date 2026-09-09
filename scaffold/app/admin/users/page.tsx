import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { listAccounts, readFlash, roleOptions, type AccountRow } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { TextFilter, SelectFilter } from '@/components/ui/FilterBar';
import { query } from '@/lib/db';

/**
 * /admin/users - the account directory.
 *
 * One row per login. The roster row (name, id, position, fleet, base) is joined when the account
 * is linked to a person; an unlinked account shows as such rather than as a blank name, because
 * "no roster row" is a state an administrator must be able to see. Roles are rendered as chips
 * with their fleet/base binding (migration 0142): "Instructor · A320" is a different grant from
 * "Instructor". Filters are a GET form; filtering is SQL. Gate: platform.users.view.
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
  const status = (one(sp.status) || 'active') as 'active' | 'inactive' | '';

  const [rows, roles, fleets, flash] = await Promise.all([
    listAccounts({ q, role, fleet, status }),
    roleOptions(),
    query<{ value: string; label: string }>(`SELECT code AS value, code AS label FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position`),
    readFlash(),
  ]);

  const columns: Column<AccountRow>[] = [
    { key: 'username', head: 'Username', cell: (r) => <Link href={`/admin/users/${r.id}`} className="mono">{r.username}</Link> },
    { key: 'name', head: 'Name', cell: (r) => r.full_name ? <Link href={`/admin/users/${r.id}`}>{r.full_name}</Link> : <span className="muted">no roster row</span> },
    { key: 'external_id', head: 'Employee id', cell: (r) => r.external_id ? <span className="mono">{r.external_id}</span> : <span className="muted">-</span> },
    { key: 'position', head: 'Position', cell: (r) => r.position ?? <span className="muted">-</span> },
    { key: 'fleet', head: 'Fleet', cell: (r) => r.asset_class ?? <span className="muted">-</span> },
    { key: 'base', head: 'Base', cell: (r) => r.org_unit ?? <span className="muted">-</span> },
    {
      key: 'roles', head: 'Roles',
      cell: (r) => (
        <span className="row" style={{ gap: 'var(--space-1)' }}>
          {r.grants.length === 0 ? <span className="muted">none</span> : r.grants.map((g) => (
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
          {r.is_active ? <Chip tone="good">Active</Chip> : <Chip tone="bad">Inactive</Chip>}
          {r.locked ? <Chip tone="warn">Locked</Chip> : null}
          {r.must_change_password ? <Chip tone="neutral" title="Temporary password in force">Must change password</Chip> : null}
        </span>
      ),
    },
    { key: 'last_login', head: 'Last sign-in', numeric: true, cell: (r) => r.last_login_at ? r.last_login_at.slice(0, 16).replace('T', ' ') : <span className="muted">never</span> },
  ];

  return (
    <div className="stack">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Users' }]} />
      <div className="row">
        <h1 style={{ margin: 0 }}>Users</h1>
        <span className="spacer" />
        {can(access, 'platform.users.create') ? <Link href="/admin/users/new" className="button" style={{ textDecoration: 'none' }}>New user</Link> : null}
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

      <FilterBar action="/admin/users" resetHref="/admin/users">
        <TextFilter name="q" label="Username, name, id or e-mail" value={q} placeholder="Search" />
        <SelectFilter name="role" label="Role" value={role} options={roles.map((r) => ({ value: r.value, label: r.label }))} />
        <SelectFilter name="fleet" label="Fleet" value={fleet} options={fleets} />
        <SelectFilter name="status" label="Status" value={status} anyLabel="Any" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
      </FilterBar>

      <DataTable
        testId="user-list"
        caption="Accounts"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="No account matched"
        emptyReason="No login matched these filters. Reset the filters, or create the first account."
        countSuffix={rows.length === 500 ? '(page limit reached - narrow the filters)' : undefined}
      />
    </div>
  );
}
