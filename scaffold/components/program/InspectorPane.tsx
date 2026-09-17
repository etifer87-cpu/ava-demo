'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AUTOMATION_STATES, AIMS_VISIBILITY, SETUP_ENTRY_KINDS, SNAPSHOT_ACTIONS, PF_PM_COUNTERS, formatMinutes, type Grading, type Aims, type SetupEntryKind, type OptionGroupContent, type SectionContent, type TaskContent, type SetupContent } from '@/lib/program/shape';
import { EVENT_CATEGORIES, type BehaviourRow, type InspectorData, type InspectorNode } from './inspector-types';

/**
 * InspectorPane - the right pane, one pane per element kind. Client component.
 *
 * Fields save when you leave them (blur) or change them (selects, checkboxes, + and remove): the
 * pane posts the WHOLE content of the element as JSON to `set_content`, the server parses it by
 * the element's type, and the page refreshes. There is no Save button. A refused save shows the
 * reason under the field row and keeps what you typed so it can be corrected.
 *
 * Every pane holds a local copy of the content while editing; the copy is replaced when the
 * server sends a new version of the node (after a refresh), so what you see is what is stored.
 */

const AUTOMATION_LABELS: Record<(typeof AUTOMATION_STATES)[number], string> = { required_on: 'Required ON', required_off: 'Required OFF', crew_discretion: 'Crew discretion', not_applicable: 'N/A' };
const VIS_LABELS: Record<(typeof AIMS_VISIBILITY)[number], string> = { instructor_only: 'Instructor only', also_in_subject_brief: 'Also in the pilot brief', also_on_report: 'Also on the report' };
const ENTRY_LABELS: Record<SetupEntryKind, string> = { airport: 'Airport', weather: 'Weather', position: 'Position', comms: 'Comms', reset: 'Reset', atc: 'ATC', performance: 'Performance' };
const ENTRY_HINTS: Record<SetupEntryKind, string> = { airport: 'ICAO code, e.g. SKBO', weather: 'METAR or a description', position: 'e.g. 12 NM final RWY 01, 3 000 ft', comms: 'Station and frequency', reset: 'What to reset on the IOS', atc: 'The phrase, as ATC says it', performance: 'Speeds, flex, config…' };

type GradeHow = 'none' | 'comp_scale' | 'comp_binary' | 'pass_fail' | 'result_scale';
function howOf(g: Grading): GradeHow {
  if (g.competency_grade_mode === 'scale_1_5') return 'comp_scale';
  if (g.competency_grade_mode === 'competent_not_competent') return 'comp_binary';
  if (g.task_outcome_mode === 'pass_fail') return 'pass_fail';
  if (g.task_outcome_mode === 'scale_1_5') return 'result_scale';
  return 'none';
}
function gradingFor(how: GradeHow, competencies: readonly string[]): Grading {
  switch (how) {
    case 'comp_scale': return { task_outcome_mode: 'none', competency_grade_mode: 'scale_1_5', competencies: [...competencies] };
    case 'comp_binary': return { task_outcome_mode: 'none', competency_grade_mode: 'competent_not_competent', competencies: [...competencies] };
    case 'pass_fail': return { task_outcome_mode: 'pass_fail', competency_grade_mode: 'none', competencies: [] };
    case 'result_scale': return { task_outcome_mode: 'scale_1_5', competency_grade_mode: 'none', competencies: [] };
    default: return { task_outcome_mode: 'none', competency_grade_mode: 'none', competencies: [] };
  }
}

export interface InspectorPaneProps extends InspectorData {
  readonly templateId: string;
  readonly versionId: string;
}

