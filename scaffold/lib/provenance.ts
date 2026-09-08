/**
 * The provenance gate.
 *
 * Invariant (docs/11_AI_PIPELINE.md section 1): the deterministic core computes every figure,
 * the model only narrates, and narration is checked against the computed figure set before it
 * is stored.
 *
 * This module is the check. It extracts every number from generated narrative and matches it
 * against the set of numbers the deterministic core computed for that run.
 *
 * THE FAILURE THIS MODULE EXISTS TO AVOID, twice over:
 *
 *  1. Too strict, by accident. A gate that walks only the TOP-LEVEL keys of the figure
 *     structure sees the run totals and misses every per-competency average, because those
 *     live in arrays of objects one or two levels down. The model correctly writes "an average
 *     of 2.4", the gate does not find 2.4 in its flat list, and a correct, fully-sourced report
 *     is rejected. Operators then lower the threshold, which disables the gate for the
 *     incorrect cases too. So: flattenFigures walks arrays and objects RECURSIVELY, to any
 *     depth, and also registers formatting variants of every value.
 *
 *  2. Too loose. A gate matching any substring of any number passes a hallucinated "17
 *     sessions" because 17 appears inside a date. So: numbers are extracted with word
 *     boundaries, and date-like spans are removed before extraction.
 */

export type FigureSet = {
  /** Every numeric value found anywhere in the computed structure, deduplicated. */
  values: number[];
  /** Rendered string forms of those values, for exact-text matching. */
  literals: Set<string>;
  /** Where each value came from, for diagnostics when the gate rejects something. */
  paths: Map<number, string[]>;
  /** Identifiers of the sources available to be cited (document name + date labels). */
  sources: string[];
};

export type ProvenanceOptions = {
  /** Fraction of numbers in the narrative that must match. Default 1.0: no unsourced figure. */
  minProvenance?: number;
  /** Fraction of available sources that must be cited. Default 0.6. */
  minCoverage?: number;
  /** Absolute tolerance when matching numerically. Default 0.005 (covers 1-dp rounding). */
  epsilon?: number;
  /** Extra numbers that are always allowed (section numbers, list ordinals, the year). */
  allowlist?: number[];
};

export type UnsourcedFigure = { value: number; text: string; context: string };

export type ProvenanceReport = {
  pass: boolean;
  provenanceScore: number;
  coverageScore: number;
  numbersFound: number;
  numbersMatched: number;
  unsourced: UnsourcedFigure[];
  sourcesAvailable: number;
  sourcesCited: number;
  sourcesMissing: string[];
  thresholds: { minProvenance: number; minCoverage: number };
};

const DEFAULTS = { minProvenance: 1.0, minCoverage: 0.6, epsilon: 0.005 };

/* ------------------------------------------------------------------------- *
 * Building the figure set
 * ------------------------------------------------------------------------- */

function variantsOf(n: number): string[] {
  const out = new Set<string>();
  out.add(String(n));
  if (Number.isInteger(n)) {
    out.add(n.toFixed(1));
    out.add(n.toFixed(2));
  } else {
    out.add(n.toFixed(1));
    out.add(n.toFixed(2));
    out.add(String(Math.round(n)));
  }
  // Ratios are commonly narrated as percentages.
  if (n >= 0 && n <= 1) {
    const pct = n * 100;
    out.add(String(Math.round(pct)));
    out.add(pct.toFixed(1));
  }
  return [...out];
}

/**
 * Walks the computed figure structure to ANY depth - through arrays, through objects,
 * through arrays of objects - collecting every number. This recursion is the whole point of
 * the module; a top-level-only version rejects correct nested figures. See the header.
 */
export function flattenFigures(
  input: unknown,
  sources: string[] = [],
  opts: { maxDepth?: number } = {},
): FigureSet {
  const maxDepth = opts.maxDepth ?? 24;
  const values: number[] = [];
  const literals = new Set<string>();
  const paths = new Map<number, string[]>();

  const record = (n: number, path: string) => {
    if (!Number.isFinite(n)) return;
    if (!paths.has(n)) {
      paths.set(n, []);
      values.push(n);
    }
    paths.get(n)!.push(path);
    for (const v of variantsOf(n)) literals.add(v);
  };

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth || node === null || node === undefined) return;

    if (typeof node === "number") return record(node, path);

    if (typeof node === "string") {
      // Values that arrived as strings ("2.4", "3") still count as computed figures.
      const trimmed = node.trim();
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) record(Number(trimmed), path);
      // A date in the figure set contributes its parts, so "14 March 2026" narrates cleanly.
      const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) {
        record(Number(iso[1]), `${path}.year`);
        record(Number(iso[2]), `${path}.month`);
        record(Number(iso[3]), `${path}.day`);
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }

    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };

  walk(input, "", 0);
  return { values, literals, paths, sources: [...sources] };
}

