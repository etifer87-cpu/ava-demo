import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { loadProgramVersion, programVocab } from '@/lib/program';
import { hasBlockers } from '@/lib/program/rules';
import { totalPlannedMinutes } from '@/lib/program/model';
import { listLibrary, pickList, equivalencyGroups } from '@/lib/program/library';
import { SETUP_KINDS } from '@/lib/program/shape';
import { readFlash } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import BuilderCanvas from '@/components/program/BuilderCanvas';
import Inspector from '@/components/program/Inspector';
import type { CanvasNode, PresetItem } from '@/components/program/canvas-types';
import { plannedMinutes, type ProgramNode } from '@/lib/program/model';
import { phaseColour } from '@/lib/config';
import { formatMinutes } from '@/lib/program/shape';

/**
 * /templates/[id] - the builder. docs/06_PROGRAM_BUILDER.md section 5.2.
 *
 * Three panes: the palette (what can be added), the program canvas (drag, drop, rename inline),
 * the inspector (the selected element's content). The canvas is the one client component; it
 * posts JSON to the elements route and refreshes this page, so the tree on screen is always the
 * tree in the database. Selection is `?sel=<key>`; `?version=` opens another version. Gate: training.templates.view to read;
 * training.templates.configure for every form, checked again in the route.
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
  const tabRaw = one('tab');
  const openTab = (tabRaw === 'setup' || tabRaw === 'conduct' || tabRaw === 'assessment' || tabRaw === 'aims') ? tabRaw : 'setup';

  const template = (await query<TemplateRow>(`
    SELECT t.id, t.code, t.name, t.template_kind, COALESCE(k.label, t.template_kind) AS kind_label, ac.code AS asset_class, t.current_version_id, t.is_active
      FROM session_templates t LEFT JOIN template_kinds k ON k.code = t.template_kind LEFT JOIN asset_classes ac ON ac.id = t.asset_class_id
     WHERE t.id = $1::uuid AND t.deleted_at IS NULL`, [id]))[0] ?? null;
  if (!template) notFound();

  const versionId = wantedVersion ?? template.current_version_id;
  const [program, versions, library, flash] = await Promise.all([
    versionId ? loadProgramVersion(versionId) : Promise.resolve(null),
    query<{ id: string; version: number; status: string }>(`SELECT id, version, status FROM session_template_versions WHERE template_id = $1::uuid AND deleted_at IS NULL ORDER BY version DESC`, [id]),
    listLibrary({ q: '', fleet: template.asset_class }),
    readFlash(),
  ]);
  // Presets: block presets and saved exercises from the library, for the palette's second group.
  const presets: PresetItem[] = library
    .filter((r) => r.kind === 'block' || r.kind === 'task')
    .map((r) => ({ code: r.code, title: r.title, kind: r.kind === 'block' ? 'block' : 'exercise', phase: null, summary: r.summary }));
  if (program && program.version.template_id !== template.id) notFound();

  const vocab = programVocab();
  const canConfigure = can(access, 'training.templates.configure');
  const canLibrary = can(access, 'training.library.manage');
  const editable = canConfigure && program?.version.status === 'draft';

  const node = program && sel ? program.tree.byKey.get(sel) ?? null : null;

  // Picker data is loaded only when a task is selected: six set-up lists, the malfunction and
  // inject lists, the equivalency groups and the framework's competencies. Nothing selected,
  // nothing fetched.
  const picks = node?.content.type === 'task' ? await (async () => {
    const fleet = template.asset_class;
    const [airport, weather, mass_config, position, comms, reset, atc_script, malfunctions, injects, groups, competencies] = await Promise.all([
      pickList('airport', fleet), pickList('weather', fleet), pickList('mass_config', fleet), pickList('position', fleet), pickList('comms', fleet), pickList('reset', fleet), pickList('atc_script', fleet),
      pickList('malfunction', fleet), pickList('inject', fleet), equivalencyGroups(fleet),
      query<{ code: string; name: string }>(`SELECT c.code, c.name FROM competencies c JOIN competency_frameworks f ON f.id = c.framework_id WHERE f.is_active AND c.is_active ORDER BY c.position, c."index"`),
    ]);
    const setupOptions = { airport, weather, mass_config, position, comms, reset, atc_script } satisfies Record<(typeof SETUP_KINDS)[number], unknown>;
    return { setupOptions, malfunctions, injects, groups, competencies };
  })() : null;
  const target = node ? (node.content.type === 'section' ? node : node.parentKey ? program?.tree.byKey.get(node.parentKey) ?? null : null) : null;

  const base = `/templates/${template.id}`;
  const hrefFor = (key: string) => {
    const u = new URLSearchParams();
    if (wantedVersion) u.set('version', wantedVersion);
    u.set('sel', key);
    if (key === sel && tabRaw) u.set('tab', tabRaw);
    return `${base}?${u.toString()}`;
  };


  const toCanvas = (n: ProgramNode): CanvasNode => {
    const c = n.content;
    const kind: CanvasNode['kind'] = c.type === 'section' ? 'section' : c.type === 'task' ? 'exercise' : c.type === 'setup' ? 'setup' : c.type === 'event_option' ? c.options.kind : c.type === 'note' ? 'note' : 'other';
    const badges: string[] = [];
    if (c.type === 'task') {
      if (c.task.pf) badges.push(`PF ${c.task.pf}`);
      if (c.task.grading.competencies.length) badges.push(c.task.grading.competencies.join(' · '));
      if (c.task.grading.task_outcome_mode !== 'none' || c.task.grading.competency_grade_mode !== 'none') badges.push('graded');
      if (c.task.conduct.slot) badges.push('slot');
    }
    if (c.type === 'event_option') {
      const n2 = c.options.options.length;
      badges.push(n2 === 0 ? 'empty' : `${n2} ${c.options.kind === 'malfunction' ? (n2 === 1 ? 'failure' : 'failures') : (n2 === 1 ? 'item' : 'items')}`);
      if (n2 > 1) badges.push(c.options.mode === 'choose_one' ? 'choose one' : 'in sequence');
    }
    if (c.type === 'setup') badges.push(`${c.setup.rows.length} row${c.setup.rows.length === 1 ? '' : 's'}`);
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
  const carry: Record<string, string> = {};
  if (wantedVersion) carry.version = wantedVersion;

  const planned = program ? totalPlannedMinutes(program.tree) : null;
  const period = program?.tree.setup.period_minutes ?? null;
  const blockers = program ? hasBlockers(program.findings) : false;
  const taskCount = program ? [...program.tree.byKey.values()].filter((n) => n.content.type === 'task').length : 0;

  return (
    <div className="stack" data-testid="template-builder">
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
        {` · ${taskCount} task${taskCount === 1 ? '' : 's'}`}
        {versions.length > 1 ? <> · versions: {versions.map((v, i) => <span key={v.id}>{i ? ', ' : ''}<Link href={`${base}?version=${v.id}`}>v{v.version} {v.status}</Link></span>)}</> : null}
      </p>

      {flash ? <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : flash.kind === 'warn' ? ' notice-warn' : ''}`} role="status"><p style={{ margin: 0 }}>{flash.message}</p></div> : null}

      {!program ? (
        <Card title="No version"><p className="muted small" style={{ margin: 0 }}>This program has no version to open. A program is created with its version 1; this row predates that rule.</p></Card>
      ) : (
        <>
          <div className="builder" data-testid="builder">
            <BuilderCanvas templateId={template.id} versionId={program.version.id} roots={canvasRoots} presets={presets} selected={sel} editable={Boolean(editable)} basePath={base} carry={carry} />
            <Inspector tree={program.tree} node={node} templateId={template.id} versionId={program.version.id} editable={Boolean(editable)} vocab={vocab} picks={picks} openTab={openTab} />
          </div>

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
