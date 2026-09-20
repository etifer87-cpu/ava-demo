/**
 * lib/program/shape.ts - the content shape of a program template's elements.
 *
 * `template_elements.content` is JSONB and, before this file, free-form. Every screen that reads
 * or writes it now goes through the parsers here, so there is exactly one place that knows what
 * a task, a section, a set-up or an option group may carry. docs/06_PROGRAM_BUILDER.md section 2.1.
 *
 * PURE. No imports from config.ts (server-only) and no database: the operator vocabularies a
 * parser needs - phases, section kinds, PF seats - arrive as a `ProgramVocab` value, read from
 * policy.yaml by lib/program/index.ts and passed DOWN. That is what lets the same parsers run in
 * a unit test with a literal vocabulary, and it is the binding rule of every config file: nothing
 * here hardcodes a value that lives in YAML.
 *
 * TWO KINDS OF VOCABULARY, deliberately split:
 *   - Operator words (phases, section kinds, seats) come from policy.yaml. An operator adds a
 *     phase without a deploy.
 *   - Renderer branches (automation states, grading modes, visibility, selection policy,
 *     snapshot) are code constants. Each value needs a control, a projection rule and a report
 *     block; a value added to YAML with no branch behind it would render as a blank. Same reasoning
 *     as migration 0033's element catalogue.
 *
 * PARSING IS LENIENT AND HONEST. Unknown keys are ignored (a later edition may add some); a wrong
 * type or an unknown enum value is dropped AND reported as a ShapeProblem with its path. The
 * builder's write path refuses a save with problems; the read path renders what parsed and shows
 * the problems, because a task whose one bad field hides the whole task is a task nobody can fix.
 */

/* ------------------------------------------------------------------ */
/* Code vocabularies - renderer branches                                */
/* ------------------------------------------------------------------ */

export const AUTOMATION_STATES = ['required_on', 'required_off', 'crew_discretion', 'not_applicable'] as const;
export type AutomationState = (typeof AUTOMATION_STATES)[number];

export const TASK_OUTCOME_MODES = ['none', 'pass_fail', 'scale_1_5'] as const;
export type TaskOutcomeMode = (typeof TASK_OUTCOME_MODES)[number];

export const COMPETENCY_GRADE_MODES = ['none', 'scale_1_5', 'competent_not_competent'] as const;
export type CompetencyGradeMode = (typeof COMPETENCY_GRADE_MODES)[number];

export const AIMS_VISIBILITY = ['instructor_only', 'also_in_subject_brief', 'also_on_report'] as const;
export type AimsVisibility = (typeof AIMS_VISIBILITY)[number];

export const SELECTION_POLICIES = ['instructor_choice', 'rotation', 'random', 'manager_assigned'] as const;
export type SelectionPolicy = (typeof SELECTION_POLICIES)[number];

export const SNAPSHOT_ACTIONS = ['take', 'recall'] as const;
export type SnapshotAction = (typeof SNAPSHOT_ACTIONS)[number];
/** What a PF/PM choice on an exercise counts as on the line-flying status: a take-off, a landing, or nothing in particular. */
export const PF_PM_COUNTERS = ['take_off', 'landing', 'other'] as const;
export type PfPmCounter = (typeof PF_PM_COUNTERS)[number];

/** The seven set-up condition kinds. A key, so a picker can enumerate them in order. */
export const SETUP_KINDS = ['airport', 'weather', 'mass_config', 'position', 'comms', 'reset', 'atc_script'] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Operator vocabulary - from policy.yaml, passed in                     */
/* ------------------------------------------------------------------ */

