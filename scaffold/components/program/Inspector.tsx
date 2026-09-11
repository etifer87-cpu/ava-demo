import { formatMinutes } from '@/lib/program/shape';
import { plannedMinutes, type ProgramNode, type ProgramTree } from '@/lib/program/model';
import TaskTabs, { type TaskTabsProps } from './TaskTabs';

/**
 * Inspector - the right pane of the builder. Server component.
 *
 * Renders the one selected element's forms, and the forms that add beneath it. This slice carries
 * STRUCTURE: title, section fields (kind, phase, time, training-only), move, remove, add section,
 * add blank element. The task tabs - Set-up, Conduct, Assessment, Aims - are the next step and
 * slot into the same pane. Every form posts to the elements route and returns here with the
 * changed element selected. Save is a button per form, not per field: the pane has at most one
 * form open at a time and the change is a full round trip anyway.
 */
export interface InspectorProps {
  readonly tree: ProgramTree;
  readonly node: ProgramNode | null;
  readonly templateId: string;
  readonly versionId: string;
  readonly editable: boolean;
  readonly vocab: { readonly sectionKinds: ReadonlySet<string>; readonly phases: ReadonlyMap<string, string>; readonly pfSeats: ReadonlySet<string> };
  /** Picker data for the task tabs; null when the page did not load it (nothing selected). */
  readonly picks: Pick<TaskTabsProps, 'setupOptions' | 'malfunctions' | 'injects' | 'groups' | 'competencies'> | null;
  readonly openTab: TaskTabsProps['open'];
}

const BLANK_TYPES = [['task', 'Task'], ['setup', 'Set-up block'], ['event_option', 'Option group'], ['note', 'Note']] as const;

