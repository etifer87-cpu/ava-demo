import { phaseColour } from '@/lib/config';
import { formatMinutes } from '@/lib/program/shape';
import { plannedMinutes, type ProgramNode, type ProgramTree } from '@/lib/program/model';

/**
 * Outline - the program tree, read-only. Server component.
 *
 * The seed of the builder canvas (docs/06 section 5.2): every section as a band with its phase
 * as a 3px left rule, every task beneath it with its time and its grading state. No controls
 * here; the builder adds selection and the inspector around this, and the instructor projection
 * draws from the same tree.
 */
export function Outline({ tree, phaseLabels }: { readonly tree: ProgramTree; readonly phaseLabels: ReadonlyMap<string, string> }) {
  if (tree.roots.length === 0) {
    return <p className="muted small" style={{ margin: 0 }}>This version holds no elements yet.</p>;
  }
  return <ol className="outline">{tree.roots.map((n) => <OutlineNode key={n.key} node={n} phaseLabels={phaseLabels} depth={0} />)}</ol>;
}

function OutlineNode({ node, phaseLabels, depth }: { node: ProgramNode; phaseLabels: ReadonlyMap<string, string>; depth: number }) {
  const c = node.content;
  const minutes = plannedMinutes(node);
  if (c.type === 'section') {
    const colour = phaseColour(c.section.phase);
    return (
      <li className="outline-section" style={colour ? { borderLeftColor: colour } : undefined} data-phase={c.section.phase ?? undefined}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <span className="outline-title">{node.title || node.key}</span>
          {c.section.phase ? <span className="xs muted">{phaseLabels.get(c.section.phase) ?? c.section.phase}</span> : null}
          {c.section.training_only ? <span className="xs muted">training only</span> : null}
          <span className="spacer" />
          <span className="mono xs">{minutes === null ? '-' : formatMinutes(minutes)}</span>
        </div>
        {node.children.length ? <ol className="outline" style={{ marginTop: 'var(--space-2)' }}>{node.children.map((k) => <OutlineNode key={k.key} node={k} phaseLabels={phaseLabels} depth={depth + 1} />)}</ol> : null}
      </li>
    );
  }
  const graded = c.type === 'task' && (c.task.grading.task_outcome_mode !== 'none' || c.task.grading.competency_grade_mode !== 'none');
  return (
    <li className={`outline-item outline-${c.type}`}>
      <span className="mono xs muted outline-kind">{c.type === 'event_option' ? 'options' : c.type}</span>
      <span>{node.title || node.key}</span>
      {c.type === 'task' && c.task.grading.competencies.length ? <span className="xs muted">{c.task.grading.competencies.join(' · ')}</span> : null}
      {graded ? <span className="xs muted" title="Carries a grade control">graded</span> : null}
      <span className="spacer" />
      <span className="mono xs">{minutes === null ? '' : formatMinutes(minutes)}</span>
    </li>
  );
}

export default Outline;
