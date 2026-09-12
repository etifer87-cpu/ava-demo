'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { InstructorView, InstructorStep, ReportModel } from '@/lib/program/projection';
import type { Grading } from '@/lib/program/shape';

/**
 * InstructorDemo - the instructor's session and the record, as a walk-through.
 *
 * Everything on this screen is in memory: grades, observable behaviours, comments, the outcome,
 * the signatures and an objection. Nothing is written anywhere, and the page says so. It exists
 * so that a manager can drive the session they built exactly as the instructor will - grade,
 * pick behaviours, sign, object - and see the record that comes out, before any pilot flies it.
 * The delivery screen will render the same projections with a real session behind them.
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
}

type CompGrade = { grade: number | 'competent' | 'not_competent' | 'not_observed' | null; obs: string[] };
type ExerciseGrade = { result: number | 'pass' | 'fail' | null; comps: Record<string, CompGrade>; comment: string; role: 'PF' | 'PM' | null };

const AUTO: Record<string, string> = { required_on: 'REQUIRED ON', required_off: 'REQUIRED OFF', crew_discretion: 'CREW DISCRETION', not_applicable: 'N/A' };
const fmt = (m: number | null) => (m === null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
const isGraded = (g: Grading) => g.task_outcome_mode !== 'none' || g.competency_grade_mode !== 'none';

export function InstructorDemo(p: InstructorDemoProps) {
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<'session' | 'report'>('session');
  const [grades, setGrades] = useState<Record<string, ExerciseGrade>>({});
  const [outcome, setOutcome] = useState<string>('');
  const [remarks, setRemarks] = useState('');
  const [sectionNotes, setSectionNotes] = useState<Record<string, string>>({});
  const [additional, setAdditional] = useState(false);
  const [signed, setSigned] = useState<{ instructor: string | null; subject: string | null }>({ instructor: null, subject: null });
  const [objection, setObjection] = useState<{ reason: string; by: string; at: string } | null>(null);

  const phaseLabel = useMemo(() => new Map(p.phaseLabels), [p.phaseLabels]);
  const phaseColour = useMemo(() => new Map(p.phaseColours), [p.phaseColours]);
  const comps = useMemo(() => new Map(p.competencies.map((c) => [c.code, c])), [p.competencies]);
  const steps = p.view.sections.flatMap((s) => s.steps.map((st) => ({ st, section: s })));
  const current = steps[idx] ?? null;
  const gradeOf = (key: string): ExerciseGrade => grades[key] ?? { result: null, comps: {}, comment: '', role: null };
  const setGrade = (key: string, next: ExerciseGrade) => setGrades((g) => ({ ...g, [key]: next }));
  const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const locked = signed.instructor !== null || signed.subject !== null || objection !== null;
  const gradedSteps = steps.filter(({ st }) => st.kind === 'exercise' && isGraded(st.grading));
  const done = gradedSteps.filter(({ st }) => { const g = gradeOf(st.key); return st.kind === 'exercise' && ((st.grading.task_outcome_mode !== 'none' && g.result !== null) || (st.grading.competency_grade_mode !== 'none' && st.grading.competencies.every((c) => g.comps[c]?.grade))); }).length;

  return (
    <div className="stack" data-testid="instructor-demo">
      <div className="notice" style={{ borderLeftColor: 'var(--state-info)' }}><p style={{ margin: 0 }}><strong>Demo.</strong> Grade, pick behaviours, sign and object exactly as in a session. Nothing here is recorded; reload the page and it is gone.</p></div>
      <div className="row">
        <button type="button" className={`button ${mode === 'session' ? '' : 'button-quiet'}`} onClick={() => setMode('session')}>Session</button>
        <button type="button" className={`button ${mode === 'report' ? '' : 'button-quiet'}`} onClick={() => setMode('report')}>Record{gradedSteps.length ? <span className="xs muted"> · {done}/{gradedSteps.length} graded</span> : null}</button>
        <span className="spacer" />
        <span className="mono xs muted">device {p.insideMinutes ?? '-'}{p.outsideMinutes ? ` + ${p.outsideMinutes} outside` : ''}</span>
      </div>

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
                  {s.steps.map((st) => { const i = steps.findIndex((x) => x.st.key === st.key); const g = gradeOf(st.key); const has = st.kind === 'exercise' && isGraded(st.grading); const complete = has && st.kind === 'exercise' && ((st.grading.task_outcome_mode !== 'none' && g.result !== null) || (st.grading.competency_grade_mode !== 'none' && st.grading.competencies.length > 0 && st.grading.competencies.every((c) => g.comps[c]?.grade)));
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
                  <span className="mono xs muted">task 00:00 · session 0:00</span>
                </div>
                <StepBody step={current.st} section={current.section} grade={gradeOf(current.st.key)} onGrade={(g) => setGrade(current.st.key, g)} comps={comps} locked={locked} />
                {current.section.trainingOnly ? (
                  <div className="grade-panel" style={{ marginTop: 'var(--space-3)' }} data-testid="section-comment">
                    <div className="xs muted" style={{ letterSpacing: '0.04em' }}>{current.section.title.toUpperCase()} · INSTRUCTOR COMMENTS{locked ? ' · locked by a signature' : ''}</div>
                    <p className="xs muted" style={{ margin: '4px 0 0' }}>Not graded. What was trained, what was repeated and why; this goes on the record as text.</p>
                    <div className="field" style={{ marginTop: 'var(--space-2)' }}><textarea rows={4} value={sectionNotes[current.section.key] ?? ''} onChange={(e) => setSectionNotes((n) => ({ ...n, [current.section.key]: e.target.value }))} disabled={locked} placeholder="Items trained and observations." /></div>
                  </div>
                ) : null}
                <div className="row" style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="button button-quiet" onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0}>Previous</button>
                  <span className="spacer" />
                  {idx < steps.length - 1 ? <button type="button" className="button" onClick={() => setIdx(idx + 1)}>Next step</button> : <button type="button" className="button" onClick={() => setMode('report')}>Review and sign</button>}
                </div>
              </>
            ) : <p className="muted small">Nothing to show: the program has no steps.</p>}
          </section>
        </div>
      ) : (
        <Record p={p} grades={grades} sectionNotes={sectionNotes} steps={steps} outcome={outcome} setOutcome={setOutcome} remarks={remarks} setRemarks={setRemarks} additional={additional} setAdditional={setAdditional} signed={signed} setSigned={setSigned} objection={objection} setObjection={setObjection} now={now} locked={locked} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function GradeButtons<T extends number | string>({ values, value, onPick, labels, disabled }: { values: readonly T[]; value: T | null; onPick: (v: T) => void; labels?: Record<string, string>; disabled: boolean }) {
  return <div className="row" style={{ gap: 'var(--space-1)' }}>{values.map((v) => <button key={String(v)} type="button" className={`button ${value === v ? '' : 'button-quiet'} xs`} onClick={() => onPick(v)} disabled={disabled} aria-pressed={value === v}>{labels?.[String(v)] ?? String(v)}</button>)}</div>;
}

function StepBody({ step, section, grade, onGrade, comps, locked }: { step: InstructorStep; section: { title: string; trainingOnly: boolean }; grade: ExerciseGrade; onGrade: (g: ExerciseGrade) => void; comps: Map<string, CompetencyDef>; locked: boolean }) {
  switch (step.kind) {
    case 'exercise': {
      const g = step.grading;
      const graded = isGraded(g);
      const setComp = (code: string, patch: Partial<CompGrade>) => onGrade({ ...grade, comps: { ...grade.comps, [code]: { grade: null, obs: [], ...(grade.comps[code] ?? {}), ...patch } } });
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
              <div className="xs muted" style={{ letterSpacing: '0.04em' }}>GRADE · THIS EXERCISE{locked ? ' · locked by a signature' : ''}</div>
              {step.pfPm ? (
                <div className="row" style={{ marginTop: 'var(--space-2)', gap: 'var(--space-2)', alignItems: 'center' }} data-testid="pf-pm">
                  <span className="small">Flown as</span>
                  <GradeButtons values={['PF', 'PM'] as const} value={grade.role} onPick={(v) => onGrade({ ...grade, role: v })} disabled={locked} />
                  <span className="xs muted">{step.pfPm === 'take_off' ? 'counts as a take-off on the line-flying status' : step.pfPm === 'landing' ? 'counts as a landing on the line-flying status' : 'recorded, not counted'}</span>
                </div>
              ) : null}
              {g.task_outcome_mode === 'pass_fail' ? <div style={{ marginTop: 'var(--space-2)' }}><GradeButtons values={['pass', 'fail'] as const} value={grade.result as 'pass' | 'fail' | null} onPick={(v) => onGrade({ ...grade, result: v })} labels={{ pass: 'Pass', fail: 'Fail' }} disabled={locked} /></div> : null}
              {g.task_outcome_mode === 'scale_1_5' ? <div style={{ marginTop: 'var(--space-2)' }}><GradeButtons values={[1, 2, 3, 4, 5] as const} value={grade.result as number | null} onPick={(v) => onGrade({ ...grade, result: v })} disabled={locked} /></div> : null}
              {g.competency_grade_mode !== 'none' ? g.competencies.map((code) => {
                const c = comps.get(code); const cg = grade.comps[code] ?? { grade: null, obs: [] };
                const scale = g.competency_grade_mode === 'scale_1_5';
                const showObs = cg.grade !== null && cg.grade !== 'not_observed';
                return (
                  <div key={code} className="comp-grade">
                    <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                      <span className="mono" style={{ width: '3.5rem' }} title={c?.name}>{code}</span>
                      <span className="xs muted" style={{ flex: '1 1 10rem' }}>{c?.name}</span>
                      {scale ? <GradeButtons values={[1, 2, 3, 4, 5] as const} value={typeof cg.grade === 'number' ? cg.grade : null} onPick={(v) => setComp(code, { grade: v })} disabled={locked} />
                        : <GradeButtons values={['competent', 'not_competent'] as const} value={cg.grade === 'competent' || cg.grade === 'not_competent' ? cg.grade : null} onPick={(v) => setComp(code, { grade: v })} labels={{ competent: 'Competent', not_competent: 'Not competent' }} disabled={locked} />}
                      <button type="button" className={`button ${cg.grade === 'not_observed' ? '' : 'button-quiet'} xs`} onClick={() => setComp(code, { grade: 'not_observed', obs: [] })} disabled={locked}>N/O</button>
                    </div>
                    {showObs && c ? (
                      <div className="ob-list">
                        <div className="xs muted">Observable behaviours {typeof cg.grade === 'number' && cg.grade >= 4 ? '- strengths' : typeof cg.grade === 'number' && cg.grade <= 2 ? '- needs development' : cg.grade === 'not_competent' ? '- not met' : '- observed'} · {cg.obs.length} selected</div>
                        {c.obs.map((ob) => (
                          <label key={ob.code} className="check"><input type="checkbox" checked={cg.obs.includes(ob.code)} disabled={locked} onChange={(e) => setComp(code, { obs: e.target.checked ? [...cg.obs, ob.code] : cg.obs.filter((x) => x !== ob.code) })} /><span><span className="mono xs">{ob.code}</span> <span className="small">{ob.text}</span></span></label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              }) : null}
              <div className="field" style={{ marginTop: 'var(--space-2)' }}><label>Comment</label><textarea rows={2} value={grade.comment} onChange={(e) => onGrade({ ...grade, comment: e.target.value })} disabled={locked} placeholder="What drove the grade." /></div>
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

function Record(props: { p: InstructorDemoProps; grades: Record<string, ExerciseGrade>; sectionNotes: Record<string, string>; steps: { st: InstructorStep }[]; outcome: string; setOutcome: (v: string) => void; remarks: string; setRemarks: (v: string) => void; additional: boolean; setAdditional: (v: boolean) => void; signed: { instructor: string | null; subject: string | null }; setSigned: (v: { instructor: string | null; subject: string | null }) => void; objection: { reason: string; by: string; at: string } | null; setObjection: (v: { reason: string; by: string; at: string } | null) => void; now: () => string; locked: boolean }) {
  const { p, grades, sectionNotes, outcome, setOutcome, remarks, setRemarks, additional, setAdditional, signed, setSigned, objection, setObjection, now, locked } = props;
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [reason, setReason] = useState(''); const [by, setBy] = useState('');
  const gradeOf = (key: string): ExerciseGrade => grades[key] ?? { result: null, comps: {}, comment: '', role: null };
  const pfCounts = props.steps.filter(({ st }) => st.kind === 'exercise' && st.pfPm && gradeOf(st.key).role).map(({ st }) => ({ counter: st.kind === 'exercise' ? st.pfPm : null, role: gradeOf(st.key).role }));
  const pfLine = pfCounts.length ? `Take-offs as PF ${pfCounts.filter((x) => x.counter === 'take_off' && x.role === 'PF').length} · landings as PF ${pfCounts.filter((x) => x.counter === 'landing' && x.role === 'PF').length} · as PM ${pfCounts.filter((x) => x.role === 'PM').length}` : null;
  const comments = props.steps.filter(({ st }) => st.kind === 'exercise' && gradeOf(st.key).comment.trim()).map(({ st }) => `${st.title}: ${gradeOf(st.key).comment.trim()}`);
  const status = objection ? `INCOMPLETE · objection` : signed.instructor && signed.subject ? 'SIGNED' : signed.instructor || signed.subject ? 'AWAITING SIGNATURE' : 'DRAFT';
  const cell = (v: ExerciseGrade['result'] | CompGrade['grade']) => v === null ? '—' : v === 'pass' ? 'PASS' : v === 'fail' ? 'FAIL' : v === 'competent' ? 'C' : v === 'not_competent' ? 'NC' : v === 'not_observed' ? 'N/O' : String(v);

  return (
    <article className="report" data-testid="report">
      {objection ? <div className="notice notice-bad"><p style={{ margin: 0 }}><strong>Objection recorded.</strong> The record is marked {p.objection.marksRecord} and the {p.objection.notifiesRole.replace(/_/g, ' ')} has been notified to review it (demo: shown here, sent nowhere).</p><p className="small" style={{ margin: '4px 0 0' }}>{objection.by}, {objection.at}: “{objection.reason}”</p></div> : null}
      <header className="report-head">
        <div className="row" style={{ alignItems: 'baseline' }}><div className="report-brand">{p.kindLabel}</div><span className="spacer" /><span className={`chip ${objection ? 'chip-bad' : status === 'SIGNED' ? 'chip-good' : 'chip-warn'}`}><span className="chip-dot" aria-hidden="true" />{status}</span></div>
        <h2 style={{ margin: 'var(--space-2) 0 0' }}>{p.programName}</h2>
        <dl className="report-meta">
          <div><dt>Date</dt><dd>{new Date().toISOString().slice(0, 10)}</dd></div>
          <div><dt>Location</dt><dd className="muted">—</dd></div>
          <div><dt>Device</dt><dd className="muted">— (chosen when the session is created)</dd></div>
          <div><dt>Trainee</dt><dd className="muted">Trainee (demo)</dd></div>
          <div><dt>Position</dt><dd className="muted">—</dd></div>
          <div><dt>Instructor</dt><dd>{p.instructorName}</dd></div>
        </dl>
      </header>

      <table className="data report-table">
        <thead><tr><th scope="col">Exercise</th><th scope="col">Assessed on</th><th scope="col">Competency</th><th scope="col" className="num">Grade</th><th scope="col">Observable behaviours</th></tr></thead>
        <tbody>
          {p.report.sections.map((s) => (
            <SectionRows key={s.key} s={s} gradeOf={gradeOf} cell={cell} phaseLabel={new Map(p.phaseLabels)} note={sectionNotes[s.key]?.trim() || null} />
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
          {signed.instructor ? <span className="chip chip-good"><span className="chip-dot" aria-hidden="true" />Signed · {signed.instructor}</span> : <div><button type="button" className="button" onClick={() => setSigned({ ...signed, instructor: now() })} disabled={!outcome} title={outcome ? undefined : 'Choose the outcome first'}>Sign</button></div>}
        </div>
        <div className="sig-block">
          <div className="xs muted" style={{ letterSpacing: '0.04em' }}>TRAINEE</div>
          <div className="small"><strong>Trainee (demo)</strong></div>
          <p className="sig-statement">{p.statements.subject}{p.statements.subjectExtra ? <><br /><strong>{p.statements.subjectExtra}</strong></> : null}</p>
          {objection ? <span className="chip chip-bad"><span className="chip-dot" aria-hidden="true" />Objected · {objection.at}</span>
            : signed.subject ? <span className="chip chip-good"><span className="chip-dot" aria-hidden="true" />Signed · {signed.subject}</span>
            : <div className="row"><button type="button" className="button" onClick={() => setSigned({ ...signed, subject: now() })} disabled={!signed.instructor} title={signed.instructor ? undefined : 'The instructor signs first'}>Sign</button>{p.objection.allowed ? <button type="button" className="button button-quiet" onClick={() => dialog.current?.showModal()} disabled={!signed.instructor}>{p.objection.label}</button> : null}</div>}
        </div>
      </div>
      <footer className="xs muted mono" style={{ marginTop: 'var(--space-3)' }}>Demo record · content hash — · both signatures attest to this content. Any later change voids them.</footer>

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

function SectionRows({ s, gradeOf, cell, phaseLabel, note }: { s: ReportModel['sections'][number]; gradeOf: (k: string) => ExerciseGrade; cell: (v: ExerciseGrade['result'] | CompGrade['grade']) => string; phaseLabel: Map<string, string>; note: string | null }): ReactNode {
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
            {c ? <><td className="mono">{c}</td><td className="num">{cell(g.comps[c]?.grade ?? null)}</td><td className="xs">{(g.comps[c]?.obs ?? []).length ? g.comps[c]?.obs.join(', ') : <span className="muted">{g.comps[c]?.grade ? 'at standard' : ''}</span>}</td></>
              : <><td className="muted">{r.grading.task_outcome_mode === 'pass_fail' ? 'Pass / fail' : r.grading.task_outcome_mode === 'scale_1_5' ? 'Task 1-5' : '—'}</td><td className="num">{r.grading.task_outcome_mode !== 'none' ? cell(g.result) : ''}</td><td className="xs muted">{r.grading.task_outcome_mode === 'none' ? (r.trainingOnly ? 'training phase, no grade' : 'not graded') : ''}</td></>}
          </tr>
        ));
      })}
    </>
  );
}

export default InstructorDemo;
