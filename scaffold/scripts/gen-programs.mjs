#!/usr/bin/env node
/**
 * gen-programs.mjs - writes the demo's program set into data/programs/*.json.
 *
 *   npm run gen:programs
 *
 * Pure: no database, no network. It reads the two malfunction indexes in data/library/ for
 * names and writes one definition per program in the shape seed-program.mjs loads. Rerunning it
 * rewrites the same files; the seed is then idempotent on drafts as before.
 *
 * The set, for A320 and B787, years 2024-2026:
 *   EBT recurrent    Module 1 and Module 2 (six-month cycles), Session 1 and Session 2 each.
 *                    The threat picture rotates by year, module and session: the evaluation
 *                    malfunction grids, the manoeuvres and the scenario differ across the 12
 *                    sessions of a fleet, so no year repeats the last.
 *   OPC/LPC          one combined check per fleet-year; the examiner chooses OPC or LPC when
 *                    the session is created.
 *   Ground school    one recurrent program per fleet-year; subjects as sections, each graded
 *                    as a task 1-5 and on KNO.
 *   Line check       one template for every fleet, no year, reused. Route, legs, PF/PM, aircraft
 *                    type, registration and flight time belong to the session the examiner
 *                    creates, not to the template.
 *
 * Airports SKBO, SKCL, SKRG and KJFK only. Every value is illustrative and from no operator's
 * document; structure per ICAO Doc 9995, PANS-TRG, EASA ORO.FC.231 and Part-FCL Appendix 9.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = path.join(ROOT, 'data', 'library');
const OUT = path.join(ROOT, 'data', 'programs');

const YEARS = [2024, 2025, 2026];
const FLEETS = ['A320', 'B787'];
const ALL_COMPS = ['KNO', 'PRO', 'COM', 'FPA', 'FPM', 'LTW', 'PSD', 'SAW', 'WLM'];
const ROLES = {
  ebt: ['instructor', 'examiner', 'assessment_manager'],
  check: ['examiner', 'assessment_manager'],
  ground: ['ground_instructor', 'assessment_manager'],
};

/* ------------------------------------------------------------------ small builders */

const grading = (task = 'none', comp = 'none', comps = []) => ({ task_outcome_mode: task, competency_grade_mode: comp, competencies: comps });
const aims = (a, focus = null, criteria = null, visibility = 'instructor_only') => ({ aims: a, competency_focus: focus, grading_criteria: criteria, visibility });
const section = (key, title, phase, time, extra = {}, children = []) => ({ key, type: 'section', title, content: { section_kind: 'block', phase, time, ...extra }, children });
const note = (key, title, text) => ({ key, type: 'note', title, content: { text } });
const task = (key, title, c) => ({ key, type: 'task', title, content: c });
const setup = (key, title, entries, mass, snapshot = null, notes = null) => ({ key, type: 'setup', title, content: { entries: { airport: [], weather: [], position: [], comms: [], reset: [], atc: [], performance: [], ...entries }, mass, snapshot, ...(notes ? { notes } : {}) } });
const events = (key, title, items) => ({ key, type: 'event_option', title, content: { kind: 'event', mode: 'sequence', options: items.map((it, i) => ({ key: it.ref.replace(/^event\./, '').slice(0, 30) || `e${i}`, name: it.name, ref: it.ref, option: null, trigger: it.trigger, category: it.category })) } });

