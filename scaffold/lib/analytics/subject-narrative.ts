import 'server-only';
import { query, queryOne } from '@/lib/db';
import { callModel, isOk, isDegraded, type InferenceResult } from '@/lib/inference';
import { gate, provenanceOptionsFromEnv, type ProvenanceReport } from '@/lib/provenance';
import { subjectFigures, type SubjectFigures } from './subject-figures';

/**
 * lib/analytics/subject-narrative.ts — the narrative half, and the gate between the two.
 *
 * The invariant this file exists to hold, in one sentence: THE MODEL NEVER PRODUCES A NUMBER.
 * `subject-figures.ts` computes every figure in SQL; the model receives them and writes sentences
 * about them; `lib/provenance.ts` then checks every number in those sentences back against the
 * computed set. A narrative carrying a figure the core never produced is REJECTED, stored for
 * inspection, and never rendered as a report.
 *
 * That is worth stating plainly to an airline, because the usual objection to a language model in
 * a training record is the right one: it will eventually assert something confident and false, and
 * a false figure in a pilot's file is not a typo. The answer here is not "we prompted it carefully".
 * The answer is that a report which names an unsourced number cannot reach the screen.
 *
 * FINDINGS, NOT PROSE (docs/08_AI_NARRATIVE.md §2). The model returns a small structured object —
 * a headline, a handful of findings, things to watch — and the surface renders it. It is never
 * asked for a paragraph of continuous prose, because prose invites transitions, and transitions
 * invite invented connective facts: "following a difficult month", "as in the previous check".
 * Short findings tied to figures have nowhere to put an embellishment.
 */

export interface NarrativeFinding {
  readonly title: string;
  readonly detail: string;
}

export interface SubjectNarrative {
  readonly headline: string;
  readonly findings: readonly NarrativeFinding[];
  readonly watch: readonly string[];
}

export type RunStatus = 'complete' | 'rejected' | 'failed';

export interface AnalysisRunResult {
  readonly id: string;
  readonly status: RunStatus;
  readonly degraded: boolean;
  readonly narrative: SubjectNarrative | null;
  readonly provenance: ProvenanceReport | null;
  readonly error: string | null;
}

/* ------------------------------------------------------------------ prompt */

const SYSTEM = `You write short factual findings about one pilot's training record for a training manager at an airline.

ABSOLUTE RULES
1. Every number you write must appear verbatim in the FIGURES you are given. Do not compute, derive, sum, average, round differently, or convert anything. If a number you want is not in FIGURES, write the sentence without it or leave that finding out.
2. Do not count, total, add, subtract, or work anything out. If you want to say how many competencies are trending down, how many records carry a below-standard grade, or how many of anything there are, that count is already in FIGURES under "counts". If a count you want is not there, do not write the sentence. A number that is correct arithmetic on two figures is still a number you produced, and this system does not publish numbers it did not compute.
3. Do not describe causes. You can see what was graded, not why. Never write that a pilot was tired, rushed, under pressure, unfamiliar, or improving because of anything.
4. Do not recommend a training decision, a pass, a fail, or a check. You describe; the training manager decides.
5. Name records by their exact title, copied from RECORDS TO NAME. The user prompt says how many you must name; a finding that mentions no record is still allowed, but the report as a whole must reach that count.
6. If the evidence is thin, say so plainly and write fewer findings. A short honest answer is correct; padding is not.

STYLE
British English. Plain sentences. No adjectives of praise or blame. No "demonstrates", "showcases", "leverages". Write about what the record shows, not about the pilot as a person.

Return JSON only, matching this shape:
{"headline": string, "findings": [{"title": string, "detail": string}], "watch": [string]}
headline: one sentence, at most 25 words.
findings: 3 to 5 items. title at most 8 words; detail 1 to 3 sentences.
watch: 0 to 3 short phrases naming what a manager should look at next. No numbers required.`;