export function InspectorPane(props: InspectorPaneProps) {
  const { node, templateId, versionId, editable } = props;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/elements`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ version: versionId, ...body }) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !data.ok) { setError(data.message ?? `Not saved (${res.status}).`); return false; }
      router.refresh();
      return true;
    } catch { setError('Not saved: the server could not be reached.'); return false; }
    finally { setBusy(false); }
  }, [templateId, versionId, router]);

  const save = useCallback((key: string, content: unknown) => post({ _action: 'set_content', key, content }), [post]);

  useEffect(() => { if (error) { const t = setTimeout(() => setError(null), 10000); return () => clearTimeout(t); } return undefined; }, [error]);

  return (
    <aside className="rail inspector" data-testid="inspector" aria-label="Inspector" aria-busy={busy}>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h2 className="card-title" style={{ margin: 0 }}>{node ? paneTitle(node) : 'Inspector'}</h2>
        <span className="spacer" />
        {busy ? <span className="xs muted">saving…</span> : node ? <span className="mono xs muted">{node.key}</span> : null}
      </div>
      {error ? <div className="notice notice-bad" role="alert"><p style={{ margin: 0 }}>{error}</p></div> : null}
      {!node ? <p className="small muted" style={{ margin: 0 }}>Click an element in the program, or drag one in from the left.</p> : null}
      {node && !editable ? <p className="xs muted" style={{ margin: 0 }}>This version is published. It is shown exactly as it was frozen; take a new draft to change it.</p> : null}

      {node && editable ? <Pane key={node.key} node={node} data={props} save={save} /> : null}
      {node && !editable ? <ReadOnly node={node} data={props} /> : null}

      {node && editable ? <Structure node={node} data={props} post={post} /> : null}
    </aside>
  );
}

function paneTitle(n: InspectorNode): string {
  return n.kind === 'section' ? 'Section' : n.kind === 'exercise' ? 'Exercise' : n.kind === 'setup' ? 'Set-up' : n.kind === 'options' ? (n.content.kind === 'malfunction' ? 'Malfunction' : 'Event') : n.kind === 'note' ? 'Note' : 'Element';
}

function Pane({ node, data, save }: { node: InspectorNode; data: InspectorData; save: (key: string, content: unknown) => Promise<boolean> }) {
  switch (node.kind) {
    case 'section': return <SectionPane node={node} data={data} save={save} />;
    case 'exercise': return <ExercisePane node={node} data={data} save={save} />;
    case 'setup': return <SetupPane node={node} save={save} />;
    case 'options': return node.content.kind === 'malfunction' ? <MalfunctionPane node={node} data={data} save={save} /> : <EventPane node={node} data={data} save={save} />;
    case 'note': return <NotePane node={node} save={save} />;
    default: return <p className="xs muted">Elements of type <span className="mono">{node.elementType}</span> have no pane yet.</p>;
  }
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                        */
/* ------------------------------------------------------------------ */

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="field"><label>{label}</label>{children}{hint ? <span className="xs muted">{hint}</span> : null}</div>;
}

function GradeBlock({ grading, competencies, behaviours, onChange }: { grading: Grading; competencies: readonly { code: string; name: string }[]; behaviours: readonly BehaviourRow[]; onChange: (g: Grading) => void }) {
  const how = howOf(grading);
  const gradable = how !== 'none';
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }} data-testid="grade-block">
      <label className="check"><input type="checkbox" checked={gradable} onChange={(e) => onChange(gradingFor(e.target.checked ? 'comp_scale' : 'none', grading.competencies))} /><span><strong>Gradable</strong> - the instructor records a grade here</span></label>
      {gradable ? (
        <Field label="How">
          <select value={how} onChange={(e) => onChange(gradingFor(e.target.value as GradeHow, grading.competencies))}>
            <option value="comp_scale">Competencies, graded 1-5</option>
            <option value="comp_binary">Competencies, competent / not competent</option>
            <option value="pass_fail">Pass / fail</option>
            <option value="result_scale">Result 1-5, no competencies</option>
          </select>
        </Field>
      ) : null}
      {gradable && (how === 'comp_scale' || how === 'comp_binary') ? (
        <fieldset className="comp-list">
          <legend className="xs muted">Competencies to grade</legend>
          {competencies.map((c) => (
            <label key={c.code} className="check">
              <input type="checkbox" checked={grading.competencies.includes(c.code)} onChange={(e) => onChange({ ...grading, competencies: e.target.checked ? [...grading.competencies, c.code] : grading.competencies.filter((x) => x !== c.code) })} />
              <span><span className="ccode">{c.code}</span> <span className="xs muted">{c.name}</span></span>
            </label>
          ))}
          {grading.competencies.length === 0 ? <span className="xs" style={{ color: 'var(--state-warn)' }}>Tick at least one.</span> : null}
        </fieldset>
      ) : null}
      {gradable ? <BehaviourList codes={grading.competencies} competencies={competencies} behaviours={behaviours} /> : null}
    </div>
  );
}

/**
 * BehaviourList - the observable behaviours of the ticked competencies, from the active framework.
 *
 * Read-only wherever it appears. A program says which competencies an exercise targets; the
 * behaviours are what the instructor will actually be offered against each one when grading, and
 * they are the catalogue's words, not ours. Collapsed, because there are up to nine competencies
 * and the list is long by design.
 */
function BehaviourList({ codes, competencies, behaviours }: { codes: readonly string[]; competencies: readonly { code: string; name: string }[]; behaviours: readonly BehaviourRow[] }) {
  const chosen = competencies.filter((c) => codes.includes(c.code));
  const count = behaviours.filter((b) => codes.includes(b.competency)).length;
  if (chosen.length === 0 || behaviours.length === 0) return null;
  return (
    <details className="collapse" data-testid="ob-list">
      <summary className="xs">Observable behaviours ({count})</summary>
      <div className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        {chosen.map((c) => {
          const obs = behaviours.filter((b) => b.competency === c.code);
          return (
            <div key={c.code}>
              <p className="xs" style={{ margin: 0 }}><span className="ccode">{c.code}</span> <span className="muted">{c.name}</span></p>
              {obs.length === 0
                ? <p className="xs muted" style={{ margin: 0 }}>Nothing in the catalogue for this competency.</p>
                : <ul className="xs muted" style={{ margin: 'var(--space-1) 0 0', paddingLeft: '1.1em' }}>{obs.map((o) => <li key={o.code}><span className="ccode">{o.code}</span> {o.text}</li>)}</ul>}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function AimsBlock({ aims, onChange, onBlur }: { aims: Aims; onChange: (a: Aims) => void; onBlur: () => void }) {
  return (
    <>
      <Field label="Aims"><textarea rows={3} value={aims.aims ?? ''} onChange={(e) => onChange({ ...aims, aims: e.target.value })} onBlur={onBlur} placeholder="What this is for." /></Field>
      <Field label="Competency focus"><textarea rows={3} value={aims.competency_focus ?? ''} onChange={(e) => onChange({ ...aims, competency_focus: e.target.value })} onBlur={onBlur} placeholder="Why these competencies, what to look for here." /></Field>
      <Field label="Grading criteria"><textarea rows={3} value={aims.grading_criteria ?? ''} onChange={(e) => onChange({ ...aims, grading_criteria: e.target.value })} onBlur={onBlur} placeholder="The standard, in words an instructor can act on." /></Field>
      <Field label="Visibility"><select value={aims.visibility} onChange={(e) => onChange({ ...aims, visibility: e.target.value as Aims['visibility'] })}>{AIMS_VISIBILITY.map((v) => <option key={v} value={v}>{VIS_LABELS[v]}</option>)}</select></Field>
    </>
  );
}

function TimeInput({ minutes, onCommit }: { minutes: number | null; onCommit: (m: number | null) => void }) {
  const [v, setV] = useState(minutes === null ? '' : formatMinutes(minutes));
  useEffect(() => { setV(minutes === null ? '' : formatMinutes(minutes)); }, [minutes]);
  return <input className="mono" value={v} placeholder="0:45" onChange={(e) => setV(e.target.value)} onBlur={() => { const m = /^(\d{1,2}):([0-5]\d)$/.exec(v.trim()); if (v.trim() === '') onCommit(null); else if (m) onCommit(Number(m[1]) * 60 + Number(m[2])); else setV(minutes === null ? '' : formatMinutes(minutes)); }} />;
}

/** A hook that keeps a local copy of the content and saves it whole. `flush` saves what is held; `set` updates and (optionally) saves at once. */
function useContent<T>(initial: T, serialise: (v: T) => unknown, key: string, save: (key: string, content: unknown) => Promise<boolean>) {
  const [v, setV] = useState<T>(initial);
  useEffect(() => { setV(initial); }, [initial]);
  const flush = useCallback((next?: T) => { void save(key, serialise(next ?? v)); }, [save, key, serialise, v]);
  const setAndSave = useCallback((next: T) => { setV(next); void save(key, serialise(next)); }, [save, key, serialise]);
  return { v, setV, flush, setAndSave };
}

/* ------------------------------------------------------------------ */
/* Section                                                              */
/* ------------------------------------------------------------------ */

const serialiseSection = (s: SectionContent) => ({ section_kind: s.section_kind, phase: s.phase, time: s.minutes === null ? null : formatMinutes(s.minutes), from_preset: s.from_preset, aims: s.aims, training_only: s.training_only, grading: s.grading });

function SectionPane({ node, data, save }: { node: Extract<InspectorNode, { kind: 'section' }>; data: InspectorData; save: (k: string, c: unknown) => Promise<boolean> }) {
  const { v, setV, flush, setAndSave } = useContent(node.content, serialiseSection, node.key, save);
  return (
    <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-section">
      <div className="two">
        <Field label="Level"><select value={v.section_kind ?? ''} onChange={(e) => setAndSave({ ...v, section_kind: e.target.value || null })}><option value="">-</option>{data.vocab.sectionKinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
        <Field label="Phase"><select value={v.phase ?? ''} onChange={(e) => setAndSave({ ...v, phase: e.target.value || null })}><option value="">none</option>{data.vocab.phases.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></Field>
      </div>
      <div className="two">
        <Field label="Time (H:MM)" hint="Empty: the sum of what is inside."><TimeInput minutes={v.minutes} onCommit={(m) => setAndSave({ ...v, minutes: m })} /></Field>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={v.training_only} onChange={(e) => setAndSave({ ...v, training_only: e.target.checked })} /><span>Training only</span></label>
      </div>
      <GradeBlock grading={v.grading} competencies={data.competencies} behaviours={data.behaviours} onChange={(g) => setAndSave({ ...v, grading: g })} />
      <details className="collapse"><summary>Aims for the whole section</summary>
        <div className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}><AimsBlock aims={v.aims} onChange={(a) => setV({ ...v, aims: a })} onBlur={() => flush()} /></div>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Exercise                                                             */
/* ------------------------------------------------------------------ */

const serialiseTask = (t: TaskContent) => ({
  time: t.minutes === null ? null : formatMinutes(t.minutes), pf: t.pf, setup: t.setup,
  conduct: t.conduct, automation: t.automation, aims: t.aims, grading: t.grading, snapshot: t.snapshot, pf_pm: t.pf_pm, variants: t.variants,
});

function ExercisePane({ node, data, save }: { node: Extract<InspectorNode, { kind: 'exercise' }>; data: InspectorData; save: (k: string, c: unknown) => Promise<boolean> }) {
  const { v, setV, flush, setAndSave } = useContent(node.content, serialiseTask, node.key, save);
  return (
    <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-exercise">
      <div className="three">
        <Field label="Time"><TimeInput minutes={v.minutes} onCommit={(m) => setAndSave({ ...v, minutes: m })} /></Field>
        <Field label="Pilot flying"><select value={v.pf ?? ''} onChange={(e) => setAndSave({ ...v, pf: e.target.value || null })}><option value="">-</option>{data.vocab.pfSeats.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
        <Field label="Snapshot"><select value={v.snapshot ?? ''} onChange={(e) => setAndSave({ ...v, snapshot: (e.target.value || null) as TaskContent['snapshot'] })}><option value="">-</option>{SNAPSHOT_ACTIONS.map((s) => <option key={s} value={s}>{s === 'take' ? 'Save Flight Plan' : 'Recall Flight Plan'}</option>)}</select></Field>
      </div>
      <Field label="PF or PM recorded on the record" hint="For line flying: the instructor marks whether the trainee flew this as PF or PM; take-offs and landings as PF count on the line-flying status.">
        <select value={v.pf_pm ?? ''} onChange={(e) => setAndSave({ ...v, pf_pm: (e.target.value || null) as TaskContent['pf_pm'] })}><option value="">Not recorded</option>{PF_PM_COUNTERS.map((s) => <option key={s} value={s}>{s === 'take_off' ? 'Recorded, counts as a take-off' : s === 'landing' ? 'Recorded, counts as a landing' : 'Recorded, no count'}</option>)}</select>
      </Field>
      <div className="three" role="group" aria-label="Automation">
        {(['ap', 'athr', 'fd'] as const).map((k) => (
          <Field key={k} label={k === 'ap' ? 'AP' : k === 'athr' ? 'A/THR' : 'FD'}>
            <select value={v.automation[k]} onChange={(e) => setAndSave({ ...v, automation: { ...v.automation, [k]: e.target.value as TaskContent['automation']['ap'] } })}>{AUTOMATION_STATES.map((s) => <option key={s} value={s}>{AUTOMATION_LABELS[s]}</option>)}</select>
          </Field>
        ))}
      </div>
      <GradeBlock grading={v.grading} competencies={data.competencies} behaviours={data.behaviours} onChange={(g) => setAndSave({ ...v, grading: g })} />
      <AimsBlock aims={v.aims} onChange={(a) => setV({ ...v, aims: a })} onBlur={() => flush()} />
      <Field label="Instructor notes" hint="Never leaves the instructor view."><textarea rows={4} value={v.conduct.instructor_notes ?? ''} onChange={(e) => setV({ ...v, conduct: { ...v.conduct, instructor_notes: e.target.value } })} onBlur={() => flush()} /></Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Set-up                                                               */
/* ------------------------------------------------------------------ */

const serialiseSetup = (s: SetupContent) => ({ entries: s.entries, mass: s.mass, notes: s.notes, snapshot: s.snapshot });

function SetupPane({ node, save }: { node: Extract<InspectorNode, { kind: 'setup' }>; save: (k: string, c: unknown) => Promise<boolean> }) {
  const { v, setV, flush, setAndSave } = useContent(node.content, serialiseSetup, node.key, save);
  const setEntry = (k: SetupEntryKind, i: number, text: string) => setV({ ...v, entries: { ...v.entries, [k]: v.entries[k].map((x, j) => (j === i ? text : x)) } });
  const addEntry = (k: SetupEntryKind) => setV({ ...v, entries: { ...v.entries, [k]: [...v.entries[k], ''] } });
  const removeEntry = (k: SetupEntryKind, i: number) => setAndSave({ ...v, entries: { ...v.entries, [k]: v.entries[k].filter((_, j) => j !== i) } });
  return (
    <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-setup">
      {SETUP_ENTRY_KINDS.filter((k) => k !== 'performance').map((k) => (
        <div key={k} className="field">
          <div className="row" style={{ gap: 'var(--space-2)' }}><label style={{ margin: 0 }}>{ENTRY_LABELS[k]}</label><span className="spacer" /><button type="button" className="button button-quiet xs" onClick={() => addEntry(k)} aria-label={`Add ${ENTRY_LABELS[k]}`}>+</button></div>
          {v.entries[k].length === 0 ? <span className="xs muted">{ENTRY_HINTS[k]}</span> : null}
          {v.entries[k].map((text, i) => (
            <div key={i} className="row" style={{ gap: 'var(--space-1)', flexWrap: 'nowrap' }}>
              <input value={text} placeholder={ENTRY_HINTS[k]} onChange={(e) => setEntry(k, i, e.target.value)} onBlur={() => flush()} className={k === 'airport' ? 'mono' : ''} />
              <button type="button" className="button button-quiet xs" onClick={() => removeEntry(k, i)} aria-label="Remove">×</button>
            </div>
          ))}
        </div>
      ))}
      <div className="field">
        <label>Mass & config</label>
        <div className="three">
          <input placeholder="ZFW" value={v.mass.zfw ?? ''} onChange={(e) => setV({ ...v, mass: { ...v.mass, zfw: e.target.value } })} onBlur={() => flush()} aria-label="ZFW" />
          <input placeholder="ZFWCG" value={v.mass.zfwcg ?? ''} onChange={(e) => setV({ ...v, mass: { ...v.mass, zfwcg: e.target.value } })} onBlur={() => flush()} aria-label="ZFWCG" />
          <input placeholder="Fuel" value={v.mass.fuel ?? ''} onChange={(e) => setV({ ...v, mass: { ...v.mass, fuel: e.target.value } })} onBlur={() => flush()} aria-label="Fuel" />
        </div>
      </div>
      <div className="field">
        <div className="row" style={{ gap: 'var(--space-2)' }}><label style={{ margin: 0 }}>Performance</label><span className="spacer" /><button type="button" className="button button-quiet xs" onClick={() => addEntry('performance')} aria-label="Add performance line">+</button></div>
        {v.entries.performance.length === 0 ? <span className="xs muted">{ENTRY_HINTS.performance}</span> : null}
        {v.entries.performance.map((text, i) => (
          <div key={i} className="row" style={{ gap: 'var(--space-1)', flexWrap: 'nowrap' }}>
            <textarea rows={2} value={text} onChange={(e) => setEntry('performance', i, e.target.value)} onBlur={() => flush()} />
            <button type="button" className="button button-quiet xs" onClick={() => removeEntry('performance', i)} aria-label="Remove">×</button>
          </div>
        ))}
      </div>
      <Field label="Snapshot"><select value={v.snapshot ?? ''} onChange={(e) => setAndSave({ ...v, snapshot: (e.target.value || null) as SetupContent['snapshot'] })}><option value="">-</option>{SNAPSHOT_ACTIONS.map((s) => <option key={s} value={s}>{s === 'take' ? 'Take a snapshot here' : 'Recall the snapshot here'}</option>)}</select></Field>
      <Field label="Notes"><textarea rows={3} value={v.notes ?? ''} onChange={(e) => setV({ ...v, notes: e.target.value })} onBlur={() => flush()} /></Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Malfunction                                                          */
/* ------------------------------------------------------------------ */

const serialiseOptions = (o: OptionGroupContent) => ({ kind: o.kind, mode: o.mode, fleet: o.fleet, options: o.options, slot: o.slot });
type OptionRow = OptionGroupContent['options'][number];
const rowKey = (base: string, existing: readonly OptionRow[]) => { let k = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'; let n = 2; const taken = new Set(existing.map((r) => r.key)); const b = k; while (taken.has(k)) k = `${b}-${n++}`; return k; };

function ModeSwitch({ mode, count, onChange }: { mode: OptionGroupContent['mode']; count: number; onChange: (m: OptionGroupContent['mode']) => void }) {
  return (
    <Field label="When there is more than one" hint={mode === 'choose_one' ? 'The instructor sees a grid, picks one; the pick is what the record stores.' : 'All of them, in this order.'}>
      <select value={mode} onChange={(e) => onChange(e.target.value as OptionGroupContent['mode'])} disabled={count < 2}>
        <option value="sequence">Run all, in sequence</option>
        <option value="choose_one">Instructor chooses one at delivery</option>
      </select>
    </Field>
  );
}

function MalfunctionPane({ node, data, save }: { node: Extract<InspectorNode, { kind: 'options' }>; data: InspectorData; save: (k: string, c: unknown) => Promise<boolean> }) {
  const { v, setV, flush, setAndSave } = useContent(node.content, serialiseOptions, node.key, save);
  const [q, setQ] = useState('');
  const fleet = v.fleet ?? data.programFleet ?? '';
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return data.malfunctions.filter((m) => m.title.toLowerCase().includes(t) || (m.ata ?? '').includes(t) || (m.system ?? '').toLowerCase().includes(t) || `ata ${m.ata ?? ''}`.includes(t)).slice(0, 30);
  }, [q, data.malfunctions]);
  const add = (m: { code: string; title: string; options: readonly string[] }) => {
    const row: OptionRow = { key: rowKey(m.title, v.options), name: m.title, ref: m.code, option: m.options[0] ?? null, trigger: null, category: null };
    setAndSave({ ...v, options: [...v.options, row] }); setQ('');
  };
  const update = (i: number, patch: Partial<OptionRow>) => setV({ ...v, options: v.options.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const remove = (i: number) => setAndSave({ ...v, options: v.options.filter((_, j) => j !== i) });
  const optionsOf = (ref: string | null) => data.malfunctions.find((m) => m.code === ref)?.options ?? [];
  return (
    <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-malfunction">
      <Field label="Aircraft type">
        <select value={fleet} onChange={(e) => setAndSave({ ...v, fleet: e.target.value || null })}>
          {data.fleets.map((f) => <option key={f.code} value={f.code}>{f.code}</option>)}
        </select>
      </Field>
      {data.malfunctions.length === 0 ? <p className="xs muted" style={{ margin: 0 }}>No malfunction index for {fleet || 'this type'} yet. Failures can still be typed below.</p> : null}
      <Field label="Search" hint="ATA chapter, system or name - e.g. 28, fuel, leak">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a malfunction" />
      </Field>
      {results.length ? (
        <ul className="pick-list" role="listbox">
          {results.map((m) => (
            <li key={m.code}><button type="button" className="pick" onClick={() => add(m)}><span className="mono xs muted">{m.ata ? `ATA ${m.ata}` : ''}</span> <span>{m.title}</span>{m.options.length ? <span className="xs muted"> · {m.options.join(', ')}</span> : null}</button></li>
          ))}
        </ul>
      ) : q.trim() && data.malfunctions.length ? <p className="xs muted" style={{ margin: 0 }}>Nothing matches. Type it below as a custom failure.</p> : null}
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button type="button" className="button button-quiet xs" onClick={() => setAndSave({ ...v, options: [...v.options, { key: rowKey('custom', v.options), name: q.trim() || 'Custom failure', ref: null, option: null, trigger: null, category: null }] })}>+ Custom failure</button>
        {data.groups.length ? (
          <select className="xs" value="" onChange={(e) => { const g = data.groups.find((x) => x.code === e.target.value); if (!g) return; const rows = g.candidates.filter((c) => !v.options.some((r) => r.ref === c.code)).map((c) => ({ key: rowKey(c.title, v.options), name: c.title, ref: c.code, option: c.options[0] ?? null, trigger: null, category: null })); setAndSave({ ...v, options: [...v.options, ...rows], mode: v.options.length + rows.length > 1 ? 'choose_one' : v.mode }); }} aria-label="Load a group of candidates">
            <option value="">Load a group…</option>
            {data.groups.map((g) => <option key={g.code} value={g.code}>{g.name} ({g.candidates.length})</option>)}
          </select>
        ) : null}
      </div>

      <div className="field">
        <label>Failures{v.options.length ? ` (${v.options.length})` : ''}</label>
        {v.options.length === 0 ? <span className="xs muted">None yet. Search above and click to add.</span> : null}
        <ol className="option-rows">
          {v.options.map((r, i) => {
            const opts = optionsOf(r.ref);
            return (
              <li key={r.key} className="option-row">
                <div className="row" style={{ gap: 'var(--space-1)', flexWrap: 'nowrap', alignItems: 'center' }}>
                  <span className="mono xs muted">{i + 1}</span>
                  <input value={r.name} onChange={(e) => update(i, { name: e.target.value })} onBlur={() => flush()} aria-label="Failure" readOnly={r.ref !== null} />
                  {opts.length ? <select value={r.option ?? ''} onChange={(e) => { const next = { ...v, options: v.options.map((x, j) => (j === i ? { ...x, option: e.target.value || null } : x)) }; setAndSave(next); }} aria-label="Option" style={{ width: '6rem' }}>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select> : null}
                  <button type="button" className="button button-quiet xs" onClick={() => remove(i)} aria-label="Remove">×</button>
                </div>
                <input value={r.trigger ?? ''} placeholder="Trigger / insertion, e.g. at V1 · passing 1 500 ft" onChange={(e) => update(i, { trigger: e.target.value })} onBlur={() => flush()} className="xs" aria-label="Trigger" />
              </li>
            );
          })}
        </ol>
      </div>
      <ModeSwitch mode={v.mode} count={v.options.length} onChange={(m) => setAndSave({ ...v, mode: m })} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Event                                                                */
/* ------------------------------------------------------------------ */

function EventPane({ node, data, save }: { node: Extract<InspectorNode, { kind: 'options' }>; data: InspectorData; save: (k: string, c: unknown) => Promise<boolean> }) {
  const { v, setV, flush, setAndSave } = useContent(node.content, serialiseOptions, node.key, save);
  const update = (i: number, patch: Partial<OptionRow>) => setV({ ...v, options: v.options.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const remove = (i: number) => setAndSave({ ...v, options: v.options.filter((_, j) => j !== i) });
  const addBlank = () => setAndSave({ ...v, options: [...v.options, { key: rowKey('event', v.options), name: '', ref: null, option: null, trigger: null, category: 'Other' }] });
  const addFromLibrary = (code: string) => { const e = data.events.find((x) => x.code === code); if (!e) return; setAndSave({ ...v, options: [...v.options, { key: rowKey(e.title, v.options), name: e.title, ref: e.code, option: null, trigger: e.trigger, category: e.category ?? 'Other' }] }); };
  return (
    <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-event">
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button type="button" className="button button-quiet xs" onClick={addBlank}>+ New event</button>
        {data.events.length ? (
          <select className="xs" value="" onChange={(e) => addFromLibrary(e.target.value)} aria-label="Add a pre-created event">
            <option value="">Add a pre-created one…</option>
            {EVENT_CATEGORIES.map((cat) => { const in_ = data.events.filter((e) => (e.category ?? 'Other') === cat); return in_.length ? <optgroup key={cat} label={cat}>{in_.map((e) => <option key={e.code} value={e.code}>{e.title}</option>)}</optgroup> : null; })}
          </select>
        ) : null}
      </div>
      <div className="field">
        <label>Events{v.options.length ? ` (${v.options.length})` : ''}</label>
        {v.options.length === 0 ? <span className="xs muted">None yet.</span> : null}
        <ol className="option-rows">
          {v.options.map((r, i) => (
            <li key={r.key} className="option-row">
              <div className="row" style={{ gap: 'var(--space-1)', flexWrap: 'nowrap', alignItems: 'center' }}>
                <span className="mono xs muted">{i + 1}</span>
                <select value={r.category ?? 'Other'} onChange={(e) => setAndSave({ ...v, options: v.options.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)) })} aria-label="Category" style={{ width: '9rem' }}>{EVENT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                <input value={r.name} placeholder="What happens" onChange={(e) => update(i, { name: e.target.value })} onBlur={() => flush()} aria-label="Event" />
                <button type="button" className="button button-quiet xs" onClick={() => remove(i)} aria-label="Remove">×</button>
              </div>
              <input value={r.trigger ?? ''} placeholder="When / how, e.g. during the weather deviation, single threat ahead" onChange={(e) => update(i, { trigger: e.target.value })} onBlur={() => flush()} className="xs" aria-label="Trigger" />
            </li>
          ))}
        </ol>
      </div>
      <ModeSwitch mode={v.mode} count={v.options.length} onChange={(m) => setAndSave({ ...v, mode: m })} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Note                                                                 */
/* ------------------------------------------------------------------ */

function NotePane({ node, save }: { node: Extract<InspectorNode, { kind: 'note' }>; save: (k: string, c: unknown) => Promise<boolean> }) {
  const { v, setV, flush } = useContent(node.content, (n) => ({ text: n.text }), node.key, save);
  return (
    <div className="stack pane" data-testid="pane-note">
      <Field label="Text" hint="Shown to the instructor with the section it sits in."><textarea rows={8} value={v.text} onChange={(e) => setV({ text: e.target.value })} onBlur={() => flush()} /></Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Read-only and structure                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Read-only - what a published version shows                           */
/* ------------------------------------------------------------------ */

/**
 * A published version is READ far more often than a draft is edited: a training manager opens a
 * program to answer "what does this exercise assess, and against what standard". So the read-only
 * pane carries the same substance as the editable one, field for field, with nothing to type into.
 * It is not a placeholder for the editor; it is the other half of the same screen.
 */
function RO({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label><div className="small" style={{ margin: 0 }}>{children}</div></div>;
}

const DASH = <span className="muted">-</span>;
function shown(v: string | null | undefined): ReactNode { return v && v.trim() ? v : DASH; }

function GradeSummary({ grading, competencies, behaviours }: { grading: Grading; competencies: readonly { code: string; name: string }[]; behaviours: readonly BehaviourRow[] }) {
  const how = howOf(grading);
  const label = how === 'comp_scale' ? 'Competencies, graded 1-5'
    : how === 'comp_binary' ? 'Competencies, competent / not competent'
    : how === 'pass_fail' ? 'Pass / fail'
    : how === 'result_scale' ? 'Result 1-5, no competencies'
    : 'Not graded here';
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }} data-testid="grade-summary">
      <RO label="Graded">{label}</RO>
      {grading.competencies.length > 0 ? (
        <>
          <ul className="small" style={{ margin: 0, paddingLeft: '1.1em' }}>
            {grading.competencies.map((code) => (
              <li key={code}><span className="ccode">{code}</span> <span className="xs muted">{competencies.find((x) => x.code === code)?.name ?? ''}</span></li>
            ))}
          </ul>
          <BehaviourList codes={grading.competencies} competencies={competencies} behaviours={behaviours} />
        </>
      ) : null}
    </div>
  );
}

function AimsSummary({ aims }: { aims: Aims }) {
  if (!aims.aims && !aims.competency_focus && !aims.grading_criteria) return null;
  return (
    <>
      {aims.aims ? <RO label="Aims">{aims.aims}</RO> : null}
      {aims.competency_focus ? <RO label="Competency focus">{aims.competency_focus}</RO> : null}
      {aims.grading_criteria ? <RO label="Grading criteria">{aims.grading_criteria}</RO> : null}
      <p className="xs muted" style={{ margin: 0 }}>{VIS_LABELS[aims.visibility]}</p>
    </>
  );
}

function ReadOnly({ node, data }: { node: InspectorNode; data: InspectorData }) {
  const name = <p className="small" style={{ margin: 0 }}><strong>{node.title || node.key}</strong></p>;
  switch (node.kind) {
    case 'section': {
      const c = node.content;
      return (
        <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-section-ro">
          {name}
          <div className="two">
            <RO label="Level">{shown(c.section_kind)}</RO>
            <RO label="Phase">{shown(data.vocab.phases.find(([code]) => code === c.phase)?.[1] ?? c.phase)}</RO>
          </div>
          <div className="two">
            <RO label="Time">{c.minutes === null ? <span className="muted">the sum of what is inside</span> : <span className="mono">{formatMinutes(c.minutes)}</span>}</RO>
            <RO label="Counts">{c.training_only ? 'Training only - grades here do not count' : 'Counts on the record'}</RO>
          </div>
          <GradeSummary grading={c.grading} competencies={data.competencies} behaviours={data.behaviours} />
          <AimsSummary aims={c.aims} />
        </div>
      );
    }
    case 'exercise': {
      const c = node.content;
      return (
        <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-exercise-ro">
          {name}
          <div className="three">
            <RO label="Time">{c.minutes === null ? DASH : <span className="mono">{formatMinutes(c.minutes)}</span>}</RO>
            <RO label="Pilot flying">{shown(c.pf)}</RO>
            <RO label="Snapshot">{c.snapshot === null ? DASH : c.snapshot === 'take' ? 'Save Flight Plan' : 'Recall Flight Plan'}</RO>
          </div>
          <RO label="PF or PM recorded on the record">{c.pf_pm === null ? 'Not recorded' : c.pf_pm === 'take_off' ? 'Recorded, counts as a take-off' : c.pf_pm === 'landing' ? 'Recorded, counts as a landing' : 'Recorded, no count'}</RO>
          <div className="three">
            <RO label="AP">{AUTOMATION_LABELS[c.automation.ap]}</RO>
            <RO label="A/THR">{AUTOMATION_LABELS[c.automation.athr]}</RO>
            <RO label="FD">{AUTOMATION_LABELS[c.automation.fd]}</RO>
          </div>
          <GradeSummary grading={c.grading} competencies={data.competencies} behaviours={data.behaviours} />
          <AimsSummary aims={c.aims} />
          {c.conduct.instructor_notes ? <RO label="Instructor notes">{c.conduct.instructor_notes}</RO> : null}
        </div>
      );
    }
    case 'setup': {
      const c = node.content;
      const mass = [c.mass.zfw, c.mass.zfwcg, c.mass.fuel].filter((x) => x && x.trim()).join(' · ');
      return (
        <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-setup-ro">
          {name}
          {SETUP_ENTRY_KINDS.filter((k) => c.entries[k].length > 0).map((k) => (
            <RO key={k} label={ENTRY_LABELS[k]}>
              <ul style={{ margin: 0, paddingLeft: '1.1em' }}>{c.entries[k].map((t, i) => <li key={i} className={k === 'airport' ? 'mono' : undefined}>{t}</li>)}</ul>
            </RO>
          ))}
          {mass ? <RO label="Mass & config">{mass}</RO> : null}
          {c.snapshot ? <RO label="Snapshot">{c.snapshot === 'take' ? 'Take a snapshot here' : 'Recall the snapshot here'}</RO> : null}
          {c.notes ? <RO label="Notes">{c.notes}</RO> : null}
        </div>
      );
    }
    case 'options': {
      const c = node.content;
      return (
        <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-options-ro">
          {name}
          <div className="two">
            <RO label="Kind">{c.kind === 'malfunction' ? 'Malfunction' : 'Event'}</RO>
            <RO label="When there is more than one">{c.mode === 'choose_one' ? 'The instructor chooses one at delivery' : 'All of them, in sequence'}</RO>
          </div>
          {c.fleet ? <RO label="Fleet">{c.fleet}</RO> : null}
          <RO label={`${c.options.length} ${c.options.length === 1 ? 'entry' : 'entries'}`}>
            {c.options.length === 0 ? <span className="muted">Empty.</span> : (
              <ul style={{ margin: 0, paddingLeft: '1.1em' }}>
                {c.options.map((o) => (
                  <li key={o.key}>{o.name}
                    {o.option ? <span className="xs muted"> · {o.option}</span> : null}
                    {o.trigger ? <span className="xs muted"> · {o.trigger}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </RO>
        </div>
      );
    }
    case 'note':
      return <div className="stack pane" style={{ gap: 'var(--space-3)' }} data-testid="pane-note-ro">{name}<RO label="Text">{shown(node.content.text)}</RO></div>;
    default:
      return <div className="stack pane" style={{ gap: 'var(--space-3)' }}>{name}<p className="xs muted" style={{ margin: 0 }}>Elements of type <span className="mono">{node.elementType}</span> have no pane yet.</p></div>;
  }
}

function Structure({ node, data, post }: { node: InspectorNode; data: InspectorData; post: (b: Record<string, unknown>) => Promise<boolean> }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const move = async (direction: 'up' | 'down') => { if (await post({ _action: 'move', key: node.key, direction })) router.refresh(); };
  const remove = async () => { if (await post({ _action: 'remove', key: node.key })) { setConfirming(false); router.replace(window.location.pathname); router.refresh(); } };
  return (
    <div className="row" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }} data-testid="inspector-structure">
      <button type="button" className="button button-quiet xs" onClick={() => void move('up')} disabled={data.index <= 0}>Move up</button>
      <button type="button" className="button button-quiet xs" onClick={() => void move('down')} disabled={data.index < 0 || data.index >= data.siblingCount - 1}>Move down</button>
      <span className="spacer" />
      {!confirming ? <button type="button" className="button button-quiet xs" onClick={() => setConfirming(true)}>Remove{data.descendants ? ` (+${data.descendants})` : ''}</button>
        : <><span className="xs">Remove <strong>{node.title || node.key}</strong>{data.descendants ? ` and ${data.descendants} beneath` : ''}?</span><button type="button" className="button xs" onClick={() => void remove()}>Yes, remove</button><button type="button" className="button button-quiet xs" onClick={() => setConfirming(false)}>Keep</button></>}
    </div>
  );
}

export default InspectorPane;
