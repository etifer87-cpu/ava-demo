import { describe, it, expect } from 'vitest';
import {
  competencyGradeText, competencyGradeValue, latestAttempts, proposeCompetencyGrade,
  taskGradeText, taskGradeValue, GradeRejected, type GradeVocabulary,
} from '../grade-tokens';

/**
 * The grading core, tested without a database.
 *
 * The vocabulary here mirrors the shipped config (analytics.yaml grade_scale, policy.yaml grading)
 * but is stated locally on purpose: these tests assert the RULES, not the operator's current values,
 * so an operator who renames a token or moves below_standard_max does not break them.
 */
const V: GradeVocabulary = {
  scale: {
    valid_pattern: '^[1-5]$', min: 1, max: 5, non_scoring: ['NR', 'NO', 'NA'],
    below_standard_max: 2, meets_standard_min: 3, critical_grade: 1,
  },
  taskPassFail: ['PASS', 'FAIL'],
  competencyBinary: ['C', 'NC'],
  notObserved: 'NO',
};

const task = (elementKey: string, grade: string | null, targets: string[], attempt = 1) => ({ elementKey, grade, targets, attempt });

describe('grade tokens', () => {
  it('stores a numeric task grade as its digit and reads it back', () => {
    expect(taskGradeText('scale_1_5', 4, V)).toBe('4');
    expect(taskGradeValue('scale_1_5', '4', V)).toBe(4);
  });

  it('stores a pass / fail task in the operator vocabulary', () => {
    expect(taskGradeText('pass_fail', 'pass', V)).toBe('PASS');
    expect(taskGradeText('pass_fail', 'fail', V)).toBe('FAIL');
    expect(taskGradeValue('pass_fail', 'FAIL', V)).toBe('fail');
  });

  it('clears a grade with null rather than with a zero or an empty token', () => {
    expect(taskGradeText('scale_1_5', null, V)).toBeNull();
    expect(taskGradeValue('scale_1_5', '', V)).toBeNull();
    expect(taskGradeValue('scale_1_5', null, V)).toBeNull();
  });

  it('refuses a value the mode does not use, rather than coercing it', () => {
    expect(() => taskGradeText('pass_fail', 3, V)).toThrow(GradeRejected);
    expect(() => taskGradeText('scale_1_5', 'pass', V)).toThrow(GradeRejected);
    expect(() => taskGradeText('none', 3, V)).toThrow(GradeRejected);
    expect(() => taskGradeText('scale_1_5', 6, V)).toThrow(GradeRejected);
    expect(() => taskGradeText('scale_1_5', 2.5, V)).toThrow(GradeRejected);
  });

  it('writes not observed as the configured non-scoring code, in either competency mode', () => {
    expect(competencyGradeText('scale_1_5', 'not_observed', V)).toBe('NO');
    expect(competencyGradeText('competent_not_competent', 'not_observed', V)).toBe('NO');
    expect(competencyGradeValue('scale_1_5', 'NO', V)).toBe('not_observed');
  });

  it('reads a stored competency grade back in its own mode', () => {
    expect(competencyGradeValue('competent_not_competent', 'NC', V)).toBe('not_competent');
    expect(competencyGradeValue('scale_1_5', '3', V)).toBe(3);
    // A token from the other mode is not silently accepted.
    expect(competencyGradeValue('competent_not_competent', '3', V)).toBeNull();
  });
});

describe('latestAttempts', () => {
  it('keeps the highest attempt of each element and nothing else', () => {
    const rows = [task('t1', '2', [], 1), task('t1', '4', [], 2), task('t2', '3', [], 1)];
    const kept = latestAttempts(rows);
    expect(kept).toHaveLength(2);
    expect(kept.find((r) => r.elementKey === 't1')?.grade).toBe('4');
  });
});

describe('proposeCompetencyGrade', () => {
  it('proposes nothing when no task targeting the competency has a scored grade', () => {
    const p = proposeCompetencyGrade('KNO', 'scale_1_5', [task('t1', '4', ['COM']), task('t2', null, ['KNO'])], V);
    expect(p.grade).toBeNull();
    expect(p.value).toBeNull();
    expect(p.basis.n_scored).toBe(0);
  });

  it('does not treat a non-scoring code as evidence', () => {
    const p = proposeCompetencyGrade('KNO', 'scale_1_5', [task('t1', 'NO', ['KNO']), task('t2', 'NA', ['KNO'])], V);
    expect(p.grade).toBeNull();
  });

  it('averages the tasks that target the competency and ignores the others', () => {
    const p = proposeCompetencyGrade('KNO', 'scale_1_5', [
      task('t1', '4', ['KNO']), task('t2', '4', ['KNO', 'COM']), task('t3', '2', ['COM']),
    ], V);
    expect(p.grade).toBe('4');
    expect(p.basis.n_scored).toBe(2);
    expect(p.basis.from).toEqual(['t1', 't2']);
  });

  it('rounds a tie DOWN, never in the pilot favour', () => {
    const p = proposeCompetencyGrade('KNO', 'scale_1_5', [task('t1', '3', ['KNO']), task('t2', '4', ['KNO'])], V);
    expect(p.basis.mean).toBe(3.5);
    expect(p.grade).toBe('3');
  });

  it('rounds up when the mean is above the midpoint', () => {
    const p = proposeCompetencyGrade('KNO', 'scale_1_5', [task('t1', '4', ['KNO']), task('t2', '4', ['KNO']), task('t3', '3', ['KNO'])], V);
    expect(p.grade).toBe('4');
  });

  it('never averages a critical grade away', () => {
    const p = proposeCompetencyGrade('KNO', 'scale_1_5', [
      task('t1', '1', ['KNO']), task('t2', '5', ['KNO']), task('t3', '5', ['KNO']),
    ], V);
    expect(p.grade).toBe('1');
    expect(p.basis.critical).toBe(true);
    expect(p.basis.mean).toBeCloseTo(11 / 3);
  });

  it('proposes not competent in binary mode when the evidence is below standard', () => {
    const low = proposeCompetencyGrade('KNO', 'competent_not_competent', [task('t1', '2', ['KNO']), task('t2', '2', ['KNO'])], V);
    expect(low.grade).toBe('NC');
    const ok = proposeCompetencyGrade('KNO', 'competent_not_competent', [task('t1', '3', ['KNO'])], V);
    expect(ok.grade).toBe('C');
  });

  it('carries the behaviour count without letting it move the grade', () => {
    const bare = proposeCompetencyGrade('KNO', 'scale_1_5', [task('t1', '3', ['KNO'])], V, 0);
    const evidenced = proposeCompetencyGrade('KNO', 'scale_1_5', [task('t1', '3', ['KNO'])], V, 4);
    expect(bare.grade).toBe(evidenced.grade);
    expect(evidenced.basis.obs_selected).toBe(4);
  });
});
