import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { ticketRef, TICKET_STATUSES as STATUSES, TICKET_PRIORITIES as PRIORITIES, TICKET_CATEGORIES as CATEGORIES } from '@/lib/tickets';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import { StatusChip, PriorityChip } from '@/components/ui/TicketChips';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { TextFilter, SelectFilter } from '@/components/ui/FilterBar';
import { foldedLikeAny } from '@/lib/search';

/**
 * /admin/tickets - the Tech Log queue.
 *
 * Problems and requests users filed from inside the application (/support/report). Status tabs,
 * a text search, priority and category filters - all GET, all SQL. A ticket is never deleted; it
 * closes as resolved or won't fix, and its history is the event timeline on the detail page.
 * Gate: platform.tickets.triage.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tech Log' };

interface Row {
  id: string; number: string; subject: string; category: string; priority: string; status: string;
  reporter_label: string; assignee: string | null; created_at: string; last_event_at: string; due_on: string | null; events: string;
}

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.tickets.triage');

  const sp = await searchParams;
  const status = one(sp.status) || 'active';
  const q = one(sp.q);
  const priority = one(sp.priority);
  const category = one(sp.category);

  const where: string[] = ['true'];
  const params: unknown[] = [];
  if (status === 'active') where.push(`t.status IN ('open','in_progress')`);
  else if (status !== 'all') { params.push(status); where.push(`t.status = $${params.length}`); }
  if (priority) { params.push(priority); where.push(`t.priority = $${params.length}`); }
  if (category) { params.push(category); where.push(`t.category = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(${foldedLikeAny(['t.subject', 't.description', 't.reporter_label', 't.route'], `$${params.length}`)})`); }

  const [rows, counts] = await Promise.all([
    query<Row>(
      `SELECT t.id, t.number::text, t.subject, t.category, t.priority, t.status, t.reporter_label,
              COALESCE(p.full_name, u.username) AS assignee,
              t.created_at::text, t.last_event_at::text, t.due_on::text,
              (SELECT count(*)::text FROM tech_ticket_events e WHERE e.ticket_id = t.id) AS events
         FROM tech_tickets t
         LEFT JOIN users u ON u.id = t.assignee_user_id
         LEFT JOIN people p ON p.id = u.person_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                 CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 t.created_at DESC
        LIMIT 500`,
      params,
    ),
    query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM tech_tickets GROUP BY status`),
  ]);
  const count = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
  const active = count('open') + count('in_progress');
  const total = counts.reduce((a, c) => a + Number(c.n), 0);

  const columns: Column<Row>[] = [
    { key: 'ref', head: 'Ref', cell: (r) => <Link href={`/admin/tickets/${r.id}`} className="mono">{ticketRef(r.number)}</Link> },
    { key: 'subject', head: 'Subject', cell: (r) => <Link href={`/admin/tickets/${r.id}`}>{r.subject}</Link> },
    { key: 'category', head: 'Category', cell: (r) => CATEGORIES.find((c) => c.value === r.category)?.label ?? r.category },
    { key: 'priority', head: 'Priority', cell: (r) => <PriorityChip priority={r.priority} /> },
    { key: 'status', head: 'Status', cell: (r) => <StatusChip status={r.status} /> },
    { key: 'reporter', head: 'Reported by', cell: (r) => r.reporter_label },
    { key: 'assignee', head: 'Assigned to', cell: (r) => r.assignee ?? <span className="muted">-</span> },
    { key: 'created', head: 'Created', numeric: true, cell: (r) => <span className="mono xs">{r.created_at.slice(0, 10)}</span> },
    { key: 'last', head: 'Last activity', numeric: true, cell: (r) => <span className="mono xs">{r.last_event_at.slice(0, 16).replace('T', ' ')}</span> },
    { key: 'due', head: 'Due', numeric: true, cell: (r) => r.due_on ? <span className="mono xs">{r.due_on}</span> : <span className="muted">-</span> },
  ];

  return (
    <div className="stack">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Tech Log' }]} />
      <div className="row">
        <h1 style={{ margin: 0 }}>Tech Log</h1>
        <span className="small muted">{active} open of {total}</span>
        <span className="spacer" />
        <Link href="/support/report" className="button button-quiet" style={{ textDecoration: 'none' }}>Report a problem</Link>
      </div>

      <nav className="tabs" aria-label="Ticket status">
        <a href="/admin/tickets?status=active" aria-current={status === 'active' ? 'page' : undefined}>Active ({active})</a>
        {STATUSES.map((s) => (
          <a key={s.value} href={`/admin/tickets?status=${s.value}`} aria-current={status === s.value ? 'page' : undefined}>{s.label} ({count(s.value)})</a>
        ))}
        <a href="/admin/tickets?status=all" aria-current={status === 'all' ? 'page' : undefined}>All ({total})</a>
      </nav>

      <FilterBar action="/admin/tickets" resetHref={`/admin/tickets?status=${status}`} carry={{ status }}>
        <TextFilter name="q" label="Text" value={q} placeholder="subject, description, reporter, page" />
        <SelectFilter name="priority" label="Priority" value={priority} options={PRIORITIES.map((p) => ({ value: p.value, label: p.label }))} />
        <SelectFilter name="category" label="Category" value={category} options={CATEGORIES.map((c) => ({ value: c.value, label: c.label }))} />
      </FilterBar>

      <DataTable
        testId="ticket-list"
        caption="Tickets"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="No tickets"
        emptyReason="Nothing matched. Users file tickets from 'Report a problem' in the header."
      />
    </div>
  );
}
