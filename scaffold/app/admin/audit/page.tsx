import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { TextFilter } from '@/components/ui/FilterBar';

/**
 * /admin/audit - the App Log.
 *
 * A read-only window on audit_log, which is append-only by trigger and REVOKE (migration 0011).
 * Tabs are action prefixes (the index is text_pattern_ops for exactly this); the text search runs
 * over the actor, the action, the entity, the reason and the details JSON in SQL; paging is a URL
 * parameter. Nothing here can change a row, and nothing here is cached. Gate: platform.audit.view.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'App Log' };

const PAGE = 50;

const TABS: { key: string; label: string; prefixes: string[] }[] = [
  { key: 'all',      label: 'All',           prefixes: [] },
  { key: 'auth',     label: 'Sign-ins',      prefixes: ['auth.'] },
  { key: 'user',     label: 'Accounts',      prefixes: ['user.'] },
  { key: 'training', label: 'Training',      prefixes: ['template.', 'session.', 'record.'] },
  { key: 'docs',     label: 'Documents',     prefixes: ['document.', 'certificate.'] },
  { key: 'export',   label: 'Exports',       prefixes: ['export.'] },
  { key: 'config',   label: 'Configuration', prefixes: ['config.'] },
  { key: 'ticket',   label: 'Tech log',      prefixes: ['ticket.'] },
];

interface Row {
  id: string;
  occurred_at: string;
  actor_label: string | null;
  actor_user_id: string | null;
  action: string;
  entity_table: string | null;
  entity_id: string | null;
  capability_code: string | null;
  reason: string | null;
  request_ip: string | null;
  details: Record<string, unknown>;
}

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.audit.view');

  const sp = await searchParams;
  const tabKey = one(sp.tab) || 'all';
  const tab = TABS.find((t) => t.key === tabKey) ?? TABS[0];
  const q = one(sp.q);
  const actor = one(sp.actor);
  const from = one(sp.from);
  const to = one(sp.to);
  const page = Math.max(1, Number.parseInt(one(sp.page) || '1', 10) || 1);

  const where: string[] = ['true'];
  const params: unknown[] = [];
  if (tab.prefixes.length) {
    params.push(tab.prefixes);
    where.push(`EXISTS (SELECT 1 FROM unnest($${params.length}::text[]) p WHERE a.action LIKE p || '%')`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(a.actor_label ILIKE $${params.length} OR a.action ILIKE $${params.length} OR a.entity_id ILIKE $${params.length} OR a.reason ILIKE $${params.length} OR a.details::text ILIKE $${params.length})`);
  }
  if (actor) {
    params.push(`%${actor}%`);
    where.push(`a.actor_label ILIKE $${params.length}`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { params.push(from); where.push(`a.occurred_at >= $${params.length}::date`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to))   { params.push(to);   where.push(`a.occurred_at < ($${params.length}::date + interval '1 day')`); }

  const countParams = [...params];
  params.push(PAGE, (page - 1) * PAGE);

  const [rows, total] = await Promise.all([
    query<Row>(
      `SELECT a.id::text, a.occurred_at::text, a.actor_label, a.actor_user_id, a.action, a.entity_table, a.entity_id,
              a.capability_code, a.reason, a.request_ip::text, a.details
         FROM audit_log a
        WHERE ${where.join(' AND ')}
        ORDER BY a.occurred_at DESC, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log a WHERE ${where.join(' AND ')}`, countParams).then((r) => Number(r[0]?.n ?? 0)),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const carry = { tab: tab.key, q, actor, from, to };
  const href = (p: number) => `/admin/audit?${new URLSearchParams({ ...Object.fromEntries(Object.entries(carry).filter(([, v]) => v)), page: String(p) }).toString()}`;

  const columns: Column<Row>[] = [
    { key: 'when', head: 'When', cell: (r) => <span className="mono xs">{r.occurred_at.slice(0, 19).replace('T', ' ')}</span> },
    { key: 'who', head: 'Who', cell: (r) => r.actor_user_id ? <Link href={`/admin/users/${r.actor_user_id}`}>{r.actor_label ?? r.actor_user_id}</Link> : (r.actor_label ?? <span className="muted">system</span>) },
    { key: 'action', head: 'Action', cell: (r) => <span className={`mono xs${r.action.endsWith('.failed') ? ' text-bad' : ''}`}>{r.action}</span> },
    { key: 'entity', head: 'Entity', cell: (r) => r.entity_table ? <span className="xs">{r.entity_table}{r.entity_id ? <span className="mono muted"> {r.entity_id.slice(0, 8)}</span> : null}</span> : <span className="muted">-</span> },
    { key: 'detail', head: 'Detail', cell: (r) => <span className="xs">{r.reason ?? summarise(r.details)}</span> },
    { key: 'ip', head: 'IP', cell: (r) => <span className="mono xs muted">{r.request_ip ?? '-'}</span> },
  ];

  return (
    <div className="stack">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'App Log' }]} />
      <h1>App Log</h1>

      <nav className="tabs" aria-label="Log sections">
        {TABS.map((t) => (
          <a key={t.key} href={`/admin/audit?tab=${t.key}`} aria-current={t.key === tab.key ? 'page' : undefined}>{t.label}</a>
        ))}
      </nav>

      <FilterBar action="/admin/audit" resetHref={`/admin/audit?tab=${tab.key}`} carry={{ tab: tab.key }}>
        <TextFilter name="q" label="Text" value={q} placeholder="action, entity, reason, detail" />
        <TextFilter name="actor" label="Who" value={actor} placeholder="name or username" />
        <div className="field"><label htmlFor="f-from">From</label><input id="f-from" name="from" type="date" defaultValue={from} /></div>
        <div className="field"><label htmlFor="f-to">To</label><input id="f-to" name="to" type="date" defaultValue={to} /></div>
      </FilterBar>

      <DataTable
        testId="audit-log"
        caption={`${tab.label} events`}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="No events"
        emptyReason="Nothing in the log matched these filters."
        countSuffix={`of ${total} - page ${page} of ${pages}`}
      />

      {pages > 1 ? (
        <div className="row">
          {page > 1 ? <a className="button button-quiet" href={href(page - 1)}>Previous</a> : null}
          <span className="small muted">Page {page} of {pages}</span>
          {page < pages ? <a className="button button-quiet" href={href(page + 1)}>Next</a> : null}
        </div>
      ) : null}
    </div>
  );
}

function summarise(details: Record<string, unknown>): string {
  const keys = Object.keys(details ?? {});
  if (keys.length === 0) return '';
  return keys.slice(0, 5).map((k) => `${k}: ${Array.isArray(details[k]) ? (details[k] as unknown[]).join(',') : String(details[k])}`).join(' · ');
}
