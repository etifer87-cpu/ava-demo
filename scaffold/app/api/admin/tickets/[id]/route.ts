import { NextResponse, type NextRequest } from 'next/server';
import { seeOther } from '@/lib/http';
import { transaction } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { audit, actorFromSession, requestContext } from '@/lib/audit';
import { flashCookie } from '@/lib/admin';
import { isPriority, isStatus, ticketRef } from '@/lib/tickets';

/**
 * POST /api/admin/tickets/[id] - the administrator's response: status, priority, assignee, due
 * date and a note, applied as one transaction that appends one event per change (plus a comment
 * event for the note). Tickets are never deleted here or anywhere. Gate: platform.tickets.triage.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.tickets.triage');

  const form = await request.formData();
  const str = (k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
  const status = str('status', 20);
  const priority = str('priority', 20);
  const assignee = str('assignee_user_id', 40) || null;
  const due = str('due_on', 10) || null;
  const note = str('note', 4000) || null;
  const actorLabel = session.fullName ?? session.username;

  const back = (flash: Parameters<typeof flashCookie>[0]) => {
    const res = seeOther(`/admin/tickets/${id}`);
    res.cookies.set(flashCookie(flash));
    return res;
  };

  if (!isStatus(status) || !isPriority(priority)) return back({ kind: 'bad', message: 'Choose a valid status and priority.' });

  try {
    const changes = await transaction(async (client) => {
      const cur = await client.query<{ number: string; status: string; priority: string; assignee_user_id: string | null; due_on: string | null }>(
        `SELECT number::text, status, priority, assignee_user_id, due_on::text FROM tech_tickets WHERE id = $1::uuid FOR UPDATE`, [id],
      );
      const t = cur.rows[0];
      if (!t) throw new Error('No such ticket.');
      const ev = async (kind: string, from: string | null, to: string | null, n: string | null = null) => {
        await client.query(
          `INSERT INTO tech_ticket_events (ticket_id, actor_user_id, actor_label, kind, status_from, status_to, note) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
          [id, session.userId, actorLabel, kind, from, to, n],
        );
      };
      const changed: string[] = [];
      if (t.status !== status) { await ev('status', t.status, status); changed.push(`status ${status}`); }
      if (t.priority !== priority) { await ev('priority', t.priority, priority); changed.push(`priority ${priority}`); }
      if ((t.assignee_user_id ?? null) !== assignee) {
        const who = assignee ? (await client.query<{ label: string }>(`SELECT COALESCE(p.full_name, u.username) AS label FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1::uuid`, [assignee])).rows[0]?.label ?? null : null;
        await ev('assigned', t.assignee_user_id, who); changed.push(who ? `assigned ${who}` : 'unassigned');
      }
      if ((t.due_on ?? null) !== due) { await ev('due', t.due_on, due); changed.push(due ? `due ${due}` : 'due cleared'); }
      if (note) { await ev('comment', null, null, note); changed.push('note'); }

      await client.query(
        `UPDATE tech_tickets SET status = $2, priority = $3, assignee_user_id = $4::uuid, due_on = $5::date, last_event_at = now() WHERE id = $1::uuid`,
        [id, status, priority, assignee, due],
      );
      if (changed.length) {
        await audit({ action: 'ticket.update', entityTable: 'tech_tickets', entityId: id, capabilityCode: 'platform.tickets.triage', details: { ref: ticketRef(t.number), changes: changed } },
          actorFromSession(session), requestContext(request.headers), client);
      }
      return changed;
    });
    return back({ kind: 'ok', message: changes.length ? `Saved: ${changes.join(', ')}.` : 'Nothing changed.' });
  } catch (err) {
    return back({ kind: 'bad', message: err instanceof Error ? err.message : 'Could not save.' });
  }
}