/**
 * THE CITATION COUNT IS DERIVED FROM THE GATE'S OWN THRESHOLD, not written here as a number.
 *
 * The first real run of this pipeline scored 100% provenance - every one of nineteen figures traced
 * to the computed set, not one invention - and was rejected anyway, because it named three of six
 * records where the coverage rule requires 60%, which is four. The narrative was correct. The
 * prompt had simply never said how many records to name, and "name the records you draw on" gets
 * three when four is the pass mark.
 *
 * That is the failure mode lib/provenance.ts warns about in its own header: a gate that rejects
 * correct work teaches operators to lower the threshold, and a lowered threshold stops catching the
 * incorrect work too. So the requirement is made explicit to the writer INSTEAD of being relaxed
 * for the checker - and it is computed from the same configured threshold the checker will use, so
 * the two cannot drift apart when somebody retunes PROVENANCE_MIN_COVERAGE.
 */
function userPrompt(figures: SubjectFigures, sources: readonly string[]): string {
  const minCoverage = provenanceOptionsFromEnv().minCoverage ?? 0.6;
  const required = Math.max(1, Math.ceil(minCoverage * sources.length));
  return [
    'FIGURES (the only numbers you may use):',
    JSON.stringify(figures, null, 2),
    '',
    'RECORDS TO NAME (copy these titles exactly):',
    ...sources.map((t) => `- ${t}`),
    '',
    `You must name at least ${required} of those ${sources.length} records across your findings.`,
    '',
    `Write the findings for ${figures.subject.full_name} (${figures.subject.staff_number}) over the last ${figures.window.months} months.`,
  ].join('\n');
}

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'findings', 'watch'],
  properties: {
    headline: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail'],
        properties: { title: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    watch: { type: 'array', items: { type: 'string' } },
  },
};

/** The validator is authoritative: a response that does not satisfy this never reaches storage. */
function validate(value: unknown): { valid: true; value: SubjectNarrative } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  const v = value as Partial<SubjectNarrative> | null;
  if (!v || typeof v !== 'object') return { valid: false, errors: ['response was not an object'] };
  if (typeof v.headline !== 'string' || v.headline.trim() === '') errors.push('headline must be a non-empty string');
  if (!Array.isArray(v.findings) || v.findings.length === 0) errors.push('findings must be a non-empty array');
  else {
    v.findings.forEach((f, idx) => {
      if (!f || typeof f !== 'object') { errors.push(`findings[${idx}] must be an object`); return; }
      if (typeof f.title !== 'string' || f.title.trim() === '') errors.push(`findings[${idx}].title must be a non-empty string`);
      if (typeof f.detail !== 'string' || f.detail.trim() === '') errors.push(`findings[${idx}].detail must be a non-empty string`);
    });
  }
  if (!Array.isArray(v.watch) || v.watch.some((w) => typeof w !== 'string')) errors.push('watch must be an array of strings');
  if (errors.length) return { valid: false, errors };
  return { valid: true, value: v as SubjectNarrative };
}

/** Everything the gate reads, as one string. Titles count: a title can carry a figure too. */
function narrativeText(nar: SubjectNarrative): string {
  return [nar.headline, ...nar.findings.flatMap((f) => [f.title, f.detail]), ...nar.watch].join('\n');
}

/**
 * The sources the narrative is expected to name, and against which coverage is measured.
 *
 * DISTINCT RECORD TITLES, not one per record: a pilot's twelve months are four or five programs
 * flown repeatedly, and requiring a citation per record would demand the same title five times.
 */
function sourceLabels(figures: SubjectFigures): string[] {
  return [...new Set(figures.recent_records.map((r) => r.title))].slice(0, 6);
}

/* ------------------------------------------------------------------- runner */

export interface RunInput {
  readonly personId: string;
  readonly requestedBy: string;
  readonly months?: number;
}

