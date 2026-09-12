/**
 * program.test.ts - the content shape, the tree and the findings.
 *
 * Each test names the failure it prevents. Every fixture below is invented to exercise a rule and
 * carries no operator content. Runner-agnostic: describe / it / expect.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { formatMinutes, isModifiedFromLibrary, parseMinutes, parseTaskContent, parseSectionContent, parseSetupContent, parseOptionGroupContent, serialiseTaskContent, serialiseSetupContent, type ProgramVocab } from '../shape';
import { buildTree, plannedMinutes, totalPlannedMinutes, type ElementRow } from '../model';
import { assertRegistryComplete, evaluate, RULE_IMPLEMENTATIONS, type RuleRegistry } from '../rules';

const vocab: ProgramVocab = {
  sectionKinds: new Set(['module', 'session', 'block']),
  phases: new Map([['brief', 'Briefing'], ['eval', 'Evaluation'], ['mt', 'Manoeuvres training'], ['sbt', 'Scenario-based training'], ['reinf', 'Additional training'], ['debrief', 'Debriefing']]),
  pfSeats: new Set(['CM1', 'CM2']),
};

/** The registry the product ships, read from disk: the test proves the file, not a copy of it. */
const registry: RuleRegistry = parseYaml(readFileSync(path.resolve(process.cwd(), 'config/rules.yaml'), 'utf8')) as RuleRegistry;

const row = (o: Partial<ElementRow> & { element_key: string; element_type: string }): ElementRow => ({
  parent_key: null, title: o.element_key, external_ref: null, position: 0, is_mandatory: false, is_graded: o.element_type === 'task', max_attempts: null, content: {},
  ...o,
});

/* ------------------------------------------------------------------ */
describe('minutes', () => {
  it('parses H:MM and round-trips, so a time saved twice is byte-identical', () => {
    expect(parseMinutes('0:50')).toBe(50);
    expect(parseMinutes('1:15')).toBe(75);
    expect(parseMinutes(45)).toBe(45);
    expect(formatMinutes(75)).toBe('1:15');
    expect(formatMinutes(parseMinutes('4:00'))).toBe('4:00');
  });
  it('returns null, never 0, for absent or malformed - null is "not stated"', () => {
    expect(parseMinutes('')).toBeNull();
    expect(parseMinutes('ninety')).toBeNull();
    expect(parseMinutes('1:75')).toBeNull();
    expect(parseMinutes(null)).toBeNull();
  });
});

describe('task content', () => {
  it('reads a full task and reports nothing', () => {
    const { value, problems } = parseTaskContent({
      time: '0:45', pf: 'CM2',
      setup: { airport: 'apt.skbo', weather: { ref: 'wx.skbo.rain', override: '29008KT 4000 -RA' } },
      conduct: { malfunction: 'malf.athr.ch1', insertion: 'Passing 1500 ft AAL', injects: ['inj.tcas.ta'], instructor_notes: 'Vary the moment.' },
      automation: { ap: 'required_off', athr: 'required_on', fd: 'required_on' },
      aims: { grading_criteria: 'Stabilised by 1000 ft AFE', visibility: 'also_on_report' },
      grading: { task_outcome_mode: 'none', competency_grade_mode: 'scale_1_5', competencies: ['FPM', 'SAW', 'WLM'] },
      snapshot: 'take',
    }, vocab);
    expect(problems).toEqual([]);
    expect(value.minutes).toBe(45);
    expect(value.pf).toBe('CM2');
    expect(value.setup.airport).toEqual({ ref: 'apt.skbo', override: null });
    expect(value.setup.weather?.override).toBe('29008KT 4000 -RA');
    expect(value.conduct.injects).toHaveLength(1);
    expect(value.grading.competencies).toEqual(['FPM', 'SAW', 'WLM']);
    expect(isModifiedFromLibrary(value)).toBe(true);
  });

  it('drops an unknown enum value AND reports it, so a bad field hides itself and not the task', () => {
    const { value, problems } = parseTaskContent({ automation: { ap: 'sometimes' }, pf: 'CAPTAIN' }, vocab);
    expect(value.automation.ap).toBe('crew_discretion');
    expect(value.pf).toBeNull();
    expect(problems.map((p) => p.path).sort()).toEqual(['automation.ap', 'pf']);
  });

  it('never renders pilot flying as "both": null stays null', () => {
    expect(parseTaskContent({}, vocab).value.pf).toBeNull();
    expect(parseTaskContent({ pf: 'both' }, vocab).value.pf).toBeNull();
  });

  it('a slot wins over a fixed malfunction, and says so', () => {
    const { value, problems } = parseTaskContent({ conduct: { malfunction: 'malf.x', slot: { group: 'eg.engine-takeoff', policy: 'rotation', no_repeat_within_modules: 3 } } }, vocab);
    expect(value.conduct.malfunction).toBeNull();
    expect(value.conduct.slot?.group).toBe('eg.engine-takeoff');
    expect(problems.some((p) => p.path === 'conduct.malfunction')).toBe(true);
  });

  it('competency grading with no target competency is reported - a grade against nothing', () => {
    const { problems } = parseTaskContent({ grading: { competency_grade_mode: 'scale_1_5' } }, vocab);
    expect(problems.some((p) => p.path === 'grading.competencies')).toBe(true);
  });

  it('serialises to the canonical spelling and parses back to the same value', () => {
    const first = parseTaskContent({ time: 30, setup: { airport: 'apt.skcl' }, grading: { competencies: ['KNO'] } }, vocab).value;
    const again = parseTaskContent(serialiseTaskContent(first), vocab);
    expect(again.problems).toEqual([]);
    expect(again.value).toEqual(first);
    expect(serialiseTaskContent(first).time).toBe('0:30');
  });
});

