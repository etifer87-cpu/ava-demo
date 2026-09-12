/**
 * projection.test.ts - the three views are functions over one tree, and the subject view never
 * carries what the instructor sees. Fixtures invented; no operator content.
 */
import { buildTree, type ElementRow } from '../model';
import { instructorProjection, subjectProjection } from '../projection';
import type { ProgramVocab } from '../shape';

const vocab: ProgramVocab = { sectionKinds: new Set(['block']), phases: new Map([['eval', 'Evaluation'], ['sbt', 'Scenario-based training']]), pfSeats: new Set(['CM1', 'CM2']) };
const row = (o: Partial<ElementRow> & { element_key: string; element_type: string }): ElementRow => ({ parent_key: null, title: o.element_key, external_ref: null, position: 0, is_mandatory: false, is_graded: false, max_attempts: null, content: {}, ...o });

const ROWS: ElementRow[] = [
  row({ element_key: 'eval', element_type: 'section', title: 'EVAL 1', content: { section_kind: 'block', phase: 'eval', time: '0:50', aims: { aims: 'Fly it as on the line' } } }),
  row({ element_key: 'eval.setup', element_type: 'setup', parent_key: 'eval', position: 0, title: 'Set-up', content: { entries: { airport: ['SKBO'], weather: ['CAVOK'] }, mass: { zfw: '58', zfwcg: null, fuel: '7' } } }),
  row({ element_key: 'eval.loft', element_type: 'task', parent_key: 'eval', position: 1, title: 'LOFT', content: { time: '0:45', pf: 'CM1', automation: { ap: 'required_off' }, aims: { aims: 'Own aim', grading_criteria: 'Stable by 1 000 ft', visibility: 'also_on_report' }, conduct: { instructor_notes: 'SECRET NOTE' }, grading: { competency_grade_mode: 'scale_1_5', competencies: ['FPM', 'SAW'] } } }),
  row({ element_key: 'eval.malf', element_type: 'event_option', parent_key: 'eval', position: 2, title: 'Engine', content: { kind: 'malfunction', mode: 'choose_one', options: [{ key: 'a', name: 'COMPRESSOR STALL', option: '1' }, { key: 'b', name: 'FLAME OUT', option: '2' }] } }),
  row({ element_key: 'sbt', element_type: 'section', position: 1, title: 'SBT 1', content: { section_kind: 'block', phase: 'sbt', training_only: true } }),
  row({ element_key: 'sbt.x', element_type: 'task', parent_key: 'sbt', position: 0, title: 'Taxi', content: {} }),
];

describe('instructor projection', () => {
  const view = instructorProjection(buildTree(ROWS, { period: '4:00', aims: { aims: 'Program-wide aim' } }, 'ebt_recurrent', vocab).tree, { runtime: null });
  it('walks every step in program order, sections first', () => {
    expect(view.order.map((o) => o.key)).toEqual(['eval.setup', 'eval.loft', 'eval.malf', 'sbt.x']);
    expect(view.sections.map((s) => s.title)).toEqual(['EVAL 1', 'SBT 1']);
  });
  it('inherits aims downward with the source labelled, most specific last', () => {
    const loft = view.sections[0]?.steps[1];
    expect(loft?.kind).toBe('exercise');
    if (loft?.kind === 'exercise') expect(loft.aims.map((a) => a.source)).toEqual(['Program', 'EVAL 1', 'This exercise']);
  });
  it('carries the instructor notes, the automation and the choose-one grid', () => {
    const loft = view.sections[0]?.steps[1]; const malf = view.sections[0]?.steps[2];
    if (loft?.kind === 'exercise') { expect(loft.notes).toBe('SECRET NOTE'); expect(loft.automation.ap).toBe('required_off'); }
    if (malf?.kind === 'malfunction') { expect(malf.mode).toBe('choose_one'); expect(malf.items).toHaveLength(2); }
  });
});

describe('subject projection - the signed record', () => {
  const report = subjectProjection(buildTree(ROWS, {}, 'ebt_recurrent', vocab).tree);
  it('lists exercises with the failures they were assessed on, by name only', () => {
    const loft = report.sections[0]?.rows[0];
    expect(loft?.title).toBe('LOFT');
    expect(loft?.failures).toEqual(['COMPRESSOR STALL · 1', 'FLAME OUT · 2']);
    expect(loft?.competencies).toEqual(['FPM', 'SAW']);
  });
  it('shows aims only where visibility allows, and never set-up, conduct, notes or timers - asserted over the serialised object', () => {
    const text = JSON.stringify(report);
    expect(text).toContain('Stable by 1 000 ft');
    for (const banned of ['SECRET NOTE', 'SKBO', 'CAVOK', 'required_off', 'instructor_notes', '"minutes"', '"setup"', '"conduct"']) expect(text).not.toContain(banned);
  });
  it('marks a training-only section so the outcome can exclude it', () => {
    expect(report.sections[1]?.trainingOnly).toBe(true);
  });
});