export function Inspector({ tree, node, templateId, versionId, editable, vocab, picks, openTab }: InspectorProps) {
  const action = `/api/templates/${templateId}/elements`;
  const parentSection = node ? (node.content.type === 'section' ? node : node.parentKey ? tree.byKey.get(node.parentKey) ?? null : null) : null;
  const siblings = node ? (node.parentKey ? tree.byKey.get(node.parentKey)?.children ?? [] : tree.roots) : [];
  const idx = node ? siblings.findIndex((s) => s.key === node.key) : -1;
  const descendants = node ? countDescendants(node) : 0;

  return (
    <aside className="rail inspector" data-testid="inspector" aria-label="Inspector">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h2 className="card-title" style={{ margin: 0 }}>Inspector</h2>
        <span className="spacer" />
        {node ? <span className="mono xs muted">{node.key}</span> : null}
      </div>

      {!editable ? <p className="xs muted" style={{ margin: 0 }}>This version is not a draft. Nothing here can be changed; clone it to a new draft to edit.</p> : null}

      {node ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            <strong>{node.title || node.key}</strong> <span className="xs muted">{node.content.type === 'event_option' ? 'option group' : node.content.type}</span>
            {plannedMinutes(node) !== null ? <span className="xs muted"> · {formatMinutes(plannedMinutes(node))}</span> : null}
          </p>

          {editable ? (
            <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)' }} data-testid="inspector-rename">
              <input type="hidden" name="_action" value="rename" /><input type="hidden" name="version" value={versionId} /><input type="hidden" name="key" value={node.key} />
              <div className="field"><label htmlFor="i-title">Title</label><input id="i-title" name="title" defaultValue={node.title} required minLength={2} maxLength={200} /></div>
              <div><button className="button button-quiet xs" type="submit">Save title</button></div>
            </form>
          ) : null}

          {editable && node.content.type === 'section' ? (
            <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)' }} data-testid="inspector-section">
              <input type="hidden" name="_action" value="set_section" /><input type="hidden" name="version" value={versionId} /><input type="hidden" name="key" value={node.key} />
              <div className="field"><label htmlFor="i-kind">Level</label>
                <select id="i-kind" name="section_kind" defaultValue={node.content.section.section_kind ?? ''}><option value="">-</option>{[...vocab.sectionKinds].map((k) => <option key={k} value={k}>{k}</option>)}</select>
              </div>
              <div className="field"><label htmlFor="i-phase">Phase</label>
                <select id="i-phase" name="phase" defaultValue={node.content.section.phase ?? ''}><option value="">none</option>{[...vocab.phases].map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>
              </div>
              <div className="field"><label htmlFor="i-time">Time (H:MM)</label><input id="i-time" name="time" defaultValue={node.content.section.minutes === null ? '' : formatMinutes(node.content.section.minutes)} pattern="\d{1,2}:[0-5]\d" className="mono" placeholder="empty: sum of the tasks" /></div>
              <label className="check"><input type="checkbox" name="training_only" defaultChecked={node.content.section.training_only} /><span>Training only - grades here do not count</span></label>
              <div><button className="button button-quiet xs" type="submit">Save section</button></div>
            </form>
          ) : null}

          {editable && node.content.type === 'task' && picks ? (
            <TaskTabs task={node.content.task} elementKey={node.key} templateId={templateId} versionId={versionId} pfSeats={[...vocab.pfSeats]} open={openTab} {...picks} />
          ) : null}

          {editable ? (
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <form method="post" action={action}><input type="hidden" name="_action" value="move" /><input type="hidden" name="version" value={versionId} /><input type="hidden" name="key" value={node.key} /><input type="hidden" name="direction" value="up" /><button className="button button-quiet xs" type="submit" disabled={idx <= 0}>Move up</button></form>
              <form method="post" action={action}><input type="hidden" name="_action" value="move" /><input type="hidden" name="version" value={versionId} /><input type="hidden" name="key" value={node.key} /><input type="hidden" name="direction" value="down" /><button className="button button-quiet xs" type="submit" disabled={idx < 0 || idx >= siblings.length - 1}>Move down</button></form>
            </div>
          ) : null}

          {editable ? (
            <details className="collapse">
              <summary className="xs">Remove{descendants ? ` (and ${descendants} beneath)` : ''}</summary>
              <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }} data-testid="inspector-remove">
                <input type="hidden" name="_action" value="remove" /><input type="hidden" name="version" value={versionId} /><input type="hidden" name="key" value={node.key} />
                <label className="check"><input type="checkbox" required /><span>Remove <strong>{node.title || node.key}</strong>{descendants ? ` and the ${descendants} element${descendants === 1 ? '' : 's'} beneath it` : ''}. A draft can always be rebuilt; a key that is removed is gone.</span></label>
                <div><button className="button button-quiet xs" type="submit">Remove</button></div>
              </form>
            </details>
          ) : null}
        </>
      ) : <p className="small muted" style={{ margin: 0 }}>Nothing selected. Choose a section or a task in the program, or add a section below.</p>}

      {editable ? (
        <>
          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: 0 }} />
          <details className="collapse" open={tree.roots.length === 0}>
            <summary>Add a section{parentSection ? ` inside ${parentSection.title || parentSection.key}` : ' at the top level'}</summary>
            <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }} data-testid="inspector-add-section">
              <input type="hidden" name="_action" value="add_section" /><input type="hidden" name="version" value={versionId} /><input type="hidden" name="parent" value={parentSection?.key ?? ''} />
              <div className="field"><label htmlFor="s-title">Title *</label><input id="s-title" name="title" required minLength={2} maxLength={200} placeholder="e.g. EVAL 1" /></div>
              <div className="field"><label htmlFor="s-kind">Level</label><select id="s-kind" name="section_kind" defaultValue="block"><option value="">-</option>{[...vocab.sectionKinds].map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
              <div className="field"><label htmlFor="s-phase">Phase</label><select id="s-phase" name="phase" defaultValue=""><option value="">none</option>{[...vocab.phases].map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div>
              <div className="field"><label htmlFor="s-time">Time (H:MM)</label><input id="s-time" name="time" pattern="\d{1,2}:[0-5]\d" className="mono" placeholder="0:50" /></div>
              <label className="check"><input type="checkbox" name="training_only" /><span>Training only</span></label>
              <div><button className="button xs" type="submit">Add section</button></div>
            </form>
          </details>
          {parentSection ? (
            <details className="collapse">
              <summary>Add a blank element to {parentSection.title || parentSection.key}</summary>
              <form method="post" action={action} className="stack" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }} data-testid="inspector-add-blank">
                <input type="hidden" name="_action" value="add_blank" /><input type="hidden" name="version" value={versionId} /><input type="hidden" name="parent" value={parentSection.key} />
                <div className="field"><label htmlFor="b-type">Type</label><select id="b-type" name="element_type" defaultValue="task">{BLANK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                <div className="field"><label htmlFor="b-title">Title *</label><input id="b-title" name="title" required minLength={2} maxLength={200} /></div>
                <div><button className="button xs" type="submit">Add</button></div>
              </form>
            </details>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function countDescendants(n: ProgramNode): number {
  return n.children.reduce((acc, c) => acc + 1 + countDescendants(c), 0);
}

export default Inspector;