/* ------------------------------------------------------------------------- *
 * Extracting numbers from narrative
 * ------------------------------------------------------------------------- */

/** Strip markup and the spans that legitimately contain digits nobody is claiming as a figure. */
function narrativeText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")            // placeholder tokens
    .replace(/<[^>]+>/g, " ")                     // tags
    .replace(/&[a-z]+;|&#\d+;/gi, " ")            // entities
    .replace(/\s+/g, " ");
}

const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b/g,
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/gi,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi,
];

/** Numbers extracted with word boundaries, after dates are removed. */
export function extractNumbers(html: string): Array<{ value: number; text: string; context: string }> {
  let text = narrativeText(html);
  for (const p of DATE_PATTERNS) text = text.replace(p, " ");

  const out: Array<{ value: number; text: string; context: string }> = [];
  const re = /(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    const from = Math.max(0, m.index - 60);
    const to = Math.min(text.length, m.index + m[1].length + 60);
    out.push({ value, text: m[1], context: text.slice(from, to).trim() });
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * The gate
 * ------------------------------------------------------------------------- */

function matches(value: number, text: string, figures: FigureSet, epsilon: number): boolean {
  if (figures.literals.has(text)) return true;
  for (const v of figures.values) {
    if (Math.abs(v - value) <= epsilon) return true;
    // Ratio narrated as a percentage, or the reverse.
    if (v >= 0 && v <= 1 && Math.abs(v * 100 - value) <= epsilon * 100) return true;
    if (value >= 0 && value <= 1 && Math.abs(v - value * 100) <= epsilon * 100) return true;
  }
  return false;
}

/** How many of the available sources the narrative actually cites, by name or by label. */
function citedSources(html: string, sources: string[]): string[] {
  const hay = narrativeText(html).toLowerCase();
  return sources.filter((s) => {
    const needle = s.trim().toLowerCase();
    return needle.length >= 4 && hay.includes(needle);
  });
}

/**
 * Check generated narrative against the computed figure set.
 * Call before persisting anything the model wrote. A failing report is stored with the run
 * so the prompt or the figure set can be corrected; it does not publish with a warning
 * unless minProvenance is deliberately lowered below 1.
 */
export function checkProvenance(
  narrativeHtml: string,
  figures: FigureSet,
  options: ProvenanceOptions = {},
): ProvenanceReport {
  const minProvenance = options.minProvenance ?? DEFAULTS.minProvenance;
  const minCoverage = options.minCoverage ?? DEFAULTS.minCoverage;
  const epsilon = options.epsilon ?? DEFAULTS.epsilon;
  const allow = new Set(options.allowlist ?? []);

  const found = extractNumbers(narrativeHtml);
  const unsourced: UnsourcedFigure[] = [];
  let matched = 0;

  for (const f of found) {
    if (allow.has(f.value) || matches(f.value, f.text, figures, epsilon)) matched++;
    else unsourced.push(f);
  }

  const provenanceScore = found.length === 0 ? 1 : matched / found.length;

  const cited = citedSources(narrativeHtml, figures.sources);
  const coverageScore = figures.sources.length === 0 ? 1 : cited.length / figures.sources.length;

  return {
    pass: provenanceScore >= minProvenance && coverageScore >= minCoverage,
    provenanceScore,
    coverageScore,
    numbersFound: found.length,
    numbersMatched: matched,
    unsourced,
    sourcesAvailable: figures.sources.length,
    sourcesCited: cited.length,
    sourcesMissing: figures.sources.filter((s) => !cited.includes(s)),
    thresholds: { minProvenance, minCoverage },
  };
}

/** Thresholds from config/environment, so no number is inline in code. */
export function provenanceOptionsFromEnv(): ProvenanceOptions {
  const n = (name: string, d: number) => {
    const v = process.env[name];
    const parsed = v === undefined || v.trim() === "" ? NaN : Number(v);
    return Number.isFinite(parsed) ? parsed : d;
  };
  return {
    minProvenance: n("PROVENANCE_MIN_SCORE", DEFAULTS.minProvenance),
    minCoverage: n("PROVENANCE_MIN_COVERAGE", DEFAULTS.minCoverage),
  };
}

/**
 * Convenience: build the set and check in one call.
 * `sources` are the document labels the narrative could cite; coverage is measured against
 * DISTINCT SOURCES CITED, never citation count. Density rises exactly when coverage collapses
 * onto the two most recent documents, so counting citations rewards the failure.
 */
export function gate(
  narrativeHtml: string,
  computedFigures: unknown,
  sources: string[],
  options?: ProvenanceOptions,
): ProvenanceReport {
  return checkProvenance(
    narrativeHtml,
    flattenFigures(computedFigures, sources),
    { ...provenanceOptionsFromEnv(), ...(options ?? {}) },
  );
}
