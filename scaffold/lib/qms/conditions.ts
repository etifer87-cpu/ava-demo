/**
 * scaffold/lib/qms/conditions.ts
 *
 * The condition-type registry. ONE exported object, CONDITION_TYPES, drives both halves of the
 * module: the builder renders its editor from `params`, and the engine evaluates through
 * `evaluate`. A condition type present in one and absent from the other is the defect this file
 * exists to prevent.
 *
 * Adding a condition type is one entry here plus, where the evidence is new, one integration
 * feed. It is never a schema change.
 *
 * Spec: docs/08_QMS.md section 4.
 */

/* ------------------------------------------------------------------ dates */

/** Pure date helpers. Every comparison goes through them; none of them reads a clock. */
export const toDay = (v: string | Date | null | undefined): number | null => {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString();
  const ms = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(ms) ? null : Math.floor(ms / 86400000);
};

export const toISODate = (day: number): string =>
  new Date(day * 86400000).toISOString().slice(0, 10);

export const maxDate = (dates: (string | null | undefined)[]): string | null => {
  let best: number | null = null;
  for (const d of dates) {
    const n = toDay(d);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best === null ? null : toISODate(best);
};

export const minDate = (dates: (string | null | undefined)[]): string | null => {
  let best: number | null = null;
  for (const d of dates) {
    const n = toDay(d);
    if (n !== null && (best === null || n < best)) best = n;
  }
  return best === null ? null : toISODate(best);
};

/* --------------------------------------------------------------- evidence */

export interface EvidenceRecord {
  record_id: string;
  template_code: string | null;
  session_kind: string | null;
  result: string | null;
  event_date: string;
  source: 'app' | 'import' | 'ingest' | 'external';
}

export interface EvidenceCompetencyGrade {
  record_id: string;
  competency_id: string;
  grade_num: number | null;
  event_date: string;
}

export interface EvidenceObSelection {
  record_id: string;
  observable_behaviour_id: string;
  event_date: string;
}

export interface EvidenceElementGrade {
  record_id: string;
  element_key: string;
  grade: string | null;
  attempt: number;
  event_date: string;
}

export interface EvidenceSector {
  sector_id: string;
  event_date: string;
  role: 'PF' | 'PM';
  to_by_subject: boolean;
  lnd_by_subject: boolean;
}

export interface EvidenceDocument {
  document_id: string;
  doc_type: string;
  review_state: string;
  issued_on: string | null;
  valid_from: string | null;
  valid_until: string | null;
}

export interface EvidenceQualification {
  qual_type_code: string;
  valid_from: string | null;
  valid_until: string | null;
  grace_until: string | null;
  status_override: 'suspended' | 'inactive' | null;
}

export interface EvidenceAttestation {
  attestation_key: string;
  attested_at: string;
  valid_until: string | null;
  is_stale: boolean;
  revoked: boolean;
}

export interface EvidenceExternal {
  kind: string;
  system: string;
  occurred_at: string;
  code: string | null;
  value: number | null;
  passed: boolean | null;
}

/** Which feeds are actually connected. A stubbed condition consults this before anything else. */
export interface FeedAvailability {
  lms: boolean;
  scheduling: boolean;
  external: boolean;
}

export interface QmsEvidence {
  subject_id: string;
  records: EvidenceRecord[];
  competencyGrades: EvidenceCompetencyGrade[];
  obSelections: EvidenceObSelection[];
  elementGrades: EvidenceElementGrade[];
  sectors: EvidenceSector[];
  documents: EvidenceDocument[];
  qualifications: EvidenceQualification[];
  attestations: EvidenceAttestation[];
  external: EvidenceExternal[];
  feeds: FeedAvailability;
  /** The holding being renewed, if any. Drives the early-renewal anchor. */
  priorHolding?: { valid_from: string | null; valid_until: string | null } | null;
  /** id to display name. Presentation only; nothing keys on a name. */
  labels?: Record<string, string>;
}

export const emptyEvidence = (subject_id: string): QmsEvidence => ({
  subject_id,
  records: [], competencyGrades: [], obSelections: [], elementGrades: [], sectors: [],
  documents: [], qualifications: [], attestations: [], external: [],
  feeds: { lms: false, scheduling: false, external: false },
  priorHolding: null,
});

/* ---------------------------------------------------------------- results */

export type UnmetReason =
  | 'met'
  | 'no_matching_evidence'
  | 'threshold_not_reached'
  | 'outside_window'
  | 'not_valid_as_of'
  | 'feed_unavailable'
  | 'invalid_params'
  | 'unknown_condition_type';

export interface ConditionResult {
  met: boolean;
  /** False means "cannot be determined", which is NEVER the same as met. */
  evaluable: boolean;
  reason: UnmetReason;
  met_at: string | null;
  evidence_refs: string[];
  detail?: Record<string, unknown>;
}

export const unmet = (reason: UnmetReason, evaluable = true): ConditionResult =>
  ({ met: false, evaluable, reason, met_at: null, evidence_refs: [] });

const hit = (
  met_at: string | null,
  refs: string[],
  detail?: Record<string, unknown>,
): ConditionResult => ({ met: true, evaluable: true, reason: 'met', met_at, evidence_refs: refs, detail });

/* ----------------------------------------------------------------- editor */

export type ParamKind =
  | 'text' | 'integer' | 'number' | 'boolean' | 'date'
  | 'select' | 'code_list' | 'window_days'
  | 'competency' | 'observable_behaviour'
  | 'template' | 'doc_type' | 'qual_type' | 'attestation_key' | 'external_kind';

export interface ParamDescriptor {
  key: string;
  label: string;
  kind: ParamKind;
  required: boolean;
  help?: string;
  options?: string[];
  min?: number;
  max?: number;
  defaultValue?: unknown;
}

export type Params = Record<string, unknown>;

export interface PhraseContext {
  /** id to display name. Never used for matching. */
  labels?: Record<string, string>;
}

export interface ConditionTypeSpec {
  id: string;
  label: string;
  group: 'training' | 'competency' | 'experience' | 'evidence' | 'external';
  /** buildable: evaluable today. stubbed: authorable and renderable, not yet evaluable. */
  status: 'buildable' | 'stubbed';
  summary: string;
  params: ParamDescriptor[];
  /** One clause of English: no leading capital, no full stop. */
  phrase: (p: Params, ctx: PhraseContext) => string;
  evaluate: (p: Params, e: QmsEvidence, asOf: string) => ConditionResult;
}

const label = (ctx: PhraseContext, id: unknown): string =>
  (ctx.labels && typeof id === 'string' && ctx.labels[id]) || String(id ?? '');

const str = (p: Params, k: string): string | null =>
  typeof p[k] === 'string' && (p[k] as string).length > 0 ? (p[k] as string) : null;
const num = (p: Params, k: string): number | null =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : null;
const list = (p: Params, k: string): string[] =>
  Array.isArray(p[k]) ? (p[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [];

const windowFloor = (asOf: string, days: number | null): number | null => {
  const a = toDay(asOf);
  return days === null || a === null ? null : a - days;
};

/** Inside the lookback window and not in the future relative to asOf. */
const inWindow = (eventDate: string, floor: number | null, asOfDay: number | null): boolean => {
  const d = toDay(eventDate);
  if (d === null) return false;
  if (asOfDay !== null && d > asOfDay) return false;
  return floor === null || d >= floor;
};

/* --------------------------------------------------------------- registry */

export const CONDITION_TYPES: Record<string, ConditionTypeSpec> = {
  session_completed: {
    id: 'session_completed',
    label: 'Session completed',
    group: 'training',
    status: 'buildable',
    summary: 'A record exists for a named template or session kind with an accepted result.',
    params: [
      { key: 'template_code', label: 'Template', kind: 'template', required: false },
      { key: 'session_kind', label: 'Session kind', kind: 'text', required: false },
      { key: 'results', label: 'Accepted results', kind: 'code_list', required: true, defaultValue: ['pass'] },
      { key: 'within_days', label: 'Completed within (days)', kind: 'window_days', required: false, min: 1 },
    ],
    phrase: (p, ctx) => {
      const what = str(p, 'template_code') ? label(ctx, p.template_code) : (str(p, 'session_kind') ?? 'any session');
      const res = list(p, 'results');
      const w = num(p, 'within_days');
      return `completed ${what}${res.length ? ` with a result of ${res.join(' or ')}` : ''}` +
        (w ? ` in the last ${w} days` : '');
    },
    evaluate: (p, e, asOf) => {
      const results = list(p, 'results').map((r) => r.toLowerCase());
      const tpl = str(p, 'template_code');
      const kind = str(p, 'session_kind');
      if (results.length === 0 || (!tpl && !kind)) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, num(p, 'within_days'));
      const hits = e.records.filter((r) =>
        (tpl ? r.template_code === tpl : true) &&
        (kind ? r.session_kind === kind : true) &&
        results.includes((r.result ?? '').toLowerCase()) &&
        inWindow(r.event_date, floor, asOfDay));
      if (hits.length === 0) return unmet('no_matching_evidence');
      return hit(minDate(hits.map((h) => h.event_date)), hits.map((h) => `record:${h.record_id}`));
    },
  },

  record_count: {
    id: 'record_count',
    label: 'Number of records',
    group: 'training',
    status: 'buildable',
    summary: 'At least N accepted records of a kind, optionally inside a window.',
    params: [
      { key: 'session_kind', label: 'Session kind', kind: 'text', required: true },
      { key: 'results', label: 'Accepted results', kind: 'code_list', required: false },
      { key: 'count', label: 'Minimum count', kind: 'integer', required: true, min: 1 },
      { key: 'within_days', label: 'Within (days)', kind: 'window_days', required: false, min: 1 },
    ],
    phrase: (p) => {
      const n = num(p, 'count') ?? 0;
      const w = num(p, 'within_days');
      return `at least ${n} ${str(p, 'session_kind') ?? 'record'}${n === 1 ? '' : 's'}` +
        (w ? ` in the last ${w} days` : '');
    },
    evaluate: (p, e, asOf) => {
      const n = num(p, 'count');
      const kind = str(p, 'session_kind');
      if (n === null || n < 1 || !kind) return unmet('invalid_params');
      const results = list(p, 'results').map((r) => r.toLowerCase());
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, num(p, 'within_days'));
      const hits = e.records
        .filter((r) => r.session_kind === kind &&
          (results.length === 0 || results.includes((r.result ?? '').toLowerCase())) &&
          inWindow(r.event_date, floor, asOfDay))
        .sort((a, b) => (toDay(a.event_date) ?? 0) - (toDay(b.event_date) ?? 0));
      const nth = hits[n - 1];
      if (hits.length < n || !nth) return { ...unmet('threshold_not_reached'), detail: { have: hits.length, need: n } };
      return hit(nth.event_date, hits.slice(0, n).map((h) => `record:${h.record_id}`),
        { have: hits.length, need: n });
    },
  },

  competency_minimum: {
    id: 'competency_minimum',
    label: 'Competency minimum',
    group: 'competency',
    status: 'buildable',
    summary: 'A competency graded at or above a minimum on the most recent qualifying record.',
    params: [
      { key: 'competency_id', label: 'Competency', kind: 'competency', required: true },
      { key: 'minimum', label: 'Minimum grade', kind: 'number', required: true, min: 1, max: 5 },
      { key: 'within_days', label: 'Within (days)', kind: 'window_days', required: false, min: 1 },
    ],
    phrase: (p, ctx) =>
      `${label(ctx, p.competency_id)} graded at least ${num(p, 'minimum') ?? '?'}` +
      (num(p, 'within_days') ? ` in the last ${num(p, 'within_days')} days` : ''),
    evaluate: (p, e, asOf) => {
      const id = str(p, 'competency_id');
      const min = num(p, 'minimum');
      if (!id || min === null) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, num(p, 'within_days'));
      const scoped = e.competencyGrades
        .filter((g) => g.competency_id === id && g.grade_num !== null &&
          inWindow(g.event_date, floor, asOfDay))
        .sort((a, b) => (toDay(b.event_date) ?? 0) - (toDay(a.event_date) ?? 0));
      const latest = scoped[0];
      if (!latest) return unmet('no_matching_evidence');
      if ((latest.grade_num ?? 0) < min) {
        return { ...unmet('threshold_not_reached'), detail: { grade: latest.grade_num, minimum: min } };
      }
      return hit(latest.event_date, [`record:${latest.record_id}`], { grade: latest.grade_num });
    },
  },

  observable_behaviour_seen: {
    id: 'observable_behaviour_seen',
    label: 'Observable behaviour recorded',
    group: 'competency',
    status: 'buildable',
    summary: 'A named observable behaviour selected on at least N records.',
    params: [
      { key: 'observable_behaviour_id', label: 'Observable behaviour', kind: 'observable_behaviour', required: true },
      { key: 'count', label: 'Minimum occurrences', kind: 'integer', required: false, min: 1, defaultValue: 1 },
      { key: 'within_days', label: 'Within (days)', kind: 'window_days', required: false, min: 1 },
    ],
    phrase: (p, ctx) => {
      const n = num(p, 'count') ?? 1;
      return `${label(ctx, p.observable_behaviour_id)} recorded${n > 1 ? ` on at least ${n} records` : ''}`;
    },
    evaluate: (p, e, asOf) => {
      const id = str(p, 'observable_behaviour_id');
      if (!id) return unmet('invalid_params');
      const n = num(p, 'count') ?? 1;
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, num(p, 'within_days'));
      const hits = e.obSelections
        .filter((o) => o.observable_behaviour_id === id && inWindow(o.event_date, floor, asOfDay))
        .sort((a, b) => (toDay(a.event_date) ?? 0) - (toDay(b.event_date) ?? 0));
      const nth = hits[n - 1];
      if (hits.length < n || !nth) return { ...unmet('threshold_not_reached'), detail: { have: hits.length, need: n } };
      return hit(nth.event_date, hits.slice(0, n).map((h) => `record:${h.record_id}`));
    },
  },

  element_signed: {
    id: 'element_signed',
    label: 'Template element completed',
    group: 'training',
    status: 'buildable',
    summary: 'Named template elements graded with an accepted grade. Element keys, never row ids.',
    params: [
      { key: 'element_keys', label: 'Element keys', kind: 'code_list', required: true },
      { key: 'grades', label: 'Accepted grades', kind: 'code_list', required: false },
      { key: 'all_required', label: 'All of them', kind: 'boolean', required: false, defaultValue: true },
    ],
    phrase: (p) => {
      const keys = list(p, 'element_keys');
      return `${p.all_required !== false ? 'all' : 'any'} of the syllabus items ${keys.join(', ')} completed`;
    },
    evaluate: (p, e, asOf) => {
      const keys = list(p, 'element_keys');
      if (keys.length === 0) return unmet('invalid_params');
      const grades = list(p, 'grades').map((g) => g.toLowerCase());
      const asOfDay = toDay(asOf);
      const found = new Map<string, { date: string; record: string }>();
      for (const g of e.elementGrades) {
        if (!keys.includes(g.element_key)) continue;
        if (grades.length > 0 && !grades.includes((g.grade ?? '').toLowerCase())) continue;
        if (!inWindow(g.event_date, null, asOfDay)) continue;
        const prev = found.get(g.element_key);
        if (!prev || (toDay(g.event_date) ?? 0) < (toDay(prev.date) ?? 0)) {
          found.set(g.element_key, { date: g.event_date, record: g.record_id });
        }
      }
      const all = p.all_required !== false;
      const ok = all ? found.size === keys.length : found.size > 0;
      if (!ok) {
        return {
          ...unmet(found.size === 0 ? 'no_matching_evidence' : 'threshold_not_reached'),
          detail: { have: [...found.keys()], missing: keys.filter((k) => !found.has(k)) },
        };
      }
      const dates = [...found.values()].map((v) => v.date);
      return hit(all ? maxDate(dates) : minDate(dates),
        [...found.values()].map((v) => `record:${v.record}`));
    },
  },

  sector_count: {
    id: 'sector_count',
    label: 'Line sectors',
    group: 'experience',
    status: 'buildable',
    summary: 'Sectors counted from the sector table, filtered by operating role and by task performed.',
    params: [
      { key: 'count', label: 'Minimum sectors', kind: 'integer', required: true, min: 1 },
      { key: 'role', label: 'Operating role', kind: 'select', required: false, options: ['PF', 'PM', 'any'], defaultValue: 'any' },
      { key: 'requires_takeoff', label: 'Take-off performed', kind: 'boolean', required: false, defaultValue: false },
      { key: 'requires_landing', label: 'Landing performed', kind: 'boolean', required: false, defaultValue: false },
      { key: 'within_days', label: 'Within (days)', kind: 'window_days', required: false, min: 1 },
    ],
    phrase: (p) => {
      const n = num(p, 'count') ?? 0;
      const role = str(p, 'role');
      const bits: string[] = [];
      if (role && role !== 'any') bits.push(`as ${role}`);
      if (p.requires_takeoff === true) bits.push('with a take-off performed');
      if (p.requires_landing === true) bits.push('with a landing performed');
      const w = num(p, 'within_days');
      return `at least ${n} line sector${n === 1 ? '' : 's'}${bits.length ? ` ${bits.join(' and ')}` : ''}` +
        (w ? ` in the last ${w} days` : '');
    },
    evaluate: (p, e, asOf) => {
      const n = num(p, 'count');
      if (n === null || n < 1) return unmet('invalid_params');
      const role = str(p, 'role');
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, num(p, 'within_days'));
      const hits = e.sectors
        .filter((s) => (!role || role === 'any' || s.role === role) &&
          (p.requires_takeoff !== true || s.to_by_subject) &&
          (p.requires_landing !== true || s.lnd_by_subject) &&
          inWindow(s.event_date, floor, asOfDay))
        .sort((a, b) => (toDay(a.event_date) ?? 0) - (toDay(b.event_date) ?? 0));
      const nth = hits[n - 1];
      if (hits.length < n || !nth) return { ...unmet('threshold_not_reached'), detail: { have: hits.length, need: n } };
      return hit(nth.event_date, hits.slice(0, n).map((h) => `sector:${h.sector_id}`),
        { have: hits.length, need: n });
    },
  },
};

