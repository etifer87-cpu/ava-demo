'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { InstructorView, InstructorStep, ReportModel } from '@/lib/program/projection';
import type { Grading } from '@/lib/program/shape';
import GradeChip from '@/components/ui/GradeChip';

/**
 * InstructorDemo - the instructor's session and the record. ONE surface, two modes.
 *
 * Without `live` it is the builder's walk-through: everything is in memory, nothing is written, and
 * a reload starts over. A manager drives the program they just built exactly as the instructor will.
 *
 * With `live` it IS the grading surface of a real session. Every change is written as it is made
 * through /api/sessions/[id]/grades - a grade on the click, a remark when the typing stops - so
 * there is no Save button to miss and nothing to lose by closing a laptop mid-session. The surface
 * never unmounts to save: it keeps its state, shows what was written and when, and says so when a
 * write is refused. Two modes rather than two components, because a second component would be the
 * one that drifts.
 *
 * COMPETENCY GRADES ARE PER SESSION, NOT PER EXERCISE. `competency_grades` is unique on
 * (session, person, competency) - migration 0027 - because a competency is assessed across the whole
 * session and the record carries one grade for it. So the grade for CMN is the same wherever CMN
 * appears, in both modes: grading it under the second exercise that targets it revises the grade,
 * it does not add a second one. The demo behaves identically for the same reason it renders the same
 * projections - so that what the manager drives is what the instructor will get.
 */

export interface CompetencyDef { readonly code: string; readonly name: string; readonly obs: readonly { readonly code: string; readonly text: string }[] }

export interface InstructorDemoProps {
  readonly programName: string;
  readonly kindLabel: string;
  readonly instructorName: string;
  readonly view: InstructorView;
  readonly report: ReportModel;
  readonly competencies: readonly CompetencyDef[];
  readonly phaseLabels: readonly (readonly [string, string])[];
  readonly phaseColours: readonly (readonly [string, string])[];
  readonly excludedPhases: readonly string[];
  readonly insideMinutes: string | null;
  readonly outsideMinutes: string | null;
  readonly outcomes: readonly string[];
  readonly statements: { readonly assessor: string; readonly subject: string; readonly subjectExtra: string | null };
  readonly objection: { readonly allowed: boolean; readonly label: string; readonly prompt: string; readonly marksRecord: string; readonly notifiesRole: string };
  /** An internal record (screening, assessment): the trainee never sees it, so only the assessor signs. */
  readonly hiddenFromSubject: boolean;
  /** Present on a real session: every change is written. Absent: the in-memory walk-through. */
  readonly live?: LiveSession;
}

export type CompGrade = { grade: number | 'competent' | 'not_competent' | 'not_observed' | null; obs: string[] };
export type ExerciseGrade = { result: number | 'pass' | 'fail' | null; comment: string; role: 'PF' | 'PM' | null };

/** What the server proposed for one competency, and the evidence it read. Rendered beside the grade. */
export interface CompProposal { readonly grade: string | null; readonly n_scored: number; readonly mean: number | null; readonly critical: boolean }

/** One task's attempt state: which attempt is being graded, and what the earlier ones were given. */
export interface AttemptState { readonly attempt: number; readonly previous: readonly { readonly attempt: number; readonly grade: string | null }[] }

/**
 * A real session behind the surface. `initial` is what is already stored, hydrated server-side so the
 * first paint is the session as it stands rather than an empty form that fills in afterwards.
 */
export interface LiveSession {
  readonly sessionId: string;
  readonly personId: string;
  readonly subjectName: string;
  readonly subjectPosition: string | null;
  readonly sessionDate: string;
  readonly facility: string | null;
  readonly device: string | null;
  /** Locked by a signature or by the session being finalised. The server decides; this only renders it. */
  readonly locked: boolean;
  readonly lockReason: string | null;
  /** Where the signatures stand, and what they attest to. Computed server-side on every render. */
  readonly signing: {
    readonly storedHash: string | null;
    readonly liveHash: string;
    /** False when the content has moved since it was signed. The reason the hash exists. */
    readonly matches: boolean;
    readonly assessor: { readonly at: string; readonly name: string | null } | null;
    readonly subject: { readonly at: string } | null;
    readonly objection: { readonly at: string; readonly reason: string | null } | null;
    readonly unsigned: { readonly at: string; readonly by: string | null; readonly reason: string | null } | null;
    readonly recordId: string | null;
    readonly canSign: boolean;
    readonly canUnsign: boolean;
    readonly canFinalise: boolean;
    readonly status: string;
    /** What each party is asked for. `employee_id` only where that person has no account at all. */
    readonly assessorMethod: 'password' | 'employee_id';
    readonly subjectMethod: 'password' | 'employee_id';
  };
  readonly initial: {
    /** When the session clock was started, ISO. Null until the instructor starts it. */
    readonly startedAt: string | null;
    readonly grades: Record<string, ExerciseGrade>;
    readonly comps: Record<string, CompGrade>;
    readonly sectionNotes: Record<string, string>;
    readonly attempts: Record<string, AttemptState>;
    readonly proposals: Record<string, CompProposal>;
    readonly outcome: string;
    readonly remarks: string;
  };
}

