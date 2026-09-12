/**
 * lib/program/projection.ts - the three views of one program, as functions over the same tree.
 *
 * docs/06_PROGRAM_BUILDER.md section 5.3 and the reference decision: AUTHOR sees everything;
 * INSTRUCTOR sees what is needed at the device (set-up, conduct, notes, automation, aims, the
 * grade controls); the SUBJECT projection is the signed record - names, competencies, grades,
 * outcome, aims only where visibility allows - and NEVER set-up, conduct, notes or timers.
 *
 * The preview screens call these with `runtime: null`; the delivery screens will call the same
 * functions with a real session. One function per view, so a preview cannot drift from the thing
 * it previews. PURE.
 */

import type { ProgramNode, ProgramTree } from './model';
import type { Aims, Grading } from './shape';
import { plannedMinutes, walk } from './model';

/* ------------------------------------------------------------------ */
/* Instructor                                                           */
/* ------------------------------------------------------------------ */

export interface InstructorAims { readonly source: string; readonly aims: Aims }

export type InstructorStep =
  | { readonly kind: 'exercise'; readonly key: string; readonly title: string; readonly minutes: number | null; readonly pf: string | null; readonly snapshot: string | null; readonly pfPm: string | null;
      readonly automation: { ap: string; athr: string; fd: string }; readonly aims: readonly InstructorAims[]; readonly notes: string | null; readonly grading: Grading; readonly trainingOnly: boolean }
  | { readonly kind: 'setup'; readonly key: string; readonly title: string; readonly lines: readonly { label: string; values: readonly string[] }[]; readonly mass: { zfw: string | null; zfwcg: string | null; fuel: string | null }; readonly notes: string | null; readonly snapshot: string | null }
  | { readonly kind: 'malfunction' | 'event'; readonly key: string; readonly title: string; readonly mode: 'sequence' | 'choose_one'; readonly items: readonly { name: string; option: string | null; trigger: string | null; category: string | null }[] }
  | { readonly kind: 'note'; readonly key: string; readonly title: string; readonly text: string };

export interface InstructorSection {
  readonly key: string;
  readonly title: string;
  readonly phase: string | null;
  readonly minutes: number | null;
  readonly trainingOnly: boolean;
  readonly grading: Grading;
  readonly steps: readonly InstructorStep[];
}

export interface InstructorView {
  readonly sections: readonly InstructorSection[];
  /** Every step in navigation order, with its section. */
  readonly order: readonly { readonly key: string; readonly sectionKey: string }[];
  readonly totalMinutes: number | null;
}

const LINE_LABELS: Record<string, string> = { airport: 'Airport', weather: 'Weather', position: 'Position', comms: 'Comms', reset: 'Reset', atc: 'ATC', performance: 'Performance' };

function aimsChain(tree: ProgramTree, node: ProgramNode): InstructorAims[] {
  // Program-level first, then every ancestor section, then the element: most specific last.
  const out: InstructorAims[] = [];
  const hasText = (a: Aims) => Boolean(a.aims || a.competency_focus || a.grading_criteria);
  if (hasText(tree.setup.aims)) out.push({ source: 'Program', aims: tree.setup.aims });
  const chain: ProgramNode[] = [];
  let cur: ProgramNode | undefined = node.parentKey === null ? undefined : tree.byKey.get(node.parentKey);
  while (cur) { chain.unshift(cur); cur = cur.parentKey === null ? undefined : tree.byKey.get(cur.parentKey); }
  for (const s of chain) if (s.content.type === 'section' && hasText(s.content.section.aims)) out.push({ source: s.title || s.key, aims: s.content.section.aims });
  if (node.content.type === 'task' && hasText(node.content.task.aims)) out.push({ source: 'This exercise', aims: node.content.task.aims });
  return out;
}

function stepOf(tree: ProgramTree, n: ProgramNode, trainingOnly: boolean): InstructorStep | null {
  const c = n.content;
  switch (c.type) {
    case 'task':
      return { kind: 'exercise', key: n.key, title: n.title || n.key, minutes: c.task.minutes, pf: c.task.pf, snapshot: c.task.snapshot, pfPm: c.task.pf_pm, automation: c.task.automation, aims: aimsChain(tree, n), notes: c.task.conduct.instructor_notes, grading: c.task.grading, trainingOnly };
    case 'setup':
      return { kind: 'setup', key: n.key, title: n.title || n.key, lines: Object.entries(c.setup.entries).filter(([, v]) => v.length).map(([k, v]) => ({ label: LINE_LABELS[k] ?? k, values: v })), mass: c.setup.mass, notes: c.setup.notes, snapshot: c.setup.snapshot };
    case 'event_option':
      return { kind: c.options.kind, key: n.key, title: n.title || n.key, mode: c.options.mode, items: c.options.options.map((o) => ({ name: o.name, option: o.option, trigger: o.trigger, category: o.category })) };
    case 'note':
      return { kind: 'note', key: n.key, title: n.title || n.key, text: c.note.text };
    default:
      return null;
  }
}

