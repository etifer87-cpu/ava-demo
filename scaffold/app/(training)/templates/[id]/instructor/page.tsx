import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { query } from '@/lib/db';
import { programVocab, ruleRegistry } from '@/lib/program';
import { budgetFor } from '@/lib/program/rules';
import { loadProgramScreen } from '@/lib/program/screens';
import { instructorProjection, subjectProjection } from '@/lib/program/projection';
import { formatMinutes } from '@/lib/program/shape';
import { brand, phaseColour, policy, signatureStatements } from '@/lib/config';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import BuilderTabs from '@/components/program/BuilderTabs';
import InstructorDemo, { type CompetencyDef } from '@/components/program/InstructorDemo';

/**
 * /templates/[id]/instructor - the program as the instructor will drive it, as a demo.
 *
 * The INSTRUCTOR projection of the real content, rendered by the same client component the
 * delivery screen will use, with an in-memory session behind it instead of a real one: the
 * manager grades, picks observable behaviours, chooses a malfunction from a grid, signs and
 * objects - and switches to the record to see what comes out. Nothing is written: there is no
 * write path on this screen at all, and a reload starts over. Gate: training.templates.view.
 *
 * Everything the demo needs that is not content comes from config or the framework tables: the
 * competency list with its observable behaviours (active framework), the outcome vocabulary and
 * the signature statements (policy.yaml), phase labels and colours (policy + brand), and the
 * device budget (rules.yaml).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function InstructorViewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.view');
  const { id } = await params;
  const sp = await searchParams;
  const { template, program, versionQuery } = await loadProgramScreen(id, typeof sp.version === 'string' ? sp.version : undefined);
  const vocab = programVocab();
  const b = brand();
  const view = program ? instructorProjection(program.tree, { runtime: null }) : null;
  const report = program ? subjectProjection(program.tree) : null;
  const bud = program ? budgetFor(program.tree, ruleRegistry()) : { inside: null, outside: null, excludedPhases: [] as readonly string[] };

  const obRows = await query<{ code: string; name: string; ob_code: string | null; ob_text: string | null }>(
    `SELECT c.code, c.name, ob.code AS ob_code, ob.text AS ob_text
       FROM competencies c
       JOIN competency_frameworks f ON f.id = c.framework_id AND f.is_active
       LEFT JOIN observable_behaviours ob ON ob.competency_id = c.id AND ob.is_active
      WHERE c.is_active
      ORDER BY c.position, c."index", ob.position, ob.code`,
  );
  const competencies: CompetencyDef[] = [];
  for (const r of obRows) {
    let c = competencies.find((x) => x.code === r.code);
    if (!c) { c = { code: r.code, name: r.name, obs: [] }; competencies.push(c); }
    if (r.ob_code && r.ob_text) (c.obs as { code: string; text: string }[]).push({ code: r.ob_code, text: r.ob_text });
  }

  const phaseCodes = [...vocab.phases.keys()];
  const phaseLabels = phaseCodes.map((code) => [code, vocab.phases.get(code) ?? code] as const);
  const phaseColours = phaseCodes.flatMap((code) => { const col = phaseColour(code, b); return col ? [[code, col] as const] : []; });
  const statements = signatureStatements(template.template_kind);
  const outcomes = policy().grading?.outcomes ?? [];

  return (
    <div className="stack builder-page" data-testid="instructor-view">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Programs', href: '/templates' }, { label: template.name, href: `/templates/${template.id}${versionQuery}` }, { label: 'As instructor' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{template.name}</h1>
        <span className="xs muted">as the instructor sees it</span>
        <span className="spacer" />
        <BuilderTabs templateId={template.id} active="instructor" versionQuery={versionQuery} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>Drive the session as the instructor will: grade, pick behaviours, choose from a grid, sign. Nothing here is recorded and no report is generated; it is a view of what the delivery screen will do.</p>

      {!view || !report || view.order.length === 0 ? (
        <div className="notice"><p style={{ margin: 0 }}>Nothing to show yet: the program has no exercises. Add sections and exercises in the builder.</p></div>
      ) : (
        <InstructorDemo
          programName={template.name}
          kindLabel={template.kind_label ?? b.product.short_name}
          instructorName={session.fullName ?? session.username}
          view={view}
          report={report}
          competencies={competencies}
          phaseLabels={phaseLabels}
          phaseColours={phaseColours}
          excludedPhases={bud.excludedPhases}
          insideMinutes={bud.inside === null ? null : formatMinutes(bud.inside)}
          outsideMinutes={bud.outside === null ? null : formatMinutes(bud.outside)}
          outcomes={outcomes}
          statements={{ assessor: statements.assessor, subject: statements.subject, subjectExtra: statements.subjectExtra }}
          objection={statements.objection}
          hiddenFromSubject={template.hide_record_from_subject}
        />
      )}
    </div>
  );
}