describe('section content', () => {
  it('accepts only the operator phases and section kinds', () => {
    const ok = parseSectionContent({ section_kind: 'block', phase: 'sbt', time: '0:35', training_only: true }, vocab);
    expect(ok.problems).toEqual([]);
    expect(ok.value.phase).toBe('sbt');
    const bad = parseSectionContent({ section_kind: 'chapter', phase: 'lunch' }, vocab);
    expect(bad.value.phase).toBeNull();
    expect(bad.problems.map((p) => p.path).sort()).toEqual(['phase', 'section_kind']);
  });
});

describe('set-up content', () => {
  it('folds the older {rows:[{label,value}]} shape into entries by label, so seeded blocks still read', () => {
    const { value, problems } = parseSetupContent({ rows: [{ label: 'Airport', value: 'SKBO' }, { label: 'Weather', value: '29008KT 4000 -RA' }, { label: 'Comms', value: '118.7' }] });
    expect(problems).toEqual([]);
    expect(value.entries.airport).toEqual(['SKBO']);
    expect(value.entries.comms).toEqual(['118.7']);
  });
  it('keeps mass as three fields and round-trips', () => {
    const first = parseSetupContent({ entries: { airport: ['SKCL', ' '], position: ['12 NM final'] }, mass: { zfw: '60.4', zfwcg: '28', fuel: '6.0' } }).value;
    expect(first.entries.airport).toEqual(['SKCL']);            // blank lines dropped
    const again = parseSetupContent(serialiseSetupContent(first));
    expect(again.problems).toEqual([]);
    expect(again.value).toEqual(first);
  });
});

describe('option group content', () => {
  it('defaults to a malfunction in sequence, and keeps the row references the pane writes', () => {
    const { value, problems } = parseOptionGroupContent({ kind: 'event', mode: 'choose_one', options: [{ key: 'a', name: 'TCAS RA', category: 'TCAS', trigger: 'in the descent' }] });
    expect(problems).toEqual([]);
    expect(value.kind).toBe('event');
    expect(value.mode).toBe('choose_one');
    expect(value.options[0]?.category).toBe('TCAS');
    expect(parseOptionGroupContent({}).value).toMatchObject({ kind: 'malfunction', mode: 'sequence', options: [] });
  });
});

