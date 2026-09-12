/**
 * initial.test.ts - the initial-training card: which column a pilot sits in and why.
 *
 * Fixtures are invented; every date, route and name below exists only to exercise a rule.
 */

import { describe, it, expect } from 'vitest';
import { buildInitialCard, type MilestoneSession, type StageDef } from '../initial';

const STAGES: StageDef[] = [
  { key: 'ground', label: 'Ground school' },
  { key: 'simulator', label: 'Simulator' },
  { key: 'skill_test', label: 'Skill test', check: true },
  { key: 'lfus', label: 'Line training (LFUS)' },
  { key: 'line_check', label: 'Line check', check: true },
];
const TODAY = '2026-09-11';

function s(over: Partial<MilestoneSession> & { stage: string; session_date: string }): MilestoneSession {
  return { id: `${over.stage}-${over.session_date}-${over.session_number ?? over.sector_number ?? 0}`, session_number: null, status: 'finalized', outcome: 'PASS', check: null, departure: null, arrival: null, sector_number: null, seat: null, aircraft_type: null, registration: null, assessor_name: null, template_name: null, record_id: null, additional_training: false, objected: false, ...over };
}

describe('buildInitialCard', () => {
  it('puts a pilot with no flown session in the first stage at 0 %', () => {
    const c = buildInitialCard([s({ stage: 'ground', session_date: '2026-09-20', status: 'in_progress', outcome: null })], STAGES, TODAY, 'Released');
    expect(c.stage).toBe('ground');
    expect(c.progress).toBe(0);
    expect(c.next).toEqual({ date: '2026-09-20', stage: 'ground' });
    expect(c.milestones.map((m) => m.state)).toEqual(['current', 'pending', 'pending', 'pending', 'pending']);
  });

  it('moves the pilot to the simulator once ground school is signed, and weighs FFS by sessions flown', () => {
    const rows = [s({ stage: 'ground', session_date: '2026-08-01' })];
    for (let n = 1; n <= 8; n += 1) rows.push(s({ stage: 'simulator', session_date: `2026-08-${String(10 + n * 2).padStart(2, '0')}`, session_number: n, status: n <= 4 ? 'finalized' : 'in_progress', outcome: n <= 4 ? 'PASS' : null }));
    const c = buildInitialCard(rows, STAGES, '2026-08-19', 'Released');
    expect(c.stage).toBe('simulator');
    expect(c.ffs).toEqual({ done: 4, total: 8 });
    expect(c.progress).toBe(30); // (1 + 4/8) / 5
    expect(c.rag).toBe('good');
  });

  it('flags a planned session whose date has passed as behind schedule', () => {
    const c = buildInitialCard([s({ stage: 'ground', session_date: '2026-08-01' }), s({ stage: 'simulator', session_date: '2026-09-01', session_number: 1, status: 'in_progress', outcome: null })], STAGES, TODAY, 'Released');
    expect(c.overdue).toBe(1);
    expect(c.rag).toBe('warn');
  });

  it('keeps a failed skill test in the skill-test column and marks the card red', () => {
    const c = buildInitialCard([s({ stage: 'ground', session_date: '2026-08-01' }), s({ stage: 'simulator', session_date: '2026-08-10', session_number: 1 }), s({ stage: 'skill_test', session_date: '2026-09-01', outcome: 'FAIL' })], STAGES, TODAY, 'Released');
    expect(c.stage).toBe('skill_test');
    expect(c.rag).toBe('bad');
    expect(c.milestones[2]!.outcome).toBe('FAIL');
  });

  it('counts LFUS sectors flown and take-offs and landings as PF', () => {
    const rows = [s({ stage: 'ground', session_date: '2026-06-01' }), s({ stage: 'simulator', session_date: '2026-07-01', session_number: 1 }), s({ stage: 'skill_test', session_date: '2026-07-20' })];
    for (let n = 1; n <= 20; n += 1) rows.push(s({ stage: 'lfus', session_date: `2026-08-${String(n).padStart(2, '0')}`, sector_number: n, seat: n % 2 ? 'PF' : 'PM', status: n <= 12 ? 'finalized' : 'in_progress', outcome: n <= 12 ? 'PASS' : null }));
    const c = buildInitialCard(rows, STAGES, '2026-08-12', 'Released');
    expect(c.stage).toBe('lfus');
    expect(c.lfus).toEqual({ flown: 12, total: 20, pf: 6 });
    expect(c.next).toEqual({ date: '2026-08-13', stage: 'lfus' });
  });

  it('releases the pilot when the line check is passed', () => {
    const c = buildInitialCard([s({ stage: 'ground', session_date: '2026-06-01' }), s({ stage: 'simulator', session_date: '2026-07-01', session_number: 1 }), s({ stage: 'skill_test', session_date: '2026-07-20' }), s({ stage: 'lfus', session_date: '2026-08-01', sector_number: 1, seat: 'PF' }), s({ stage: 'line_check', session_date: '2026-09-01' })], STAGES, TODAY, 'Released to the line');
    expect(c.released).toBe(true);
    expect(c.stage).toBe('released');
    expect(c.stageLabel).toBe('Released to the line');
    expect(c.progress).toBe(100);
  });
});
