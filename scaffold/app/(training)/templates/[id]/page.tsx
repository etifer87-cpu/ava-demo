import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { loadProgramVersion, programVocab } from '@/lib/program';
import { hasBlockers } from '@/lib/program/rules';
import { formatMinutes } from '@/lib/program/shape';
import { totalPlannedMinutes } from '@/lib/program/model';
import { readFlash } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import Outline from '@/components/program/Outline';

/**
 * /templates/[id] - one program, its current version. docs/06_PROGRAM_BUILDER.md section 5.2.
 *
 * This slice renders the READ side of the builder: identity, the version and its status, the
 * time budget against the declared period, the findings bar, the outline. The library rail, the
 * inspector and the write path arrive in the next steps and wrap around this page rather than
 * replacing it. Gate: training.templates.view.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TemplateRow { id: string; code: string; name: string; template_kind: string; kind_label: string; asset_class: string | null; current_version_id: string | null; is_active: boolean }

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = /^[0-9a-f-]{36}$/i.test(id) ? (await query<{ name: string }>(`SELECT name FROM session_templates WHERE id = $1::uuid AND deleted_at IS NULL`, [id]))[0] : undefined;
  return { title: t?.name ?? 'Program' };
}

export default async function ProgramPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.view');

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const wantedVersion = typeof sp.version === 'string' && /^[0-9a-f-]{36}$/i.test(sp.version) ? sp.version : null;

  const [template, flash] = await Promise.all([
    query<TemplateRow>(`
      SELECT t.id, t.code, t.name, t.template_kind, COALESCE(k.label, t.template_kind) AS kind_label, ac.code AS asset_class, t.current_version_id, t.is_active
        FROM session_templates t LEFT JOIN template_kinds k ON k.code = t.template_kind LEFT JOIN asset_classes ac ON ac.id = t.asset_class_id
       WHERE t.id = $1::uuid AND t.deleted_at IS NULL`, [id]).then((r) => r[0] ?? null),
    readFlash(),
  ]);
  if (!template) notFound();

  const versionId = wantedVersion ?? template.current_version_id;
  const program = versionId ? await loadProgramVersion(versionId) : null;
  if (program && program.version.template_id !== template.id) notFound();

  const versions = await query<{ id: string; version: number; status: string }>(
    `SELECT id, version, status FROM session_template_versions WHERE template_id = $1::uuid AND deleted_at IS NULL ORDER BY version DESC`, [id]);
  const vocab = programVocab();
  const planned = program ? totalPlannedMinutes(program.tree) : null;
  const period = program?.tree.setup.period_minutes ?? null;
  const blockers = program ? hasBlockers(program.findings) : false;
  const canConfigure = can(access, 'training.templates.configure');

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
        {versions.length > 1 ? <> · versions: {versions.map((v, i) => <span key={v.id}>{i ? ', ' : ''}<Link href={`/templates/${template.id}?version=${v.id}`}>v{v.version} {v.status}</Link></span>)}</> : null}
      </p>

      {flash ? <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : flash.kind === 'warn' ? ' notice-warn' : ''}`} role="status"><p style={{ margin: 0 }}>{flash.message}</p></div> : null}

      {!program ? (
        <Card title="No version"><p className="muted small" style={{ margin: 0 }}>This program has no version to open. A program is created with its version 1; this row predates that rule.</p></Card>
      ) : (
        <>
          <div className="grid grid-kpi" data-testid="program-budget">
            <div className="stat"><div className="stat-value">{planned === null ? '-' : formatMinutes(planned)}</div><div className="stat-label">Planned</div><div className="xs muted">{period === null ? 'no period declared' : `of ${formatMinutes(period)}${planned !== null ? ` · ${planned <= period ? `${formatMinutes(period - planned)} free` : `${formatMinutes(planned - period)} over`}` : ''}`}</div></div>
            <div className="stat"><div className="stat-value">{program.tree.roots.length}</div><div className="stat-label">Sections</div><div className="xs muted">at the top level</div></div>
            <div className="stat"><div className="stat-value">{[...program.tree.byKey.values()].filter((n) => n.content.type === 'task').length}</div><div className="stat-label">Tasks</div><div className="xs muted">{[...program.tree.byKey.values()].filter((n) => n.content.type === 'task' && (n.content.task.grading.task_outcome_mode !== 'none' || n.content.task.grading.competency_grade_mode !== 'none')).length} graded</div></div>
            <div className="stat"><div className="stat-value">{program.findings.length}</div><div className="stat-label">Findings</div><div className="xs muted">{blockers ? 'blockers present - cannot publish' : program.findings.length ? 'warnings only' : 'nothing to resolve'}</div></div>
          </div>

          <Card title="Program" note={canConfigure && program.version.status === 'draft' ? 'The outline of this draft. Editing arrives with the library rail and the inspector.' : 'Read-only: a published version is immutable, and a new edition is a clone to draft.'} testId="program-outline">
            <Outline tree={program.tree} phaseLabels={vocab.phases} />
          </Card>

          {program.problems.length ? (
            <Card title="Content problems" note="Fields that did not parse. The element still renders with the field dropped; fix the field and the line goes away." testId="program-problems">
              <ul className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {program.problems.map((p, i) => <li key={i}><span className="mono">{p.elementKey ?? 'setup'}{p.path ? `.${p.path}` : ''}</span> - {p.message}</li>)}
              </ul>
            </Card>
          ) : null}

          <Card title="Findings" note="Blockers stop a publish; warnings are shown and allowed. Each names what it cites." testId="program-findings">
            {program.findings.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nothing to resolve.</p> : (
              <ul className="findings">
                {program.findings.map((f, i) => (
                  <li key={i} className={`finding finding-${f.severity}`} data-rule={f.rule}>
                    <Chip tone={f.severity === 'block' ? 'bad' : 'warn'}>{f.severity === 'block' ? 'Blocker' : 'Warning'}</Chip>
                    <span className="finding-text">{f.message}{f.detail ? <span className="muted"> · {f.detail}</span> : null}{f.at ? <span className="mono xs muted"> · {f.at}</span> : null}</span>
                    {f.source ? <span className="xs muted finding-source">{f.source}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
