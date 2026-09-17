import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, canOnPerson, can } from '@/lib/access';
import { query } from '@/lib/db';
import { brand, phaseColour, policy, signatureStatements } from '@/lib/config';
import { loadProgramVersion, programVocab, ruleRegistry } from '@/lib/program';
import { budgetFor } from '@/lib/program/rules';
import { instructorProjection, subjectProjection } from '@/lib/program/projection';
import { formatMinutes } from '@/lib/program/shape';
import { getSession } from '@/lib/sessions';
import {
  gradingGate, gradingPlan, gradingVocabulary, loadSubjectGrading, readCompetency, readTask, GradeRefused,
} from '@/lib/program/grading';
import { latestAttempts } from '@/lib/program/grade-tokens';
import { signatureState } from '@/lib/program/signing';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import InstructorDemo, {
  type AttemptState, type CompetencyDef, type CompGrade, type CompProposal, type ExerciseGrade, type LiveSession,
} from '@/components/program/InstructorDemo';

/**
 * /sessions/[id]/grade - the instructor's grading surface on a REAL session.
 *
 * The same component the builder's walk-through renders (components/program/InstructorDemo), given a
 * `live` prop instead of an empty memory: the projections come from the published version the session
 * was created against, and every grade the instructor clicks is written through
 * /api/sessions/[id]/grades as they click it.
 *
 * WHAT THIS PAGE DOES AND DOES NOT DECIDE. It renders. The rules are all one layer down, in
 * lib/program/grading.ts, and the surface reaches them only through the route: whether this caller
 * may grade at all, whether a signature has locked the session, which elements the program grades and
 * on what scale, and what the task evidence proposes for a competency. That is why the gate is called
 * here too - not to enforce anything, but so the page can 404 a session this instructor may not open
 * instead of rendering a surface whose every write would be refused.
 *
 * HYDRATION. Everything already stored is read server-side and handed to the component as `initial`,
 * so the first paint is the session as it stands. An instructor who reloads mid-session, or picks the
 * session up on another machine, sees their own work rather than an empty form that fills itself in.
 *
 * THE SIGNATURE STATE IS READ, NOT KEPT. `signatureState` recomputes the content hash on every
 * render and compares it with the one stored at the first signature, so "the content has changed
 * since it was signed" is something the page can say rather than something it has to trust. The
 * buttons live in the record view; the rules are in lib/program/signing.ts.
 *
 * Gate: training.sessions.grade (in the gate), plus people.view on the pilot.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f-]{36}$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = UUID.test(id) ? await getSession(id) : null;
  return { title: s ? `Grading · ${s.template_name}` : 'Grading' };
}

export default async function GradeSessionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.sessions.view');

  const s = await getSession(id);
  if (!s) notFound();

  // The gate decides whether this caller may grade. A refusal that is about WHO they are reads as
  // "not found" - a session an instructor may not grade is not theirs to know about - while a refusal
  // that is about the session's STATE is rendered, because they can see the session itself anyway.
  const gate = await gradingGate(id, access, session.personId ?? null).catch((err: unknown) => {
    if (err instanceof GradeRefused) notFound();
    throw err;
  });

  const sp = await searchParams;
  const wanted = typeof sp.person === 'string' ? sp.person : '';
  const subject = s.subjects.find((x) => x.person_id === wanted) ?? s.subjects[0] ?? null;
  if (!subject) notFound();
  if (!(await canOnPerson(access, 'people.view', subject.person_id))) notFound();

  // The version the session was created against - the frozen one, never the template's current one.
  const program = await loadProgramVersion(gate.templateVersionId);
  if (!program) {
    return (
      <div className="stack" data-testid="session-grade">
        <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Sessions', href: '/sessions' }, { label: s.template_name, href: `/sessions/${id}` }, { label: 'Grading' }]} />
        <div className="notice notice-bad"><p style={{ margin: 0 }}>The program version behind this session could not be loaded, so there is nothing to grade against.</p></div>
      </div>
    );
  }

  const view = instructorProjection(program.tree, { runtime: null });
  const report = subjectProjection(program.tree);
  const plan = await gradingPlan(gate.templateVersionId);
  const vocab = gradingVocabulary();
  const stored = await loadSubjectGrading(id, subject.person_id);

  /* ---- the stored rows, in the shape the surface holds them ---------------------------------- */
  const grades: Record<string, ExerciseGrade> = {};
  const sectionNotes: Record<string, string> = {};
  const attempts: Record<string, AttemptState> = {};
  const current = new Map(latestAttempts(stored.tasks).map((t) => [t.elementKey, t]));

  for (const [key, row] of current) {
    if (plan.sections.has(key) && !plan.tasks.has(key)) { sectionNotes[key] = row.remark ?? ''; continue; }
    const planned = plan.tasks.get(key);
    if (!planned) continue;
    grades[key] = {
      result: readTask(planned.mode, row.grade, vocab),
      comment: row.remark ?? '',
      role: row.seat === 'PF' || row.seat === 'PM' ? row.seat : null,
    };
    const earlier = stored.tasks.filter((t) => t.elementKey === key && t.attempt < row.attempt);
    if (row.attempt > 1 || earlier.length > 0) {
      attempts[key] = {
        attempt: row.attempt,
        previous: earlier.map((t) => ({ attempt: t.attempt, grade: t.grade })),
      };
    }
  }

  const comps: Record<string, CompGrade> = {};
  const proposals: Record<string, CompProposal> = {};
  for (const row of stored.competencies) {
    const mode = plan.competencyModes.get(row.code) ?? 'none';
    if (mode === 'none') continue;
    comps[row.code] = { grade: readCompetency(mode, row.grade, vocab), obs: row.obs };
    if (row.proposedGrade) proposals[row.code] = { grade: row.proposedGrade, n_scored: 0, mean: null, critical: false };
  }

  /* ---- everything that is not content comes from config and the framework ------------------- */
  const b = brand();
  const v = programVocab();
  const bud = budgetFor(program.tree, ruleRegistry());
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
  const phaseCodes = [...v.phases.keys()];
  const phaseLabels = phaseCodes.map((code) => [code, v.phases.get(code) ?? code] as const);
  const phaseColours = phaseCodes.flatMap((code) => { const col = phaseColour(code, b); return col ? [[code, col] as const] : []; });
  const statements = signatureStatements(s.template_kind);
  const sg = await signatureState(id, subject.person_id);

  const device = s.facility_kind === 'ffs' || s.facility_kind === 'ftd' ? s.facility : null;
  const live: LiveSession = {
    sessionId: id,
    personId: subject.person_id,
    subjectName: subject.full_name,
    subjectPosition: subject.position,
    sessionDate: s.session_date,
    facility: s.route ?? (device ? null : s.facility),
    device,
    locked: gate.locked,
    lockReason: gate.lockReason,
    signing: {
      storedHash: sg.storedHash,
      liveHash: sg.liveHash,
      matches: sg.matches,
      assessor: sg.assessor ? { at: sg.assessor.at, name: sg.assessor.name } : null,
      subject: sg.subject ? { at: sg.subject.at } : null,
      unsigned: sg.unsigned,
      objection: sg.objection,
      recordId: sg.recordId,
      canSign: can(access, 'training.sessions.sign'),
      canUnsign: can(access, 'training.sessions.unsign'),
      canFinalise: can(access, 'training.sessions.finalize'),
      status: sg.status,
      assessorMethod: sg.assessorMethod,
      subjectMethod: sg.subjectMethod,
    },
    initial: { startedAt: stored.startedAt, grades, comps, sectionNotes, attempts, proposals, outcome: stored.outcome ?? '', remarks: stored.remarks ?? '' },
  };

  return (
    <div className="stack builder-page" data-testid="session-grade">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Sessions', href: '/sessions' }, { label: `${s.template_name} · ${s.session_date}`, href: `/sessions/${id}` }, { label: 'Grading' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{s.template_name}</h1>
        <span className="xs muted">{s.kind_label} · v{s.version_no}</span>
        <span className="spacer" />
        {s.subjects.length > 1 ? (
          <span className="row" style={{ gap: 'var(--space-1)' }}>
            {/*
              A PLAIN <a>, NOT <Link>, AND THAT IS NOT AN OVERSIGHT.

              These tabs differ from one another ONLY by the `person` search parameter, and the
              App Router's client cache keys its entries by ROUTE, not by search parameters. With
              <Link> the second tab therefore reused the payload already rendered for the first:
              the header swapped to the other pilot's name while the grades, the per-pilot counter
              and the completeness list stayed those of the pilot just left. Both directions - a
              pilot graded 4/4 appeared under his crewmate's name, and switching back showed the
              crewmate's empty record under his. Nothing was ever written to the wrong record; the
              DATA was right and only the screen was stale, which is worse rather than better,
              because there is nothing on the page to say so and the next grade is entered against
              what the instructor can see.

              A crewed session is two records that must never be confused, so this navigation buys
              certainty with one round trip of the only page in the platform where a confusion
              between two people would be invisible. Do not "optimise" it back into a <Link>.
            */}
            {s.subjects.map((x) => (
              <a key={x.person_id} href={`/sessions/${id}/grade?person=${x.person_id}`}
                className={`button ${x.person_id === subject.person_id ? '' : 'button-quiet'} xs`} style={{ textDecoration: 'none' }}>
                {x.full_name} <span className="xs muted">{x.seat_role}</span>
              </a>
            ))}
          </span>
        ) : null}
        <Link href={`/sessions/${id}`} className="button button-quiet xs" style={{ textDecoration: 'none' }}>The session</Link>
      </div>

      {view.order.length === 0 ? (
        <div className="notice"><p style={{ margin: 0 }}>This program version has no exercises, so there is nothing to grade.</p></div>
      ) : (
        <InstructorDemo
          programName={s.template_name}
          kindLabel={s.kind_label}
          instructorName={s.assessor_name ?? session.fullName ?? session.username}
          view={view}
          report={report}
          competencies={competencies}
          phaseLabels={phaseLabels}
          phaseColours={phaseColours}
          excludedPhases={bud.excludedPhases}
          insideMinutes={bud.inside === null ? null : formatMinutes(bud.inside)}
          outsideMinutes={bud.outside === null ? null : formatMinutes(bud.outside)}
          outcomes={policy().grading?.outcomes ?? []}
          statements={{ assessor: statements.assessor, subject: statements.subject, subjectExtra: statements.subjectExtra }}
          objection={statements.objection}
          hiddenFromSubject={sg.hiddenFromSubject}
          live={live}
        />
      )}
    </div>
  );
}