export interface ProgramVocab {
  /** Section kinds an author arranges, outermost first: e.g. module, session, block. */
  readonly sectionKinds: ReadonlySet<string>;
  /** Phase codes with their display labels: e.g. eval, mt, sbt. */
  readonly phases: ReadonlyMap<string, string>;
  /** Pilot-flying seats: e.g. CM1, CM2. */
  readonly pfSeats: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ */
/* The shapes                                                           */
/* ------------------------------------------------------------------ */

/** A reference into element_library, with an optional local override that sets `modified`. */
export interface LibraryRef {
  /** element_library.code. Never a title: the library is the authority on the name. */
  readonly ref: string;
  /** A local variation, rendered instead of the library text. Its presence marks the element modified. */
  readonly override: string | null;
}

export interface SetupConditions {
  readonly airport: LibraryRef | null;
  readonly weather: LibraryRef | null;
  readonly mass_config: LibraryRef | null;
  readonly position: LibraryRef | null;
  readonly comms: LibraryRef | null;
  readonly reset: LibraryRef | null;
  readonly atc_script: LibraryRef | null;
}

export interface SlotRef {
  /** equivalency group code in the library. */
  readonly group: string;
  readonly policy: SelectionPolicy;
  /** Authored constraints, shown as authored. Evaluation needs a history and lands with delivery. */
  readonly no_repeat_within_modules: number | null;
  readonly cycle_coverage: boolean;
}

export interface Conduct {
  /** Fixed failure. Mutually exclusive with `slot`: when a slot is present the failure is chosen at delivery. */
  readonly malfunction: LibraryRef | null;
  readonly slot: SlotRef | null;
  /** "Between V1 and V2", "Passing 1500 ft AAL". */
  readonly insertion: string | null;
  readonly injects: readonly LibraryRef[];
  /** Free text. Never leaves the instructor projection. */
  readonly instructor_notes: string | null;
}

export interface Automation {
  readonly ap: AutomationState;
  readonly athr: AutomationState;
  readonly fd: AutomationState;
}

export interface Aims {
  readonly aims: string | null;
  readonly competency_focus: string | null;
  readonly grading_criteria: string | null;
  readonly visibility: AimsVisibility;
}

export interface Grading {
  readonly task_outcome_mode: TaskOutcomeMode;
  readonly competency_grade_mode: CompetencyGradeMode;
  /** Framework competency codes this task targets. Resolved against the database at publish. */
  readonly competencies: readonly string[];
}

export interface TaskContent {
  /** Planned minutes. Parsed from "H:MM" or a number; null when not stated. */
  readonly minutes: number | null;
  /** Pilot flying, an operator seat code. null renders blank - never "both". */
  readonly pf: string | null;
  readonly setup: SetupConditions;
  readonly conduct: Conduct;
  readonly automation: Automation;
  readonly aims: Aims;
  readonly grading: Grading;
  readonly snapshot: SnapshotAction | null;
  /** When set, the instructor records whether the trainee flew this exercise as PF or PM on each
   *  record; the value says what the choice counts towards (take-offs, landings) on the status. */
  readonly pf_pm: PfPmCounter | null;
  /** Per-device overrides keyed by asset_class code, e.g. "FFS-A320". Shallow: a key present replaces that key. */
  readonly variants: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface SectionContent {
  /** module | session | block, from the operator's section kinds. */
  readonly section_kind: string | null;
  /** Phase code; null on a section that is not a phase (a module, a session). */
  readonly phase: string | null;
  /** Planned minutes for the section as a whole; null means "sum the children". */
  readonly minutes: number | null;
  /** Provenance: the library preset this was placed from, if any. Copied, never linked. */
  readonly from_preset: string | null;
  readonly aims: Aims;
  /** Whether grades in this section count towards the session outcome. */
  readonly training_only: boolean;
  /** The section's own grade controls, when the phase as a whole carries an outcome. */
  readonly grading: Grading;
}

/** The set-up element's entry kinds, in the order the pane shows them. Free text, "+" for more. */
export const SETUP_ENTRY_KINDS = ['airport', 'weather', 'position', 'comms', 'reset', 'atc', 'performance'] as const;
export type SetupEntryKind = (typeof SETUP_ENTRY_KINDS)[number];

/**
 * A Set-up element: what the simulator is set to before an exercise. Every kind is a list of free
 * text lines (an author types the ICAO code, the METAR, the frequency); mass & config is three
 * numbers. This is the element the author drags in; the older per-task `setup` references stay in
 * TaskContent for compatibility and are not shown.
 */
export interface SetupContent {
  readonly entries: Readonly<Record<SetupEntryKind, readonly string[]>>;
  readonly mass: { readonly zfw: string | null; readonly zfwcg: string | null; readonly fuel: string | null };
  readonly notes: string | null;
  readonly snapshot: SnapshotAction | null;
}

export const OPTION_GROUP_KINDS = ['malfunction', 'event'] as const;
export type OptionGroupKind = (typeof OPTION_GROUP_KINDS)[number];
export const OPTION_GROUP_MODES = ['sequence', 'choose_one'] as const;
export type OptionGroupMode = (typeof OPTION_GROUP_MODES)[number];

/**
 * An option group is a Malfunction or an Event element on the canvas: one or more items, run in
 * sequence or offered as a grid for the instructor to choose one at delivery (the chosen one is
 * what the record stores). `kind` separates a failure of an aircraft component from everything
 * else that happens to the crew (TCAS, windshear, an ATC call). `fleet` is the aircraft type the
 * malfunction list was searched under; null means the program's fleet.
 */
export interface OptionGroupContent {
  readonly kind: OptionGroupKind;
  readonly mode: OptionGroupMode;
  readonly fleet: string | null;
  readonly options: readonly { readonly key: string; readonly name: string; readonly trigger: string | null; readonly ref: string | null; readonly option: string | null; readonly category: string | null }[];
  readonly slot: SlotRef | null;
}

export interface NoteContent {
  readonly text: string;
}

/** The version-level setup block: session_template_versions.setup. */
export interface VersionSetup {
  readonly program: {
    /** Groups the templates of one program across days, e.g. "M1-PII". */
    readonly code: string | null;
    readonly module: string | null;
    readonly phase: string | null;
    readonly day: number | null;
    readonly cycle_months: number | null;
    /** The year the program applies to, e.g. 2026. */
    readonly year: number | null;
  };
  /** The declared period, in minutes. The time rules measure against this. */
  readonly period_minutes: number | null;
  /* No device here: the device is chosen when a session (an ETR) is created, never on the program. */
  /** Program-level aims, inherited by every element beneath. */
  readonly aims: Aims;
}

export interface ShapeProblem {
  readonly path: string;
  readonly message: string;
}

export interface Parsed<T> {
  readonly value: T;
  readonly problems: readonly ShapeProblem[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Collector {
  readonly problems: ShapeProblem[] = [];
  constructor(private readonly base: string) {}
  at(path: string): string {
    return this.base ? `${this.base}.${path}` : path;
  }
  add(path: string, message: string): void {
    this.problems.push({ path: this.at(path), message });
  }
}

/** "H:MM" -> minutes. Also accepts a plain number of minutes. Returns null for absent or unparseable. */
export function parseMinutes(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** minutes -> "H:MM". The inverse of parseMinutes, used by every screen that shows a time. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function str(c: Collector, o: Obj, key: string, max = 4000): string | null {
  const v = o[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') { c.add(key, 'must be text'); return null; }
  return v.length > max ? v.slice(0, max) : v;
}

function bool(c: Collector, o: Obj, key: string, fallback: boolean): boolean {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') { c.add(key, 'must be true or false'); return fallback; }
  return v;
}

function int(c: Collector, o: Obj, key: string): number | null {
  const v = o[key];
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) { c.add(key, 'must be a whole number'); return null; }
  return n;
}

function minutes(c: Collector, o: Obj, key: string): number | null {
  const v = o[key];
  if (v === undefined || v === null || v === '') return null;
  const n = parseMinutes(v);
  if (n === null) c.add(key, 'must be a time like 0:45');
  return n;
}

function oneOf<T extends string>(c: Collector, o: Obj, key: string, allowed: readonly T[] | ReadonlySet<string>, fallback: T | null): T | null {
  const v = o[key];
  if (v === undefined || v === null || v === '') return fallback;
  const ok = typeof v === 'string' && (Array.isArray(allowed) ? (allowed as readonly string[]).includes(v) : (allowed as ReadonlySet<string>).has(v));
  if (!ok) { c.add(key, `must be one of ${[...allowed].join(', ')}`); return fallback; }
  return v as T;
}

function libraryRef(c: Collector, v: unknown, path: string): LibraryRef | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v ? { ref: v, override: null } : null;   // shorthand: a bare code
  if (!isObj(v)) { c.add(path, 'must be a library reference'); return null; }
  const ref = typeof v.ref === 'string' ? v.ref : '';
  if (!ref) { c.add(`${path}.ref`, 'a library reference needs a code'); return null; }
  const override = typeof v.override === 'string' && v.override ? v.override : null;
  if (v.override !== undefined && v.override !== null && typeof v.override !== 'string') c.add(`${path}.override`, 'must be text');
  return { ref, override };
}

function aims(c: Collector, v: unknown, path: string): Aims {
  const empty: Aims = { aims: null, competency_focus: null, grading_criteria: null, visibility: 'instructor_only' };
  if (v === undefined || v === null) return empty;
  if (!isObj(v)) { c.add(path, 'must be an object'); return empty; }
  const cc = new Collector(c.at(path));
  const out: Aims = {
    aims: str(cc, v, 'aims'),
    competency_focus: str(cc, v, 'competency_focus'),
    grading_criteria: str(cc, v, 'grading_criteria'),
    visibility: oneOf(cc, v, 'visibility', AIMS_VISIBILITY, 'instructor_only') ?? 'instructor_only',
  };
  c.problems.push(...cc.problems);
  return out;
}

function gradingOf(c: Collector, v: unknown, path: string): Grading {
  const gradingRaw: Obj = isObj(v) ? v : {};
  if (v !== undefined && v !== null && !isObj(v)) c.add(path, 'must be an object');
  const gc = new Collector(c.at(path));
  const compsRaw = gradingRaw.competencies;
  const competencies: string[] = [];
  if (compsRaw !== undefined && compsRaw !== null) {
    if (!Array.isArray(compsRaw)) gc.add('competencies', 'must be a list of competency codes');
    else compsRaw.forEach((x, i) => { if (typeof x === 'string' && x) { if (!competencies.includes(x)) competencies.push(x); } else gc.add(`competencies[${i}]`, 'must be a competency code'); });
  }
  const out: Grading = {
    task_outcome_mode: oneOf(gc, gradingRaw, 'task_outcome_mode', TASK_OUTCOME_MODES, 'none') ?? 'none',
    competency_grade_mode: oneOf(gc, gradingRaw, 'competency_grade_mode', COMPETENCY_GRADE_MODES, 'none') ?? 'none',
    competencies,
  };
  // DELIBERATELY NOT A PARSE PROBLEM. A grading mode with an empty competency list is bad policy,
  // not a broken shape: it parses, round-trips and stores perfectly well. It used to be added here,
  // and because write.ts refuses a save that produced ANY parse problem, the state could never be
  // stored - which made `task.no_competencies` (config/rules.yaml, severity: block) unreachable: a
  // blocker for a condition the builder would not let you create. Untick the last competency on a
  // graded exercise and the save was refused instead of the header going red, which is the opposite
  // of what the Findings card promises.
  //
  // The division of labour: SHAPE answers 'can this be represented', RULES answer 'may this be
  // published'. A draft is allowed to be mid-thought; publish.ts refuses on blockers, so nothing
  // incomplete can escape into a published version. See config/rules.yaml `task.no_competencies`.
  c.problems.push(...gc.problems);
  return out;
}

function slotRef(c: Collector, v: unknown, path: string): SlotRef | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) { c.add(path, 'must be a slot reference'); return null; }
  const cc = new Collector(c.at(path));
  const group = str(cc, v, 'group', 200);
  if (!group) { cc.add('group', 'a slot needs an equivalency group'); c.problems.push(...cc.problems); return null; }
  const out: SlotRef = {
    group,
    policy: oneOf(cc, v, 'policy', SELECTION_POLICIES, 'instructor_choice') ?? 'instructor_choice',
    no_repeat_within_modules: int(cc, v, 'no_repeat_within_modules'),
    cycle_coverage: bool(cc, v, 'cycle_coverage', false),
  };
  c.problems.push(...cc.problems);
  return out;
}

/* ------------------------------------------------------------------ */
/* Parsers                                                              */
/* ------------------------------------------------------------------ */

export function parseTaskContent(raw: unknown, vocab: ProgramVocab): Parsed<TaskContent> {
  const c = new Collector('');
  const o: Obj = isObj(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isObj(raw)) c.add('', 'content must be an object');

  // set-up: six keyed references
  const setupRaw: Obj = isObj(o.setup) ? o.setup : {};
  if (o.setup !== undefined && o.setup !== null && !isObj(o.setup)) c.add('setup', 'must be an object');
  const setup: SetupConditions = {
    airport: libraryRef(c, setupRaw.airport, 'setup.airport'),
    weather: libraryRef(c, setupRaw.weather, 'setup.weather'),
    mass_config: libraryRef(c, setupRaw.mass_config, 'setup.mass_config'),
    position: libraryRef(c, setupRaw.position, 'setup.position'),
    comms: libraryRef(c, setupRaw.comms, 'setup.comms'),
    reset: libraryRef(c, setupRaw.reset, 'setup.reset'),
    atc_script: libraryRef(c, setupRaw.atc_script, 'setup.atc_script'),
  };

  // conduct
  const conductRaw: Obj = isObj(o.conduct) ? o.conduct : {};
  if (o.conduct !== undefined && o.conduct !== null && !isObj(o.conduct)) c.add('conduct', 'must be an object');
  const cc = new Collector('conduct');
  const injectsRaw = conductRaw.injects;
  const injects: LibraryRef[] = [];
  if (injectsRaw !== undefined && injectsRaw !== null) {
    if (!Array.isArray(injectsRaw)) cc.add('injects', 'must be a list');
    else injectsRaw.forEach((x, i) => { const r = libraryRef(cc, x, `injects[${i}]`); if (r) injects.push(r); });
  }
  const malfunction = libraryRef(cc, conductRaw.malfunction, 'malfunction');
  const slot = slotRef(cc, conductRaw.slot, 'slot');
  if (malfunction && slot) cc.add('malfunction', 'a task carries a fixed malfunction OR a slot, not both; the slot wins');
  const conduct: Conduct = {
    malfunction: slot ? null : malfunction,
    slot,
    insertion: str(cc, conductRaw, 'insertion', 400),
    injects,
    instructor_notes: str(cc, conductRaw, 'instructor_notes'),
  };
  c.problems.push(...cc.problems);

  // automation: three independent chips
  const autoRaw: Obj = isObj(o.automation) ? o.automation : {};
  if (o.automation !== undefined && o.automation !== null && !isObj(o.automation)) c.add('automation', 'must be an object');
  const ac = new Collector('automation');
  const automation: Automation = {
    ap: oneOf(ac, autoRaw, 'ap', AUTOMATION_STATES, 'crew_discretion') ?? 'crew_discretion',
    athr: oneOf(ac, autoRaw, 'athr', AUTOMATION_STATES, 'crew_discretion') ?? 'crew_discretion',
    fd: oneOf(ac, autoRaw, 'fd', AUTOMATION_STATES, 'crew_discretion') ?? 'crew_discretion',
  };
  c.problems.push(...ac.problems);

  const grading = gradingOf(c, o.grading, 'grading');

  // variants: keyed by device code, shallow objects
  const variants: Record<string, Readonly<Record<string, unknown>>> = {};
  if (o.variants !== undefined && o.variants !== null) {
    if (!isObj(o.variants)) c.add('variants', 'must be an object keyed by device code');
    else for (const [k, v] of Object.entries(o.variants)) {
      if (isObj(v)) variants[k] = v; else c.add(`variants.${k}`, 'must be an object of overrides');
    }
  }

  const value: TaskContent = {
    minutes: minutes(c, o, 'time') ?? minutes(c, o, 'minutes'),
    pf: oneOf(c, o, 'pf', vocab.pfSeats, null),
    setup,
    conduct,
    automation,
    aims: aims(c, o.aims, 'aims'),
    grading,
    snapshot: oneOf(c, o, 'snapshot', SNAPSHOT_ACTIONS, null),
    pf_pm: oneOf(c, o, 'pf_pm', PF_PM_COUNTERS, null),
    variants,
  };
  return { value, problems: c.problems };
}

export function parseSectionContent(raw: unknown, vocab: ProgramVocab): Parsed<SectionContent> {
  const c = new Collector('');
  const o: Obj = isObj(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isObj(raw)) c.add('', 'content must be an object');
  const value: SectionContent = {
    section_kind: oneOf(c, o, 'section_kind', vocab.sectionKinds, null),
    phase: oneOf(c, o, 'phase', new Set(vocab.phases.keys()), null),
    minutes: minutes(c, o, 'time') ?? minutes(c, o, 'minutes'),
    from_preset: str(c, o, 'from_preset', 200),
    aims: aims(c, o.aims, 'aims'),
    training_only: bool(c, o, 'training_only', false),
    grading: gradingOf(c, o.grading, 'grading'),
  };
  return { value, problems: c.problems };
}

const EMPTY_ENTRIES: Record<SetupEntryKind, string[]> = { airport: [], weather: [], position: [], comms: [], reset: [], atc: [], performance: [] };

export function parseSetupContent(raw: unknown): Parsed<SetupContent> {
  const c = new Collector('');
  const o: Obj = isObj(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isObj(raw)) c.add('', 'content must be an object');
  const entries: Record<SetupEntryKind, string[]> = { airport: [], weather: [], position: [], comms: [], reset: [], atc: [], performance: [] };
  const e: Obj = isObj(o.entries) ? o.entries : {};
  if (o.entries !== undefined && o.entries !== null && !isObj(o.entries)) c.add('entries', 'must be an object');
  for (const k of SETUP_ENTRY_KINDS) {
    const v = e[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) { c.add(`entries.${k}`, 'must be a list of text'); continue; }
    entries[k] = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 20);
  }
  // Older rows: { rows: [{label, value}] } from the library seed and the first builder. Folded in by label.
  if (Array.isArray(o.rows)) {
    for (const r of o.rows) {
      if (!isObj(r) || typeof r.value !== 'string' || !r.value.trim()) continue;
      const label = String(r.label ?? '').toLowerCase();
      const kind: SetupEntryKind = label.startsWith('airport') ? 'airport' : label.startsWith('weather') ? 'weather' : label.startsWith('position') ? 'position' : label.startsWith('comms') ? 'comms' : label.startsWith('reset') ? 'reset' : label.startsWith('atc') ? 'atc' : 'performance';
      if (!entries[kind].includes(r.value.trim())) entries[kind].push(r.value.trim());
    }
  }
  const m: Obj = isObj(o.mass) ? o.mass : {};
  if (o.mass !== undefined && o.mass !== null && !isObj(o.mass)) c.add('mass', 'must be an object');
  const mc = new Collector('mass');
  const value: SetupContent = {
    entries,
    mass: { zfw: str(mc, m, 'zfw', 40), zfwcg: str(mc, m, 'zfwcg', 40), fuel: str(mc, m, 'fuel', 40) },
    notes: str(c, o, 'notes'),
    snapshot: oneOf(c, o, 'snapshot', SNAPSHOT_ACTIONS, null),
  };
  c.problems.push(...mc.problems);
  return { value, problems: c.problems };
}

export function serialiseSetupContent(v: SetupContent): Record<string, unknown> {
  return { entries: v.entries, mass: v.mass, notes: v.notes, snapshot: v.snapshot };
}

export function parseOptionGroupContent(raw: unknown): Parsed<OptionGroupContent> {
  const c = new Collector('');
  const o: Obj = isObj(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isObj(raw)) c.add('', 'content must be an object');
  const options: OptionGroupContent['options'][number][] = [];
  const seen = new Set<string>();
  if (o.options !== undefined && o.options !== null) {
    if (!Array.isArray(o.options)) c.add('options', 'must be a list');
    else o.options.forEach((r, i) => {
      if (!isObj(r) || typeof r.key !== 'string' || !r.key || typeof r.name !== 'string' || !r.name) { c.add(`options[${i}]`, 'must be {key, name, trigger?}'); return; }
      if (seen.has(r.key)) { c.add(`options[${i}].key`, `option key "${r.key}" is used twice`); return; }
      seen.add(r.key);
      options.push({
        key: r.key, name: r.name,
        trigger: typeof r.trigger === 'string' && r.trigger ? r.trigger : null,
        ref: typeof r.ref === 'string' && r.ref ? r.ref : null,
        option: typeof r.option === 'string' && r.option ? r.option : null,
        category: typeof r.category === 'string' && r.category ? r.category : null,
      });
    });
  }
  const value: OptionGroupContent = {
    kind: oneOf(c, o, 'kind', OPTION_GROUP_KINDS, 'malfunction') ?? 'malfunction',
    mode: oneOf(c, o, 'mode', OPTION_GROUP_MODES, 'sequence') ?? 'sequence',
    fleet: str(c, o, 'fleet', 40),
    options,
    slot: slotRef(c, o.slot, 'slot'),
  };
  return { value, problems: c.problems };
}

export function parseNoteContent(raw: unknown): Parsed<NoteContent> {
  const c = new Collector('');
  const o: Obj = isObj(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isObj(raw)) c.add('', 'content must be an object');
  const text = str(c, o, 'text', 20000) ?? '';
  if (!text) c.add('text', 'a note needs text');
  return { value: { text }, problems: c.problems };
}

export function parseVersionSetup(raw: unknown): Parsed<VersionSetup> {
  const c = new Collector('');
  const o: Obj = isObj(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isObj(raw)) c.add('', 'setup must be an object');
  const p: Obj = isObj(o.program) ? o.program : {};
  if (o.program !== undefined && o.program !== null && !isObj(o.program)) c.add('program', 'must be an object');
  const pc = new Collector('program');
  const value: VersionSetup = {
    program: {
      code: str(pc, p, 'code', 40),
      module: str(pc, p, 'module', 40),
      phase: str(pc, p, 'phase', 40),
      day: int(pc, p, 'day'),
      cycle_months: int(pc, p, 'cycle_months'),
      year: int(pc, p, 'year'),
    },
    period_minutes: minutes(c, o, 'period'),
    aims: aims(c, o.aims, 'aims'),
  };
  c.problems.push(...pc.problems);
  return { value, problems: c.problems };
}

/**
 * Serialisers - the inverse of the parsers, for the write path. They emit the canonical spelling
 * (minutes as "H:MM", refs as objects) so that two saves of the same content are byte-identical
 * and a diff in the app log is a diff in meaning.
 */
export function serialiseTaskContent(t: TaskContent): Record<string, unknown> {
  const ref = (r: LibraryRef | null) => (r ? { ref: r.ref, override: r.override } : null);
  return {
    time: t.minutes === null ? null : formatMinutes(t.minutes),
    pf: t.pf,
    setup: Object.fromEntries(SETUP_KINDS.map((k) => [k, ref(t.setup[k])])),
    conduct: {
      malfunction: ref(t.conduct.malfunction),
      slot: t.conduct.slot,
      insertion: t.conduct.insertion,
      injects: t.conduct.injects.map(ref),
      instructor_notes: t.conduct.instructor_notes,
    },
    automation: t.automation,
    aims: t.aims,
    grading: t.grading,
    snapshot: t.snapshot,
    pf_pm: t.pf_pm,
    variants: t.variants,
  };
}

export function serialiseSectionContent(s: SectionContent): Record<string, unknown> {
  return {
    section_kind: s.section_kind,
    phase: s.phase,
    time: s.minutes === null ? null : formatMinutes(s.minutes),
    from_preset: s.from_preset,
    aims: s.aims,
    training_only: s.training_only,
    grading: s.grading,
  };
}

export function serialiseOptionGroupContent(v: OptionGroupContent): Record<string, unknown> {
  return { kind: v.kind, mode: v.mode, fleet: v.fleet, options: v.options, slot: v.slot };
}

export function serialiseNoteContent(v: NoteContent): Record<string, unknown> {
  return { text: v.text };
}

/** True when any set-up or conduct field departs from its library text. Drives the "modified" badge. */
export function isModifiedFromLibrary(t: TaskContent): boolean {
  const refs: (LibraryRef | null)[] = [...SETUP_KINDS.map((k) => t.setup[k]), t.conduct.malfunction, ...t.conduct.injects];
  return refs.some((r) => r !== null && r.override !== null);
}