/**
 * Compute the figures, ask for a narrative, check it, store the run.
 *
 * Returns a row in every case, including the degraded one. A request that produced nothing is
 * still a thing that happened to a pilot's file and belongs in the history; silently returning
 * nothing would leave the manager wondering whether they clicked the button.
 */
export async function runSubjectAnalysis(input: RunInput): Promise<AnalysisRunResult | null> {
  const months = input.months ?? 12;
  const figures = await subjectFigures(input.personId, months);
  if (!figures) return null;

  const sources = sourceLabels(figures);
  const configVersion = await queryOne<{ id: string }>(
    `SELECT id FROM config_versions WHERE name = 'analytics' AND is_active LIMIT 1`,
  );

  // The framework is NOT optional on a run, even though the column has been nullable since 0031.
  // A run is a statement about a pilot measured against a competency vocabulary; without the
  // framework it cannot be read back years later, and `every graded or evidence-bearing row
  // carries a framework` is exactly the gate assertion that caught this path writing NULL on the
  // server on 2026-09-20. Resolved the same way every other reader resolves it.
  const framework = await queryOne<{ id: string }>(
    `SELECT id FROM competency_frameworks WHERE is_active ORDER BY created_at LIMIT 1`,
  );
  if (!framework?.id) {
    throw new Error(
      'no active competency framework: an analysis run cannot be attributed to a vocabulary that ' +
        'does not exist. Seed the framework before requesting an analysis.',
    );
  }

  const started = await queryOne<{ id: string }>(
    `INSERT INTO analysis_runs (person_id, framework_id, run_kind, status, requested_by, config_version_id, figures, sources)
     VALUES ($1::uuid, $2::uuid, 'subject', 'running', $3::uuid, $4::uuid, $5::jsonb, $6::jsonb)
     RETURNING id`,
    [input.personId, framework.id, input.requestedBy, configVersion?.id ?? null,
     JSON.stringify(figures), JSON.stringify(sources)],
  );
  const id = started?.id;
  if (!id) throw new Error('the analysis run could not be created');

  const finish = async (
    status: RunStatus,
    narrative: SubjectNarrative | null,
    report: ProvenanceReport | null,
    model: string | null,
    error: string | null,
  ): Promise<AnalysisRunResult> => {
    await query(
      `UPDATE analysis_runs
          SET status = $2, completed_at = now(), narrative_html = $3, narrative_model = $4,
              provenance = $5::jsonb, error = $6
        WHERE id = $1::uuid`,
      [id, status, narrative ? JSON.stringify(narrative) : null, model, report ? JSON.stringify(report) : null, error],
    );
    return { id, status, degraded: model === null && status === 'complete', narrative, provenance: report, error };
  };

  let result: InferenceResult<SubjectNarrative>;
  try {
    result = await callModel<SubjectNarrative>({
      tier: 'deep',
      system: SYSTEM,
      user: userPrompt(figures, sources),
      validate,
      schema: SCHEMA,
    });
  } catch (err) {
    return finish('failed', null, null, null, err instanceof Error ? err.message : String(err));
  }

  // Degraded is a SUPPORTED STATE, not an error: every figure on the page still renders and the
  // run records that narration was unavailable. The platform does not stop when the model does.
  if (isDegraded(result)) {
    return finish('complete', null, null, null, `narration unavailable: ${result.detail}`);
  }
  if (!isOk(result)) {
    return finish('failed', null, null, null, `${result.reason}: ${result.detail}`);
  }

  const narrative = result.data;
  const report = gate(narrativeText(narrative), figures, sources);

  if (!report.pass) {
    const worst = report.unsourced[0];
    const why = worst
      ? `the narrative used ${worst.text}, which the deterministic core did not produce (“${worst.context.trim()}”)`
      : `only ${report.sourcesCited} of ${report.sourcesAvailable} records were named`;
    return finish('rejected', narrative, report, result.meta.model, `Refused by the provenance gate: ${why}.`);
  }

  return finish('complete', narrative, report, result.meta.model, null);
}
