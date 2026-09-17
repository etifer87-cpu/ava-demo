import { AIMS_VISIBILITY, AUTOMATION_STATES, COMPETENCY_GRADE_MODES, SELECTION_POLICIES, SETUP_KINDS, SNAPSHOT_ACTIONS, TASK_OUTCOME_MODES, formatMinutes, type TaskContent } from '@/lib/program/shape';
import type { GroupOption, PickOption } from '@/lib/program/library';

/**
 * TaskTabs - the inspector's content forms for one task. Server component.
 *
 * Four forms - Set-up, Conduct, Assessment, Aims - each posting `set_task` with its tab, so saving
 * one never disturbs another (docs/06 section 5.2, and the reference decision on the four bags).
 * Set-up and the malfunction are PICKERS over the library, never free text: the override field
 * exists for the local variation and sits under the picker. Automation is three selects, always
 * visible, never behind a disclosure. When a slot is chosen the malfunction picker is replaced by
 * the group: if there is a slot, the failure is not chosen here.
 */
export interface TaskTabsProps {
  readonly task: TaskContent;
  readonly elementKey: string;
  readonly templateId: string;
  readonly versionId: string;
  readonly setupOptions: Readonly<Record<(typeof SETUP_KINDS)[number], readonly PickOption[]>>;
  readonly malfunctions: readonly PickOption[];
  readonly injects: readonly PickOption[];
  readonly groups: readonly GroupOption[];
  readonly competencies: readonly { code: string; name: string }[];
  readonly pfSeats: readonly string[];
  readonly open: 'setup' | 'conduct' | 'assessment' | 'aims';
}

const SETUP_LABELS: Record<(typeof SETUP_KINDS)[number], string> = { airport: 'Airport', weather: 'Weather', mass_config: 'Mass & config', position: 'Position', comms: 'Comms', reset: 'Reset', atc_script: 'ATC script' };
const AUTOMATION_LABELS: Record<(typeof AUTOMATION_STATES)[number], string> = { required_on: 'Required ON', required_off: 'Required OFF', crew_discretion: 'Crew discretion', not_applicable: 'N/A' };
const OUTCOME_LABELS: Record<(typeof TASK_OUTCOME_MODES)[number], string> = { none: 'No task result', pass_fail: 'Pass / fail', scale_1_5: 'Scale 1-5' };
const GRADE_LABELS: Record<(typeof COMPETENCY_GRADE_MODES)[number], string> = { none: 'No competency grade', scale_1_5: 'Scale 1-5 per competency', competent_not_competent: 'Competent / not competent' };
const VIS_LABELS: Record<(typeof AIMS_VISIBILITY)[number], string> = { instructor_only: 'Instructor only', also_in_subject_brief: 'Also in the pilot brief', also_on_report: 'Also on the report' };
const POLICY_LABELS: Record<(typeof SELECTION_POLICIES)[number], string> = { instructor_choice: 'Instructor choice', rotation: 'Rotation', random: 'Random', manager_assigned: 'Manager assigned' };

function Picker({ id, name, options, value, empty = '—' }: { id: string; name: string; options: readonly PickOption[]; value: string | null; empty?: string }) {
  const grouped = new Map<string, PickOption[]>();
  for (const o of options) { const g = o.group ?? ''; grouped.set(g, [...(grouped.get(g) ?? []), o]); }
  return (
    <select id={id} name={name} defaultValue={value ?? ''}>
      <option value="">{empty}</option>
      {[...grouped.entries()].map(([g, opts]) => g
        ? <optgroup key={g} label={g}>{opts.map((o) => <option key={o.code} value={o.code}>{o.title}</option>)}</optgroup>
        : opts.map((o) => <option key={o.code} value={o.code}>{o.title}</option>))}
    </select>
  );
}