const AUTO: Record<string, string> = { required_on: 'REQUIRED ON', required_off: 'REQUIRED OFF', crew_discretion: 'CREW DISCRETION', not_applicable: 'N/A' };
const fmt = (m: number | null) => (m === null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
const isGraded = (g: Grading) => g.task_outcome_mode !== 'none' || g.competency_grade_mode !== 'none';

/* ------------------------------------------------------------------ the write path */

type SavePhase = 'idle' | 'saving' | 'saved' | 'error';
interface SaveState { readonly phase: SavePhase; readonly at: string | null; readonly message: string | null }
interface GradeBody { readonly kind: 'task' | 'attempt' | 'competency' | 'session'; readonly [key: string]: unknown }

/**
 * One click, one write - and the order of the writes preserved.
 *
 * `post` chains its requests rather than firing them in parallel: two grades clicked a moment apart
 * are two rows and could not collide, but a grade and its correction ARE one row, and a network that
 * delivers them out of order would store the wrong one. The chain costs nothing at this rate and
 * removes the whole class of problem.
 *
 * `postSoon` is for text. A remark is debounced by `delay` so that typing is not one request per
 * keystroke, and every debounced write is flushed - by `flush` before a view change, and by the
 * browser hiding the page - because a remark the instructor typed and never saw saved is worse than
 * no remark at all. `keepalive` lets the last flush outlive the page.
 */
function usePersistence(live: LiveSession | undefined) {
  const [save, setSave] = useState<SaveState>({ phase: 'idle', at: null, message: null });
  const chain = useRef<Promise<Record<string, unknown> | null>>(Promise.resolve(null));
  const pending = useRef(new Map<string, { body: GradeBody; timer: ReturnType<typeof setTimeout> }>());

  const post = useCallback((body: GradeBody): Promise<Record<string, unknown> | null> => {
    if (!live) return Promise.resolve(null);
    setSave((s) => ({ ...s, phase: 'saving' }));
    const run = chain.current.then(async () => {
      try {
        const res = await fetch(`/api/sessions/${live.sessionId}/grades`, {
          method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, person_id: live.personId }),
        });
        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!res.ok || json?.ok !== true) {
          setSave({ phase: 'error', at: null, message: typeof json?.message === 'string' ? json.message : 'That change was not saved.' });
          return null;
        }
        setSave({ phase: 'saved', at: new Date().toTimeString().slice(0, 5), message: null });
        return json;
      } catch {
        setSave({ phase: 'error', at: null, message: 'That change could not be sent. Nothing was lost here - try again.' });
        return null;
      }
    });
    chain.current = run;
    return run;
  }, [live]);

  const postSoon = useCallback((key: string, body: GradeBody, delay = 800) => {
    if (!live) return;
    const existing = pending.current.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => { pending.current.delete(key); void post(body); }, delay);
    pending.current.set(key, { body, timer });
    setSave((s) => ({ ...s, phase: 'saving' }));
  }, [live, post]);

  const flush = useCallback(() => {
    const items = [...pending.current.values()];
    pending.current.clear();
    for (const item of items) { clearTimeout(item.timer); void post(item.body); }
  }, [post]);

  useEffect(() => {
    if (!live) return undefined;
    const onLeave = () => flush();
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', onLeave);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [live, flush]);

  return { save, post, postSoon, flush };
}

/** What is saved, and when. The only place the surface talks about writing at all. */
function SaveLine({ live, save }: { live: LiveSession; save: SaveState }) {
  const tone = save.phase === 'error' ? ' notice-bad' : live.locked ? ' notice-warn' : '';
  return (
    <div className={`notice${tone}`} role="status" data-testid="save-line" style={tone === '' ? { borderLeftColor: 'var(--state-good)' } : undefined}>
      <p style={{ margin: 0 }} className="small">
        {live.locked ? <><strong>Locked.</strong> {live.lockReason}</>
          : save.phase === 'error' ? <><strong>Not saved.</strong> {save.message}</>
          : save.phase === 'saving' ? <>Saving&hellip;</>
          : save.phase === 'saved' ? <><strong>Saved.</strong> Every grade and remark is written as you make it; last write {save.at}.</>
          : <><strong>{live.subjectName}</strong>{live.subjectPosition ? ` · ${live.subjectPosition}` : ''} · {live.sessionDate}{live.device ? ` · ${live.device}` : ''}. Grades are written as you make them - there is nothing to save by hand.</>}
      </p>
    </div>
  );
}

export function InstructorDemo(p: InstructorDemoProps) {
  const live = p.live;
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<'session' | 'report'>('session');
  const [grades, setGrades] = useState<Record<string, ExerciseGrade>>(() => live?.initial.grades ?? {});
  // Session-level, not per exercise: see the note at the top of this file.
  const [compGrades, setCompGrades] = useState<Record<string, CompGrade>>(() => live?.initial.comps ?? {});
  const [proposals, setProposals] = useState<Record<string, CompProposal>>(() => live?.initial.proposals ?? {});
  const [attempts, setAttempts] = useState<Record<string, AttemptState>>(() => live?.initial.attempts ?? {});
  const [startedAt, setStartedAt] = useState<string | null>(live?.initial.startedAt ?? null);
  const [outcome, setOutcome] = useState<string>(live?.initial.outcome ?? '');
  const [remarks, setRemarks] = useState(live?.initial.remarks ?? '');
  const [sectionNotes, setSectionNotes] = useState<Record<string, string>>(() => live?.initial.sectionNotes ?? {});
  const [additional, setAdditional] = useState(false);
  const [signed, setSigned] = useState<{ instructor: string | null; subject: string | null }>({ instructor: null, subject: null });
  const [objection, setObjection] = useState<{ reason: string; by: string; at: string } | null>(null);
  const { save, post, postSoon, flush } = usePersistence(live);

  const phaseLabel = useMemo(() => new Map(p.phaseLabels), [p.phaseLabels]);
  const phaseColour = useMemo(() => new Map(p.phaseColours), [p.phaseColours]);
  const comps = useMemo(() => new Map(p.competencies.map((c) => [c.code, c])), [p.competencies]);
  const steps = p.view.sections.flatMap((s) => s.steps.map((st) => ({ st, section: s })));
  const current = steps[idx] ?? null;
  const gradeOf = (key: string): ExerciseGrade => grades[key] ?? { result: null, comment: '', role: null };
  const compOf = (code: string): CompGrade => compGrades[code] ?? { grade: null, obs: [] };
  const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  // In a live session the LOCK is the server's, not this component's: a signature is a write, and
  // step 31 is what makes one. In the demo, signing locks the page because there is nowhere else for
  // the rule to live.
  const locked = live ? live.locked : signed.instructor !== null || signed.subject !== null || objection !== null;
  const gradedSteps = steps.filter(({ st }) => st.kind === 'exercise' && isGraded(st.grading));
  const done = gradedSteps.filter(({ st }) => { const g = gradeOf(st.key); return st.kind === 'exercise' && ((st.grading.task_outcome_mode !== 'none' && g.result !== null) || (st.grading.competency_grade_mode !== 'none' && st.grading.competencies.every((c) => compOf(c).grade))); }).length;

  /* Every change below writes immediately in live mode and is a no-op in the demo. The local state
     is set first so the surface answers the click at once; a refused write says so on the save line
     and the instructor can click again. Nothing is queued behind a Save button. */
  const onResult = (key: string, result: ExerciseGrade['result']) => {
    setGrades((g) => ({ ...g, [key]: { ...(g[key] ?? { result: null, comment: '', role: null }), result } }));
    void post({ kind: 'task', element_key: key, value: result });
  };
  const onSeat = (key: string, role: 'PF' | 'PM' | null) => {
    setGrades((g) => ({ ...g, [key]: { ...(g[key] ?? { result: null, comment: '', role: null }), role } }));
    void post({ kind: 'task', element_key: key, seat: role });
  };
  const onComment = (key: string, comment: string) => {
    setGrades((g) => ({ ...g, [key]: { ...(g[key] ?? { result: null, comment: '', role: null }), comment } }));
    postSoon(`task:${key}`, { kind: 'task', element_key: key, remark: comment });
  };
  const onSectionNote = (sectionKey: string, note: string) => {
    setSectionNotes((n) => ({ ...n, [sectionKey]: note }));
    postSoon(`note:${sectionKey}`, { kind: 'task', element_key: sectionKey, remark: note });
  };
  const onComp = (code: string, patch: Partial<CompGrade>) => {
    const next: CompGrade = { ...compOf(code), ...patch };
    setCompGrades((c) => ({ ...c, [code]: next }));
    void post({ kind: 'competency', code, value: next.grade, obs: next.obs }).then((json) => {
      if (!json) return;
      const basis = (json.basis ?? {}) as { n_scored?: number; mean?: number | null; critical?: boolean };
      setProposals((ps) => ({ ...ps, [code]: {
        grade: typeof json.proposed === 'string' ? json.proposed : null,
        n_scored: basis.n_scored ?? 0, mean: basis.mean ?? null, critical: basis.critical === true,
      } }));
    });
  };
  /* The outcome is the one field the server can REFUSE on its merits rather than on its spelling:
     the operator's standard (lib/program/outcome-standard.ts) rejects a passing outcome over a set
     of grades that may not carry one. So this is the one field that must put itself back when the
     write is refused - otherwise the select shows PASS, the save line says it was not saved, and
     the surface disagrees with the record. The refusal text is the server's and reaches the save
     line on its own; it names the count and the threshold, so nothing is repeated here. */
  const onOutcome = (value: string) => {
    const was = outcome;
    setOutcome(value);
    void post({ kind: 'session', outcome: value }).then((json) => { if (!json) setOutcome(was); });
  };
  const onRemarks = (value: string) => { setRemarks(value); postSoon('remarks', { kind: 'session', remarks: value }); };
  /* A repeat is a NEW ATTEMPT, never an edit: the first grade stays where it is and the surface shows
     it as history. The attempt number comes back from the server, which is the only thing that knows
     how many rows there already are. */
  const onRepeat = async (key: string) => {
    const was = gradeOf(key).result;
    const json = await post({ kind: 'attempt', element_key: key });
    const next = typeof json?.attempt === 'number' ? json.attempt : (attempts[key]?.attempt ?? 1) + 1;
    setAttempts((a) => ({ ...a, [key]: {
      attempt: next,
      previous: [...(a[key]?.previous ?? []), { attempt: a[key]?.attempt ?? 1, grade: was === null ? null : String(was).toUpperCase() }],
    } }));
    setGrades((g) => ({ ...g, [key]: { ...(g[key] ?? { result: null, comment: '', role: null }), result: null, comment: '' } }));
  };
  const onStart = (iso: string | null) => { setStartedAt(iso); void post({ kind: 'session', started_at: iso }); };

  /* Competencies more than one exercise targets. There is ONE grade for each of them (the record
     carries one), so the panel appears under every exercise that targets it and says so - a grade
     that follows you from exercise to exercise is confusing exactly until it is labelled. */
  const sharedComps = useMemo(() => {
    const count = new Map<string, number>();
    for (const { st } of steps) {
      if (st.kind !== 'exercise' || st.grading.competency_grade_mode === 'none') continue;
      for (const c of st.grading.competencies) count.set(c, (count.get(c) ?? 0) + 1);
    }
    return new Set([...count.entries()].filter(([, n]) => n > 1).map(([c]) => c));
  }, [steps]);

  /**
   * WHAT IS NOT GRADED YET, in the order the instructor will find it. A session goes to review when
   * it is complete, not before: an ETR with a hole in it is the thing a record must never be, and the
   * hole is far cheaper to close now, in the room, than after a signature. A competency appears once
   * however many exercises target it, because there is one grade for it.
   */
  const missing = useMemo(() => {
    const out: { key: string; label: string; what: string; index: number }[] = [];
    const seen = new Set<string>();
    steps.forEach(({ st }, i) => {
      if (st.kind !== 'exercise') return;
      const g = st.grading;
      if (g.task_outcome_mode !== 'none' && (grades[st.key]?.result ?? null) === null) {
        out.push({ key: `task:${st.key}`, label: st.title, what: 'no grade', index: i });
      }
      if (g.competency_grade_mode !== 'none') {
        for (const code of g.competencies) {
          if (seen.has(code)) continue;
          seen.add(code);
          if (!(compGrades[code]?.grade ?? null)) out.push({ key: `comp:${code}`, label: code, what: 'competency not graded', index: i });
        }
      }
    });
    return out;
  }, [steps, grades, compGrades]);
  // The rule binds a real session. The builder's walk-through is not a session: a manager looking at
  // the record of a program they have half-graded is the whole point of the preview, so there it warns.
  const blocked = live !== undefined && missing.length > 0;
  const goTo = (i: number) => { flush(); setMode('session'); setIdx(i); };
  const showRecord = () => { if (blocked) return; flush(); setMode('report'); };

  return (
    <div className="stack" data-testid="instructor-demo">
      {live ? <SaveLine live={live} save={save} />
        : <div className="notice" style={{ borderLeftColor: 'var(--state-info)' }}><p style={{ margin: 0 }}><strong>Demo.</strong> Grade, pick behaviours, sign and object exactly as in a session. Nothing here is recorded; reload the page and it is gone.</p></div>}
      <div className="row">
        <button type="button" className={`button ${mode === 'session' ? '' : 'button-quiet'}`} onClick={() => setMode('session')}>Session</button>
        <button type="button" className={`button ${mode === 'report' ? '' : 'button-quiet'}`} onClick={showRecord} disabled={blocked}
          title={blocked ? `${missing.length} ${missing.length === 1 ? 'grade is' : 'grades are'} still missing` : undefined}>Record{gradedSteps.length ? <span className="xs muted"> · {done}/{gradedSteps.length} graded</span> : null}</button>
        <span className="spacer" />
        <Chrono startedAt={startedAt} onStart={onStart} locked={locked} stepKey={current?.st.key ?? null} />
        <span className="mono xs muted">device {p.insideMinutes ?? '-'}{p.outsideMinutes ? ` + ${p.outsideMinutes} outside` : ''}</span>
      </div>

      {missing.length > 0 && (mode === 'report' || blocked || live !== undefined) ? (
        <div className={`notice${blocked ? ' notice-warn' : ''}`} data-testid="missing-grades">
          <p style={{ margin: 0 }} className="small">
            <strong>{missing.length} still to grade.</strong>{' '}
            {blocked ? 'Review and sign opens when the session is complete.' : 'The record below is incomplete.'}
          </p>
          <div className="row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
            {missing.slice(0, 12).map((m) => (
              <button key={m.key} type="button" className="button button-quiet xs" onClick={() => goTo(m.index)} title={m.what}>
                <span className="mono">{m.label}</span> <span className="xs muted">{m.what}</span>
              </button>
            ))}
            {missing.length > 12 ? <span className="xs muted">and {missing.length - 12} more</span> : null}
          </div>
        </div>
      ) : null}

      {mode === 'session' ? (
        <div className="instructor-layout">
          <aside className="rail" aria-label="Navigate the session" data-testid="instructor-rail">
            <h2 className="card-title" style={{ margin: 0 }}>Session</h2>
            {p.view.sections.map((s) => (
              <div key={s.key} className="nav-section" style={phaseColour.get(s.phase ?? '') ? { borderLeftColor: phaseColour.get(s.phase ?? '') } : undefined}>
                <div className="row" style={{ alignItems: 'baseline', gap: 'var(--space-2)' }}>
                  <span className="nav-section-title">{s.title}</span>
                  {s.phase ? <span className="xs muted">{phaseLabel.get(s.phase) ?? s.phase}</span> : null}
                  <span className="spacer" />
                  <span className="mono xs">{fmt(s.minutes)}{s.phase && p.excludedPhases.includes(s.phase) ? <span className="muted" title="Outside the device period"> ·</span> : null}</span>
                </div>
                <ol className="nav-steps">
                  {s.steps.map((st) => { const i = steps.findIndex((x) => x.st.key === st.key); const g = gradeOf(st.key); const has = st.kind === 'exercise' && isGraded(st.grading); const complete = has && st.kind === 'exercise' && ((st.grading.task_outcome_mode !== 'none' && g.result !== null) || (st.grading.competency_grade_mode !== 'none' && st.grading.competencies.length > 0 && st.grading.competencies.every((c) => compOf(c).grade)));
                    return (
                      <li key={st.key}><button type="button" className={`nav-step${i === idx ? ' is-current' : ''}`} onClick={() => setIdx(i)} aria-current={i === idx ? 'step' : undefined} style={{ width: '100%', background: i === idx ? undefined : 'none', border: 0, cursor: 'pointer', font: 'inherit' }}>
                        <span className={`nav-dot nav-dot-${st.kind}`} aria-hidden="true" /><span className="nav-step-title">{st.title}</span>{has ? <span className="xs" style={{ color: complete ? 'var(--state-good)' : 'var(--ink-muted)' }}>{complete ? '✓' : '●'}</span> : null}
                      </button></li>
                    ); })}
                </ol>
              </div>
            ))}
          </aside>

          <section className="canvas" aria-label="Current step" data-testid="instructor-step">
            {current ? (
              <>
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <span className="xs muted" style={{ letterSpacing: '0.04em' }}>{current.section.title.toUpperCase()} · STEP {idx + 1} OF {steps.length}</span>
                  <span className="spacer" />
                  <span className="mono xs muted">{startedAt ? 'clock running · see the top of the page' : 'clock not started'}</span>
                </div>
                <StepBody
                  step={current.st} section={current.section} comps={comps} locked={locked}
                  grade={gradeOf(current.st.key)} compOf={compOf} proposals={proposals} sharedComps={sharedComps}
                  attempt={attempts[current.st.key] ?? null} canRepeat={live !== undefined}
                  onResult={(v) => onResult(current.st.key, v)} onSeat={(v) => onSeat(current.st.key, v)}
                  onComment={(v) => onComment(current.st.key, v)} onComp={onComp}
                  onRepeat={() => { void onRepeat(current.st.key); }}
                />
                {current.section.trainingOnly ? (
                  <div className="grade-panel" style={{ marginTop: 'var(--space-3)' }} data-testid="section-comment">
                    <div className="xs muted" style={{ letterSpacing: '0.04em' }}>{current.section.title.toUpperCase()} · INSTRUCTOR COMMENTS{locked ? ' · locked by a signature' : ''}</div>
                    <p className="xs muted" style={{ margin: '4px 0 0' }}>Not graded. What was trained, what was repeated and why; this goes on the record as text.</p>
                    <div className="field" style={{ marginTop: 'var(--space-2)' }}><textarea rows={4} value={sectionNotes[current.section.key] ?? ''} onChange={(e) => onSectionNote(current.section.key, e.target.value)} disabled={locked} placeholder="Items trained and observations." /></div>
                  </div>
                ) : null}
                <div className="row" style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="button button-quiet" onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0}>Previous</button>
                  <span className="spacer" />
                  {idx < steps.length - 1 ? <button type="button" className="button" onClick={() => { flush(); setIdx(idx + 1); }}>Next step</button> : <button type="button" className="button" onClick={showRecord} disabled={blocked} title={blocked ? `${missing.length} ${missing.length === 1 ? 'grade is' : 'grades are'} still missing` : undefined}>Review and sign</button>}
                </div>
              </>
            ) : <p className="muted small">Nothing to show: the program has no steps.</p>}
          </section>
        </div>
      ) : (
        <Record p={p} grades={grades} compGrades={compGrades} sectionNotes={sectionNotes} steps={steps} outcome={outcome} setOutcome={onOutcome} remarks={remarks} setRemarks={onRemarks} additional={additional} setAdditional={setAdditional} signed={signed} setSigned={setSigned} objection={objection} setObjection={setObjection} now={now} locked={locked} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A row of grade buttons.
 *
 * CLICKING THE GRADE AGAIN CLEARS IT. A mis-click is otherwise unfixable on a surface where a grade
 * is written the moment it is pressed: there is no Cancel, so the button that set it has to be the
 * button that unsets it. Clearing writes NULL, which is "not graded yet" - never a zero.
 *
 * `tone="grade"` paints each numeral in its own colour from brand.yaml's grade_palette, through the
 * --grade-N variables lib/config.ts emits. The numeral is always shown as well: brand.yaml states
 * that a grade is never encoded by colour alone, on screen or in a report.
 */
function GradeButtons<T extends number | string>({ values, value, onPick, labels, disabled, tone }: { values: readonly T[]; value: T | null; onPick: (v: T | null) => void; labels?: Record<string, string>; disabled: boolean; tone?: 'grade' }) {
  return <div className="row" style={{ gap: 'var(--space-1)' }}>{values.map((v) => {
    const on = value === v;
    const colour = tone === 'grade' && typeof v === 'number' ? `var(--grade-${v})` : null;
    const style = colour
      ? on ? { background: colour, borderColor: colour, color: 'var(--brand-primary-ink)' } : { color: colour, borderColor: colour }
      : undefined;
    return (
      <button key={String(v)} type="button" className={`button ${on ? '' : 'button-quiet'} xs`} style={style}
        onClick={() => onPick(on ? null : v)} disabled={disabled} aria-pressed={on}
        title={on ? 'Click again to clear it' : undefined}>{labels?.[String(v)] ?? String(v)}</button>
    );
  })}</div>;
}

/** Elapsed seconds as h:mm:ss. Hours are shown from zero: a session is read against its plan. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The session chrono.
 *
 * An instructor times a session against the plan, and the one number they need is how long it has
 * been running - not how long this page has been open. So the START TIME is the state, it is
 * adjustable (the surface is opened after the briefing as often as before it), and in a live session
 * it is stored with the session, so a reload or a second machine picks up the same clock rather than
 * starting a new one. The step timer beside it is deliberately NOT stored: it answers "how long have
 * I been on this exercise", which is a question about now.
 */
function Chrono({ startedAt, onStart, locked, stepKey }: { startedAt: string | null; onStart: (iso: string | null) => void; locked: boolean; stepKey: string | null }) {
  // A CLOCK CANNOT BE SERVER-RENDERED. The server renders one second and the browser hydrates in the
  // next, so React finds 1:25:55 where it expected 1:25:56 and throws the whole subtree away. So the
  // elapsed figures render only AFTER mount, and the server sends a placeholder of the same shape.
  // Everything that is deterministic - the start time itself, which comes from the session - renders
  // on the server as usual.
  const [now, setNow] = useState<number | null>(null);
  const [stepFrom, setStepFrom] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    setStepFrom(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setStepFrom(Date.now()); }, [stepKey]);

  const started = startedAt ? Date.parse(startedAt) : NaN;
  const running = Number.isFinite(started);
  const hhmm = running ? new Date(started).toTimeString().slice(0, 5) : '';
  const blank = '--:--:--';

  const adjust = (value: string) => {
    const [h, m] = value.split(':').map((x) => Number(x));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const base = running ? new Date(started) : new Date();
    base.setHours(h as number, m as number, 0, 0);
    onStart(base.toISOString());
  };

  return (
    <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }} data-testid="chrono">
      {running ? (
        <>
          <span className="mono" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} title="Since the start time">{now === null ? blank : clock((now - started) / 1000)}</span>
          <span className="xs muted">step {now === null || stepFrom === null ? blank : clock((now - stepFrom) / 1000)}</span>
          <label className="xs muted" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            started
            <input type="time" value={hhmm} onChange={(e) => adjust(e.target.value)} disabled={locked} className="mono" style={{ font: 'inherit', padding: '0 2px' }} aria-label="Session start time" />
          </label>
        </>
      ) : (
        <button type="button" className="button button-quiet xs" onClick={() => onStart(new Date().toISOString())} disabled={locked}>Start the clock</button>
      )}
    </span>
  );
}