let MALF = new Map();
const malfGrid = (key, title, fleet, picks, mode = 'choose_one') => ({
  key, type: 'event_option', title,
  content: {
    kind: 'malfunction', mode, fleet,
    options: picks.map((p, i) => {
      const m = MALF.get(p.ref);
      if (!m) throw new Error(`unknown malfunction ${p.ref}`);
      const option = p.option ?? (m.options[0] ?? null);
      const key = `${p.ref.split('.').pop()}${option ? `-${option.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}`.slice(0, 40) || `m${i}`;
      return { key, name: m.title, ref: p.ref, option, trigger: p.trigger, category: null };
    }),
  },
});

/* ------------------------------------------------------------------ fleet data */

const WX = {
  SKBO: ['SKBO 13008KT 6000 -RA BKN012 12/11 Q1026', 'SKBO 12010KT 4000 -RA OVC010 11/10 Q1027', 'SKBO 09006KT 9999 SCT030 14/09 Q1028', 'SKBO 14012KT 3000 RA BKN008 10/09 Q1024'],
  SKCL: ['SKCL 20006KT 9999 SCT025 28/22 Q1013', 'SKCL 22010KT 8000 SHRA BKN020 26/22 Q1012', 'SKCL 19004KT 9999 FEW030 30/21 Q1011', 'SKCL 21015G25KT 6000 TSRA BKN018CB 25/22 Q1010'],
  SKRG: ['SKRG 01008KT 9999 FEW030 20/12 Q1022', 'SKRG 01006KT 9999 SCT025 21/13 Q1021', 'SKRG 36010KT 5000 BR BKN006 17/15 Q1023', 'SKRG 02004KT 2000 -DZ OVC004 16/15 Q1024'],
  KJFK: ['KJFK 31014G22KT 10SM FEW040 08/M02 A3005', 'KJFK 06012KT 2SM -SN OVC009 M01/M03 A2982', 'KJFK 22008KT 5SM BR SCT012 21/19 A3010', 'KJFK 34018G28KT 10SM SCT050 03/M06 A3021'],
};
const COMMS = { SKBO: ['SKBO GND 121.9', 'SKBO TWR 118.1', 'SKBO APP 119.5'], SKCL: ['SKCL GND 121.7', 'SKCL TWR 118.7', 'SKCL APP 119.9'], SKRG: ['SKRG GND 121.8', 'SKRG TWR 118.3', 'SKRG APP 120.1'], KJFK: ['KJFK GND 121.9', 'KJFK TWR 119.1', 'NY APP 127.4'] };
const wx = (icao, i) => WX[icao][i % WX[icao].length];

const FLEET = {
  A320: {
    legs: [['SKBO', 'SKCL'], ['SKCL', 'SKBO'], ['SKBO', 'SKRG'], ['SKRG', 'SKBO'], ['SKCL', 'SKRG'], ['SKRG', 'SKCL']],
    mass: (fuel) => ({ zfw: '58.4 t', zfwcg: '29 %', fuel }),
    fuel: { leg: '7.2 t', mt: '6.5 t', sbt: '9.8 t', check: '8.0 t' },
    perf: { to: 'Flex take-off, CONF 1+F', toga: 'TOGA take-off, CONF 2', ldg: 'Landing wet, autobrake MED' },
    position: { gate: 'gate, cold and dark, external power on', turn: 'gate, turnaround, APU running', lineup: 'lined up, engines running', final: '10 NM final, configured' },
    themes: {
      electrical: [{ ref: 'malf.a320.24.gen-fault-excitation', option: 'Gen1', trigger: 'In the cruise' }, { ref: 'malf.a320.24.ac-bus-fault', option: '1', trigger: 'After top of climb' }, { ref: 'malf.a320.24.tr-fault', option: '2', trigger: 'Passing FL200 in the climb' }],
      hydraulic: [{ ref: 'malf.a320.29.eng-pump-lo-press', option: 'Green', trigger: 'After gear retraction' }, { ref: 'malf.a320.29.elec-pump-fault', option: 'Yellow', trigger: 'In the cruise' }, { ref: 'malf.a320.29.rsvr-lo-air-press', option: 'Blue', trigger: 'Top of descent' }],
      air: [{ ref: 'malf.a320.21.pack-regul-fault', option: '1', trigger: 'Passing FL150 in the climb' }, { ref: 'malf.a320.36.bleed-leak', option: '2', trigger: 'After top of climb' }, { ref: 'malf.a320.21.cab-press-sys-fault', option: '1', trigger: 'In the cruise' }],
      autoflight: [{ ref: 'malf.a320.22.a-thr-fault', option: '1', trigger: 'Passing FL100 in the climb' }, { ref: 'malf.a320.22.fmgc-fault', option: '1', trigger: 'After top of climb' }, { ref: 'malf.a320.22.fcu-fault', option: '2', trigger: 'Before top of descent' }],
      controls: [{ ref: 'malf.a320.27.elac-fault', option: '1', trigger: 'In the cruise' }, { ref: 'malf.a320.27.flap-sys-fault', option: '1', trigger: 'Selecting CONF 2 on approach' }, { ref: 'malf.a320.27.spoiler-retraction-fault-left-3', trigger: 'After take-off' }],
      nav: [{ ref: 'malf.a320.34.adr-fault', option: '1', trigger: 'Passing FL180 in the climb' }, { ref: 'malf.a320.34.ils-receiver-fault', option: '1', trigger: 'Established on the approach' }, { ref: 'malf.a320.34.wx-radar-fault', trigger: 'Before the weather deviation' }],
      engine: [{ ref: 'malf.a320.70.oil-press-inc-dec', option: '2', trigger: 'In the cruise' }, { ref: 'malf.a320.70.high-vibrations-n1', option: '1', trigger: 'Passing FL120 in the climb' }, { ref: 'malf.a320.70.egt-inc-dec', option: '2', trigger: 'Thrust reduction altitude' }],
      gear: [{ ref: 'malf.a320.32.l-g-not-down-locked', option: 'Nose', trigger: 'Gear down on approach' }, { ref: 'malf.a320.32.antiskid-fault', trigger: 'Before the approach briefing' }, { ref: 'malf.a320.32.auto-brk-fault', trigger: 'Configuring for the approach' }],
    },
    engV1: [{ ref: 'malf.a320.70.compressor-stall', option: '2', trigger: 'At V1' }, { ref: 'malf.a320.70.flame-out-no-damage', option: '2', trigger: 'At V1' }, { ref: 'malf.a320.70.serious-damage-with-abrupt-power-loss', option: '2', trigger: 'At V1' }, { ref: 'malf.a320.70.extinguishable-fire-by-first-agent', option: 'Eng 2', trigger: 'At V1' }],
    rto: [{ ref: 'malf.a320.70.flame-out-with-damage', option: '1', trigger: 'At 110 kt' }, { ref: 'malf.a320.32.tyre-burst', option: 'NW left', trigger: 'At 100 kt' }, { ref: 'malf.a320.26.cargo-smoke-fwd', trigger: 'At 90 kt' }],
    scenarios: {
      fuel: [{ ref: 'malf.a320.70.eng-fuel-leak', option: '1', trigger: 'Reaching cruise level' }, { ref: 'malf.a320.28.tank-fuel-leak', option: 'L in', trigger: 'After take-off' }, { ref: 'malf.a320.70.hidden-fuel-leak', option: '1', trigger: 'In the cruise' }],
      smoke: [{ ref: 'malf.a320.26.avionic-smoke', trigger: 'In the cruise' }, { ref: 'malf.a320.26.cargo-smoke-aft', trigger: 'Top of climb' }, { ref: 'malf.a320.21.cabin-duct-overheat', option: 'Fwd', trigger: 'In the climb' }],
      hydraulic: [{ ref: 'malf.a320.29.eng-pump-lo-press', option: 'Green', trigger: 'After take-off' }, { ref: 'malf.a320.29.rsvr-overheat', option: 'Yellow', trigger: 'In the cruise' }, { ref: 'malf.a320.29.ptu-fault', trigger: 'After gear retraction' }],
      electrical: [{ ref: 'malf.a320.24.gen-fault-excitation', option: 'Gen1', trigger: 'In the cruise' }, { ref: 'malf.a320.24.gen-fault-excitation', option: 'Gen2', trigger: 'Ten minutes after the first' }, { ref: 'malf.a320.24.ac-bus-fault-ess', trigger: 'Top of descent' }],
      airspeed: [{ ref: 'malf.a320.34.total-pitot-blockage-blocked-pitot', option: 'Capt', trigger: 'Passing FL100 in the climb' }, { ref: 'malf.a320.34.pitot-inlet-blockage', option: 'F/O', trigger: 'After take-off' }, { ref: 'malf.a320.34.airspeed-channel-adr-fault', option: '1', trigger: 'In the climb' }],
      law: [{ ref: 'malf.a320.27.demonstration-of-alternate-law', trigger: 'In the cruise' }, { ref: 'malf.a320.27.demonstration-of-direct-law', trigger: 'On the approach' }, { ref: 'malf.a320.27.elac-fault', option: '1', trigger: 'Top of descent' }],
      pressurisation: [{ ref: 'malf.a320.21.excess-cab-altitude', trigger: 'At cruise level' }, { ref: 'malf.a320.21.outflow-valve-stuck', trigger: 'In the climb' }, { ref: 'malf.a320.21.door-leakage', trigger: 'Passing FL250' }],
      gear: [{ ref: 'malf.a320.32.l-g-not-down-locked', option: 'L Main', trigger: 'Gear down on approach' }, { ref: 'malf.a320.32.loss-of-braking', trigger: 'On landing' }, { ref: 'malf.a320.32.retraction-fault', option: 'R Main', trigger: 'After take-off' }],
    },
    scenarioText: {
      fuel: ['Fuel leak in the climb', 'Detect the leak, apply the procedure, decide where to land.', 'Problem solving with incomplete information: the fuel check is the first clue.', 'Leak detected from the fuel check or the ECAM, procedure applied, diversion decided with the fuel remaining.', 'No reverse at landing: fuel leak procedure.'],
      smoke: ['Smoke of unknown origin', 'Find the source, protect the crew, land as soon as possible.', 'Workload management under time pressure; communication with cabin and ATC.', 'Oxygen masks and communication established, procedure applied, diversion decided without delay.', 'Keep the smoke source ambiguous for the first minutes; clear it when the procedure isolates it.'],
      hydraulic: ['Hydraulic system loss with degraded landing', 'Manage the loss, prepare the landing with the degraded configuration.', 'Application of procedures with the landing distance in mind.', 'Consequences identified, landing distance computed, approach briefed for the degraded configuration.', 'Freeze after the ECAM actions to discuss the landing distance.'],
      electrical: ['Loss of both generators', 'Restore what can be restored, fly on emergency power to a landing.', 'Situation awareness of what is lost; workload management with a reduced display.', 'Emergency generator confirmed, essential equipment identified, approach flown with the available means.', 'Second generator fails ten minutes after the first; do not fail the APU.'],
      airspeed: ['Unreliable airspeed', 'Recognise it, fly pitch and thrust, sort out the sources.', 'Manual flight path management on raw pitch and thrust; problem solving to identify the good source.', 'Unreliable speed recognised early, memory items applied, a reliable source identified and the approach flown safely.', 'Pitot blockage builds over one minute; it does not clear.'],
      law: ['Degraded flight control law on approach', 'Fly the approach and landing in a degraded law.', 'Manual control with reduced protections; application of the landing procedure in the degraded law.', 'Approach stabilised in the degraded law, landing within the touchdown zone, the procedure complete.', 'Give the crew the full approach; do not freeze before the landing.'],
      pressurisation: ['Cabin altitude climbing in the cruise', 'Emergency descent, then a diversion at low level.', 'Time-critical decision; workload management during the descent; fuel at low level.', 'Masks on and descent started without delay, ATC informed, level-off and diversion planned with the fuel at low level.', 'Give an intermediate ATC altitude restriction during the descent to see whether the crew questions it.'],
      gear: ['Landing gear not down and locked', 'Work the problem, decide on the landing, prepare the cabin.', 'Problem solving and decision making with time available; leadership in the cabin briefing.', 'All means tried in the correct order, decision made with the fuel and the runway in mind, cabin prepared.', 'The gravity extension works. Do not add a second failure.'],
    },
  },
  B787: {
    legs: [['SKBO', 'KJFK'], ['KJFK', 'SKBO'], ['SKBO', 'SKCL'], ['SKCL', 'SKBO'], ['SKBO', 'SKRG'], ['SKRG', 'SKBO']],
    mass: (fuel) => ({ zfw: '161.0 t', zfwcg: '24 %', fuel }),
    fuel: { leg: '38.0 t', mt: '22.0 t', sbt: '42.0 t', check: '26.0 t' },
    perf: { to: 'Assumed temperature take-off, flaps 5', toga: 'Full thrust take-off, flaps 15', ldg: 'Landing wet, autobrake 3' },
    position: { gate: 'gate, cold and dark, ground power on', turn: 'gate, turnaround, APU running', lineup: 'lined up, engines running', final: '10 NM final, configured' },
    themes: {
      electrical: [{ ref: 'malf.b787.24.generator-drive-fault', option: 'L1', trigger: 'In the cruise' }, { ref: 'malf.b787.24.bus-fault', option: 'L 235V AC', trigger: 'After top of climb' }, { ref: 'malf.b787.24.electrical-load-shed', trigger: 'Passing FL200 in the climb' }],
      hydraulic: [{ ref: 'malf.b787.29.hydraulic-pressure-system', option: 'C', trigger: 'After gear retraction' }, { ref: 'malf.b787.29.hydraulic-pump-fault', option: 'L Eng', trigger: 'In the cruise' }, { ref: 'malf.b787.29.hydraulic-quantity-low', option: 'R', trigger: 'Top of descent' }],
      air: [{ ref: 'malf.b787.21.pack-fault', option: 'L', trigger: 'Passing FL150 in the climb' }, { ref: 'malf.b787.36.bleed-leak', option: 'R', trigger: 'After top of climb' }, { ref: 'malf.b787.21.cabin-auto-inop', trigger: 'In the cruise' }],
      autoflight: [{ ref: 'malf.b787.22.autothrottle-disconnect', trigger: 'Passing FL100 in the climb' }, { ref: 'malf.b787.22.fmc-fault', option: 'L', trigger: 'After top of climb' }, { ref: 'malf.b787.22.autoland-degrade', option: 'No Land 3', trigger: 'Established on the approach' }],
      controls: [{ ref: 'malf.b787.27.flight-control-mode-secondary', trigger: 'In the cruise' }, { ref: 'malf.b787.27.flaps-drive', trigger: 'Selecting flaps 20 on approach' }, { ref: 'malf.b787.27.speedbrake-fault', trigger: 'Top of descent' }],
      nav: [{ ref: 'malf.b787.34.gps-fault', option: 'L', trigger: 'Passing FL180 in the climb' }, { ref: 'malf.b787.34.ils-fault', option: 'L', trigger: 'Established on the approach' }, { ref: 'malf.b787.34.weather-radar-fault', trigger: 'Before the weather deviation' }],
      engine: [{ ref: 'malf.b787.70.engine-oil-pressure-low', option: 'R', trigger: 'In the cruise' }, { ref: 'malf.b787.70.engine-vibration-high', option: 'L', trigger: 'Passing FL120 in the climb' }, { ref: 'malf.b787.70.engine-eec-mode', option: 'R', trigger: 'Thrust reduction altitude' }],
      gear: [{ ref: 'malf.b787.32.gear-disagree', option: 'Nose', trigger: 'Gear down on approach' }, { ref: 'malf.b787.32.antiskid-off', trigger: 'Before the approach briefing' }, { ref: 'malf.b787.32.autobrake-fault', trigger: 'Configuring for the approach' }],
    },
    engV1: [{ ref: 'malf.b787.70.engine-surge', option: 'R', trigger: 'At V1' }, { ref: 'malf.b787.70.engine-failure-flameout', option: 'R', trigger: 'At V1' }, { ref: 'malf.b787.70.engine-severe-damage', option: 'R', trigger: 'At V1' }, { ref: 'malf.b787.26.engine-fire', option: 'R', trigger: 'At V1' }],
    rto: [{ ref: 'malf.b787.70.engine-failure-flameout', option: 'L', trigger: 'At 110 kt' }, { ref: 'malf.b787.32.tyre-burst', option: 'Nose L', trigger: 'At 100 kt' }, { ref: 'malf.b787.26.cargo-fire', option: 'Fwd', trigger: 'At 90 kt' }],
    scenarios: {
      fuel: [{ ref: 'malf.b787.28.fuel-leak-engine', option: 'L', trigger: 'Reaching cruise level' }, { ref: 'malf.b787.28.fuel-leak-tank', option: 'L Main', trigger: 'After take-off' }, { ref: 'malf.b787.28.fuel-imbalance', trigger: 'In the cruise' }],
      smoke: [{ ref: 'malf.b787.26.smoke-equipment-cooling', trigger: 'In the cruise' }, { ref: 'malf.b787.26.cargo-fire', option: 'Aft', trigger: 'Top of climb' }, { ref: 'malf.b787.26.smoke-lavatory', trigger: 'In the climb' }],
      hydraulic: [{ ref: 'malf.b787.29.hydraulic-pressure-system', option: 'C', trigger: 'After take-off' }, { ref: 'malf.b787.29.hydraulic-quantity-low', option: 'L', trigger: 'In the cruise' }, { ref: 'malf.b787.29.hydraulic-pump-fault', option: 'C1 Elec', trigger: 'After gear retraction' }],
      electrical: [{ ref: 'malf.b787.24.generator-off', option: 'L1', trigger: 'In the cruise' }, { ref: 'malf.b787.24.generator-off', option: 'L2', trigger: 'Ten minutes after the first' }, { ref: 'malf.b787.24.bus-fault', option: 'L DC', trigger: 'Top of descent' }],
      airspeed: [{ ref: 'malf.b787.34.airspeed-unreliable', option: 'Capt', trigger: 'Passing FL100 in the climb' }, { ref: 'malf.b787.34.pitot-blocked', option: 'F/O', trigger: 'After take-off' }, { ref: 'malf.b787.34.pitot-blocked', option: 'Standby', trigger: 'In the climb' }],
      law: [{ ref: 'malf.b787.27.flight-control-mode-secondary', trigger: 'In the cruise' }, { ref: 'malf.b787.27.flight-control-mode-direct', trigger: 'On the approach' }, { ref: 'malf.b787.27.stabilizer-trim-fault', option: 'Jam', trigger: 'Top of descent' }],
      pressurisation: [{ ref: 'malf.b787.21.cabin-altitude', option: 'Rapid', trigger: 'At cruise level' }, { ref: 'malf.b787.21.outflow-valve-fault', option: 'Aft', trigger: 'In the climb' }, { ref: 'malf.b787.21.cabin-altitude', option: 'Slow', trigger: 'Passing FL250' }],
      gear: [{ ref: 'malf.b787.32.gear-disagree', option: 'L Main', trigger: 'Gear down on approach' }, { ref: 'malf.b787.32.brake-temperature-high', option: 'L', trigger: 'After landing' }, { ref: 'malf.b787.32.gear-disagree', option: 'R Main', trigger: 'After take-off' }],
    },
    scenarioText: {
      fuel: ['Fuel leak over the ocean', 'Detect the leak, apply the procedure, decide where to land.', 'Problem solving with incomplete information: the fuel check is the first clue; the decision with an ETOPS alternate is the outcome.', 'Leak detected from the fuel check or the EICAS, procedure applied, diversion decided with the fuel remaining.', 'No reverse at landing: fuel leak procedure.'],
      smoke: ['Smoke of unknown origin', 'Find the source, protect the crew, land as soon as possible.', 'Workload management under time pressure; communication with cabin and ATC.', 'Oxygen masks and communication established, procedure applied, diversion decided without delay.', 'Keep the smoke source ambiguous for the first minutes; clear it when the procedure isolates it.'],
      hydraulic: ['Hydraulic system loss with degraded landing', 'Manage the loss, prepare the landing with the degraded configuration.', 'Application of procedures with the landing distance in mind.', 'Consequences identified, landing distance computed, approach briefed for the degraded configuration.', 'Freeze after the checklist to discuss the landing distance.'],
      electrical: ['Loss of two generators on one side', 'Restore what can be restored, manage the load and land.', 'Situation awareness of what is lost; workload management with a reduced display.', 'Load shed understood, essential equipment identified, approach flown with the available means.', 'Second generator fails ten minutes after the first; do not fail the APU.'],
      airspeed: ['Unreliable airspeed', 'Recognise it, fly pitch and thrust, sort out the sources.', 'Manual flight path management on raw pitch and thrust; problem solving to identify the good source.', 'Unreliable speed recognised early, memory items applied, a reliable source identified and the approach flown safely.', 'Pitot blockage builds over one minute; it does not clear.'],
      law: ['Flight control mode degradation on approach', 'Fly the approach and landing in the degraded mode.', 'Manual control with reduced protections; application of the landing procedure in the degraded mode.', 'Approach stabilised in the degraded mode, landing within the touchdown zone, the checklist complete.', 'Give the crew the full approach; do not freeze before the landing.'],
      pressurisation: ['Cabin altitude climbing in the cruise', 'Emergency descent, then a diversion at low level.', 'Time-critical decision; workload management during the descent; fuel at low level.', 'Masks on and descent started without delay, ATC informed, level-off and diversion planned with the fuel at low level.', 'Give an intermediate ATC altitude restriction during the descent to see whether the crew questions it.'],
      gear: ['Landing gear disagree', 'Work the problem, decide on the landing, prepare the cabin.', 'Problem solving and decision making with time available; leadership in the cabin briefing.', 'All means tried in the correct order, decision made with the fuel and the runway in mind, cabin prepared.', 'The alternate extension works. Do not add a second failure.'],
    },
  },
};

const THEMES = ['electrical', 'hydraulic', 'air', 'autoflight', 'controls', 'nav', 'engine', 'gear'];
const SCENARIOS = ['fuel', 'smoke', 'hydraulic', 'electrical', 'airspeed', 'law', 'pressurisation', 'gear'];

const EVENTS = {
  tcasTa: { ref: 'event.tcas-ta', name: 'TCAS traffic advisory during the weather deviation', trigger: 'Single threat ahead while the crew is deviating around weather', category: 'TCAS' },
  reclear: { ref: 'event.atc-reclearance', name: 'ATC re-clearance on arrival', trigger: 'Runway change inside 20 NM', category: 'ATC' },
  wxMinima: { ref: 'event.wx-below-minima', name: 'Destination weather deteriorates', trigger: 'Before the approach briefing: destination below minima for 30 minutes', category: 'Weather' },
  crosswind: { ref: 'event.wx-crosswind-up', name: 'Crosswind increases on final', trigger: 'Gusting to the limit inside 5 NM', category: 'Weather' },
  cabin: { ref: 'event.cabin-report', name: 'Cabin report of a sick passenger', trigger: 'Mid-cruise, needs a decision', category: 'Cabin' },
  ground: { ref: 'event.ground-interruption', name: 'Ground interruption before push-back', trigger: 'Loadsheet change at the gate', category: 'Ground' },
  traffic: { ref: 'event.traffic-departure', name: 'Traffic on departure', trigger: 'Conflicting traffic on the SID', category: 'ATC' },
  speed: { ref: 'event.atc-speed', name: 'ATC speed constraint on final', trigger: '170 kt until 5 NM', category: 'ATC' },
  breakout: { ref: 'event.atc-breakout', name: 'ATC breakout on final', trigger: 'Go-around instruction at 1 500 ft', category: 'ATC' },
  bird: { ref: 'event.bird-report', name: 'Bird activity reported', trigger: 'Tower report before line-up', category: 'Ground' },
  runway: { ref: 'event.runway-closure', name: 'Runway closure at destination', trigger: 'Disabled aircraft; expect the other runway', category: 'ATC' },
  wsApp: { ref: 'event.windshear-approach', name: 'Windshear on approach', trigger: 'Predictive warning at 1 200 ft', category: 'Windshear' },
};
const EVENT_SETS = [[EVENTS.tcasTa, EVENTS.reclear], [EVENTS.wxMinima, EVENTS.speed], [EVENTS.ground, EVENTS.traffic], [EVENTS.crosswind, EVENTS.breakout], [EVENTS.cabin, EVENTS.runway], [EVENTS.bird, EVENTS.wsApp]];

/* ------------------------------------------------------------------ manoeuvres pool */

function manoeuvre(fleet, id, key, minutes, pf, idx) {
  const f = FLEET[fleet];
  const auto = (ap, athr, fd) => ({ ap, athr, fd });
  const t = (title, a, focus, criteria, notes, automation = auto('crew_discretion', 'crew_discretion', 'required_on'), extra = []) => [
    ...extra,
    task(key, title, { time: minutes, pf, automation, aims: aims(a, focus, criteria), conduct: { instructor_notes: notes, injects: [] }, grading: grading('scale_1_5') }),
  ];
  switch (id) {
    case 'engV1': return t('Engine failure after V1', 'Continue the take-off, control the flight path, secure the engine.', 'Manual control at low speed with asymmetric thrust; procedure application under time pressure.', 'Directional control kept within limits, rotation and climb speed as per SOP, engine secured with the procedure complete.', 'One repeat per crew member as PF. Recall the flight plan between repeats.', auto('required_off', 'crew_discretion', 'required_on'), [malfGrid(`${key}.malf`, 'Engine malfunction at V1', fleet, [f.engV1[idx % 4], f.engV1[(idx + 1) % 4], f.engV1[(idx + 2) % 4]])]);
    case 'rto': return t('Rejected take-off at high speed', 'Stop the aircraft on the runway, then manage the aftermath.', 'Decision at high speed; procedure application; communication with cabin and ATC after the stop.', 'Stop decision within the SOP window, full stopping means used, brakes and cabin managed after the stop.', 'Brake temperature and evacuation decision are the discussion after the stop.', auto('required_off', 'crew_discretion', 'not_applicable'), [malfGrid(`${key}.malf`, 'Reason to reject', fleet, f.rto)]);
    case 'oeiGa': return t('One-engine-inoperative approach and go-around', 'OEI approach to minima, go-around, second approach and landing.', 'Flight path management with automation on one engine; go-around management.', 'Stabilised OEI approach, go-around flown with the correct sequence, second approach to a landing.', `Reposition to ${f.position.final} with the right engine secured.`, auto('crew_discretion', 'not_applicable', 'required_on'));
    case 'oeiLdg': return t('One-engine-inoperative landing, manual', 'Manual OEI approach and landing.', 'Manual flight path control with asymmetric thrust to a landing.', 'Stabilised by 1 000 ft, touchdown in the zone, directional control on the runway.', 'Autopilot off from 10 NM; one attempt per crew member.', auto('required_off', 'not_applicable', 'required_on'));
    case 'rawData': return t('Raw-data ILS, manual', 'ILS to minima without flight director or autothrust.', 'Manual flight path management on raw data; scan and energy.', 'Localiser and glideslope within one dot below 1 000 ft, speed within +10/-5 kt.', 'Flight directors off at glideslope capture.', auto('required_off', 'required_off', 'required_off'));
    case 'nonPrecision': return t('Non-precision approach', 'RNP approach with vertical guidance to minima and landing.', 'Application of the approach procedure; monitoring of the vertical path.', 'Approach briefed and flown as published, minima respected, stabilised by 1 000 ft.', 'RNP approach at SKRG; if no vertical guidance, fly the CDFA.', auto('crew_discretion', 'crew_discretion', 'required_on'));
    case 'lvo': return t('Low visibility approach and landing', 'CAT II/III approach and landing with the required callouts.', 'Monitoring and cross-checking in low visibility; procedure application.', 'Callouts complete, decision at the correct height, landing or go-around as required.', 'Set RVR 300 m; fail the autoland on the second attempt if time allows.', auto('required_on', 'required_on', 'required_on'));
    case 'upset': return t('Upset prevention and recovery', 'Recover from nose-high and nose-low upsets.', 'Manual handling at the edge of the envelope; recognition before recovery.', 'Recovery technique applied in the correct order, no secondary stall, altitude loss within the expected range.', 'Set up at FL200; autopilot disconnects at the upset.', auto('required_off', 'required_off', 'required_off'));
    case 'stall': return t('Approach to stall and recovery', 'Recover at the first indication in clean and landing configuration.', 'Recognition and manual handling; energy management after the recovery.', 'Recovery at the first indication, pitch reduced before thrust, no secondary stall.', 'Two configurations: clean at FL150 and landing configuration at 5 000 ft.', auto('required_off', 'required_off', 'required_off'));
    case 'tcasRa': return t('TCAS resolution advisory', 'Fly the RA, then return to the clearance.', 'Manual flight path response to the RA; communication with ATC.', 'RA flown within the guidance, ATC informed, return to the clearance after clear of conflict.', 'Corrective RA in the climb; one per crew member as PF.', auto('required_off', 'crew_discretion', 'required_on'), [events(`${key}.events`, 'Traffic', [{ ...EVENTS.tcasTa, name: 'Traffic advisory, then a resolution advisory', trigger: 'Climbing through FL120' }])]);
    case 'windshear': return t('Windshear escape', 'Escape manoeuvre on take-off and on approach.', 'Manual handling at maximum performance; recognition of the warning.', 'Escape manoeuvre flown at the warning, configuration unchanged until clear, no altitude loss below the threshold.', 'One on take-off, one on approach, the second crew member as PF.', auto('required_off', 'required_off', 'required_off'), [events(`${key}.events`, 'Windshear', [EVENTS.wsApp])]);
    case 'egpws': return t('Terrain warning and escape', 'Pull-up at the warning.', 'Immediate manual response; situation awareness of terrain.', 'Pull-up initiated at the warning with full performance, terrain cleared, recovery to a safe altitude.', 'Vectors towards terrain on the approach to SKRG in IMC.', auto('required_off', 'required_off', 'required_off'));
    case 'gaAll': return t('Go-around, all engines', 'Go-around from minima and from low altitude.', 'Flight path management during the go-around; automation mode awareness.', 'Correct sequence, pitch and thrust as per SOP, level-off at the missed approach altitude.', 'One from minima, one from 50 ft with the landing clearance cancelled.', auto('crew_discretion', 'crew_discretion', 'required_on'));
    case 'crosswind': return t('Crosswind take-off and landing', 'Take-off and landing at the demonstrated crosswind.', 'Manual handling in crosswind; decision to continue or go around.', 'Runway centreline kept, de-crab and touchdown technique as per SOP.', 'Crosswind at the demonstrated limit, gusting; wet runway.', auto('required_off', 'crew_discretion', 'required_on'), [events(`${key}.events`, 'Wind', [EVENTS.crosswind])]);
    case 'emergencyDescent': return t('Emergency descent', 'Descend to a safe altitude without delay.', 'Memory items and procedure under time pressure; communication with ATC and cabin.', 'Masks on, descent started within the expected time, ATC informed, level-off at the correct altitude.', 'From cruise level; ATC gives a conflicting instruction during the descent.', auto('crew_discretion', 'crew_discretion', 'required_on'), [malfGrid(`${key}.malf`, 'Loss of pressurisation', fleet, f.scenarios.pressurisation)]);
    default: throw new Error(`unknown manoeuvre ${id}`);
  }
}
const MANOEUVRES = ['engV1', 'oeiGa', 'rto', 'rawData', 'nonPrecision', 'upset', 'lvo', 'tcasRa', 'stall', 'windshear', 'oeiLdg', 'egpws', 'gaAll', 'crosswind', 'emergencyDescent'];

/* ------------------------------------------------------------------ EBT session */

function ebtSession(fleet, year, module, session) {
  const f = FLEET[fleet];
  const idx = (year - 2024) * 4 + (module - 1) * 2 + (session - 1); // 0..11 per fleet
  const legA = f.legs[(idx * 2) % f.legs.length];
  const legB = f.legs[(idx * 2 + 1) % f.legs.length];
  const themeA = THEMES[idx % THEMES.length];
  const themeB = THEMES[(idx + 3) % THEMES.length];
  const evA = EVENT_SETS[idx % EVENT_SETS.length];
  const evB = EVENT_SETS[(idx + 2) % EVENT_SETS.length];
  const m1 = session === 1 && module === 1 ? 'engV1' : MANOEUVRES[(idx * 2) % MANOEUVRES.length];
  let m2 = MANOEUVRES[(idx * 2 + 1) % MANOEUVRES.length];
  if (m2 === m1) m2 = MANOEUVRES[(idx * 2 + 2) % MANOEUVRES.length];
  const sc = SCENARIOS[(idx * 3 + (year - 2024) * 2) % SCENARIOS.length]; // no slot repeats its scenario across the three years
  const [scTitle, scAim, scFocus, scCriteria, scNotes] = f.scenarioText[sc];
  const code = `ebt.${fleet.toLowerCase()}.${year}.m${module}.s${session}`;
  const name = `EBT Module ${module} - Session ${session} - ${fleet}`;
  const leg = (n, [dep, dst], theme, ev, pf) => [
    setup(`eval.setup${n}`, `Set-up - leg ${n}`, {
      airport: [dep, dst], weather: [wx(dep, idx + n), wx(dst, idx + n + 1)],
      position: [`${dep} ${n === 1 ? f.position.gate : f.position.turn}`],
      comms: [COMMS[dep][0], COMMS[dep][1], COMMS[dst][2]],
      reset: [n === 1 ? 'Total reset, all failures cleared' : 'Clear all failures; keep fuel used'],
      atc: [n === 1 ? 'Standard departure; taxi with one runway crossing' : 'Late runway change possible on arrival'],
      performance: [`${f.perf.to}, wet runway`, f.perf.ldg],
    }, f.mass(f.fuel.leg)),
    malfGrid(`eval.leg${n}.malf`, `System failure - leg ${n}`, fleet, f.themes[theme]),
    events(`eval.leg${n}.events`, `Events - leg ${n}`, ev),
    task(`eval.leg${n}`, `Line-oriented sector ${dep} - ${dst}`, {
      time: '0:50', pf, automation: { ap: 'crew_discretion', athr: 'crew_discretion', fd: 'crew_discretion' },
      aims: aims('A complete sector flown as on the line, from cockpit preparation to shutdown.', n === 1 ? 'Situation awareness through the departure weather; workload management in a busy terminal area; communication with ATC under a non-standard clearance.' : 'Problem solving and decision making with a system failure; leadership and teamwork in the recovery; application of procedures.', n === 1 ? 'Deviations recognised and corrected without prompting; SOP callouts complete; ATC instructions read back and complied with; the crew\'s own plan survives the threat.' : 'Failure identified and the procedure applied; options weighed and a decision briefed; the crew shares the workload without being told.', 'also_on_report'),
      conduct: { instructor_notes: 'Act as ATC, ground and cabin only. Do not coach. If the crew does not detect the failure within two minutes of insertion, note it and continue.', injects: [] },
      grading: grading('none', 'scale_1_5', n === 1 ? ['SAW', 'WLM', 'COM'] : ['PSD', 'LTW', 'PRO']),
    }),
  ];
  const [mA, mB] = [manoeuvre(fleet, m1, 'mt.ex1', '0:30', 'CM1', idx), manoeuvre(fleet, m2, 'mt.ex2', '0:20', 'CM2', idx)];
  const elements = [
    section('brief', 'Briefing', 'brief', '1:00', {}, [
      note('brief.notes', 'Briefing guide', `TEM framing for the day. The evaluation phase is flown as on the line: the instructor intervenes only as ATC, ground or cabin. Manoeuvres and the scenario are training, graded as tasks; say so to the crew. Charts and performance for ${[...new Set([...legA, ...legB, 'SKRG'])].join(', ')} prepared before the session.`),
      task('brief.session', 'Session briefing', { time: '1:00', aims: { aims: 'Set expectations: what is assessed, what is trained, how the day is graded.', visibility: 'also_in_subject_brief', grading_criteria: 'Knows the session\'s threats and the applicable procedures; briefs clearly and completely.' }, grading: grading('none', 'competent_not_competent', ['KNO', 'COM']) }),
    ]),
    section('eval', 'Evaluation phase', 'eval', '1:40', { aims: { aims: 'Line-oriented evaluation over two sectors with realistic threats. Assess, do not teach; note observable behaviours for the debrief.', visibility: 'instructor_only' } }, [...leg(1, legA, themeA, evA, 'CM1'), ...leg(2, legB, themeB, evB, 'CM2')]),
    section('mt', 'Manoeuvres training', 'mt', '0:50', { training_only: false, aims: { aims: 'Handling practice, graded as a task 1-5. Repeat until flown to standard.', visibility: 'instructor_only' } }, [
      setup('mt.setup', 'Set-up - manoeuvres', { airport: ['SKRG'], weather: [wx('SKRG', idx)], position: [`SKRG RWY 01, ${f.position.lineup}`], comms: [COMMS.SKRG[1]], reset: ['Clear all failures; reposition between repeats'], performance: [f.perf.toga] }, f.mass(f.fuel.mt), 'take'),
      ...mA, ...mB,
    ]),
    section('sbt', 'Scenario-based training', 'sbt', '1:10', { training_only: false, aims: { aims: 'A scenario the crew has not seen, drawn from the threat picture. Graded as a task 1-5; facilitate, and freeze the simulator to teach when it pays.', visibility: 'instructor_only' } }, [
      setup('sbt.setup', 'Set-up - scenario', { airport: [legB[1], legB[0]], weather: [wx(legB[1], idx + 2), wx(legB[0], idx + 3)], position: [`${legB[1]} gate, engines running, ready for taxi`], comms: [COMMS[legB[1]][0], COMMS[legB[0]][2]], reset: ['Reset fuel used before the scenario'], atc: ['Unrestricted climb; expect direct routing'], performance: [f.perf.to] }, f.mass(f.fuel.sbt), 'take'),
      malfGrid('sbt.malf', scTitle, fleet, f.scenarios[sc]),
      events('sbt.events', 'Events - scenario', [EVENTS.speed]),
      task('sbt.main', scTitle, { time: '0:55', pf: 'CM2', automation: { ap: 'crew_discretion', athr: 'crew_discretion', fd: 'crew_discretion' }, aims: aims(scAim, scFocus, scCriteria), conduct: { instructor_notes: scNotes, injects: [] }, grading: grading('scale_1_5') }),
      task('sbt.approach', 'Approach and landing after the scenario', { time: '0:15', pf: 'CM2', automation: { ap: 'crew_discretion', athr: 'crew_discretion', fd: 'required_on' }, aims: aims('Fly the diversion approach stabilised, with the scenario\'s consequences in mind.', 'Energy management and stabilised approach criteria under an ATC constraint.', 'Stabilised by 1 000 ft with the ATC constraint met; landing within the computed distance.'), conduct: { instructor_notes: 'Apply the landing consequences of the scenario (no reverse, longer distance, degraded braking) as they stand.', injects: [] }, grading: grading('scale_1_5') }),
    ]),
    section('reinf', 'Additional training', 'reinf', '0:20', { training_only: true }, [
      task('reinf.time', 'Additional training', { time: '0:20', aims: { aims: 'Repeat what was observed during the session - the manoeuvre or the behaviour the crew or the instructor identified. Time as observed. Not graded.', visibility: 'instructor_only' }, grading: grading() }),
    ]),
    section('debrief', 'Debriefing', 'debrief', '0:30', {}, [
      task('debrief.session', 'Facilitated debriefing', { time: '0:30', aims: { aims: 'Facilitated debrief led by the crew\'s own analysis of the evaluation phase; observable behaviours below standard, and the root cause, agreed before the grades are given.', visibility: 'also_in_subject_brief', grading_criteria: 'Analyses the crew\'s own performance openly; takes and gives feedback.' }, grading: grading('none', 'competent_not_competent', ['COM', 'LTW']) }),
    ]),
  ];
  return {
    note: `EBT recurrent, ${fleet}, ${year}, Module ${module}, Session ${session}. 1:00 briefing, 4:00 in the FFS, 0:30 debriefing; evaluation on competencies, manoeuvres and scenario graded as tasks 1-5, additional training as observed. Generated by scripts/gen-programs.mjs; every value is illustrative.`,
    template: {
      code, name, kind: 'ebt_recurrent', fleet,
      setup: { program: { code: `EBT-${fleet}`, module: `Module ${module}`, phase: null, day: session, cycle_months: 6, year }, period: '4:00', aims: aims('Assess and develop the crew\'s competencies in a line-oriented environment; train manoeuvres and scenarios drawn from the operator\'s threat picture.') },
      allowed_assessor_roles: ROLES.ebt,
      notes: `${year} threat picture: ${themeA} and ${themeB} failures in the evaluation, ${scTitle.toLowerCase()} in the scenario.`,
    },
    elements,
    competencies_default: ALL_COMPS,
  };
}

/* ------------------------------------------------------------------ OPC / LPC */

function proficiencyCheck(fleet, year) {
  const f = FLEET[fleet];
  const y = year - 2024;
  const item = (key, title, minutes, pf, a, criteria, comps, extra = [], automation = { ap: 'crew_discretion', athr: 'crew_discretion', fd: 'required_on' }) => [
    ...extra,
    task(key, title, { time: minutes, pf, automation, aims: aims(a, null, criteria, 'also_on_report'), conduct: { instructor_notes: null, injects: [] }, grading: grading('pass_fail', 'scale_1_5', comps) }),
  ];
  const themeA = THEMES[(y + 1) % THEMES.length];
  const themeB = THEMES[(y + 5) % THEMES.length];
  const sc = SCENARIOS[(y + 4) % SCENARIOS.length];
  const [scTitle, scAim, , scCriteria] = f.scenarioText[sc];
  return {
    note: `OPC/LPC, ${fleet}, ${year}. One session covers both checks: the examiner chooses OPC or LPC when the session is created; the LPC signature statement applies then. Items per EASA Part-FCL Appendix 9 and ORO.FC.230 in the operator's words; each item pass/fail plus competencies 1-5. Generated by scripts/gen-programs.mjs; every value is illustrative.`,
    template: {
      code: `pc.${fleet.toLowerCase()}.${year}`, name: `OPC/LPC - ${fleet}`, kind: 'proficiency_check', fleet,
      setup: { program: { code: `PC-${fleet}`, module: 'Proficiency check', phase: null, day: 1, cycle_months: 12, year }, period: '4:00', aims: aims('Demonstrate the required standard in normal, abnormal and emergency procedures for the type; a partial pass or a fail is recorded as such.') },
      allowed_assessor_roles: ROLES.check,
      notes: 'OPC or LPC is chosen by the examiner at session creation.',
    },
    elements: [
      section('brief', 'Briefing', 'brief', '1:00', {}, [
        note('brief.notes', 'Briefing guide', 'State whether the session is an OPC or an LPC and what a partial pass means for licence privileges. Items are checked, not trained; a repeat is allowed once per item where the regulation permits.'),
        task('brief.session', 'Check briefing', { time: '1:00', aims: { aims: 'Confirm the items, the standard and the consequences of a fail.', visibility: 'also_in_subject_brief', grading_criteria: 'Knows the limitations, memory items and the procedures for the items briefed.' }, grading: grading('none', 'competent_not_competent', ['KNO']) }),
      ]),
      section('a', 'Section A - Departure and manoeuvres', null, '2:00', {}, [
        setup('a.setup', 'Set-up - departure', { airport: ['SKBO'], weather: [wx('SKBO', y)], position: [`SKBO ${f.position.gate}`], comms: COMMS.SKBO, reset: ['Total reset'], performance: [`${f.perf.to}, wet runway`] }, f.mass(f.fuel.check), 'take'),
        ...item('a.preflight', 'Pre-flight, start and taxi', '0:15', 'CM1', 'Cockpit preparation, engine start with a start malfunction, taxi.', 'Checklists complete, start malfunction handled per procedure, taxi at a safe speed.', ['PRO', 'KNO'], [malfGrid('a.preflight.malf', 'Start malfunction', fleet, fleet === 'A320' ? [{ ref: 'malf.a320.70.eng-hot-start', option: '2', trigger: 'On start' }, { ref: 'malf.a320.70.eng-hung-start', option: '1', trigger: 'On start' }] : [{ ref: 'malf.b787.70.engine-hot-start', option: 'R', trigger: 'On start' }, { ref: 'malf.b787.70.engine-hot-start', option: 'L', trigger: 'On start' }])], { ap: 'not_applicable', athr: 'not_applicable', fd: 'not_applicable' }),
        ...item('a.rto', 'Rejected take-off', '0:15', 'CM1', 'Reject at high speed and stop on the runway.', 'Stop decision within the SOP window; full stopping means; brakes and cabin managed after the stop.', ['PSD', 'FPM'], [malfGrid('a.rto.malf', 'Reason to reject', fleet, f.rto)], { ap: 'required_off', athr: 'crew_discretion', fd: 'not_applicable' }),
        ...item('a.engv1', 'Engine failure between V1 and V2', '0:20', 'CM1', 'Continue the take-off with an engine failure, secure the engine.', 'Directional control within limits, climb speed as per SOP, engine secured with the procedure complete.', ['FPM', 'PRO'], [malfGrid('a.engv1.malf', 'Engine malfunction at V1', fleet, [f.engV1[y % 4], f.engV1[(y + 1) % 4], f.engV1[(y + 2) % 4]])], { ap: 'required_off', athr: 'crew_discretion', fd: 'required_on' }),
        ...item('a.oei', 'One-engine-inoperative approach, go-around and landing', '0:30', 'CM1', 'OEI ILS to minima, go-around, second approach and landing.', 'Stabilised OEI approach; go-around in the correct sequence; landing within the touchdown zone.', ['FPA', 'FPM']),
        ...item('a.system', 'System failure with an abnormal procedure', '0:25', 'CM2', 'Identify and manage a system failure in flight.', 'Failure identified, procedure applied, consequences for the landing understood and briefed.', ['PRO', 'SAW', 'WLM'], [malfGrid('a.system.malf', 'System failure', fleet, f.themes[themeA])]),
        ...item('a.upset', 'Upset prevention and recovery; approach to stall', '0:15', 'CM2', 'Recover from an upset and from an approach to stall.', 'Recovery technique in the correct order; no secondary stall; altitude loss within the expected range.', ['FPM'], [], { ap: 'required_off', athr: 'required_off', fd: 'required_off' }),
      ]),
      section('b', 'Section B - Approaches and emergencies', null, '2:00', {}, [
        setup('b.setup', 'Set-up - approaches', { airport: ['SKRG', 'SKCL'], weather: [wx('SKRG', y + 2), wx('SKCL', y + 1)], position: ['SKRG 15 NM final'], comms: [COMMS.SKRG[2], COMMS.SKRG[1]], reset: ['Clear all failures; recall the flight plan between items'], performance: [f.perf.ldg] }, f.mass(f.fuel.check), 'take'),
        ...item('b.rawdata', 'Raw-data ILS, manual', '0:15', 'CM2', 'ILS to minima without flight director or autothrust.', 'Localiser and glideslope within one dot below 1 000 ft; speed within +10/-5 kt.', ['FPM'], [], { ap: 'required_off', athr: 'required_off', fd: 'required_off' }),
        ...item('b.nonprecision', 'Non-precision approach and landing', '0:20', 'CM2', 'RNP approach with vertical guidance to minima and landing.', 'Approach briefed and flown as published; minima respected; stabilised by 1 000 ft.', ['FPA', 'PRO']),
        ...item('b.lvo', 'Low visibility approach', '0:20', 'CM1', 'CAT II/III approach and landing with the required callouts.', 'Callouts complete; decision at the correct height; landing or go-around as required.', ['PRO', 'COM'], [], { ap: 'required_on', athr: 'required_on', fd: 'required_on' }),
        ...item('b.emergency', scTitle, '0:30', 'CM1', scAim, scCriteria, ['PSD', 'LTW', 'WLM'], [malfGrid('b.emergency.malf', scTitle, fleet, f.scenarios[sc])]),
        ...item('b.warnings', 'TCAS, windshear and terrain warnings', '0:20', 'CM2', 'Respond to an RA, a windshear warning and a terrain warning.', 'Each escape manoeuvre flown at the warning with the correct technique; ATC informed.', ['FPM', 'SAW'], [events('b.warnings.events', 'Warnings', [{ ...EVENTS.tcasTa, name: 'Resolution advisory in the climb', trigger: 'Climbing through FL120' }, EVENTS.wsApp])], { ap: 'required_off', athr: 'required_off', fd: 'required_off' }),
        ...item('b.gaall', 'Go-around, all engines, and landing', '0:15', 'CM2', 'Go-around from minima and a landing to finish.', 'Correct sequence; level-off at the missed approach altitude; landing within the touchdown zone.', ['FPA'], [malfGrid('b.gaall.malf', 'On the second approach', fleet, f.themes[themeB], 'choose_one')]),
      ]),
      section('debrief', 'Debriefing', 'debrief', '0:30', {}, [
        task('debrief.session', 'Debriefing and result', { time: '0:30', aims: { aims: 'Result given item by item; a partial pass or a fail explained with the consequence for licence privileges.', visibility: 'also_in_subject_brief', grading_criteria: 'Accepts and analyses the result; asks what needs asking.' }, grading: grading('none', 'competent_not_competent', ['COM']) }),
      ]),
    ],
    competencies_default: ALL_COMPS,
  };
}

/* ------------------------------------------------------------------ ground school */

function groundSchool(fleet, year) {
  const systems = fleet === 'A320' ? 'Aircraft systems review - fly-by-wire, hydraulics, electrical, fuel' : 'Aircraft systems review - electrical architecture, flight control modes, fuel';
  const yearly = { 2024: ['RNP AR approaches at the mountainous bases', 'Volcanic ash procedures'], 2025: ['Fuel efficiency procedures', 'Runway excursion prevention'], 2026: ['GNSS interference and navigation degradation', 'Lithium battery fires in the cabin'] }[year];
  const subjects = [
    ['systems', systems, '3:00', 'Normal and abnormal operation of the type\'s systems, limitations and memory items.'],
    ['performance', 'Performance and flight planning', '2:00', 'Take-off and landing performance, contaminated runways, fuel policy and alternates.'],
    ['dg', 'Dangerous goods', '1:30', 'Classes, acceptance, loading and the response to an incident in flight.'],
    ['security', 'Security', '1:00', 'Flight deck access, unruly passengers, bomb threat procedures.'],
    ['equipment', 'Emergency and safety equipment', '1:30', 'Location and use of the type\'s equipment; evacuation and ditching.'],
    ['crm', 'Crew resource management and human factors', '2:00', 'Threat and error management, communication, workload, fatigue and the operator\'s reporting culture.'],
    ['sms', 'Safety management and reporting', '1:00', 'The SMS, the reporting system and what the operator learned from the year\'s reports.'],
    ['weather', 'Adverse weather operations', '1:30', 'Thunderstorms, windshear, icing, winter operations and the mountainous bases.'],
    ['lvo', 'Low visibility operations', '1:00', 'CAT II/III requirements, crew qualification, callouts and the airports used.'],
    ['focus', `Focus of the year - ${yearly[0]}`, '1:00', `${yearly[0]}; ${yearly[1]}.`],
  ];
  const total = subjects.reduce((m, s) => m + Number(s[2].split(':')[0]) * 60 + Number(s[2].split(':')[1]), 0);
  const period = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  return {
    note: `Recurrent ground school, ${fleet}, ${year}. One event, each subject graded as a task 1-5 and on knowledge; the knowledge test mark is recorded on the last subject. Generated by scripts/gen-programs.mjs; every value is illustrative.`,
    template: {
      code: `gs.${fleet.toLowerCase()}.${year}`, name: `Recurrent ground school - ${fleet}`, kind: 'ground_school', fleet,
      setup: { program: { code: `GS-${fleet}`, module: 'Ground school', phase: null, day: 1, cycle_months: 12, year }, period, aims: aims('Refresh the knowledge the recurrent cycle relies on: systems, performance, procedures, and the year\'s safety focus.') },
      allowed_assessor_roles: ROLES.ground,
      notes: `${year} focus: ${yearly.join('; ')}.`,
    },
    elements: subjects.map(([key, title, time, text], i) => section(key, title, null, time, {}, [
      task(`${key}.subject`, title, { time, aims: { aims: text, visibility: 'also_on_report', grading_criteria: i === subjects.length - 1 ? 'Knowledge test 80 % or above; participation in the case discussion.' : 'Answers the instructor\'s questions correctly; participates in the exercises.' }, grading: grading('scale_1_5', 'competent_not_competent', ['KNO']) }),
      ...(i === subjects.length - 1 ? [note(`${key}.test`, 'Knowledge test', 'Written test, 40 questions across all subjects, closed book. Mark recorded in the comment of this subject.')] : []),
    ])),
    competencies_default: ALL_COMPS,
  };
}

/* ------------------------------------------------------------------ line check */

function lineCheck() {
  const phase = (key, title, time, text, criteria, comps) => section(key, title, null, time, {}, [
    task(`${key}.task`, title, { time, aims: { aims: text, visibility: 'also_on_report', grading_criteria: criteria }, grading: grading('none', 'scale_1_5', comps) }),
  ]);
  return {
    note: 'Line check, every fleet, reused every year. Departure, destination, legs, PF/PM, aircraft type, registration and flight time are entered by the examiner when the session is created; the template carries the phases and what is assessed in each. Generated by scripts/gen-programs.mjs.',
    template: {
      code: 'lc.line-check', name: 'Line check', kind: 'line_check', fleet: null,
      setup: { program: { code: 'LC', module: 'Line check', phase: null, day: null, cycle_months: 12, year: null }, period: null, aims: aims('Observe a normal line operation and assess the competencies as they are applied on the line; no abnormal is introduced.') },
      allowed_assessor_roles: ROLES.check,
      notes: 'Route, legs, aircraft and flight time are session details, not template content.',
    },
    elements: [
      section('brief', 'Briefing', 'brief', '0:30', {}, [
        note('brief.notes', 'Examiner guide', 'The examiner observes and does not intervene unless safety requires it. Say so before the flight. Legs are added on the session as flown; the record carries all of them.'),
        task('brief.session', 'Pre-flight briefing with the crew', { time: '0:30', aims: { aims: 'Explain the check, the role of the examiner and what is assessed.', visibility: 'also_in_subject_brief', grading_criteria: 'Understands the check and the standard.' }, grading: grading('none', 'competent_not_competent', ['COM']) }),
      ]),
      phase('preflight', 'Pre-flight preparation', '0:45', 'Flight planning, weather, NOTAMs, fuel decision, aircraft acceptance and the crew briefing.', 'Threats identified and briefed; fuel decision reasoned; documents checked.', ['KNO', 'SAW', 'COM']),
      phase('departure', 'Departure', '0:30', 'Start, taxi, take-off and climb; SOP compliance and ATC communication.', 'Callouts and checklists complete; SID flown as cleared; monitoring effective.', ['PRO', 'FPA', 'COM']),
      phase('cruise', 'Cruise', '1:00', 'Fuel and systems monitoring, weather avoidance, cabin coordination, preparation of the arrival.', 'Monitoring maintained; deviations decided in time; arrival prepared and briefed.', ['SAW', 'WLM', 'LTW']),
      phase('arrival', 'Arrival, approach and landing', '0:45', 'Descent management, approach as briefed, stabilised approach criteria, landing and rollout.', 'Stabilised by 1 000 ft; approach as briefed or a go-around; landing within the touchdown zone.', ['FPA', 'FPM', 'PSD']),
      phase('postflight', 'Post-flight and turnaround', '0:15', 'Shutdown, documents, reporting and the crew debrief.', 'Aircraft handed over correctly; reports filed; open items shared.', ['PRO', 'COM']),
      section('debrief', 'Debriefing', 'debrief', '0:30', {}, [
        task('debrief.session', 'Debriefing and result', { time: '0:30', aims: { aims: 'Result given per phase, strengths and development points agreed.', visibility: 'also_in_subject_brief', grading_criteria: 'Reflects on the flight openly; accepts feedback.' }, grading: grading('none', 'competent_not_competent', ['COM', 'LTW']) }),
      ]),
    ],
    competencies_default: ALL_COMPS,
  };
}

/* ------------------------------------------------------------------ main */

const readJson = async (name) => JSON.parse(await readFile(path.join(LIB, name), 'utf8'));
for (const file of ['a320-malfunctions.json', 'b787-malfunctions.json']) for (const m of (await readJson(file)).malfunctions) MALF.set(m.code, m);

const defs = [];
for (const fleet of FLEETS) for (const year of YEARS) {
  for (const module of [1, 2]) for (const session of [1, 2]) defs.push(ebtSession(fleet, year, module, session));
  defs.push(proficiencyCheck(fleet, year));
  defs.push(groundSchool(fleet, year));
}
defs.push(lineCheck());

// Keys unique within a definition, every malfunction ref known.
for (const d of defs) {
  const keys = new Set();
  const walk = (els) => { for (const e of els) { if (keys.has(e.key)) throw new Error(`${d.template.code}: duplicate key ${e.key}`); keys.add(e.key); walk(e.children ?? []); } };
  walk(d.elements);
}

await mkdir(OUT, { recursive: true });
for (const d of defs) await writeFile(path.join(OUT, `${d.template.code}.json`), JSON.stringify(d, null, 2) + '\n');
await writeFile(path.join(OUT, 'retired.json'), JSON.stringify({ note: 'Program codes seed-program.mjs sets inactive: superseded seeds that still exist in a database.', codes: ['ebt.a320.recurrent.s1'] }, null, 2) + '\n');
console.log(`${defs.length} program definitions written to ${OUT}: ${defs.map((d) => d.template.code).join(', ')}`);