/**
 * The remaining types are merged into the same registry object rather than declared in a second
 * one: the editor, the engine and the renderer must all read exactly one map, or a type can exist
 * in one surface and not another. Grouped here only for readability.
 */
Object.assign(CONDITION_TYPES, {
  document_valid: {
    id: 'document_valid',
    label: 'Valid document held',
    group: 'evidence',
    status: 'buildable',
    summary: 'An approved document of a type, valid as of the evaluation date.',
    params: [
      { key: 'doc_type', label: 'Document type', kind: 'doc_type', required: true },
      { key: 'min_remaining_days', label: 'Minimum days remaining', kind: 'integer', required: false, min: 0 },
    ],
    phrase: (p: Params, ctx: PhraseContext) => {
      const rem = num(p, 'min_remaining_days');
      return `holds a valid ${label(ctx, p.doc_type)}` + (rem ? ` with at least ${rem} days remaining` : '');
    },
    evaluate: (p: Params, e: QmsEvidence, asOf: string) => {
      const type = str(p, 'doc_type');
      if (!type) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      if (asOfDay === null) return unmet('invalid_params');
      const need = num(p, 'min_remaining_days') ?? 0;
      const hits = e.documents.filter((d) => {
        if (d.doc_type !== type || d.review_state !== 'approved') return false;
        const from = toDay(d.valid_from);
        const until = toDay(d.valid_until);
        if (from !== null && from > asOfDay) return false;
        if (until !== null && until < asOfDay + need) return false;
        return true;
      });
      if (hits.length === 0) return unmet('not_valid_as_of');
      return hit(minDate(hits.map((h) => h.valid_from ?? h.issued_on ?? asOf)),
        hits.map((h) => `document:${h.document_id}`));
    },
  },

  qualification_held: {
    id: 'qualification_held',
    label: 'Other qualification held',
    group: 'evidence',
    status: 'buildable',
    summary: 'Another qualification type currently valid. This is how a dependency is expressed.',
    params: [
      { key: 'qual_type_code', label: 'Qualification', kind: 'qual_type', required: true },
      { key: 'allow_grace', label: 'Accept inside grace', kind: 'boolean', required: false, defaultValue: false },
    ],
    phrase: (p: Params, ctx: PhraseContext) => `holds a current ${label(ctx, p.qual_type_code)}`,
    evaluate: (p: Params, e: QmsEvidence, asOf: string) => {
      const code = str(p, 'qual_type_code');
      if (!code) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      if (asOfDay === null) return unmet('invalid_params');
      const found = e.qualifications.find((q) => {
        if (q.qual_type_code !== code || q.status_override !== null) return false;
        const from = toDay(q.valid_from);
        const until = toDay(p.allow_grace === true ? (q.grace_until ?? q.valid_until) : q.valid_until);
        if (from !== null && from > asOfDay) return false;
        return until === null || until >= asOfDay;
      });
      return found ? hit(found.valid_from, [`qualification:${code}`]) : unmet('not_valid_as_of');
    },
  },

  attestation_present: {
    id: 'attestation_present',
    label: 'Attestation in place',
    group: 'evidence',
    status: 'buildable',
    summary: 'A live, non-stale attestation under a named key. The consent severity in condition form.',
    params: [{ key: 'attestation_key', label: 'Attestation key', kind: 'attestation_key', required: true }],
    phrase: (p: Params, ctx: PhraseContext) => `a current ${label(ctx, p.attestation_key)} attestation is on file`,
    evaluate: (p: Params, e: QmsEvidence, asOf: string) => {
      const key = str(p, 'attestation_key');
      if (!key) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      const found = e.attestations.find((a) => {
        if (a.attestation_key !== key || a.is_stale || a.revoked) return false;
        const until = toDay(a.valid_until);
        return until === null || asOfDay === null || until >= asOfDay;
      });
      return found ? hit(found.attested_at.slice(0, 10), [`attestation:${key}`]) : unmet('no_matching_evidence');
    },
  },

  manual_evidence: {
    id: 'manual_evidence',
    label: 'Manual evidence attached',
    group: 'evidence',
    status: 'buildable',
    summary: 'A human attaches a document of a named type. Never self-satisfying: someone must act.',
    params: [
      { key: 'doc_type', label: 'Expected document type', kind: 'doc_type', required: true },
      { key: 'instruction', label: 'Instruction to the approver', kind: 'text', required: false },
    ],
    phrase: (p: Params, ctx: PhraseContext) => `an approver attaches ${label(ctx, p.doc_type)} as evidence`,
    evaluate: (p: Params, e: QmsEvidence, asOf: string) => {
      const type = str(p, 'doc_type');
      if (!type) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      const hits = e.documents.filter((d) => d.doc_type === type && d.review_state === 'approved' &&
        inWindow(d.issued_on ?? d.valid_from ?? asOf, null, asOfDay));
      if (hits.length === 0) return unmet('no_matching_evidence');
      return hit(maxDate(hits.map((h) => h.issued_on ?? h.valid_from ?? asOf)),
        hits.map((h) => `document:${h.document_id}`));
    },
  },

  /* ------ stubbed: fully authorable and renderable, deliberately not yet evaluable ------ */

  lms_course_completed: {
    id: 'lms_course_completed',
    label: 'Online course completed',
    group: 'external',
    status: 'stubbed',
    summary: 'A completion from the LMS feed. Returns not-evaluable until that feed is connected.',
    params: [
      { key: 'course_code', label: 'Course code', kind: 'text', required: true },
      { key: 'require_pass', label: 'Must be a pass', kind: 'boolean', required: false, defaultValue: true },
      { key: 'within_days', label: 'Within (days)', kind: 'window_days', required: false, min: 1 },
    ],
    phrase: (p: Params, ctx: PhraseContext) => `completed the online course ${label(ctx, p.course_code)}`,
    evaluate: (p: Params, e: QmsEvidence, asOf: string) => {
      if (!e.feeds.lms) return unmet('feed_unavailable', false);
      const code = str(p, 'course_code');
      if (!code) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, num(p, 'within_days'));
      const hits = e.external.filter((x) => x.kind === 'lms_completion' && x.code === code &&
        (p.require_pass !== true || x.passed === true) &&
        inWindow(x.occurred_at.slice(0, 10), floor, asOfDay));
      if (hits.length === 0) return unmet('no_matching_evidence');
      return hit(minDate(hits.map((h) => h.occurred_at.slice(0, 10))), [`external:${code}`]);
    },
  },

  flight_experience: {
    id: 'flight_experience',
    label: 'Accumulated experience',
    group: 'external',
    status: 'stubbed',
    summary: 'Hours, sectors or landings from the crew-scheduling feed. Not evaluable without it.',
    params: [
      { key: 'metric', label: 'Metric', kind: 'select', required: true, options: ['hours', 'sectors', 'landings'] },
      { key: 'minimum', label: 'Minimum', kind: 'number', required: true, min: 0 },
      { key: 'within_days', label: 'Within (days)', kind: 'window_days', required: false, min: 1 },
    ],
    phrase: (p: Params) => `at least ${num(p, 'minimum') ?? '?'} ${str(p, 'metric') ?? 'hours'}` +
      (num(p, 'within_days') ? ` in the last ${num(p, 'within_days')} days` : ''),
    evaluate: (p: Params, e: QmsEvidence, asOf: string) => {
      if (!e.feeds.scheduling) return unmet('feed_unavailable', false);
      const metric = str(p, 'metric');
      const min = num(p, 'minimum');
      if (!metric || min === null) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, num(p, 'within_days'));
      const hits = e.external
        .filter((x) => x.kind === 'flight_experience' && x.code === metric &&
          inWindow(x.occurred_at.slice(0, 10), floor, asOfDay))
        .sort((a, b) => (toDay(a.occurred_at) ?? 0) - (toDay(b.occurred_at) ?? 0));
      let total = 0;
      let at: string | null = null;
      for (const h of hits) {
        total += h.value ?? 0;
        if (total >= min && at === null) at = h.occurred_at.slice(0, 10);
      }
      if (total < min) return { ...unmet('threshold_not_reached'), detail: { have: total, need: min } };
      return hit(at, [`external:${metric}`], { have: total, need: min });
    },
  },

  recency_window: {
    id: 'recency_window',
    label: 'Recency',
    group: 'external',
    status: 'stubbed',
    summary: 'A qualifying duty inside a rolling window, from the crew-scheduling feed.',
    params: [
      { key: 'duty_code', label: 'Qualifying duty', kind: 'text', required: true },
      { key: 'within_days', label: 'Within (days)', kind: 'window_days', required: true, min: 1 },
    ],
    phrase: (p: Params, ctx: PhraseContext) =>
      `${label(ctx, p.duty_code)} performed in the last ${num(p, 'within_days') ?? '?'} days`,
    evaluate: (p: Params, e: QmsEvidence, asOf: string) => {
      if (!e.feeds.scheduling) return unmet('feed_unavailable', false);
      const code = str(p, 'duty_code');
      const days = num(p, 'within_days');
      if (!code || days === null) return unmet('invalid_params');
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, days);
      const hits = e.external.filter((x) => x.kind === 'duty' && x.code === code &&
        inWindow(x.occurred_at.slice(0, 10), floor, asOfDay));
      if (hits.length === 0) return unmet('outside_window');
      return hit(maxDate(hits.map((h) => h.occurred_at.slice(0, 10))), [`external:${code}`]);
    },
  },

  external_event: {
    id: 'external_event',
    label: 'External event received',
    group: 'external',
    status: 'stubbed',
    summary: 'Any integration event by kind and code. The generic escape hatch for a new feed.',
    params: [
      { key: 'event_kind', label: 'Event kind', kind: 'external_kind', required: true },
      { key: 'code', label: 'Code', kind: 'text', required: false },
      { key: 'within_days', label: 'Within (days)', kind: 'window_days', required: false, min: 1 },
    ],
    phrase: (p: Params, ctx: PhraseContext) => `an external ${label(ctx, p.event_kind)} event has been received`,
    evaluate: (p: Params, e: QmsEvidence, asOf: string) => {
      if (!e.feeds.external) return unmet('feed_unavailable', false);
      const kind = str(p, 'event_kind');
      if (!kind) return unmet('invalid_params');
      const code = str(p, 'code');
      const asOfDay = toDay(asOf);
      const floor = windowFloor(asOf, num(p, 'within_days'));
      const hits = e.external.filter((x) => x.kind === kind && (!code || x.code === code) &&
        inWindow(x.occurred_at.slice(0, 10), floor, asOfDay));
      if (hits.length === 0) return unmet('no_matching_evidence');
      return hit(minDate(hits.map((h) => h.occurred_at.slice(0, 10))), [`external:${kind}`]);
    },
  },
} as Record<string, ConditionTypeSpec>);

/* ---------------------------------------------------------------- lookups */

export const conditionTypeIds = (): string[] => Object.keys(CONDITION_TYPES);

export const isStubbed = (typeId: string): boolean =>
  CONDITION_TYPES[typeId]?.status === 'stubbed';

/** The builder lists types from here. It must never carry its own copy of the list. */
export const editorCatalogue = (): ConditionTypeSpec[] =>
  Object.values(CONDITION_TYPES).sort((a, b) =>
    a.group === b.group ? a.label.localeCompare(b.label) : a.group.localeCompare(b.group));
