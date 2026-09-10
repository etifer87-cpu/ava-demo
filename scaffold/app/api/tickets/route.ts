import { NextResponse, type NextRequest } from 'next/server';
import { transaction } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { audit, actorFromSession, requestContext } from '@/lib/audit';
import { isCategory, isPriority, ticketRef } from '@/lib/tickets';

/**
 * POST /api/tickets - file a tech-log ticket. Any signed-in role (platform.tickets.create).
 * Writes the ticket, its `created` event and one audit row in a single transaction, then sends
 * the reporter back to the intake page with the reference. Rate: one ticket per ten seconds per
 * user, enforced in SQL, so a stuck form cannot fill the queue.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.tickets.create');

  const form = await request.formData();
  const str = (k: string, max: number) => String(form.get(k) ?? '').trim().slice(0, max);
  const subject = str('subject', 200);
  const description = str('description', 8000);
  const category = str('category', 20);
  const priority = str('priority', 20);
  const route = str('route', 200);
  const label = session.fullName ?? session.username;

  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const fail = (message: string) =>
    wantsJson ? NextResponse.json({ ok: false, error: message }, { status: 400 })
              : NextResponse.redirect(new URL(`/support/report?error=${encodeURIComponent(message)}`, request.nextUrl.origin), 303);

  if (subject.length < 3 || description.length < 3) return fail('Subject and description are required.');
  if (!isCategory(category) || !isPriority(priority)) return fail('Choose a valid category and urgency.');

  try {
    const number = await transaction(async (client) => {
      const recent = await client.query(
        `SELECT 1 FROM tech_tickets WHERE reporter_user_id = $1::uuid AND created_at > now() - interval '10 seconds'`, [session.userId],
      );
      if (recent.rows.length) throw new Error('Please wait a moment before filing another report.');
      const ins = await client.query<{ id: string; number: string }>(
        `INSERT INTO tech_tickets (subject, description, category, priority, route, reporter_user_id, reporter_label)
         VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6::uuid, $7) RETURNING id, number::text`,
        [subject, description, category, priority, route.startsWith('/') ? route : '', session.userId, label],
      );
      const t = ins.rows[0];
      if (!t) throw new Error('Could not file the report.');
      await client.query(
        `INSERT INTO tech_ticket_events (ticket_id, actor_user_id, actor_label, kind, status_to) VALUES ($1::uuid, $2::uuid, $3, 'created', 'open')`,
        [t.id, session.userId, label],
      );
      await audit({ action: 'ticket.create', entityTable: 'tech_tickets', entityId: t.id, capabilityCode: 'platform.tickets.create', details: { ref: ticketRef(t.number), category, priority } },
        actorFromSession(session), requestContext(request.headers), client);
      return t.number;
    });
    return wantsJson
      ? NextResponse.json({ ok: true, ref: ticketRef(number) })
      : NextResponse.redirect(new URL(`/support/report?sent=${number}`, request.nextUrl.origin), 303);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not file the report.');
  }
}