describe('section grading', () => {
  it('a section can carry its own grade controls, and a graded section reports competencies it needs', () => {
    const ok = parseSectionContent({ phase: 'eval', grading: { competency_grade_mode: 'scale_1_5', competencies: ['FPM'] } }, vocab);
    expect(ok.problems).toEqual([]);
    expect(ok.value.grading.competency_grade_mode).toBe('scale_1_5');
    const bad = parseSectionContent({ grading: { competency_grade_mode: 'scale_1_5' } }, vocab);
    expect(bad.problems.some((p) => p.path === 'grading.competencies')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
const DAY: ElementRow[] = [
  row({ element_key: 'eval1', element_type: 'section', position: 0, content: { section_kind: 'block', phase: 'eval', time: '0:50' } }),
  row({ element_key: 'eval1.loft', element_type: 'task', parent_key: 'eval1', position: 0, content: { grading: { competency_grade_mode: 'scale_1_5', competencies: ['FPM', 'SAW', 'WLM'] }, aims: { grading_criteria: 'stated' } } }),
  row({ element_key: 'mt', element_type: 'section', position: 1, content: { section_kind: 'block', phase: 'mt', time: '0:30' } }),
  row({ element_key: 'mt.uprt', element_type: 'task', parent_key: 'mt', position: 0, content: {} }),
  row({ element_key: 'sbt1', element_type: 'section', position: 2, content: { section_kind: 'block', phase: 'sbt', training_only: true } }),
  row({ element_key: 'sbt1.t1', element_type: 'task', parent_key: 'sbt1', position: 0, content: { time: '0:20' } }),
  row({ element_key: 'sbt1.t2', element_type: 'task', parent_key: 'sbt1', position: 1, content: { time: '0:15' } }),
  row({ element_key: 'reinf', element_type: 'section', position: 3, content: { section_kind: 'block', phase: 'reinf', time: '0:15' } }),
  row({ element_key: 'reinf.note', element_type: 'note', parent_key: 'reinf', position: 0, content: { text: 'Repeat what needs repeating.' } }),
];

describe('tree', () => {
  it('nests by parent_key in position order and sums times upward; a section with its own time wins', () => {
    const { tree, problems } = buildTree(DAY, { period: '4:00' }, 'ebt_recurrent', vocab);
    expect(problems).toEqual([]);
    expect(tree.roots.map((r) => r.key)).toEqual(['eval1', 'mt', 'sbt1', 'reinf']);
    expect(tree.byKey.get('sbt1')?.children.map((c) => c.key)).toEqual(['sbt1.t1', 'sbt1.t2']);
    expect(plannedMinutes(tree.byKey.get('sbt1')!)).toBe(35);       // summed from children
    expect(plannedMinutes(tree.byKey.get('eval1')!)).toBe(50);      // own time, child has none
    expect(totalPlannedMinutes(tree)).toBe(130);
    expect(tree.setup.period_minutes).toBe(240);
  });

  it('shows an orphan at the root and reports it, rather than dropping the task nobody can see', () => {
    const rows = [...DAY, row({ element_key: 'lost', element_type: 'task', parent_key: 'no-such-section', position: 9 })];
    const { tree, problems } = buildTree(rows, {}, 'ebt_recurrent', vocab);
    expect(tree.roots.some((r) => r.key === 'lost')).toBe(true);
    expect(problems.find((p) => p.elementKey === 'lost')?.path).toBe('parent_key');
  });

  it('breaks a parent cycle and reports it', () => {
    const rows = [
      row({ element_key: 'a', element_type: 'section', parent_key: 'b', content: { section_kind: 'block' } }),
      row({ element_key: 'b', element_type: 'section', parent_key: 'a', content: { section_kind: 'block' } }),
    ];
    const { tree, problems } = buildTree(rows, {}, 'ebt_recurrent', vocab);
    expect(problems.map((p) => p.elementKey)).toEqual(['a', 'a']);           // a is unreachable, and a.parent_key closes the cycle
    expect(new Set(problems.map((p) => p.message)).size).toBe(2);
    expect(tree.roots.map((r) => r.key)).toEqual(['a']);
    expect(tree.byKey.get('a')?.children.map((c) => c.key)).toEqual(['b']);
    expect(tree.byKey.get('b')?.children).toEqual([]);
  });

  it('tags a shape problem with the element it belongs to', () => {
    const rows = [row({ element_key: 't', element_type: 'task', content: { pf: 'CAPT' } })];
    const { problems } = buildTree(rows, {}, 'ebt_recurrent', vocab);
    expect(problems).toEqual([{ elementKey: 't', path: 'pf', message: expect.stringContaining('CM1') }]);
  });
});

/* ------------------------------------------------------------------ */
describe('rules registry', () => {
  it('rules.yaml and RULE_IMPLEMENTATIONS name the same ids - a rule on one side only fails here, not on a screen', () => {
    expect(() => assertRegistryComplete(registry)).not.toThrow();
    expect(new Set(registry.rules.map((r) => r.id))).toEqual(new Set(Object.keys(RULE_IMPLEMENTATIONS)));
  });
  it('refuses a registry row with no implementation, naming it', () => {
    const bad: RuleRegistry = { version: 't', rules: [...registry.rules, { id: 'made.up', severity: 'warn', message: 'x' }] };
    expect(() => assertRegistryComplete(bad)).toThrow(/made\.up/);
  });
});

describe('findings', () => {
  const build = (rows: ElementRow[], setup: unknown = { period: '4:00' }, kind = 'ebt_recurrent') => evaluate(buildTree(rows, setup, kind, vocab).tree, registry);
  const ids = (rows: ElementRow[], setup?: unknown, kind?: string) => build(rows, setup, kind).map((f) => f.rule);

  it('a complete EBT day passes the phase and reinforcement blockers', () => {
    const f = build(DAY);
    expect(f.map((x) => x.rule)).not.toContain('ebt.three_phases');
    expect(f.map((x) => x.rule)).not.toContain('reinf.present');
  });

  it('an EBT module missing a phase is a blocker naming the missing phase', () => {
    const noSbt = DAY.filter((r) => !r.element_key.startsWith('sbt1'));
    const f = build(noSbt).find((x) => x.rule === 'ebt.three_phases');
    expect(f?.severity).toBe('block');
    expect(f?.detail).toContain('sbt');
  });

  it('phase rules do not run on a kind they do not apply to', () => {
    expect(ids(DAY.filter((r) => !r.element_key.startsWith('sbt1')), { period: '4:00' }, 'proficiency_check')).not.toContain('ebt.three_phases');
  });

  it('the time budget counts only phases inside the device: a 1:00 briefing outside a 4:00 period is not "over"', () => {
    const rows = [...DAY, row({ element_key: 'brief', element_type: 'section', position: -1, content: { section_kind: 'block', phase: 'brief', time: '1:00' } }), row({ element_key: 'brief.t', element_type: 'task', parent_key: 'brief', content: {} })];
    const f = build(rows).find((x) => x.rule === 'time.budget');
    expect(f?.detail).toBe('2:10 of 4:00');            // the briefing hour is not in the 2:10
  });

  it('the time budget warns with the numbers, and stays silent when nothing is stated', () => {
    const f = build(DAY).find((x) => x.rule === 'time.budget');
    expect(f?.severity).toBe('warn');
    expect(f?.detail).toBe('2:10 of 4:00');
    expect(ids(DAY, {})).not.toContain('time.budget');
  });

  it('a graded task inside a training-only section is a blocker pointing at the task', () => {
    const rows = DAY.map((r) => (r.element_key === 'sbt1.t1' ? { ...r, content: { grading: { task_outcome_mode: 'pass_fail' } } } : r));
    const f = build(rows).find((x) => x.rule === 'training_only.not_graded');
    expect(f?.at).toBe('sbt1.t1');
  });

  it('a graded task in the additional-training phase is a blocker even without the flag - the phase decides', () => {
    const rows = [...DAY, row({ element_key: 'reinf.t1', element_type: 'task', parent_key: 'reinf', position: 1, content: { grading: { competency_grade_mode: 'scale_1_5', competencies: ['FPM'] } } })];
    expect(build(rows).some((x) => x.rule === 'training_only.not_graded' && x.at === 'reinf.t1')).toBe(true);
  });

  it('a graded task in the manoeuvres phase is allowed - manoeuvres are graded as tasks', () => {
    const rows = DAY.map((r) => (r.element_key === 'mt.uprt' ? { ...r, content: { grading: { task_outcome_mode: 'scale_1_5' }, aims: { grading_criteria: 'x' } } } : r));
    expect(build(rows).some((x) => x.rule === 'training_only.not_graded' && x.at === 'mt.uprt')).toBe(false);
  });

  it('too many competencies on one task warns; three is fine', () => {
    expect(ids(DAY)).not.toContain('task.max_competencies');
    const rows = DAY.map((r) => (r.element_key === 'eval1.loft' ? { ...r, content: { grading: { competency_grade_mode: 'scale_1_5', competencies: ['FPM', 'SAW', 'WLM', 'PSD'] }, aims: { grading_criteria: 'x' } } } : r));
    expect(build(rows).find((x) => x.rule === 'task.max_competencies')?.detail).toBe('4 targeted, guardrail 3');
  });

  it('a graded task without grading criteria warns; an ungraded one does not', () => {
    const rows = DAY.map((r) => (r.element_key === 'eval1.loft' ? { ...r, content: { grading: { competency_grade_mode: 'scale_1_5', competencies: ['FPM'] } } } : r));
    expect(build(rows).some((x) => x.rule === 'task.grading_criteria' && x.at === 'eval1.loft')).toBe(true);
    expect(ids(DAY)).not.toContain('task.grading_criteria');
  });

  it('authored slot constraints are stated as unevaluated, once per slot, and a policy alone is silent', () => {
    const withSlot = DAY.map((r) => (r.element_key === 'eval1.loft' ? { ...r, content: { ...(r.content as object), conduct: { slot: { group: 'eg.eng', policy: 'rotation', no_repeat_within_modules: 3 } } } } : r));
    expect(build(withSlot).filter((x) => x.rule === 'slot.constraints_unevaluated')).toHaveLength(1);
    const policyOnly = DAY.map((r) => (r.element_key === 'eval1.loft' ? { ...r, content: { ...(r.content as object), conduct: { slot: { group: 'eg.eng', policy: 'rotation' } } } } : r));
    expect(ids(policyOnly)).not.toContain('slot.constraints_unevaluated');
  });

  it('blockers sort before warnings', () => {
    const noReinf = DAY.filter((r) => !r.element_key.startsWith('reinf'));
    const f = build(noReinf);
    const firstWarn = f.findIndex((x) => x.severity === 'warn');
    const lastBlock = f.map((x) => x.severity).lastIndexOf('block');
    expect(lastBlock).toBeLessThan(firstWarn === -1 ? Infinity : firstWarn);
  });
});
