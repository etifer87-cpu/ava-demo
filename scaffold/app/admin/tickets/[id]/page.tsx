import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query, queryOne } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { readFlash } from '@/lib/admin';
import { ticketRef, TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES } from '@/lib/tickets';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import { StatusChip, PriorityChip } from '@/components/ui/TicketChips';

/**
 * /admin/tickets/[id] - one ticket: what was reported, its timeline, and the administrator's
 * response form (status, priority, assignee, due date, a note). Saving appends events; the ticket
 * row is the current state and the events are how it got there. Gate: platform.tickets.triage.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ticket' };

interface Ticket {
  id: string; number: string; subject: string; description: string; category: string; priority: string; status: string;
  route: string | null; reporter_label: string; reporter_user_id: string | null; assignee_user_id: string | null;
  due_on: string | null; created_at: string; updated_at: string;
}
interface Event { id: string; occurred_at: string; actor_label: string; kind: string; status_from: string | null; status_to: string | null; note: string | null }
interface Assignee { id: string; label: string }

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.tickets.triage');

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ticket = await queryOne<Ticket>(
    `SELECT id, number::text, subject, description, category, priority, status, route, reporter_label, reporter_user_id,
            assignee_user_id, due_on::text, created_at::text, updated_at::text
       FROM tech_tickets WHERE id = $1::uuid`, [id],
  );
  if (!ticket) notFound();

  const [events, assignees, flash] = await Promise.all([
    query<Event>(`SELECT id::text, occurred_at::text, actor_label, kind, status_from, status_to, note FROM tech_ticket_events WHERE ticket_id = $1::uuid ORDER BY occurred_at, id`, [id]),
    query<Assignee>(
      `SELECT DISTINCT u.id, COALESCE(p.full_name, u.username) AS label
         FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_capabilities rc ON rc.role_code = ur.role_code
         LEFT JOIN people p ON p.id = u.person_id
        WHERE u.deleted_at IS NULL AND u.is_active AND rc.capability_code = 'platform.tickets.triage'
        ORDER BY 2`,
    ),
    readFlash(),
  ]);
  const ref = ticketRef(ticket.number);
  const category = TICKET_CATEGORIES.find((c) => c.value === ticket.category)?.label ?? ticket.category;

  return (
    <div className="stack" data-testid="ticket-detail">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Tech Log', href: '/admin/tickets' }, { label: ref }]} />
      <div className="row">
        <h1 style={{ margin: 0 }}><span className="mono muted">{ref}</span> {ticket.subject}</h1>
        <StatusChip status={ticket.status} />
        <PriorityChip priority={ticket.priority} />
      </div>

      {flash ? <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : ''}`} role="status"><p style={{ margin: 0 }}>{flash.message}</p></div> : null}

      <div className="grid grid-tiles">
        <Card title="Report">
          <dl className="props">
            <dt>Category</dt><dd>{category}</dd>
            <dt>Reported by</dt><dd>{ticket.reporter_user_id ? <Link href={`/admin/users/${ticket.reporter_user_id}`}>{ticket.reporter_label}</Link> : ticket.reporter_label}</dd>
            <dt>Created</dt><dd>{ticket.created_at.slice(0, 16).replace('T', ' ')}</dd>
            <dt>On page</dt><dd className="mono xs">{ticket.route ?? '-'}</dd>
            <dt>Due</dt><dd>{ticket.due_on ?? <span className="muted">-</span>}</dd>
          </dl>
          <p className="pre">{ticket.description}</p>
        </Card>

        <Card title="Respond" note="Saving writes one event with your name. A status change is recorded as from → to.">
          <form method="post" action={`/api/admin/tickets/${ticket.id}`} className="stack">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="status">Status</label>
                <select id="status" name="status" defaultValue={ticket.status}>
                  {TICKET_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="priority">Priority</label>
                <select id="priority" name="priority" defaultValue={ticket.priority}>
                  {TICKET_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="assignee">Assigned to</label>
                <select id="assignee" name="assignee_user_id" defaultValue={ticket.assignee_user_id ?? ''}>
                  <option value="">Nobody</option>
                  {assignees.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
              <div className="field"><label htmlFor="due">Due</label><input id="due" name="due_on" type="date" defaultValue={ticket.due_on ?? ''} /></div>
            </div>
            <div className="field"><label htmlFor="note">Action taken / note</label><textarea id="note" name="note" rows={4} maxLength={4000} placeholder="What was done, or what the reporter should know" /></div>
            <div><button className="button" type="submit">Save and log</button></div>
          </form>
        </Card>
      </div>

      <Card title="Timeline" testId="ticket-timeline">
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <span className="mono xs muted">{e.occurred_at.slice(0, 16).replace('T', ' ')}</span>
              <strong> {e.actor_label}</strong>
              <span className="muted"> · {describe(e)}</span>
              {e.note ? <p className="pre small" style={{ margin: 'var(--space-1) 0 0' }}>{e.note}</p> : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function describe(e: Event): string {
  const label = (v: string | null) => TICKET_STATUSES.find((s) => s.value === v)?.label ?? v ?? '';
  switch (e.kind) {
    case 'created': return 'filed the ticket';
    case 'status': return `status ${label(e.status_from)} → ${label(e.status_to)}`;
    case 'priority': return `priority set to ${e.status_to ?? ''}`;
    case 'assigned': return e.status_to ? `assigned to ${e.status_to}` : 'unassigned';
    case 'due': return e.status_to ? `due ${e.status_to}` : 'due date cleared';
    default: return 'commented';
  }
}
