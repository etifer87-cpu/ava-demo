import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import { labels, policy } from '@/lib/config';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { SelectFilter } from '@/components/ui/FilterBar';
import LiveSearch from '@/components/ui/LiveSearch';
import Pager, { pageParams } from '@/components/ui/Pager';

/**
 * /subjects/status - training status across the roster.
 *
 * Line pilots: for each item in policy.yaml `training_status.items` (EBT, OPC/LPC, line check,
 * ground school), the date of the last record of that kind, the expiry (validity months from
 * it) and a status: VALID, WARNING (inside the warning window), EXPIRED, PLANNED (expired or due
 * but a session is already planned), MISSING (no record). Read from records and planned sessions
 * in SQL; nothing is recomputed per row in the render.
 *
 * Initial-training pilots (people.training_course set): the stage the course has reached and
 * the progress inside it, read from their sessions - ground school, simulator (FFS n of N),
 * skill test, line training (sectors flown, take-offs and landings as PF), line check.
 *
 * Filters are a GET form, search applies while typing, the list is paged. Gate: training.records.view.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Training status' };

type Status = 'VALID' | 'WARNING' | 'EXPIRED' | 'PLANNED' | 'MISSING';
interface Row {
  id: string; seniority_number: number | null; external_id: string; full_name: string; position: string | null; fleet: string | null; base: string | null; training_course: string | null;
  items: Record<string, { last: string | null; planned: string | null }>;
  stage: string | null; session_number: number | null; ffs_total: number | null; lfus_flown: number | null; lfus_total: number | null; pf_sectors: number | null; next_date: string | null; next_kind: string | null;
  total: string;
}
function one(v: string | string[] | undefined): string { return typeof v === 'string' ? v.trim() : ''; }
const addMonths = (iso: string, m: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const daysUntil = (iso: string, today: string) => Math.round((new Date(`${iso}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000);

export default async function TrainingStatusPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.records.view');
  const L = labels();
  const P = policy();
  const cfg = P.training_status ?? { warning_days: 60, items: [], stages: {} };
  const kindLabel = new Map(P.template_kinds.map((k) => [k.kind, k.label]));
  const items = cfg.items.map((it) => ({ ...it, recordKind: kindLabel.get(it.kind) ?? it.kind }));
  const today = new Date().toISOString().slice(0, 10);

  const sp = await searchParams;
  const q = one(sp.q); const fleet = one(sp.fleet); const base = one(sp.base); const position = one(sp.position); const status = one(sp.status); const group = one(sp.group) || 'line'; const course = one(sp.course);
  const { page, size } = pageParams(sp);

  const visible = await visiblePersonIds(access, 'people.view');
  const where: string[] = ["p.deleted_at IS NULL AND p.roster_status = 'active'"];
  const params: unknown[] = [];
  if (visible !== ALL_PEOPLE) { if (visible.size === 0) where.push('false'); else { params.push([...visible]); where.push(`p.id = ANY($${params.length}::uuid[])`); } }
  if (group === 'line') where.push('p.training_course IS NULL'); else if (group === 'initial') where.push('p.training_course IS NOT NULL');
  if (q) { params.push(`%${q}%`); where.push(`(p.full_name ILIKE $${params.length} OR p.external_id ILIKE $${params.length})`); }
  if (fleet) { params.push(fleet); where.push(`ac.code = $${params.length}`); }
  if (base) { params.push(base); where.push(`ou.code = $${params.length}`); }
  if (position) { params.push(position); where.push(`p.position = $${params.length}`); }
  if (course) { params.push(course); where.push(`p.training_course = $${params.length}`); }
  params.push(items.map((it) => it.recordKind));
  const kindsParam = params.length;

  // One row per pilot: the last record per configured kind and the next planned session per kind, as JSON;
  // the initial-training progress from the sessions the course has flown and has planned.
  const rows = await query<Row>(`
    WITH last_rec AS (
      SELECT DISTINCT ON (r.person_id, r.record_kind) r.person_id, r.record_kind, r.training_date::text AS last
        FROM records r WHERE r.deleted_at IS NULL AND r.record_kind = ANY($${kindsParam}::text[]) AND r.outcome IS DISTINCT FROM 'INCOMPLETE'
       ORDER BY r.person_id, r.record_kind, r.training_date DESC),
    planned AS (
      SELECT ss.person_id, k.label AS record_kind, min(s.session_date)::text AS planned
        FROM sessions s JOIN session_subjects ss ON ss.session_id = s.id
        JOIN session_template_versions v ON v.id = s.template_version_id JOIN session_templates t ON t.id = v.template_id
        JOIN template_kinds k ON k.code = t.template_kind
       WHERE s.deleted_at IS NULL AND s.status = 'in_progress' AND s.session_date >= CURRENT_DATE
       GROUP BY ss.person_id, k.label),
    stage AS (
      SELECT DISTINCT ON (ss.person_id) ss.person_id, s.setup->>'stage' AS stage, (s.setup->>'session_number')::int AS session_number
        FROM sessions s JOIN session_subjects ss ON ss.session_id = s.id
       WHERE s.deleted_at IS NULL AND s.status <> 'in_progress' AND s.setup ? 'course'
       ORDER BY ss.person_id, s.session_date DESC, s.created_at DESC),
    nxt AS (
      SELECT DISTINCT ON (ss.person_id) ss.person_id, s.session_date::text AS next_date, COALESCE(s.setup->>'stage', k.label) AS next_kind
        FROM sessions s JOIN session_subjects ss ON ss.session_id = s.id
        JOIN session_template_versions v ON v.id = s.template_version_id JOIN session_templates t ON t.id = v.template_id JOIN template_kinds k ON k.code = t.template_kind
       WHERE s.deleted_at IS NULL AND s.status = 'in_progress' AND s.session_date >= CURRENT_DATE
       ORDER BY ss.person_id, s.session_date),
    lfus AS (
      SELECT ss.person_id,
             count(*) FILTER (WHERE s.status <> 'in_progress')::int AS lfus_flown, count(*)::int AS lfus_total,
             count(*) FILTER (WHERE s.status <> 'in_progress' AND ss.seat_role = 'PF')::int AS pf_sectors
        FROM sessions s JOIN session_subjects ss ON ss.session_id = s.id
       WHERE s.deleted_at IS NULL AND s.setup->>'stage' = 'lfus' GROUP BY ss.person_id),
    ffs AS (
      SELECT ss.person_id, count(*)::int AS ffs_total FROM sessions s JOIN session_subjects ss ON ss.session_id = s.id
       WHERE s.deleted_at IS NULL AND s.setup->>'stage' = 'simulator' GROUP BY ss.person_id)
    SELECT p.id, p.seniority_number, p.external_id, p.full_name, p.position, ac.code AS fleet, ou.code AS base, p.training_course,
           COALESCE((SELECT json_object_agg(k, json_build_object('last', lr.last, 'planned', pl.planned))
                       FROM unnest($${kindsParam}::text[]) AS k
                       LEFT JOIN last_rec lr ON lr.person_id = p.id AND lr.record_kind = k
                       LEFT JOIN planned pl ON pl.person_id = p.id AND pl.record_kind = k), '{}'::json) AS items,
           st.stage, st.session_number, f.ffs_total, l.lfus_flown, l.lfus_total, l.pf_sectors, n.next_date, n.next_kind,
           count(*) OVER ()::text AS total
      FROM people p
      LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
      LEFT JOIN org_units ou ON ou.id = p.org_unit_id
      LEFT JOIN stage st ON st.person_id = p.id
      LEFT JOIN ffs f ON f.person_id = p.id
      LEFT JOIN lfus l ON l.person_id = p.id
      LEFT JOIN nxt n ON n.person_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY p.training_course NULLS FIRST, p.seniority_number NULLS LAST
     LIMIT 2000`, params);

  const statusOf = (it: (typeof items)[number], v: { last: string | null; planned: string | null } | undefined): { status: Status; expires: string | null; days: number | null } => {
    if (!v?.last) return { status: v?.planned ? 'PLANNED' : 'MISSING', expires: null, days: null };
    const expires = addMonths(v.last, it.validity_months);
    const days = daysUntil(expires, today);
    if (days < 0) return { status: v.planned ? 'PLANNED' : 'EXPIRED', expires, days };
    if (days <= cfg.warning_days) return { status: v.planned ? 'PLANNED' : 'WARNING', expires, days };
    return { status: 'VALID', expires, days };
  };
  const evaluated = rows.map((r) => ({ r, s: Object.fromEntries(items.map((it) => [it.key, statusOf(it, r.items[it.recordKind])])) }));
  const filtered = status ? evaluated.filter(({ s }) => Object.values(s).some((x) => x.status === status)) : evaluated;
  const total = filtered.length;
  const pageRows = filtered.slice((page - 1) * size, page * size);
  const counts: Record<string, Record<Status, number>> = {};
  for (const it of items) { counts[it.key] = { VALID: 0, WARNING: 0, EXPIRED: 0, PLANNED: 0, MISSING: 0 }; for (const { s } of evaluated) counts[it.key]![s[it.key]!.status] += 1; }
  const tone = (st: Status) => st === 'VALID' ? 'good' : st === 'WARNING' || st === 'PLANNED' ? 'warn' : st === 'EXPIRED' ? 'bad' : 'neutral';
  const carry: Record<string, string> = Object.fromEntries(Object.entries({ q, fleet, base, position, status, group, course }).filter(([, v]) => v !== ''));
  const [fleets, bases, courses] = await Promise.all([
    query<{ code: string }>(`SELECT code FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position`),
    query<{ code: string }>(`SELECT code FROM org_units WHERE deleted_at IS NULL AND is_active AND kind = 'base' ORDER BY position`),
    query<{ code: string }>(`SELECT DISTINCT training_course AS code FROM people WHERE deleted_at IS NULL AND training_course IS NOT NULL ORDER BY 1`),
  ]);

  const lineColumns: Column<(typeof pageRows)[number]>[] = [
    { key: 'sen', head: 'Seniority', numeric: true, cell: ({ r }) => <Link href={`/subjects/${r.id}`} className="mono">{r.seniority_number ?? r.external_id}</Link> },
    { key: 'name', head: 'Name', cell: ({ r }) => <Link href={`/subjects/${r.id}`}>{r.full_name}</Link> },
    { key: 'rank', head: 'Rank', cell: ({ r }) => r.position ?? '-' },
    { key: 'fleet', head: 'Fleet', cell: ({ r }) => r.fleet ?? '-' },
    { key: 'base', head: 'Base', cell: ({ r }) => r.base ?? '-' },
    ...items.map((it): Column<(typeof pageRows)[number]> => ({
      key: it.key, head: it.label,
      cell: ({ r, s }) => { const x = s[it.key]!; const v = r.items[it.recordKind]; return (
        <span className="stack" style={{ gap: 2 }}>
          <Chip tone={tone(x.status)}>{x.status}</Chip>
          <span className="xs muted mono">{x.expires ? `to ${x.expires}` : v?.planned ? `planned ${v.planned}` : 'no record'}{x.status === 'PLANNED' && v?.planned ? ` · ${v.planned}` : ''}</span>
        </span>
      ); },
    })),
    { key: 'next', head: 'Next planned', numeric: true, cell: ({ r }) => r.next_date ? <span className="mono xs">{r.next_date}<span className="muted"> · {r.next_kind}</span></span> : <span className="muted">-</span> },
  ];
  const initialColumns: Column<(typeof pageRows)[number]>[] = [
    { key: 'sen', head: 'Seniority', numeric: true, cell: ({ r }) => <Link href={`/subjects/${r.id}`} className="mono">{r.seniority_number ?? r.external_id}</Link> },
    { key: 'name', head: 'Name', cell: ({ r }) => <Link href={`/subjects/${r.id}`}>{r.full_name}</Link> },
    { key: 'course', head: 'Course', cell: ({ r }) => <span className="mono">{r.training_course}</span> },
    { key: 'fleet', head: 'Fleet', cell: ({ r }) => r.fleet ?? '-' },
    { key: 'base', head: 'Base', cell: ({ r }) => r.base ?? '-' },
    {
      key: 'stage', head: 'Stage',
      cell: ({ r }) => {
        const stage = r.stage ?? (r.next_kind && cfg.stages[r.next_kind] ? r.next_kind : 'ground');
        const label = cfg.stages[stage] ?? stage;
        const done = r.stage === 'line_check';
        return <Chip tone={done ? 'good' : stage === 'lfus' ? 'info' : 'warn'}>{done ? 'Line training complete' : label}</Chip>;
      },
    },
    {
      key: 'progress', head: 'Progress',
      cell: ({ r }) => {
        if (!r.stage) return <span className="small">Ground school in progress{r.next_date ? ` · ends ${r.next_date}` : ''}</span>;
        if (r.stage === 'ground') return <span className="small">Ground school complete · FFS starts {r.next_date ?? '—'}</span>;
        if (r.stage === 'simulator') return <span className="small">FFS session {r.session_number ?? '?'} of {r.ffs_total ?? '?'}{r.next_date ? ` · next ${r.next_date}` : ''}</span>;
        if (r.stage === 'skill_test') return <span className="small">Skill test done · LFUS starts {r.next_date ?? '—'}</span>;
        if (r.stage === 'lfus') return <span className="small">Sector {r.lfus_flown ?? 0} of {r.lfus_total ?? '?'} · <strong>{r.pf_sectors ?? 0}</strong> take-offs and landings as PF{r.next_date ? ` · next ${r.next_date}` : ''}</span>;
        return <span className="small">Line check passed · released to the line</span>;
      },
    },
    { key: 'next', head: 'Next planned', numeric: true, cell: ({ r }) => r.next_date ? <span className="mono xs">{r.next_date}<span className="muted"> · {cfg.stages[r.next_kind ?? ''] ?? r.next_kind}</span></span> : <span className="muted">-</span> },
  ];

  return (
    <div className="stack" data-testid="subject-status">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: L.subject_plural, href: '/subjects' }, { label: 'Training status' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Training status</h1>
        <span className="xs muted">as of {today}</span>
      </div>

      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <Link href={`/subjects/status?${new URLSearchParams({ ...carry, group: 'line' })}`} className={`button ${group === 'line' ? '' : 'button-quiet'}`} style={{ textDecoration: 'none' }}>Line pilots</Link>
        <Link href={`/subjects/status?${new URLSearchParams({ ...carry, group: 'initial' })}`} className={`button ${group === 'initial' ? '' : 'button-quiet'}`} style={{ textDecoration: 'none' }}>Initial training</Link>
      </div>

      {group === 'line' ? (
        <div className="grid grid-kpi">
          {items.map((it) => (
            <div key={it.key} className="card" style={{ padding: 'var(--space-3)' }}>
              <div className="xs muted" style={{ letterSpacing: '0.04em' }}>{it.label.toUpperCase()} · {it.validity_months} months</div>
              <div className="row" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)', flexWrap: 'wrap' }}>
                {(['VALID', 'WARNING', 'PLANNED', 'EXPIRED', 'MISSING'] as Status[]).map((st) => counts[it.key]![st] ? <Link key={st} href={`/subjects/status?${new URLSearchParams({ ...carry, status: st })}`} style={{ textDecoration: 'none' }}><Chip tone={tone(st)}>{st} {counts[it.key]![st]}</Chip></Link> : null)}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <FilterBar action="/subjects/status" resetHref={`/subjects/status?group=${group}`} carry={{ group, size: size === 20 ? undefined : String(size) }}>
        <LiveSearch name="q" label="Name or seniority" value={q} placeholder="Type to search" />
        <SelectFilter name="fleet" label="Fleet" value={fleet} options={fleets.map((f) => ({ value: f.code, label: f.code }))} />
        <SelectFilter name="base" label="Base" value={base} options={bases.map((b) => ({ value: b.code, label: b.code }))} />
        {group === 'line' ? <SelectFilter name="position" label="Rank" value={position} options={P.positions.map((x) => ({ value: x, label: x }))} /> : null}
        {group === 'line' ? <SelectFilter name="status" label="Any item" value={status} options={(['WARNING', 'EXPIRED', 'PLANNED', 'MISSING', 'VALID'] as Status[]).map((st) => ({ value: st, label: st }))} /> : null}
        {group === 'initial' ? <SelectFilter name="course" label="Course" value={course} options={courses.map((c) => ({ value: c.code, label: c.code }))} /> : null}
      </FilterBar>

      <DataTable
        testId="status-list"
        caption={group === 'line' ? 'Line pilots' : 'Initial training'}
        columns={group === 'line' ? lineColumns : initialColumns}
        rows={pageRows}
        rowKey={({ r }) => r.id}
        emptyTitle="Nobody matched"
        emptyReason="No pilot matched these filters."
        countSuffix={total > pageRows.length ? `of ${total}` : undefined}
      />
      <Pager path="/subjects/status" params={carry} page={page} size={size} total={total} noun="pilots" />
    </div>
  );
}
