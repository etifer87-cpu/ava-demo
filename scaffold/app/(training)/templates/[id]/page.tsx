import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { loadProgramVersion, programVocab } from '@/lib/program';
import { hasBlockers } from '@/lib/program/rules';
import { formatMinutes } from '@/lib/program/shape';
import { plannedMinutes, totalPlannedMinutes, type ProgramNode } from '@/lib/program/model';
import { listLibrary, malfunctionIndex, eventLibrary, groupsWithCandidates } from '@/lib/program/library';
import { fleetOptions } from '@/lib/templates';
import { phaseColour } from '@/lib/config';
import { readFlash } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import BuilderCanvas from '@/components/program/BuilderCanvas';
import InspectorPane from '@/components/program/InspectorPane';
import type { CanvasNode, PresetItem } from '@/components/program/canvas-types';
import type { InspectorData, InspectorNode } from '@/components/program/inspector-types';

/**
 * /templates/[id] - the builder. docs/06_PROGRAM_BUILDER.md section 5.2.
 *
 * Three resizable panes: the palette (what can be added), the program canvas (drag, drop, rename
 * inline), the inspector (the selected element's pane, saving on blur). The canvas and the
 * inspector are client components; both post JSON to the elements route and refresh this page,
 * so the tree on screen is always the tree in the database. Selection is `?sel=<key>`;
 * `?version=` opens another version. Gate: training.templates.view to read;
 * training.templates.configure for every write, checked again in the route.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TemplateRow { id: string; code: string; name: string; template_kind: string; kind_label: string; asset_class: string | null; current_version_id: string | null; is_active: boolean }
const UUID = /^[0-9a-f-]{36}$/i;
const KEY = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = UUID.test(id) ? (await query<{ name: string }>(`SELECT name FROM session_templates WHERE id = $1::uuid AND deleted_at IS NULL`, [id]))[0] : undefined;
  return { title: t?.name ?? 'Program' };
}

export default async function ProgramPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.view');

  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string).trim() : '');
  const wantedVersion = UUID.test(one('version')) ? one('version') : null;
  const sel = KEY.test(one('sel')) ? one('sel') : null;

  const template = (await query<TemplateRow>(`
    SELECT t.id, t.code, t.name, t.template_kind, COALESCE(k.label, t.template_kind) AS kind_label, ac.code AS asset_class, t.current_version_id, t.is_active
      FROM session_templates t LEFT JOIN template_kinds k ON k.code = t.template_kind LEFT JOIN asset_classes ac ON ac.id = t.asset_class_id
     WHERE t.id = $1::uuid AND t.deleted_at IS NULL`, [id]))[0] ?? null;
  if (!template) notFound();

  const versionId = wantedVersion ?? template.current_version_id;
  const [program, versions, library, fleets, flash] = await Promise.all([
    versionId ? loadProgramVersion(versionId) : Promise.resolve(null),
    query<{ id: string; version: number; status: string }>(`SELECT id, version, status FROM session_template_versions WHERE template_id = $1::uuid AND deleted_at IS NULL ORDER BY version DESC`, [id]),
    listLibrary({ q: '', fleet: template.asset_class }),
    fleetOptions(),
    readFlash(),
  ]);
  if (program && program.version.template_id !== template.id) notFound();

  const vocab = programVocab();
  const canConfigure = can(access, 'training.templates.configure');
  const editable = Boolean(canConfigure && program?.version.status === 'draft');
  const base = `/templates/${template.id}`;
  const carry: Record<string, string> = {};
  if (wantedVersion) carry.version = wantedVersion;

  const presets: PresetItem[] = library
    .filter((r) => r.kind === 'block' || r.kind === 'task')
    .map((r) => ({ code: r.code, title: r.title, kind: r.kind === 'block' ? 'block' : 'exercise', phase: null, summary: r.summary }));

  // ---- the canvas model ---------------------------------------------------
  const toCanvas = (n: ProgramNode): CanvasNode => {
    const c = n.content;
    const kind: CanvasNode['kind'] = c.type === 'section' ? 'section' : c.type === 'task' ? 'exercise' : c.type === 'setup' ? 'setup' : c.type === 'event_option' ? c.options.kind : c.type === 'note' ? 'note' : 'other';
    const badges: string[] = [];
    const gradedOf = (g: { task_outcome_mode: string; competency_grade_mode: string; competencies: readonly string[] }) => {
      if (g.competencies.length) badges.push(g.competencies.join(' · '));
      if (g.task_outcome_mode !== 'none' || g.competency_grade_mode !== 'none') badges.push('graded');
    };
    if (c.type === 'task') { if (c.task.pf) badges.push(`PF ${c.task.pf}`); gradedOf(c.task.grading); }
    if (c.type === 'section') gradedOf(c.section.grading);
    if (c.type === 'event_option') {
      const n2 = c.options.options.length;
      badges.push(n2 === 0 ? 'empty' : `${n2} ${c.options.kind === 'malfunction' ? (n2 === 1 ? 'failure' : 'failures') : (n2 === 1 ? 'event' : 'events')}`);
      if (n2 > 1) badges.push(c.options.mode === 'choose_one' ? 'choose one' : 'in sequence');
    }
    if (c.type === 'setup') {
      const n2 = Object.values(c.setup.entries).reduce((a, l) => a + l.length, 0) + (c.setup.mass.zfw || c.setup.mass.fuel ? 1 : 0);
      badges.push(n2 === 0 ? 'empty' : `${n2} line${n2 === 1 ? '' : 's'}`);
    }
    const m = plannedMinutes(n);
    return {
      key: n.key, parentKey: n.parentKey, kind, title: n.title,
      phase: c.type === 'section' ? c.section.phase : null,
      phaseLabel: c.type === 'section' && c.section.phase ? vocab.phases.get(c.section.phase) ?? c.section.phase : null,
      phaseColour: c.type === 'section' ? phaseColour(c.section.phase) : null,
      minutes: m === null ? null : formatMinutes(m),
      trainingOnly: c.type === 'section' && c.section.training_only,
      badges, children: n.children.map(toCanvas),
    };
  };
  const canvasRoots = program ? program.tree.roots.map(toCanvas) : [];

  // ---- the inspector model ------------------------------------------------
  const node = program && sel ? program.tree.byKey.get(sel) ?? null : null;
  const inspectorNode: InspectorNode | null = node ? (() => {
    const c = node.content;
    switch (c.type) {
      case 'section': return { kind: 'section', key: node.key, title: node.title, content: c.section };
      case 'task': return { kind: 'exercise', key: node.key, title: node.title, content: c.task };
      case 'setup': return { kind: 'setup', key: node.key, title: node.title, content: c.setup };
      case 'event_option': return { kind: 'options', key: node.key, title: node.title, content: c.options };
      case 'note': return { kind: 'note', key: node.key, title: node.title, content: c.note };
      default: return { kind: 'other', key: node.key, title: node.title, elementType: c.elementType };
    }
  })() : null;
  const siblings = node ? (node.parentKey ? program?.tree.byKey.get(node.parentKey)?.children ?? [] : program?.tree.roots ?? []) : [];
  const countDesc = (n: ProgramNode): number => n.children.reduce((a, k) => a + 1 + countDesc(k), 0);
  const isMalf = inspectorNode?.kind === 'options' && inspectorNode.content.kind === 'malfunction';
  const isEvent = inspectorNode?.kind === 'options' && inspectorNode.content.kind === 'event';
  const paneFleet = isMalf ? (inspectorNode.content.fleet ?? template.asset_class) : template.asset_class;
  const [competencies, malfunctions, events, groups] = await Promise.all([
    inspectorNode && (inspectorNode.kind === 'section' || inspectorNode.kind === 'exercise')
      ? query<{ code: string; name: string }>(`SELECT c.code, c.name FROM competencies c JOIN competency_frameworks f ON f.id = c.framework_id WHERE f.is_active AND c.is_active ORDER BY c.position, c."index"`)
      : Promise.resolve([]),
    isMalf ? malfunctionIndex(paneFleet) : Promise.resolve([]),
    isEvent ? eventLibrary(template.asset_class) : Promise.resolve([]),
    isMalf ? groupsWithCandidates(paneFleet) : Promise.resolve([]),
  ]);
  const inspectorData: InspectorData = {
    node: inspectorNode,
    index: node ? siblings.findIndex((s) => s.key === node.key) : -1,
    siblingCount: siblings.length,
    descendants: node ? countDesc(node) : 0,
    editable,
    vocab: { sectionKinds: [...vocab.sectionKinds], phases: [...vocab.phases.entries()], pfSeats: [...vocab.pfSeats] },
    competencies, fleets: fleets.map((f) => ({ code: f.value, label: f.label })), programFleet: template.asset_class,
    malfunctions, events, groups,
  };

  const planned = program ? totalPlannedMinutes(program.tree) : null;
  const period = program?.tree.setup.period_minutes ?? null;
  const blockers = program ? hasBlockers(program.findings) : false;
  const taskCount = program ? [...program.tree.byKey.values()].filter((n) => n.content.type === 'task').length : 0;
  const hrefFor = (key: string) => `${base}?${new URLSearchParams({ ...carry, sel: key }).toString()}`;

  return (
    <div className="stack builder-page" data-testid="template-builder">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Programs', href: '/templates' }, { label: template.name }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{template.name}</h1>
        <span className="mono xs muted">{template.code}</span>
        <span className="spacer" />
        {program ? (
          program.version.status === 'published' ? <Chip tone="good">Published · v{program.version.version}</Chip>
          : program.version.status === 'retired' ? <Chip tone="neutral">Retired · v{program.version.version}</Chip>
          : <Chip tone="warn">Draft · v{program.version.version}</Chip>
        ) : <Chip tone="bad">No version</Chip>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {template.kind_label} · {template.asset_class ?? 'every fleet'}
        {program?.tree.setup.program.code ? ` · ${program.tree.setup.program.code}${program.tree.setup.program.day ? ` day ${program.tree.setup.program.day}` : ''}` : ''}
        {program?.tree.setup.device ? ` · ${program.tree.setup.device}` : ''}
        {planned !== null || period !== null ? <> · <span className="mono">{planned === null ? '-' : formatMinutes(planned)}{period !== null ? ` of ${formatMinutes(period)}` : ''}</span>{planned !== null && period !== null ? <span> · {planned <= period ? `${formatMinutes(period - planned)} free` : `${formatMinutes(planned - period)} over`}</span> : null}</> : null}
        {` · ${taskCount} exercise${taskCount === 1 ? '' : 's'}`}
        {versions.length > 1 ? <> · versions: {versions.map((v, i) => <span key={v.id}>{i ? ', ' : ''}<Link href={`${base}?version=${v.id}`}>v{v.version} {v.status}</Link></span>)}</> : null}
      </p>

      {flash ? <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : flash.kind === 'warn' ? ' notice-warn' : ''}`} role="status"><p style={{ margin: 0 }}>{flash.message}</p></div> : null}

      {!program ? (
        <Card title="No version"><p className="muted small" style={{ margin: 0 }}>This program has no version to open. A program is created with its version 1; this row predates that rule.</p></Card>
      ) : (
        <>
          <BuilderCanvas
            templateId={template.id} versionId={program.version.id} roots={canvasRoots} presets={presets} selected={sel} editable={editable} basePath={base} carry={carry}
            inspector={<InspectorPane templateId={template.id} versionId={program.version.id} {...inspectorData} />}
          />

          {program.problems.length ? (
            <Card title="Content problems" note="Fields that did not parse. The element still renders with the field dropped; fix the field and the line goes away." testId="program-problems">
              <ul className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {program.problems.map((p, i) => <li key={i}><span className="mono">{p.elementKey ?? 'setup'}{p.path ? `.${p.path}` : ''}</span> - {p.message}</li>)}
              </ul>
            </Card>
          ) : null}

          <Card title="Findings" note="Blockers stop a publish; warnings are shown and allowed. Each names what it cites; the key jumps to the element." testId="program-findings">
            {program.findings.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nothing to resolve.</p> : (
              <ul className="findings">
                {program.findings.map((f, i) => (
                  <li key={i} className={`finding finding-${f.severity}`} data-rule={f.rule}>
                    <Chip tone={f.severity === 'block' ? 'bad' : 'warn'}>{f.severity === 'block' ? 'Blocker' : 'Warning'}</Chip>
                    <span className="finding-text">{f.message}{f.detail ? <span className="muted"> · {f.detail}</span> : null}{f.at ? <> · <Link href={hrefFor(f.at)} className="mono xs">{f.at}</Link></> : null}</span>
                    {f.source ? <span className="xs muted finding-source">{f.source}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            {blockers ? <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>Blockers present: this version cannot be published until they are resolved.</p> : null}
          </Card>
        </>
      )}
    </div>
  );
}