interface StepBodyProps {
  step: InstructorStep;
  section: { title: string; trainingOnly: boolean };
  comps: Map<string, CompetencyDef>;
  locked: boolean;
  grade: ExerciseGrade;
  compOf: (code: string) => CompGrade;
  proposals: Record<string, CompProposal>;
  /** Competencies this program targets in more than one exercise; their panel is labelled. */
  sharedComps: Set<string>;
  attempt: AttemptState | null;
  canRepeat: boolean;
  onResult: (v: ExerciseGrade['result']) => void;
  // Null clears the seat: the buttons toggle, exactly as the grade buttons do, and the handler
  // beneath already writes NULL. Narrowing it here was the only place that disagreed.
  onSeat: (v: 'PF' | 'PM' | null) => void;
  onComment: (v: string) => void;
  onComp: (code: string, patch: Partial<CompGrade>) => void;
  onRepeat: () => void;
}

function StepBody({ step, section, comps, locked, grade, compOf, proposals, sharedComps, attempt, canRepeat, onResult, onSeat, onComment, onComp, onRepeat }: StepBodyProps) {
  switch (step.kind) {
    case 'exercise': {
      const g = step.grading;
      const graded = isGraded(g);
      const setComp = onComp;
      return (
        <div className="stack" style={{ gap: 'var(--space-3)' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>{step.title}</h2>
            {step.pf ? <span className="chip chip-info"><span className="chip-dot" aria-hidden="true" />PF {step.pf}</span> : null}
            {step.minutes !== null ? <span className="mono xs muted">planned {fmt(step.minutes)}</span> : null}
            {step.snapshot ? <span className="chip"><span className="chip-dot" aria-hidden="true" />{step.snapshot === 'take' ? 'Save Flight Plan' : 'Recall Flight Plan'}</span> : null}
            {section.trainingOnly ? <span className="chip"><span className="chip-dot" aria-hidden="true" />Training only</span> : null}
          </div>
          <div className="row" style={{ gap: 'var(--space-2)' }}>{(['ap', 'athr', 'fd'] as const).map((k) => <span key={k} className={`auto-chip auto-${step.automation[k]}`}>{k === 'ap' ? 'AP' : k === 'athr' ? 'A/THR' : 'FD'} · {AUTO[step.automation[k]] ?? step.automation[k]}</span>)}</div>
          {step.aims.map((a, i) => (
            <div key={i} className="aims-block">
              <div className="xs muted" style={{ letterSpacing: '0.04em' }}>AIMS · {a.source.toUpperCase()}</div>
              {a.aims.aims ? <p className="small" style={{ margin: '4px 0 0' }}>{a.aims.aims}</p> : null}
              {a.aims.competency_focus ? <p className="small" style={{ margin: '4px 0 0' }}><span className="muted">Focus:</span> {a.aims.competency_focus}</p> : null}
              {a.aims.grading_criteria ? <p className="small" style={{ margin: '4px 0 0' }}><span className="muted">Criteria:</span> {a.aims.grading_criteria}</p> : null}
            </div>
          ))}
          {step.notes ? <div className="notice"><div className="xs muted" style={{ letterSpacing: '0.04em' }}>INSTRUCTOR NOTES</div><p className="small" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{step.notes}</p></div> : null}
          {graded ? (
            <div className="grade-panel" data-testid="grade-panel">
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span className="xs muted" style={{ letterSpacing: '0.04em' }}>GRADE · THIS EXERCISE{locked ? ' · locked by a signature' : ''}{attempt && attempt.attempt > 1 ? ` · ATTEMPT ${attempt.attempt}` : ''}</span>
                <span className="spacer" />
                {canRepeat && !locked && g.task_outcome_mode !== 'none' && grade.result !== null
                  ? <button type="button" className="button button-quiet xs" onClick={onRepeat} title="Grade this exercise again. The grade already given stays on the record as the first attempt.">Repeat</button>
                  : null}
              </div>
              {attempt && attempt.previous.length > 0 ? (
                <p className="xs muted" style={{ margin: '4px 0 0' }} data-testid="attempt-history">
                  Earlier {attempt.previous.length === 1 ? 'attempt' : 'attempts'}: {attempt.previous.map((a) => `${a.attempt} → ${a.grade ?? '—'}`).join(' · ')} · kept on the record.
                </p>
              ) : null}
              {step.pfPm ? (
                <div className="row" style={{ marginTop: 'var(--space-2)', gap: 'var(--space-2)', alignItems: 'center' }} data-testid="pf-pm">
                  <span className="small">Flown as</span>
                  <GradeButtons values={['PF', 'PM'] as const} value={grade.role} onPick={onSeat} disabled={locked} />
                  <span className="xs muted">{step.pfPm === 'take_off' ? 'counts as a take-off on the line-flying status' : step.pfPm === 'landing' ? 'counts as a landing on the line-flying status' : 'recorded, not counted'}</span>
                </div>
              ) : null}
              {g.task_outcome_mode === 'pass_fail' ? <div style={{ marginTop: 'var(--space-2)' }}><GradeButtons values={['pass', 'fail'] as const} value={grade.result as 'pass' | 'fail' | null} onPick={onResult} labels={{ pass: 'Pass', fail: 'Fail' }} disabled={locked} /></div> : null}
              {g.task_outcome_mode === 'scale_1_5' ? <div style={{ marginTop: 'var(--space-2)' }}><GradeButtons values={[1, 2, 3, 4, 5] as const} value={grade.result as number | null} onPick={onResult} disabled={locked} tone="grade" /></div> : null}
              {g.competency_grade_mode !== 'none' ? g.competencies.map((code) => {
                const c = comps.get(code); const cg = compOf(code);
                const scale = g.competency_grade_mode === 'scale_1_5';
                const showObs = cg.grade !== null && cg.grade !== 'not_observed';
                const prop = proposals[code];
                const diverges = prop?.grade != null && cg.grade !== null && String(cg.grade).toUpperCase() !== prop.grade.toUpperCase()
                  && !(typeof cg.grade === 'number' && String(cg.grade) === prop.grade);
                return (
                  <div key={code} className="comp-grade">
                    <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                      <span className="mono" style={{ width: '3.5rem' }} title={c?.name}>{code}</span>
                      <span className="xs muted" style={{ flex: '1 1 10rem' }}>{c?.name}</span>
                      {scale ? <GradeButtons values={[1, 2, 3, 4, 5] as const} value={typeof cg.grade === 'number' ? cg.grade : null} onPick={(v) => setComp(code, { grade: v })} disabled={locked} tone="grade" />
                        : <GradeButtons values={['competent', 'not_competent'] as const} value={cg.grade === 'competent' || cg.grade === 'not_competent' ? cg.grade : null} onPick={(v) => setComp(code, { grade: v })} labels={{ competent: 'Competent', not_competent: 'Not competent' }} disabled={locked} />}
                      <button type="button" className={`button ${cg.grade === 'not_observed' ? '' : 'button-quiet'} xs`}
                        style={cg.grade === 'not_observed' ? { background: 'var(--ink)', borderColor: 'var(--ink)', color: 'var(--brand-primary-ink)' } : { color: 'var(--ink)' }}
                        onClick={() => setComp(code, cg.grade === 'not_observed' ? { grade: null } : { grade: 'not_observed', obs: [] })} disabled={locked}
                        title={cg.grade === 'not_observed' ? 'Click again to clear it' : 'Not observed'}>N/O</button>
                    </div>
                    {sharedComps.has(code) ? (
                      <p className="xs muted" style={{ margin: '2px 0 0' }}>
                        One grade per session: {code} is graded once and shown on every exercise that targets it, behaviours included. Changing it here changes it everywhere.
                      </p>
                    ) : null}
                    {prop?.grade ? (
                      <p className="xs" style={{ margin: '4px 0 0' }} data-testid="proposal">
                        <span className="muted">The tasks so far propose </span><strong className="mono">{prop.grade}</strong>
                        <span className="muted">{prop.critical ? ' (a critical grade is not averaged away)' : prop.mean !== null ? ` (mean ${prop.mean.toFixed(2)} over ${prop.n_scored} ${prop.n_scored === 1 ? 'task' : 'tasks'}, ties round down)` : ''}</span>
                        {diverges ? <span className="chip chip-warn" style={{ marginLeft: 'var(--space-2)' }}><span className="chip-dot" aria-hidden="true" />yours is {String(cg.grade).toUpperCase()} - say why in the comment</span> : null}
                      </p>
                    ) : null}
                    {showObs && c ? (
                      <div className="ob-list">
                        <div className="xs muted">Observable behaviours {typeof cg.grade === 'number' && cg.grade >= 4 ? '- strengths' : typeof cg.grade === 'number' && cg.grade <= 2 ? '- needs development' : cg.grade === 'not_competent' ? '- not met' : '- observed'} · {cg.obs.length} selected</div>
                        {c.obs.map((ob) => (
                          <label key={ob.code} className="check"><input type="checkbox" checked={cg.obs.includes(ob.code)} disabled={locked} onChange={(e) => setComp(code, { obs: e.target.checked ? [...cg.obs, ob.code] : cg.obs.filter((x) => x !== ob.code) })} /><span><span className="ccode xs">{ob.code}</span> <span className="small">{ob.text}</span></span></label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              }) : null}
              <div className="field" style={{ marginTop: 'var(--space-2)' }}><label>Comment</label><textarea rows={2} value={grade.comment} onChange={(e) => onComment(e.target.value)} disabled={locked} placeholder="What drove the grade." /></div>
            </div>
          ) : <p className="xs muted" style={{ margin: 0 }}>Not graded: no grade control is rendered for this exercise.</p>}
        </div>
      );
    }
    case 'setup':
      return (
        <div className="stack" style={{ gap: 'var(--space-3)' }}>
          <h2 style={{ margin: 0 }}>{step.title}</h2>
          <table className="data"><tbody>
            {step.lines.map((l) => <tr key={l.label}><th scope="row" style={{ width: '9rem' }}>{l.label}</th><td>{l.values.map((v, i) => <div key={i} className={l.label === 'Airport' ? 'mono' : ''}>{v}</div>)}</td></tr>)}
            {step.mass.zfw || step.mass.zfwcg || step.mass.fuel ? <tr><th scope="row">Mass & config</th><td className="mono">{[step.mass.zfw && `ZFW ${step.mass.zfw}`, step.mass.zfwcg && `ZFWCG ${step.mass.zfwcg}`, step.mass.fuel && `FUEL ${step.mass.fuel}`].filter(Boolean).join(' · ')}</td></tr> : null}
          </tbody></table>
          {step.snapshot ? <span className="chip"><span className="chip-dot" aria-hidden="true" />{step.snapshot === 'take' ? 'Save Flight Plan' : 'Recall Flight Plan'}</span> : null}
          {step.notes ? <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{step.notes}</p> : null}
        </div>
      );
    case 'malfunction':
    case 'event':
      return <ChoiceStep step={step} />;
    case 'note':
      return <div className="stack"><h2 style={{ margin: 0 }}>{step.title}</h2><p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{step.text}</p></div>;
  }
}

function ChoiceStep({ step }: { step: Extract<InstructorStep, { kind: 'malfunction' | 'event' }> }) {
  const [chosen, setChosen] = useState<number | null>(null);
  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      <div className="row" style={{ alignItems: 'baseline' }}><h2 style={{ margin: 0 }}>{step.title}</h2><span className={`chip ${step.kind === 'malfunction' ? 'chip-bad' : 'chip-info'}`}><span className="chip-dot" aria-hidden="true" />{step.kind === 'malfunction' ? 'Malfunction' : 'Event'}</span></div>
      {step.items.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nothing set.</p> : step.mode === 'choose_one' && step.items.length > 1 ? (
        <>
          <p className="small" style={{ margin: 0 }}>Choose one. The one chosen is what the record stores.</p>
          <div className="choose-grid">{step.items.map((it, i) => <button key={i} type="button" className={`choose-card${chosen === i ? ' is-chosen' : ''}`} onClick={() => setChosen(i)} aria-pressed={chosen === i}><span className="small"><strong>{it.name}</strong>{it.option ? ` · ${it.option}` : ''}</span>{it.trigger ? <span className="xs muted">{it.trigger}</span> : null}</button>)}</div>
          {chosen !== null ? <p className="xs" style={{ margin: 0 }}>Chosen: <strong>{step.items[chosen]?.name}</strong>{step.items[chosen]?.option ? ` · ${step.items[chosen]?.option}` : ''}</p> : null}
        </>
      ) : (
        <ol className="seq-list">{step.items.map((it, i) => <li key={i}><span className="small"><strong>{it.name}</strong>{it.option ? ` · ${it.option}` : ''}{it.category ? <span className="xs muted"> · {it.category}</span> : null}</span>{it.trigger ? <div className="xs muted">{it.trigger}</div> : null}</li>)}</ol>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Record(props: { p: InstructorDemoProps; grades: Record<string, ExerciseGrade>; compGrades: Record<string, CompGrade>; sectionNotes: Record<string, string>; steps: { st: InstructorStep }[]; outcome: string; setOutcome: (v: string) => void; remarks: string; setRemarks: (v: string) => void; additional: boolean; setAdditional: (v: boolean) => void; signed: { instructor: string | null; subject: string | null }; setSigned: (v: { instructor: string | null; subject: string | null }) => void; objection: { reason: string; by: string; at: string } | null; setObjection: (v: { reason: string; by: string; at: string } | null) => void; now: () => string; locked: boolean }) {
  const { p, grades, compGrades, sectionNotes, outcome, setOutcome, remarks, setRemarks, additional, setAdditional, signed, setSigned, objection, setObjection, now, locked } = props;
  const live = p.live;
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [reason, setReason] = useState(''); const [by, setBy] = useState('');
  const gradeOf = (key: string): ExerciseGrade => grades[key] ?? { result: null, comment: '', role: null };
  const compOf = (code: string): CompGrade => compGrades[code] ?? { grade: null, obs: [] };
  const pfCounts = props.steps.filter(({ st }) => st.kind === 'exercise' && st.pfPm && gradeOf(st.key).role).map(({ st }) => ({ counter: st.kind === 'exercise' ? st.pfPm : null, role: gradeOf(st.key).role }));
  const pfLine = pfCounts.length ? `Take-offs as PF ${pfCounts.filter((x) => x.counter === 'take_off' && x.role === 'PF').length} · landings as PF ${pfCounts.filter((x) => x.counter === 'landing' && x.role === 'PF').length} · as PM ${pfCounts.filter((x) => x.role === 'PM').length}` : null;
  const comments = props.steps.filter(({ st }) => st.kind === 'exercise' && gradeOf(st.key).comment.trim()).map(({ st }) => `${st.title}: ${gradeOf(st.key).comment.trim()}`);
  /*
   * THE BADGE READS THE SERVER'S STATE WHEN THERE IS ONE.
   *
   * `signed` is local component state and starts empty on every load, so on a real session this
   * line used to print DRAFT across the top of a record that was signed by three people and frozen
   * into a record with its PDF - the signature chips a few centimetres below it said so, from
   * `live`, at the same moment. The local state only ever mattered for the in-memory walk-through,
   * which has no `live` and no server to ask.
   *
   * FINALISED comes first because it is the strongest thing true about a record: a finalised record
   * is signed AND frozen AND no longer depends on the program version, and "SIGNED" would understate
   * all three.
   */
  const status = live
    ? live.signing.recordId
      ? 'FINALISED'
      : live.signing.objection
        ? 'INCOMPLETE · objection'
        : live.signing.assessor && (live.signing.subject || p.hiddenFromSubject)
          ? 'SIGNED'
          : live.signing.assessor || live.signing.subject
            ? 'AWAITING SIGNATURE'
            : 'DRAFT'
    : objection ? `INCOMPLETE · objection` : signed.instructor && (signed.subject || p.hiddenFromSubject) ? 'SIGNED' : signed.instructor || signed.subject ? 'AWAITING SIGNATURE' : 'DRAFT';
  /* The stored value as a human reads it. A numeric grade comes back as itself and is wrapped in a
     GradeChip below; a pass/fail or binary result is a WORD and never wears a grade colour, because
     it is not a point on the 1-5 scale. */
  const cellText = (v: ExerciseGrade['result'] | CompGrade['grade']) => v === null ? '\u2014' : v === 'pass' ? 'PASS' : v === 'fail' ? 'FAIL' : v === 'competent' ? 'C' : v === 'not_competent' ? 'NC' : v === 'not_observed' ? 'N/O' : String(v);
  const cell = (v: ExerciseGrade['result'] | CompGrade['grade']): ReactNode => {
    const text = cellText(v);
    return /^\d+$/.test(text) ? <GradeChip value={text} /> : text;
  };

  return (
    <article className="report" data-testid="report">
      {live?.signing.objection ? (
        <div className="notice notice-bad" data-testid="objection-live">
          <p style={{ margin: 0 }}><strong>Objection recorded {live.signing.objection.at.slice(0, 16).replace('T', ' ')}.</strong> The record is marked {p.objection.marksRecord} and the {p.objection.notifiesRole.replace(/_/g, ' ')} has been notified to review it. The assessment below is unchanged.</p>
          {live.signing.objection.reason ? <p className="small" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>&ldquo;{live.signing.objection.reason}&rdquo;</p> : null}
        </div>
      ) : null}
      {live?.signing.recordId ? (
        <div className="notice" style={{ borderLeftColor: 'var(--state-good)' }} data-testid="record-frozen">
          <p style={{ margin: 0 }} className="small"><strong>Finalised.</strong> This is now a frozen record on the pilot&apos;s profile, and no longer depends on the program version. Nothing above can change.</p>
          <p style={{ margin: 'var(--space-2) 0 0' }}>
            <a className="button button-quiet" href={`/api/records/${live.signing.recordId}/pdf`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>Open the PDF</a>
            <span className="xs muted" style={{ marginLeft: 'var(--space-2)' }}>Rendered and stored when the record was frozen.</span>
          </p>
        </div>
      ) : null}
      {objection ? <div className="notice notice-bad"><p style={{ margin: 0 }}><strong>Objection recorded.</strong> The record is marked {p.objection.marksRecord} and the {p.objection.notifiesRole.replace(/_/g, ' ')} has been notified to review it (demo: shown here, sent nowhere).</p><p className="small" style={{ margin: '4px 0 0' }}>{objection.by}, {objection.at}: “{objection.reason}”</p></div> : null}
      <header className="report-head">
        <div className="row" style={{ alignItems: 'baseline' }}><div className="report-brand">{p.kindLabel}</div><span className="spacer" /><span className={`chip ${objection ? 'chip-bad' : status === 'SIGNED' ? 'chip-good' : 'chip-warn'}`}><span className="chip-dot" aria-hidden="true" />{status}</span></div>
        <h2 style={{ margin: 'var(--space-2) 0 0' }}>{p.programName}</h2>
        <dl className="report-meta">
          <div><dt>Date</dt><dd>{live ? live.sessionDate : new Date().toISOString().slice(0, 10)}</dd></div>
          <div><dt>Location</dt><dd className={live?.facility ? '' : 'muted'}>{live?.facility ?? '—'}</dd></div>
          <div><dt>Device</dt><dd className={live?.device ? 'mono' : 'muted'}>{live?.device ?? '— (chosen when the session is created)'}</dd></div>
          <div><dt>{p.hiddenFromSubject ? 'Candidate' : 'Trainee'}</dt><dd className={live ? '' : 'muted'}>{live ? live.subjectName : p.hiddenFromSubject ? 'Candidate (demo)' : 'Trainee (demo)'}</dd></div>
          <div><dt>Position</dt><dd className={live?.subjectPosition ? '' : 'muted'}>{live?.subjectPosition ?? '—'}</dd></div>
          <div><dt>Instructor</dt><dd>{p.instructorName}</dd></div>
        </dl>
      </header>

      <table className="data report-table">
        <thead><tr><th scope="col">Exercise</th><th scope="col">Assessed on</th><th scope="col">Competency</th><th scope="col" className="num">Grade</th><th scope="col">Observable behaviours</th></tr></thead>
        <tbody>
          {p.report.sections.map((s) => (
            <SectionRows key={s.key} s={s} gradeOf={gradeOf} compOf={compOf} cell={cell} phaseLabel={new Map(p.phaseLabels)} note={sectionNotes[s.key]?.trim() || null} />
          ))}
        </tbody>
      </table>

      <section className="report-comment">
        <div className="xs muted" style={{ letterSpacing: '0.04em' }}>INSTRUCTOR COMMENT</div>
        {pfLine ? <p className="small" style={{ margin: '4px 0 0' }} data-testid="pf-line"><strong>{pfLine}</strong></p> : null}
        {comments.length ? <ul className="small" style={{ margin: '4px 0', paddingLeft: '1.2rem' }}>{comments.map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
        <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={locked} placeholder="Session remarks." style={{ width: '100%', boxSizing: 'border-box', marginTop: 'var(--space-2)' }} />
      </section>

      <section className="report-outcome">
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="xs muted" style={{ letterSpacing: '0.04em' }}>OUTCOME</span>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} disabled={locked} style={{ font: 'inherit', fontWeight: 700, letterSpacing: '0.06em' }}><option value="">—</option>{p.outcomes.map((o) => <option key={o} value={o}>{o}</option>)}</select>
          <span className="xs muted">chosen by the instructor, never computed</span>
        </div>
        <label className="check" style={{ marginTop: 'var(--space-2)' }}><input type="checkbox" checked={additional} disabled={locked} onChange={(e) => setAdditional(e.target.checked)} /><span className="small">Additional training recommended</span></label>
      </section>

      <div className="signatures">
        <div className="sig-block">
          <div className="xs muted" style={{ letterSpacing: '0.04em' }}>INSTRUCTOR</div>
          <div className="small"><strong>{p.instructorName}</strong></div>
          <p className="sig-statement">{p.statements.assessor}</p>
          {live
            ? live.signing.assessor
              ? <span className="chip chip-good" data-testid="sig-assessor"><span className="chip-dot" aria-hidden="true" />Signed {live.signing.assessor.at.slice(0, 16).replace('T', ' ')}{live.signing.assessor.name ? ` · ${live.signing.assessor.name}` : ''}</span>
              : <span className="xs muted">Not signed. The button is below the record.</span>
            : signed.instructor ? <span className="chip chip-good"><span className="chip-dot" aria-hidden="true" />Signed · {signed.instructor}</span>
            : <div><button type="button" className="button" onClick={() => setSigned({ ...signed, instructor: now() })} disabled={!outcome} title={outcome ? undefined : 'Choose the outcome first'}>Sign</button></div>}
        </div>
        {p.hiddenFromSubject ? (
          <div className="sig-block" data-testid="sig-hidden">
            <div className="xs muted" style={{ letterSpacing: '0.04em' }}>INTERNAL RECORD</div>
            <p className="small" style={{ margin: 0 }}>Not visible to the trainee. This record is signed by the assessor only and does not appear in the trainee&apos;s history.</p>
          </div>
        ) : (
        <div className="sig-block">
          <div className="xs muted" style={{ letterSpacing: '0.04em' }}>TRAINEE</div>
          <div className="small"><strong>{live ? live.subjectName : 'Trainee (demo)'}</strong></div>
          <p className="sig-statement">{p.statements.subject}{p.statements.subjectExtra ? <><br /><strong>{p.statements.subjectExtra}</strong></> : null}</p>
          {live
            ? live.signing.subject
              ? <span className="chip chip-good" data-testid="sig-subject"><span className="chip-dot" aria-hidden="true" />Signed {live.signing.subject.at.slice(0, 16).replace('T', ' ')}</span>
              : <span className="xs muted">{live.signing.assessor ? 'Waiting for the pilot. The button is below the record.' : 'The instructor signs first.'}</span>
            : objection ? <span className="chip chip-bad"><span className="chip-dot" aria-hidden="true" />Objected · {objection.at}</span>
            : signed.subject ? <span className="chip chip-good"><span className="chip-dot" aria-hidden="true" />Signed · {signed.subject}</span>
            : <div className="row"><button type="button" className="button" onClick={() => setSigned({ ...signed, subject: now() })} disabled={live !== undefined || !signed.instructor} title={live ? 'Signing arrives with the review step' : signed.instructor ? undefined : 'The instructor signs first'}>Sign</button>{p.objection.allowed ? <button type="button" className="button button-quiet" onClick={() => dialog.current?.showModal()} disabled={live !== undefined || !signed.instructor}>{p.objection.label}</button> : null}</div>}
        </div>
        )}
      </div>
      {live ? (
        <div className="stack" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
          {live.signing.unsigned ? (
            <div className="notice notice-warn"><p style={{ margin: 0 }} className="small">
              <strong>Signatures were removed {live.signing.unsigned.at.slice(0, 16).replace('T', ' ')}</strong>
              {live.signing.unsigned.by ? ` by ${live.signing.unsigned.by}` : ''}
              {live.signing.unsigned.reason ? `: “${live.signing.unsigned.reason}”` : '.'} Whatever is signed now is a new attestation.
            </p></div>
          ) : null}
          {!live.signing.matches ? (
            <div className="notice notice-bad"><p style={{ margin: 0 }} className="small">
              <strong>The content has changed since it was signed.</strong> The signatures attest to {live.signing.storedHash?.slice(0, 16)}…, and this record now hashes to {live.signing.liveHash.slice(0, 16)}…. Remove the signatures and sign again.
            </p></div>
          ) : null}
          <SignPanel live={live} outcome={outcome} statements={p.statements} objection={p.objection} hiddenFromSubject={p.hiddenFromSubject} />
        </div>
      ) : null}
      <footer className="xs muted mono" style={{ marginTop: 'var(--space-3)', wordBreak: 'break-all' }}>
        {live ? `Session record · content ${live.signing.storedHash ?? live.signing.liveHash}${live.signing.storedHash ? ' (signed)' : ' (not yet signed)'}` : 'Demo record · content hash —'} · both signatures attest to this content. Any later change voids them.
      </footer>

      <dialog ref={dialog} className="modal" aria-labelledby="obj-title" onCancel={(e) => e.preventDefault()}>
        <div className="stack">
          <h2 id="obj-title" className="card-title" style={{ margin: 0 }}>{p.objection.label}</h2>
          <p className="small muted" style={{ margin: 0 }}>{p.objection.prompt}</p>
          <div className="field"><label htmlFor="obj-reason">Reasons *</label><textarea id="obj-reason" rows={5} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} /></div>
          <div className="field"><label htmlFor="obj-by">Your name, to sign the objection *</label><input id="obj-by" value={by} onChange={(e) => setBy(e.target.value)} /></div>
          <p className="xs muted" style={{ margin: 0 }}>Signing the objection marks the record <strong>{p.objection.marksRecord}</strong> and sends it to the {p.objection.notifiesRole.replace(/_/g, ' ')} for review.</p>
          <div className="row">
            <button type="button" className="button" disabled={reason.trim().length < 3 || by.trim().length < 2} onClick={() => { setObjection({ reason: reason.trim(), by: by.trim(), at: now() }); dialog.current?.close(); }}>Sign the objection</button>
            <button type="button" className="button button-quiet" onClick={() => { setReason(''); setBy(''); dialog.current?.close(); }}>Cancel</button>
          </div>
        </div>
      </dialog>
    </article>
  );
}

/**
 * Signing, as an identity assertion.
 *
 * No certificate and no drawn squiggle: the statement from policy.yaml, the hash of what is being
 * attested to, and the signer re-enters THEIR OWN PASSWORD. The password is the only secret in this
 * system that belongs to one person - an employee id is on a roster every colleague can read. The
 * hash is shown rather than hidden behind the words "this content": the sentence "any later change
 * voids this" needs a visible value to be a fact.
 *
 * The pilot signs on the instructor's screen at the debrief, and signs as themselves - their own
 * password, their own user id on the row. Where a pilot has no account the surface says so and asks
 * for their employee id instead, which is a weaker assertion and is recorded as one.
 */
function SignPanel({ live, outcome, statements, objection, hiddenFromSubject }: { live: LiveSession; outcome: string; statements: InstructorDemoProps['statements']; objection: InstructorDemoProps['objection']; hiddenFromSubject: boolean }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const undo = useRef<HTMLDialogElement | null>(null);
  const [party, setParty] = useState<'assessor' | 'subject'>('assessor');
  const objectDialog = useRef<HTMLDialogElement | null>(null);
  const [secret, setSecret] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sg = live.signing;

  const post = async (payload: Record<string, unknown>, close: HTMLDialogElement | null, route: 'sign' | 'finalise' = 'sign') => {
    setBusy(true); setProblem(null);
    try {
      const res = await fetch(`/api/sessions/${live.sessionId}/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, person_id: live.personId }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
      if (!res.ok || json?.ok !== true) {
        // A rule refusal carries its own sentence. Anything else is a fault, and naming the status
        // beats a polite dead end: "not accepted" sent me looking at the employee id when the
        // problem was a 500 from the server.
        setProblem(json?.message ?? (res.status >= 500
          ? `The server could not complete that (HTTP ${res.status}). The dev-server log has the reason.`
          : `That was not accepted (HTTP ${res.status}${json?.error ? `, ${json.error}` : ''}).`));
        return;
      }
      setSecret(''); setReason('');
      close?.close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const open = (which: 'assessor' | 'subject') => { setParty(which); setProblem(null); setSecret(''); dialog.current?.showModal(); };
  const openUndo = () => { setProblem(null); setSecret(''); setReason(''); undo.current?.showModal(); };
  const method = party === 'assessor' ? sg.assessorMethod : sg.subjectMethod;
  const statement = party === 'assessor' ? statements.assessor : statements.subject;

  return (
    <>
      {problem && !dialog.current?.open && !undo.current?.open && !objectDialog.current?.open
        ? <div className="notice notice-bad" role="status"><p style={{ margin: 0 }} className="small">{problem}</p></div> : null}

      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }} data-testid="sign-actions">
        {sg.assessor === null
          ? <button type="button" className="button" onClick={() => open('assessor')} disabled={!sg.canSign || !outcome}
              title={outcome ? undefined : 'Enter the outcome first'}>Sign as the instructor</button>
          : null}
        {sg.assessor !== null && sg.subject === null && sg.objection === null && !hiddenFromSubject
          ? <button type="button" className="button" onClick={() => open('subject')} disabled={!sg.canSign}>Hand over for the pilot to sign</button>
          : null}
        {sg.assessor !== null && sg.subject === null && sg.objection === null && !hiddenFromSubject && objection.allowed
          ? <button type="button" className="button button-quiet" onClick={() => { setProblem(null); setSecret(''); setReason(''); objectDialog.current?.showModal(); }} disabled={!sg.canSign}>{objection.label}</button>
          : null}
        {sg.recordId === null && sg.assessor !== null && (sg.subject !== null || sg.objection !== null || hiddenFromSubject)
          ? <button type="button" className="button" disabled={busy || !sg.canFinalise}
              title={sg.canFinalise ? 'Freeze this into a record. It stops depending on the program from then on.' : 'Your account may not finalise a session'}
              onClick={() => void post({ action: 'finalise' }, null, 'finalise')}>Finalise the record</button>
          : null}
        {(sg.assessor !== null || sg.subject !== null) && sg.canUnsign
          ? <button type="button" className="button button-quiet" onClick={openUndo}>Remove the signatures</button>
          : null}
      </div>

      <dialog ref={dialog} className="modal" aria-labelledby="sign-title" onCancel={(e) => { if (busy) e.preventDefault(); }}>
        <div className="stack">
          <h2 id="sign-title" className="card-title" style={{ margin: 0 }}>{party === 'assessor' ? 'Instructor signature' : 'Pilot signature'}</h2>
          <p className="small" style={{ margin: 0 }}>{statement}</p>
          {party === 'subject' && statements.subjectExtra ? <p className="small" style={{ margin: 0 }}><strong>{statements.subjectExtra}</strong></p> : null}
          <p className="xs muted mono" style={{ margin: 0, wordBreak: 'break-all' }}>content {sg.liveHash}</p>
          <div className="field">
            <label htmlFor="sign-secret">
              {method === 'password'
                ? party === 'assessor' ? 'Your password' : 'The pilot enters their own password'
                : 'The pilot\'s employee id'} *
            </label>
            <input id="sign-secret" type={method === 'password' ? 'password' : 'text'} className={method === 'password' ? undefined : 'mono'}
              value={secret} onChange={(e) => setSecret(e.target.value)} maxLength={200} autoComplete="off" />
            <span className="xs muted">
              {method === 'password'
                ? 'Checked in the database, the same way signing in is. It is never stored with the signature and never appears in the log.'
                : 'This pilot has no account, so the signature can only be their employee id - a weaker assertion, and recorded as one. An account is the fix.'}
            </span>
          </div>
          {problem ? <p className="small" style={{ margin: 0, color: 'var(--state-bad)' }}>{problem}</p> : null}
          <p className="xs muted" style={{ margin: 0 }}>Signing records the time, the account that presented this screen and the content above. It locks the session: nothing can be changed afterwards without removing the signatures, which is logged.</p>
          <div className="row">
            <button type="button" className="button" disabled={busy || secret.length === 0}
              onClick={() => void post({ action: 'sign', party, secret }, dialog.current)}>Sign</button>
            <button type="button" className="button button-quiet" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
          </div>
        </div>
      </dialog>

      <dialog ref={objectDialog} className="modal" aria-labelledby="object-title" onCancel={(e) => { if (busy) e.preventDefault(); }}>
        <div className="stack">
          <h2 id="object-title" className="card-title" style={{ margin: 0 }}>{objection.label}</h2>
          <p className="small muted" style={{ margin: 0 }}>{objection.prompt}</p>
          <div className="field"><label htmlFor="object-reason">The pilot&apos;s reasons *</label><textarea id="object-reason" rows={5} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} /></div>
          <div className="field">
            <label htmlFor="object-secret">{sg.subjectMethod === 'password' ? 'The pilot enters their own password' : 'The pilot\'s employee id'} *</label>
            <input id="object-secret" type={sg.subjectMethod === 'password' ? 'password' : 'text'} className={sg.subjectMethod === 'password' ? undefined : 'mono'}
              value={secret} onChange={(e) => setSecret(e.target.value)} maxLength={200} autoComplete="off" />
          </div>
          <p className="xs muted" style={{ margin: 0 }}>The record is marked <strong>{objection.marksRecord}</strong> and the {objection.notifiesRole.replace(/_/g, ' ')} is notified to review it. The instructor&apos;s assessment is kept exactly as it was written; the objection sits beside it in the pilot&apos;s own words.</p>
          {problem ? <p className="small" style={{ margin: 0, color: 'var(--state-bad)' }}>{problem}</p> : null}
          <div className="row">
            <button type="button" className="button" disabled={busy || reason.trim().length < 3 || secret.length === 0}
              onClick={() => void post({ action: 'object', reason: reason.trim(), secret }, objectDialog.current, 'finalise')}>Record the objection</button>
            <button type="button" className="button button-quiet" disabled={busy} onClick={() => objectDialog.current?.close()}>Cancel</button>
          </div>
        </div>
      </dialog>

      <dialog ref={undo} className="modal" aria-labelledby="unsign-title" onCancel={(e) => { if (busy) e.preventDefault(); }}>
        <div className="stack">
          <h2 id="unsign-title" className="card-title" style={{ margin: 0 }}>Remove the signatures</h2>
          <p className="small" style={{ margin: 0 }}>Every signature on this session is removed and it opens for editing again. The removal, its reason and your name go in the app log, and the content hash is cleared - whatever is signed afterwards is a new attestation.</p>
          <div className="field"><label htmlFor="unsign-reason">Why *</label><textarea id="unsign-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} /></div>
          <div className="field">
            <label htmlFor="unsign-pw">Your password *</label>
            <input id="unsign-pw" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} maxLength={200} autoComplete="current-password" />
            <span className="xs muted">Confirmed the same way a signature is: undoing an attestation is itself an attestation.</span>
          </div>
          {problem ? <p className="small" style={{ margin: 0, color: 'var(--state-bad)' }}>{problem}</p> : null}
          <div className="row">
            <button type="button" className="button" disabled={busy || reason.trim().length < 3 || secret.length === 0}
              onClick={() => void post({ action: 'unsign', reason: reason.trim(), password: secret }, undo.current)}>Remove the signatures</button>
            <button type="button" className="button button-quiet" disabled={busy} onClick={() => undo.current?.close()}>Cancel</button>
          </div>
        </div>
      </dialog>
    </>
  );
}

function SectionRows({ s, gradeOf, compOf, cell, phaseLabel, note }: { s: ReportModel['sections'][number]; gradeOf: (k: string) => ExerciseGrade; compOf: (code: string) => CompGrade; cell: (v: ExerciseGrade['result'] | CompGrade['grade']) => ReactNode; phaseLabel: Map<string, string>; note: string | null }): ReactNode {
  return (
    <>
      <tr className="report-section"><th scope="rowgroup" colSpan={5}>{s.title}{s.phase ? <span className="xs muted"> · {phaseLabel.get(s.phase) ?? s.phase}</span> : null}{s.trainingOnly ? <span className="xs muted"> · training only, not graded</span> : null}</th></tr>
      {s.trainingOnly ? <tr><td colSpan={5} className="small">{note ? <><span className="xs muted">Instructor comments: </span><span style={{ whiteSpace: 'pre-wrap' }}>{note}</span></> : <span className="muted">No instructor comments.</span>}</td></tr> : null}
      {s.rows.map((r) => {
        const g = gradeOf(r.key);
        const comps = r.grading.competency_grade_mode !== 'none' ? r.competencies : [];
        const rows = comps.length ? comps : [null];
        return rows.map((c, i) => (
          <tr key={`${r.key}-${c ?? 'task'}`}>
            {i === 0 ? <td rowSpan={rows.length}><div>{r.title}{r.pfPm && g.role ? <span className="xs" style={{ marginLeft: 'var(--space-2)', fontWeight: 600 }}>as {g.role}</span> : null}</div>{r.aims ? <div className="xs muted">{r.aims}</div> : null}{r.gradingCriteria ? <div className="xs muted">Criteria: {r.gradingCriteria}</div> : null}</td> : null}
            {i === 0 ? <td rowSpan={rows.length} className="small">{r.failures.length ? r.failures.map((f, j) => <div key={j}>{f}</div>) : <span className="muted">—</span>}</td> : null}
            {c ? <><td className="mono">{c}</td><td className="num">{cell(compOf(c).grade)}</td><td className="xs">{compOf(c).obs.length ? compOf(c).obs.join(', ') : <span className="muted">{compOf(c).grade ? 'at standard' : ''}</span>}</td></>
              : <><td className="muted">{r.grading.task_outcome_mode === 'pass_fail' ? 'Pass / fail' : r.grading.task_outcome_mode === 'scale_1_5' ? 'Task 1-5' : '—'}</td><td className="num">{r.grading.task_outcome_mode !== 'none' ? cell(g.result) : ''}</td><td className="xs muted">{r.grading.task_outcome_mode === 'none' ? (r.trainingOnly ? 'training phase, no grade' : 'not graded') : ''}</td></>}
          </tr>
        ));
      })}
    </>
  );
}

export default InstructorDemo;
