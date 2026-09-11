import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { loadProgramVersion, programVocab } from '@/lib/program';
import { hasBlockers } from '@/lib/program/rules';
import { formatMinutes } from '@/lib/program/shape';
import { totalPlannedMinutes } from '@/lib/program/model';
import { listLibrary, pickList, equivalencyGroups } from '@/lib/program/library';
import { SETUP_KINDS } from '@/lib/program/shape';
import { fleetOptions } from '@/lib/templates';
import { readFlash } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import Outline from '@/components/program/Outline';
import LibraryRail from '@/components/program/LibraryRail';
import Inspector from '@/components/program/Inspector';

/**
 * /templates/[id] - the builder. docs/06_PROGRAM_BUILDER.md section 5.2.
 *
 * Three panes: the library rail, the program canvas, the inspector. Everything is server-rendered
 * and every state is a URL: `?sel=<key>` selects, `?lib=<text>` searches the rail, `?version=`
 * opens another version of the same program. The inspector renders the selected element's forms
 * only - one form, not thirty-four - and every change is a POST to the elements route that comes
 * back here with the changed element selected. Gate: training.templates.view to read;
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
  const libQ = one('lib').slice(0, 80);
  const tabRaw = one('tab');
  const openTab = (tabRaw === 'setup' || tabRaw === 'conduct' || tabRaw === 'assessment' || tabRaw === 'aims') ? tabRaw : 'setup';

  const template = (await query<TemplateRow>(`
    SELECT t.id, t.code, t.name, t.template_kind, COALESCE(k.label, t.template_kind) AS kind_label, ac.code AS asset_class, t.current_version_id, t.is_active
      FROM session_templates t LEFT JOIN template_kinds k ON k.code = t.template_kind LEFT JOIN asset_classes ac ON ac.id = t.asset_class_id
     WHERE t.id = $1::uuid AND t.deleted_at IS NULL`, [id]))[0] ?? null;
  if (!template) notFound();

  const versionId = wantedVersion ?? template.current_version_id;
  const [program, versions, library, fleets, flash] = await Promise.all([
    versionId ? loadProgramVersion(versionId) : Promise.resolve(null),
    query<{ id: string; version: number; status: string }>(`SELECT id, version, status FROM session_template_versions WHERE template_id = $1::uuid AND deleted_at IS NULL ORDER BY version DESC`, [id]),
    listLibrary({ q: libQ, fleet: template.asset_class }),
    fleetOptions(),
    readFlash(),
  ]);
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
    const [airport, weather, mass_config, position, reset, atc_script, malfunctions, injects, groups, competencies] = await Promise.all([
      pickList('airport', fleet), pickList('weather', fleet), pickList('mass_config', fleet), pickList('position', fleet), pickList('reset', fleet), pickList('atc_script', fleet),
      pickList('malfunction', fleet), pickList('inject', fleet), equivalencyGroups(fleet),
      query<{ code: string; name: string }>(`SELECT c.code, c.name FROM competencies c JOIN competency_frameworks f ON f.id = c.framework_id WHERE f.is_active AND c.is_active ORDER BY c.position, c."index"`),
    ]);
    const setupOptions = { airport, weather, mass_config, position, reset, atc_script } satisfies Record<(typeof SETUP_KINDS)[number], unknown>;
    return { setupOptions, malfunctions, injects, groups, competencies };
  })() : null;
  const target = node ? (node.content.type === 'section' ? node : node.parentKey ? program?.tree.byKey.get(node.parentKey) ?? null : null) : null;

  const base = `/templates/${template.id}`;
  const hrefFor = (key: string) => {
    const u = new URLSearchParams();
    if (wantedVersion) u.set('version', wantedVersion);
    if (libQ) u.set('lib', libQ);
    u.set('sel', key);
    if (key === sel && tabRaw) u.set('tab', tabRaw);
    return `${base}?${u.toString()}`;
  };
  const pathWith = (parts: Record<string, string | null>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(parts)) if (v) u.set(k, v); const s = u.toString(); return s ? `${base}?${s}` : base; };
  const currentPath = pathWith({ version: wantedVersion, sel, lib: libQ || null });
  const clearHref = pathWith({ version: wantedVersion, lib: libQ || null });

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
            <LibraryRail
              rows={library} q={libQ} templateId={template.id} versionId={program.version.id}
              targetKey={editable && target ? target.key : null} targetTitle={target?.title ?? null}
              canPlace={editable} canCreate={canLibrary} fleets={fleets.map((f) => ({ value: f.value, label: f.label }))}
              basePath={base} carry={{ version: wantedVersion ?? undefined, sel: sel ?? undefined }}
              currentPath={currentPath} highlight={libQ && KEY.test(libQ) ? libQ : null}
            />
            <section className="canvas" data-testid="program-outline" aria-label="Program">
              <div className="row" style={{ alignItems: 'baseline' }}>
                <h2 className="card-title" style={{ margin: 0 }}>Program</h2>
                <span className="spacer" />
                {sel ? <Link href={clearHref} className="xs">Clear selection</Link> : null}
              </div>
              <Outline tree={program.tree} phaseLabels={vocab.phases} selected={sel} hrefFor={hrefFor} />
            </section>
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
