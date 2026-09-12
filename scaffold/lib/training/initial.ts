/**
 * initial.ts - where an initial-training pilot stands, derived from their sessions.
 *
 * Pure: no database, no config lookup. The page reads the sessions that carry setup.course and
 * hands them here with the stage order from policy.yaml; the board, the table and the drawer all
 * read the same card. The card is never stored: a session signed today moves the pilot on the
 * next render, which is what "moved automatically by milestone" means.
 *
 * Rules
 *   - A stage is DONE when it has sessions and every one of them is past in_progress; a stage
 *     that is a check (skill test, line check) also needs a passing outcome on its last session.
 *   - The pilot's stage is the first stage in order that is not done. With every stage done the
 *     pilot is RELEASED (stage key 'released', shown after the last configured column).
 *   - Progress is the share of applicable milestones complete; the simulator and LFUS stages
 *     weigh by their sessions flown, so a pilot on sector 12 of 20 sits at a visible fraction of
 *     that stage rather than at 0 or 100.
 *   - RAG: 'bad' when any milestone session failed or carries an objection or a recommendation
 *     for additional training; 'warn' when a planned session's date has passed without being
 *     flown (behind schedule); 'good' otherwise.
 */

export interface MilestoneSession {
  id: string;
  stage: string;
  session_number: number | null;
  session_date: string;
  status: string;
  outcome: string | null;
  check: string | null;
  departure: string | null;
  arrival: string | null;
  sector_number: number | null;
  seat: string | null;
  aircraft_type: string | null;
  registration: string | null;
  assessor_name: string | null;
  template_name: string | null;
  record_id: string | null;
  additional_training: boolean;
  objected: boolean;
}

export interface StageDef { key: string; label: string; check?: boolean }

export interface Milestone {
  key: string; label: string;
  state: 'done' | 'current' | 'planned' | 'pending';
  from: string | null; to: string | null;
  done: number; total: number;
  outcome: string | null;
  sessions: MilestoneSession[];
}

export interface InitialCard {
  stage: string; stageLabel: string; released: boolean;
  progress: number;
  rag: 'good' | 'warn' | 'bad';
  ffs: { done: number; total: number };
  lfus: { flown: number; total: number; pf: number };
  next: { date: string; stage: string } | null;
  overdue: number;
  milestones: Milestone[];
}

const FAIL = /FAIL|NOT PROFICIENT|NOT COMPETENT|INCOMPLETE/;
const flown = (s: MilestoneSession) => s.status !== 'in_progress' && s.status !== 'void';

export function buildInitialCard(sessions: readonly MilestoneSession[], stages: readonly StageDef[], today: string, releasedLabel: string): InitialCard {
  const byStage = new Map<string, MilestoneSession[]>();
  for (const s of [...sessions].sort((a, b) => a.session_date.localeCompare(b.session_date) || (a.session_number ?? 0) - (b.session_number ?? 0) || (a.sector_number ?? 0) - (b.sector_number ?? 0))) {
    if (!byStage.has(s.stage)) byStage.set(s.stage, []);
    byStage.get(s.stage)!.push(s);
  }

  const milestones: Milestone[] = [];
  let current: string | null = null;
  for (const st of stages) {
    const ss = byStage.get(st.key) ?? [];
    const done = ss.filter(flown);
    const last = done.at(-1) ?? null;
    const passed = st.check ? (last?.outcome !== null && last?.outcome !== undefined && !FAIL.test(last.outcome)) : true;
    const complete = ss.length > 0 && done.length === ss.length && passed;
    let state: Milestone['state'];
    if (complete) state = 'done';
    else if (current === null) { state = 'current'; current = st.key; }
    else state = ss.length ? 'planned' : 'pending';
    milestones.push({ key: st.key, label: st.label, state, from: ss[0]?.session_date ?? null, to: ss.at(-1)?.session_date ?? null, done: done.length, total: ss.length, outcome: st.check ? last?.outcome ?? null : null, sessions: ss });
  }
  const released = current === null;

  // Progress: each stage weighs 1; sessions-based stages weigh by their fraction flown.
  const weight = milestones.map((m) => (m.state === 'done' ? 1 : m.total > 0 ? m.done / m.total : 0));
  const progress = stages.length ? Math.round((weight.reduce((a, b) => a + b, 0) / stages.length) * 100) : 0;

  const all = [...byStage.values()].flat();
  const lfusAll = byStage.get('lfus') ?? [];
  const ffsAll = byStage.get('simulator') ?? [];
  const overdue = all.filter((s) => s.status === 'in_progress' && s.session_date < today).length;
  const bad = all.some((s) => flown(s) && ((s.outcome && FAIL.test(s.outcome)) || s.additional_training || s.objected));
  const nextS = all.filter((s) => s.status === 'in_progress' && s.session_date >= today).sort((a, b) => a.session_date.localeCompare(b.session_date))[0] ?? null;

  return {
    stage: released ? 'released' : current!,
    stageLabel: released ? releasedLabel : stages.find((s) => s.key === current)?.label ?? current!,
    released,
    progress: released ? 100 : progress,
    rag: bad ? 'bad' : overdue ? 'warn' : 'good',
    ffs: { done: ffsAll.filter(flown).length, total: ffsAll.length },
    lfus: { flown: lfusAll.filter(flown).length, total: lfusAll.length, pf: lfusAll.filter((s) => flown(s) && s.seat === 'PF').length },
    next: nextS ? { date: nextS.session_date, stage: nextS.stage } : null,
    overdue,
    milestones,
  };
}
