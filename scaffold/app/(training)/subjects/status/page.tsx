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
import { InitialKanban, type BoardPilot } from '@/components/training/InitialKanban';
import { buildInitialCard, type MilestoneSession, type StageDef } from '@/lib/training/initial';

/**
 * /subjects/status - training status across the roster.
 *
 * Line pilots: for each item in policy.yaml `training_status.items` (EBT, OPC/LPC, line check,
 * ground school), the date of the last record of that kind, the expiry (validity months from
 * it) and a status: VALID, WARNING (inside the warning window), EXPIRED, PLANNED (expired or due
 * but a session is already planned), MISSING (no record). Read from records and planned sessions
 * in SQL; nothing is recomputed per row in the render.
 *
 * Initial-training pilots (people.training_course set): a board by default (`?view=board`), one
 * column per stage, one swimlane per course, a card per pilot placed by the first milestone not
 * yet complete - derived from their sessions on every render, so a signed session moves the card
 * (lib/training/initial.ts). `?view=table` is the same data one row per pilot. A card opens the
 * milestone timeline and the sector-by-sector LFUS table; a sector opens its record.
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
  next_date: string | null; next_kind: string | null;
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
  const cfg = P.training_status ?? { warning_days: 60, items: [], stages: {}, check_stages: [], released_label: 'Released', board: { finishing_days: 14 } };
  const stageDefs: StageDef[] = Object.entries(cfg.stages).map(([key, label]) => ({ key, label, check: (cfg.check_stages ?? []).includes(key) }));
  const releasedLabel = cfg.released_label ?? 'Released';
  const kindLabel = new Map(P.template_kinds.map((k) => [k.kind, k.label]));
  const items = cfg.items.map((it) => ({ ...it, recordKind: kindLabel.get(it.kind) ?? it.kind }));
  const today = new Date().toISOString().slice(0, 10);

  const sp = await searchParams;
  const q = one(sp.q); const fleet = one(sp.fleet); const base = one(sp.base); const position = one(sp.position); const status = one(sp.status); const item = one(sp.item); const group = one(sp.group) || 'line'; const course = one(sp.course); const view = group === 'initial' ? (one(sp.view) === 'table' ? 'table' : 'board') : 'table';
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

  // One row per pilot: the last record per configured kind and the next planned session per kind, as JSON,
  // and the next planned session of any kind.
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
    nxt AS (
      SELECT DISTINCT ON (ss.person_id) ss.person_id, s.session_date::text AS next_date, COALESCE(s.setup->>'stage', k.label) AS next_kind
        FROM sessions s JOIN session_subjects ss ON ss.session_id = s.id
        JOIN session_template_versions v ON v.id = s.template_version_id JOIN session_templates t ON t.id = v.template_id JOIN template_kinds k ON k.code = t.template_kind
       WHERE s.deleted_at IS NULL AND s.status = 'in_progress' AND s.session_date >= CURRENT_DATE
       ORDER BY ss.person_id, s.session_date)
    SELECT p.id, p.seniority_number, p.external_id, p.full_name, p.position, ac.code AS fleet, ou.code AS base, p.training_course,
           COALESCE((SELECT json_object_agg(k, json_build_object('last', lr.last, 'planned', pl.planned))
                       FROM unnest($${kindsParam}::text[]) AS k
                       LEFT JOIN last_rec lr ON lr.person_id = p.id AND lr.record_kind = k
                       LEFT JOIN planned pl ON pl.person_id = p.id AND pl.record_kind = k), '{}'::json) AS items,
           n.next_date, n.next_kind,
           count(*) OVER ()::text AS total
      FROM people p
      LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
      LEFT JOIN org_units ou ON ou.id = p.org_unit_id
      LEFT JOIN nxt n ON n.person_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY p.training_course NULLS FIRST, p.seniority_number NULLS LAST
     LIMIT 2000`, params);

  // Initial training: every session of the course per pilot, with the record it produced, for the cards.
  const milestones = new Map<string, MilestoneSession[]>();
  if (group === 'initial' && rows.length) {
    const ms = await query<MilestoneSession & { person_id: string }>(`
      SELECT ss.person_id, s.id, s.setup->>'stage' AS stage, (s.setup->>'session_number')::int AS session_number, s.session_date::text AS session_date, s.status,
             COALESCE(r.outcome_override, r.outcome, s.outcome) AS outcome, s.setup->>'check' AS "check", s.setup->>'departure' AS departure, s.setup->>'arrival' AS arrival,
             (s.setup->>'sector_number')::int AS sector_number, ss.seat_role AS seat, s.setup->>'aircraft_type' AS aircraft_type, s.setup->>'registration' AS registration,
             a.full_name AS assessor_name, t.name AS template_name, r.id AS record_id,
             COALESCE((r.snapshot->>'additional_training')::boolean, false) AS additional_training, COALESCE(r.snapshot ? 'objection', false) AS objected
        FROM sessions s JOIN session_subjects ss ON ss.session_id = s.id
        JOIN session_template_versions v ON v.id = s.template_version_id JOIN session_templates t ON t.id = v.template_id
        LEFT JOIN people a ON a.id = s.assessor_person_id
        LEFT JOIN records r ON r.session_id = s.id AND r.person_id = ss.person_id AND r.deleted_at IS NULL
       WHERE s.deleted_at IS NULL AND s.status <> 'void' AND s.setup ? 'course' AND ss.person_id = ANY($1::uuid[])
       ORDER BY s.session_date, s.created_at`, [rows.map((r) => r.id)]);
    for (const { person_id, ...m } of ms) { if (!milestones.has(person_id)) milestones.set(person_id, []); milestones.get(person_id)!.push(m); }
  }
  const boardPilots: BoardPilot[] = group === 'initial' ? rows.map((r) => ({ id: r.id, seniority_number: r.seniority_number, external_id: r.external_id, full_name: r.full_name, position: r.position, fleet: r.fleet, base: r.base, training_course: r.training_course, card: buildInitialCard(milestones.get(r.id) ?? [], stageDefs, today, releasedLabel) })) : [];
  const cardOf = new Map(boardPilots.map((b) => [b.id, b.card]));

  const statusOf = (it: (typeof items)[number], v: { last: string | null; planned: string | null } | undefined): { status: Status; expires: string | null; days: number | null } => {
    if (!v?.last) return { status: v?.planned ? 'PLANNED' : 'MISSING', expires: null, days: null };
    const expires = addMonths(v.last, it.validity_months);
    const days = daysUntil(expires, today);
    if (days < 0) return { status: v.planned ? 'PLANNED' : 'EXPIRED', expires, days };
    if (days <= cfg.warning_days) return { status: v.planned ? 'PLANNED' : 'WARNING', expires, days };
    return { status: 'VALID', expires, days };
  };
  const evaluated = rows.map((r) => ({ r, s: Object.fromEntries(items.map((it) => [it.key, statusOf(it, r.items[it.recordKind])])) }));
  // `status` alone means "any item has this status" - the select in the filter bar. `item` narrows it to
  // one policy item, which is what a counter on an item's card means: EBT · EXPIRED 6 must return 6 rows,
  // not every pilot expired on anything. The counter link carries both; the filter bar carries neither, so
  // submitting the form deliberately widens back to any item.
  const filtered = status
    ? evaluated.filter(({ s }) => (item && s[item] ? s[item]!.status === status : Object.values(s).some((x) => x.status === status)))
    : evaluated;
  const total = filtered.length;
  const pageRows = filtered.slice((page - 1) * size, page * size);
  const counts: Record<string, Record<Status, number>> = {};
  for (const it of items) { counts[it.key] = { VALID: 0, WARNING: 0, EXPIRED: 0, PLANNED: 0, MISSING: 0 }; for (const { s } of evaluated) counts[it.key]![s[it.key]!.status] += 1; }
  const tone = (st: Status) => st === 'VALID' ? 'good' : st === 'WARNING' || st === 'PLANNED' ? 'warn' : st === 'EXPIRED' ? 'bad' : 'neutral';
  const carry: Record<string, string> = Object.fromEntries(Object.entries({ q, fleet, base, position, status, item, group, course, view: group === 'initial' && view === 'table' ? 'table' : '' }).filter(([, v]) => v !== ''));
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
      cell: ({ r }) => { const c = cardOf.get(r.id)!; return <Chip tone={c.released ? 'good' : c.rag === 'bad' ? 'bad' : c.stage === 'lfus' ? 'info' : 'warn'}>{c.stageLabel}</Chip>; },
    },
    {
      key: 'progress', head: 'Progress',
      cell: ({ r }) => { const c = cardOf.get(r.id)!; return (
        <span className="stack" style={{ gap: 2 }}>
          <span className="small">{c.stage === 'simulator' ? `FFS ${c.ffs.done} of ${c.ffs.total}` : c.stage === 'lfus' || c.released ? <>Sector {c.lfus.flown} of {c.lfus.total} · <strong>{c.lfus.pf}</strong> take-offs and landings as PF</> : c.stageLabel}{c.overdue ? <span className="chip chip-warn" style={{ marginLeft: 'var(--space-2)' }}>{c.overdue} overdue</span> : null}</span>
          <span className={`kanban-bar bar-${c.rag}`} style={{ width: 160 }}><span style={{ width: `${c.progress}%` }} /></span>
        </span>
      ); },
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
                {(['VALID', 'WARNING', 'PLANNED', 'EXPIRED', 'MISSING'] as Status[]).map((st) => counts[it.key]![st] ? <Link key={st} href={`/subjects/status?${new URLSearchParams({ ...carry, status: st, item: it.key })}`} style={{ textDecoration: 'none' }}><Chip tone={tone(st)}>{st} {counts[it.key]![st]}</Chip></Link> : null)}
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

      {group === 'line' && status && item ? (
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'baseline' }}>
          <span className="xs muted">Filtered by</span>
          <Chip tone={tone(status as Status)}>{items.find((it) => it.key === item)?.label ?? item} · {status}</Chip>
          <Link href={`/subjects/status?${new URLSearchParams(Object.fromEntries(Object.entries(carry).filter(([k]) => k !== 'status' && k !== 'item')))}`} className="xs">Clear</Link>
        </div>
      ) : null}

      {group === 'initial' ? (
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <span className="xs muted">View</span>
          <Link href={`/subjects/status?${new URLSearchParams({ ...carry, view: 'board' })}`} className={`button xs ${view === 'board' ? '' : 'button-quiet'}`} style={{ textDecoration: 'none' }}>Board</Link>
          <Link href={`/subjects/status?${new URLSearchParams({ ...carry, view: 'table' })}`} className={`button xs ${view === 'table' ? '' : 'button-quiet'}`} style={{ textDecoration: 'none' }}>Table</Link>
        </div>
      ) : null}

      {view === 'board' ? (
        boardPilots.length ? <InitialKanban pilots={boardPilots} stages={stageDefs} releasedLabel={releasedLabel} today={today} finishingDays={cfg.board?.finishing_days ?? 14} /> : <p className="muted">No pilot in initial training matched these filters.</p>
      ) : (<>
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
      </>)}
    </div>
  );
}
