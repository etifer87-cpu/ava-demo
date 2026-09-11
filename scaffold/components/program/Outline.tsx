import Link from 'next/link';
import { phaseColour } from '@/lib/config';
import { formatMinutes } from '@/lib/program/shape';
import { plannedMinutes, type ProgramNode, type ProgramTree } from '@/lib/program/model';

/**
 * Outline - the program canvas. Server component.
 *
 * Every section is a band with its phase as a 3px left rule; every element beneath is a row.
 * Selection is a URL (`?sel=<key>`), so the inspector is server-rendered for the one element that
 * is selected and the other rows are plain markup (docs/06 section 5.2, "one form, not
 * thirty-four"). No client state, no drag - placing and moving are forms in the inspector.
 */
export interface OutlineProps {
  readonly tree: ProgramTree;
  readonly phaseLabels: ReadonlyMap<string, string>;
  readonly selected: string | null;
  /** Builds the href that selects a key, keeping the other query parameters. */
  readonly hrefFor: (key: string) => string;
}

export function Outline({ tree, phaseLabels, selected, hrefFor }: OutlineProps) {
  if (tree.roots.length === 0) {
    return <p className="muted small" style={{ margin: 0 }}>No sections yet. Add the first one on the right.</p>;
  }
  return <ol className="outline">{tree.roots.map((n) => <OutlineNode key={n.key} node={n} phaseLabels={phaseLabels} selected={selected} hrefFor={hrefFor} />)}</ol>;
}

function OutlineNode({ node, phaseLabels, selected, hrefFor }: { node: ProgramNode; phaseLabels: ReadonlyMap<string, string>; selected: string | null; hrefFor: (k: string) => string }) {
  const c = node.content;
  const minutes = plannedMinutes(node);
  const isSel = node.key === selected;
  if (c.type === 'section') {
    const colour = phaseColour(c.section.phase);
    return (
      <li className={`outline-section${isSel ? ' is-selected' : ''}`} style={colour ? { borderLeftColor: colour } : undefined} data-phase={c.section.phase ?? undefined} data-key={node.key}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <Link href={hrefFor(node.key)} className="outline-title" aria-current={isSel ? 'true' : undefined}>{node.title || node.key}</Link>
          {c.section.phase ? <span className="xs muted">{phaseLabels.get(c.section.phase) ?? c.section.phase}</span> : null}
          {c.section.section_kind ? <span className="xs muted">{c.section.section_kind}</span> : null}
          {c.section.training_only ? <span className="xs muted">training only</span> : null}
          <span className="spacer" />
          <span className="mono xs">{minutes === null ? '-' : formatMinutes(minutes)}</span>
        </div>
        {node.children.length ? (
          <ol className="outline" style={{ marginTop: 'var(--space-2)' }}>{node.children.map((k) => <OutlineNode key={k.key} node={k} phaseLabels={phaseLabels} selected={selected} hrefFor={hrefFor} />)}</ol>
        ) : <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>Empty section. Select it and place a task from the library.</p>}
      </li>
    );
  }
  const graded = c.type === 'task' && (c.task.grading.task_outcome_mode !== 'none' || c.task.grading.competency_grade_mode !== 'none');
  const modified = c.type === 'task' && Object.values(c.task.setup).some((r) => r && r.override) ;
  return (
    <li className={`outline-item outline-${c.type}${isSel ? ' is-selected' : ''}`} data-key={node.key}>
      <span className="mono xs muted outline-kind">{c.type === 'event_option' ? 'options' : c.type}</span>
      <Link href={hrefFor(node.key)} aria-current={isSel ? 'true' : undefined}>{node.title || node.key}</Link>
      {c.type === 'task' && c.task.pf ? <span className="xs muted">PF {c.task.pf}</span> : null}
      {c.type === 'task' && c.task.grading.competencies.length ? <span className="xs muted">{c.task.grading.competencies.join(' · ')}</span> : null}
      {c.type === 'task' && c.task.conduct.slot ? <span className="xs muted" title="Failure chosen at delivery from an equivalency group">slot</span> : null}
      {graded ? <span className="xs muted" title="Carries a grade control">graded</span> : null}
      {modified ? <span className="xs muted" title="A set-up field departs from its library text">modified</span> : null}
      <span className="spacer" />
      <span className="mono xs">{minutes === null ? '' : formatMinutes(minutes)}</span>
    </li>
  );
}

export default Outline;
