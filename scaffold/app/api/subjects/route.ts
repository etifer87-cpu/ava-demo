import { NextResponse, type NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';

/**
 * GET /api/subjects - the id/label list of the subjects this caller may see.
 *
 * It exists for two callers: scripts/smoke-screens.mjs, which enumerates every subject page rather
 * than sampling, and any client that needs a picker. It returns ids and labels and nothing else -
 * a roster endpoint that returns rows is a roster endpoint that leaks a roster.
 *
 * Scope filtering happens in SQL, before serialisation. The visible id set is passed as ONE uuid[]
 * parameter: interpolating several hundred ids into a URL or a statement is what produced the
 * oversized request that made a predecessor's list page fail with "could not load" for months.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  external_id: string;
  full_name: string;
  is_active: boolean;
}

export async function GET(request: NextRequest) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'people.view');

  const includeInactive = request.nextUrl.searchParams.get('include_inactive') === 'true';
  const visible = await visiblePersonIds(access, 'people.view');

  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (!includeInactive) where.push('is_active');
  if (visible !== ALL_PEOPLE) {
    if (visible.size === 0) {
      return NextResponse.json({ data: [] }, { headers: { 'cache-control': 'no-store' } });
    }
    params.push([...visible]);
    where.push(`id = ANY($${params.length}::uuid[])`);
  }

  const rows = await query<Row>(
    `SELECT id, external_id, full_name, is_active
       FROM people
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN external_id ~ '^[0-9]+$' THEN lpad(external_id, 20, '0') ELSE external_id END`,
    params,
  );

  return NextResponse.json(
    { data: rows.map((r) => ({ id: r.id, label: `${r.external_id} ${r.full_name}`.trim() })) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