/** The instructor's projection. `runtime` is null for the preview; a session later. */
export function instructorProjection(tree: ProgramTree, _opts: { runtime: null }): InstructorView {
  const sections: InstructorSection[] = [];
  const order: { key: string; sectionKey: string }[] = [];
  const looseKey = '(program)';
  let loose: InstructorStep[] = [];
  for (const root of tree.roots) {
    if (root.content.type !== 'section') {
      const s = stepOf(tree, root, false);
      if (s) { loose.push(s); order.push({ key: s.key, sectionKey: looseKey }); }
      continue;
    }
    const trainingOnly = root.content.section.training_only;
    const steps: InstructorStep[] = [];
    for (const n of walk(root.children)) {
      if (n.content.type === 'section') continue;          // nested sections flatten into their parent
      const s = stepOf(tree, n, trainingOnly);
      if (s) { steps.push(s); order.push({ key: s.key, sectionKey: root.key }); }
    }
    sections.push({ key: root.key, title: root.title || root.key, phase: root.content.section.phase, minutes: plannedMinutes(root), trainingOnly, grading: root.content.section.grading, steps });
  }
  if (loose.length) sections.push({ key: looseKey, title: 'Program', phase: null, minutes: null, trainingOnly: false, grading: { task_outcome_mode: 'none', competency_grade_mode: 'none', competencies: [] }, steps: loose });
  let total: number | null = null;
  for (const r of tree.roots) { const m = plannedMinutes(r); if (m !== null) total = (total ?? 0) + m; }
  return { sections, order, totalMinutes: total };
}

/* ------------------------------------------------------------------ */
/* Subject - the signed record                                          */
/* ------------------------------------------------------------------ */

export interface ReportRow {
  readonly key: string;
  readonly title: string;
  /** Failure names the subject was assessed on. Names only. */
  readonly failures: readonly string[];
  readonly competencies: readonly string[];
  readonly grading: Grading;
  readonly trainingOnly: boolean;
  /** Aims text the visibility allows onto the report. */
  readonly aims: string | null;
  readonly gradingCriteria: string | null;
  /** The record carries a PF/PM choice for this row, counted as this on the line-flying status. */
  readonly pfPm: string | null;
}

export interface ReportSection { readonly key: string; readonly title: string; readonly phase: string | null; readonly trainingOnly: boolean; readonly grading: Grading; readonly rows: readonly ReportRow[] }

export interface ReportModel {
  readonly sections: readonly ReportSection[];
}

/** The subject's projection: what the record shows and both parties sign. Names, grades, outcome - never set-up, conduct, notes or timers. */
export function subjectProjection(tree: ProgramTree): ReportModel {
  const sections: ReportSection[] = [];
  for (const root of tree.roots) {
    if (root.content.type !== 'section') continue;
    const trainingOnly = root.content.section.training_only;
    const rows: ReportRow[] = [];
    // Failures inside the section attach to the exercise they follow; those before any exercise attach to the first.
    let pendingFailures: string[] = [];
    const kids = [...walk(root.children)].filter((n) => n.content.type !== 'section');
    for (const n of kids) {
      const c = n.content;
      if (c.type === 'event_option' && c.options.kind === 'malfunction') {
        const names = c.options.options.map((o) => o.option ? `${o.name.replace(/ · .*$/, '')} · ${o.option}` : o.name);
        const last = rows[rows.length - 1];
        if (last) rows[rows.length - 1] = { ...last, failures: [...last.failures, ...names] }; else pendingFailures.push(...names);
        continue;
      }
      if (c.type !== 'task') continue;
      const onReport = c.task.aims.visibility === 'also_on_report';
      rows.push({
        key: n.key, title: n.title || n.key,
        failures: pendingFailures.splice(0),
        competencies: c.task.grading.competencies, grading: c.task.grading, trainingOnly,
        aims: onReport ? c.task.aims.aims : null,
        gradingCriteria: onReport ? c.task.aims.grading_criteria : null,
        pfPm: c.task.pf_pm,
      });
    }
    sections.push({ key: root.key, title: root.title || root.key, phase: root.content.section.phase, trainingOnly, grading: root.content.section.grading, rows });
  }
  return { sections };
}