export function TaskTabs({ task, elementKey, templateId, versionId, setupOptions, malfunctions, injects, groups, competencies, pfSeats, open }: TaskTabsProps) {
  const action = `/api/templates/${templateId}/elements`;
  const hidden = (tab: string) => (<><input type="hidden" name="_action" value="set_task" /><input type="hidden" name="version" value={versionId} /><input type="hidden" name="key" value={elementKey} /><input type="hidden" name="tab" value={tab} /></>);
  const missingRefs = SETUP_KINDS.filter((k) => task.setup[k] && !setupOptions[k].some((o) => o.code === task.setup[k]?.ref));

  return (
    <div className="stack tabs" data-testid="task-tabs">
      <details className="collapse" open={open === 'setup'}>
        <summary>Set-up <span className="xs muted">{SETUP_KINDS.filter((k) => task.setup[k]).length} of {SETUP_KINDS.length} set</span></summary>
        <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }} data-testid="tab-setup">
          {hidden('setup')}
          {SETUP_KINDS.map((k) => (
            <div key={k} className="field">
              <label htmlFor={`su-${k}`}>{SETUP_LABELS[k]}</label>
              <Picker id={`su-${k}`} name={`${k}_ref`} options={setupOptions[k]} value={task.setup[k]?.ref ?? null} empty="not set" />
              <input name={`${k}_override`} defaultValue={task.setup[k]?.override ?? ''} placeholder="local variation (optional)" aria-label={`${SETUP_LABELS[k]} override`} className="xs" />
            </div>
          ))}
          {missingRefs.length ? <p className="xs muted" style={{ margin: 0 }}>References not in the library: {missingRefs.map((k) => task.setup[k]?.ref).join(', ')}. Saving replaces them with what is chosen above.</p> : null}
          <div><button className="button button-quiet xs" type="submit">Save set-up</button></div>
        </form>
      </details>

      <details className="collapse" open={open === 'conduct'}>
        <summary>Conduct <span className="xs muted">{task.conduct.slot ? 'slot' : task.conduct.malfunction ? 'malfunction' : 'no failure'}{task.conduct.injects.length ? ` · ${task.conduct.injects.length} inject${task.conduct.injects.length === 1 ? '' : 's'}` : ''}</span></summary>
        <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }} data-testid="tab-conduct">
          {hidden('conduct')}
          <div className="automation" role="group" aria-label="Automation">
            {(['ap', 'athr', 'fd'] as const).map((k) => (
              <div key={k} className="field">
                <label htmlFor={`au-${k}`}>{k === 'ap' ? 'AP' : k === 'athr' ? 'A/THR' : 'FD'}</label>
                <select id={`au-${k}`} name={k} defaultValue={task.automation[k]}>{AUTOMATION_STATES.map((s) => <option key={s} value={s}>{AUTOMATION_LABELS[s]}</option>)}</select>
              </div>
            ))}
          </div>
          <div className="field">
            <label htmlFor="cd-slot">Failure chosen at delivery from</label>
            <select id="cd-slot" name="slot_group" defaultValue={task.conduct.slot?.group ?? ''}>
              <option value="">No - a fixed failure below</option>
              {groups.map((g) => <option key={g.code} value={g.code}>{g.name} ({g.candidates})</option>)}
            </select>
          </div>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <div className="field" style={{ flex: 1 }}><label htmlFor="cd-policy">Selection</label>
              <select id="cd-policy" name="slot_policy" defaultValue={task.conduct.slot?.policy ?? 'instructor_choice'}>{SELECTION_POLICIES.map((p) => <option key={p} value={p}>{POLICY_LABELS[p]}</option>)}</select>
            </div>
            <div className="field" style={{ width: '6rem' }}><label htmlFor="cd-norep">No repeat within</label><input id="cd-norep" name="slot_no_repeat" type="number" min={1} max={12} defaultValue={task.conduct.slot?.no_repeat_within_modules ?? ''} placeholder="modules" /></div>
          </div>
          <label className="check"><input type="checkbox" name="slot_cycle" defaultChecked={task.conduct.slot?.cycle_coverage ?? false} /><span>Every candidate at least once per cycle</span></label>
          <p className="xs muted" style={{ margin: 0 }}>Slot settings apply only when a group is chosen. Rotation and coverage are recorded as authored; they are evaluated once sessions exist.</p>
          <div className="field">
            <label htmlFor="cd-malf">Fixed malfunction</label>
            <Picker id="cd-malf" name="malfunction_ref" options={malfunctions} value={task.conduct.malfunction?.ref ?? null} empty="none" />
            <input name="malfunction_override" defaultValue={task.conduct.malfunction?.override ?? ''} placeholder="local variation, e.g. option 2, remove after recognition" className="xs" aria-label="Malfunction override" />
          </div>
          <div className="field"><label htmlFor="cd-ins">Insertion</label><input id="cd-ins" name="insertion" defaultValue={task.conduct.insertion ?? ''} maxLength={400} placeholder="e.g. Between V1 and V2 · Passing 1 500 ft AAL" /></div>
          <div className="field">
            <label htmlFor="cd-inj">Injects</label>
            <select id="cd-inj" name="injects" multiple size={Math.min(6, Math.max(3, injects.length))} defaultValue={task.conduct.injects.map((i) => i.ref)}>
              {injects.map((o) => <option key={o.code} value={o.code}>{o.title}</option>)}
            </select>
            <span className="xs muted">Ctrl / Cmd-click to choose several.</span>
          </div>
          <div className="field"><label htmlFor="cd-notes">Instructor notes</label><textarea id="cd-notes" name="instructor_notes" rows={4} maxLength={4000} defaultValue={task.conduct.instructor_notes ?? ''} placeholder="Never leaves the instructor view." /></div>
          <div><button className="button button-quiet xs" type="submit">Save conduct</button></div>
        </form>
      </details>

      <details className="collapse" open={open === 'assessment'}>
        <summary>Assessment <span className="xs muted">{task.grading.task_outcome_mode === 'none' && task.grading.competency_grade_mode === 'none' ? 'not graded' : `${task.grading.competencies.length} competenc${task.grading.competencies.length === 1 ? 'y' : 'ies'}`}</span></summary>
        <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }} data-testid="tab-assessment">
          {hidden('assessment')}
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <div className="field" style={{ width: '6rem' }}><label htmlFor="as-time">Time</label><input id="as-time" name="time" defaultValue={task.minutes === null ? '' : formatMinutes(task.minutes)} pattern="\d{1,2}:[0-5]\d" className="mono" placeholder="0:45" /></div>
            <div className="field" style={{ flex: 1 }}><label htmlFor="as-pf">Pilot flying</label>
              <select id="as-pf" name="pf" defaultValue={task.pf ?? ''}><option value="">not stated</option>{pfSeats.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            </div>
            <div className="field" style={{ flex: 1 }}><label htmlFor="as-snap">Snapshot</label>
              <select id="as-snap" name="snapshot" defaultValue={task.snapshot ?? ''}><option value="">-</option>{SNAPSHOT_ACTIONS.map((s) => <option key={s} value={s}>{s === 'take' ? 'Take a snapshot' : 'Recall the snapshot'}</option>)}</select>
            </div>
          </div>
          <div className="field"><label htmlFor="as-out">Task result</label><select id="as-out" name="task_outcome_mode" defaultValue={task.grading.task_outcome_mode}>{TASK_OUTCOME_MODES.map((m) => <option key={m} value={m}>{OUTCOME_LABELS[m]}</option>)}</select></div>
          <div className="field"><label htmlFor="as-grade">Competency grade</label><select id="as-grade" name="competency_grade_mode" defaultValue={task.grading.competency_grade_mode}>{COMPETENCY_GRADE_MODES.map((m) => <option key={m} value={m}>{GRADE_LABELS[m]}</option>)}</select></div>
          <fieldset className="check-grid" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="xs muted">Competencies targeted</legend>
            {competencies.map((c) => (
              <label key={c.code} className="check"><input type="checkbox" name="competencies" value={c.code} defaultChecked={task.grading.competencies.includes(c.code)} /><span><span className="ccode">{c.code}</span> <span className="xs muted">{c.name}</span></span></label>
            ))}
          </fieldset>
          <div><button className="button button-quiet xs" type="submit">Save assessment</button></div>
        </form>
      </details>

      <details className="collapse" open={open === 'aims' || Boolean(task.aims.aims || task.aims.competency_focus || task.aims.grading_criteria)}>
        <summary>Aims <span className="xs muted">{VIS_LABELS[task.aims.visibility]}</span></summary>
        <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }} data-testid="tab-aims">
          {hidden('aims')}
          <div className="field"><label htmlFor="ai-aims">Aims</label><textarea id="ai-aims" name="aims" rows={3} maxLength={4000} defaultValue={task.aims.aims ?? ''} placeholder="What this task is for." /></div>
          <div className="field"><label htmlFor="ai-focus">Competency focus</label><textarea id="ai-focus" name="competency_focus" rows={3} maxLength={4000} defaultValue={task.aims.competency_focus ?? ''} placeholder="Why these competencies, what to look for here." /></div>
          <div className="field"><label htmlFor="ai-crit">Grading criteria</label><textarea id="ai-crit" name="grading_criteria" rows={3} maxLength={4000} defaultValue={task.aims.grading_criteria ?? ''} placeholder="The standard, in words an instructor can act on." /></div>
          <div className="field"><label htmlFor="ai-vis">Visibility</label><select id="ai-vis" name="visibility" defaultValue={task.aims.visibility}>{AIMS_VISIBILITY.map((v) => <option key={v} value={v}>{VIS_LABELS[v]}</option>)}</select></div>
          <div><button className="button button-quiet xs" type="submit">Save aims</button></div>
        </form>
      </details>
    </div>
  );
}

export default TaskTabs;
