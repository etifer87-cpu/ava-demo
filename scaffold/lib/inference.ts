/**
 * The single model seam.
 *
 * Nothing above this module knows the vendor, the auth scheme, the wire format or the
 * response shape. Everything is three environment variables:
 *
 *   LLM_BASE_URL     an OpenAI-compatible endpoint, no trailing slash. Empty = degraded mode.
 *   LLM_MODEL_FAST   classify, extract, map step
 *   LLM_MODEL_DEEP   structured findings, narrative, report assembly
 *
 * Rules this module enforces, from docs/11_AI_PIPELINE.md:
 *   - degraded mode (no inference configured) is a supported, tested state, returned as a
 *     value the caller must handle, not thrown;
 *   - JSON output is schema-validated;
 *   - exactly one repair retry on a schema failure, then a hard failure that carries the raw
 *     response - never a fabricated fallback object;
 *   - no model id, URL or auth header appears anywhere else in the codebase.
 *
 * See docs/11 sections 5, 6, 8 and 11.
 */

export type Tier = "fast" | "deep";

export type InferenceOk<T> = {
  ok: true;
  degraded: false;
  data: T;
  raw: string;
  meta: { tier: Tier; model: string; attempts: number; repaired: boolean; ms: number };
};

/**
 * Degraded: inference is not configured, or the endpoint could not be reached.
 * This is NOT a failure. Callers must handle it and continue without narration.
 */
export type InferenceDegraded = {
  ok: false;
  degraded: true;
  reason: "not_configured" | "unavailable";
  detail: string;
};

/**
 * Failed: the endpoint answered but the answer could not be made to satisfy the schema,
 * after the single repair retry. This IS a failure. The run stops. `raw` is stored for
 * inspection. Nothing downstream may substitute a plausible object for this.
 */
export type InferenceFailed = {
  ok: false;
  degraded: false;
  reason: "schema" | "refused" | "empty";
  detail: string;
  raw: string;
};

export type InferenceResult<T> = InferenceOk<T> | InferenceDegraded | InferenceFailed;

export type Validator<T> = (value: unknown) =>
  | { valid: true; value: T }
  | { valid: false; errors: string[] };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type CallOptions<T> = {
  tier: Tier;
  system: string;
  user: string;
  /** Validates the parsed JSON. Required: an unvalidated model response never reaches storage. */
  validate: Validator<T>;
  /** Optional JSON-schema object sent to endpoints that support structured outputs. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type Cfg = {
  baseUrl: string;
  apiKey: string;
  model: Record<Tier, string>;
  timeoutMs: Record<Tier, number>;
  maxTokens: Record<Tier, number>;
  temperature: number;
  repairRetries: number;
};

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function config(): Cfg {
  return {
    baseUrl: (process.env.LLM_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    apiKey: (process.env.LLM_API_KEY ?? "").trim(),
    model: {
      fast: (process.env.LLM_MODEL_FAST ?? "").trim(),
      deep: (process.env.LLM_MODEL_DEEP ?? "").trim(),
    },
    timeoutMs: {
      fast: num("LLM_TIMEOUT_FAST_MS", 60_000),
      deep: num("LLM_TIMEOUT_DEEP_MS", 300_000),
    },
    maxTokens: {
      fast: num("LLM_MAX_TOKENS_FAST", 3000),
      deep: num("LLM_MAX_TOKENS_DEEP", 16000),
    },
    temperature: num("LLM_TEMPERATURE", 0),
    repairRetries: Math.min(1, Math.max(0, num("LLM_REPAIR_RETRIES", 1))),
  };
}

/** True when a model call can be attempted at all. Cheap; call it before building a prompt. */
export function isInferenceConfigured(tier?: Tier): boolean {
  const c = config();
  if (!c.baseUrl) return false;
  if (tier) return Boolean(c.model[tier]);
  return Boolean(c.model.fast || c.model.deep);
}

/**
 * Transport salvage only: a leading BOM, a code fence, prose either side of a brace-balanced
 * object. This repairs DAMAGE IN TRANSIT. It never repairs content, never fills a missing
 * field, and every salvage is reported to the caller for logging.
 */
export function salvageJsonText(raw: string): { text: string; salvaged: boolean } {
  let t = raw.replace(/^﻿/, "").trim();
  let salvaged = false;

  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && fenced[1] !== undefined) {
    t = fenced[1].trim();
    salvaged = true;
  }

  if (!t.startsWith("{") && !t.startsWith("[")) {
    const objStart = t.indexOf("{");
    const arrStart = t.indexOf("[");
    const start =
      objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start !== -1 && end > start) {
      t = t.slice(start, end + 1);
      salvaged = true;
    }
  }
  return { text: t, salvaged };
}

async function postChat(
  cfg: Cfg,
  tier: Tier,
  messages: ChatMessage[],
  opts: CallOptions<unknown>,
): Promise<{ kind: "text"; text: string } | { kind: "degraded"; detail: string }> {
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs[tier];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });

  const body: Record<string, unknown> = {
    model: cfg.model[tier],
    messages,
    max_tokens: opts.maxTokens ?? cfg.maxTokens[tier],
    temperature: opts.temperature ?? cfg.temperature,
    stream: false,
  };
  // Structured outputs where the endpoint supports them; the validator is authoritative either way.
  body.response_format = opts.schema
    ? { type: "json_schema", json_schema: { name: "result", strict: true, schema: opts.schema } }
    : { type: "json_object" };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = `${res.status} ${res.statusText}: ${(await res.text()).slice(0, 500)}`;
      // Transport-level problems are degraded, not failures: the platform keeps working
      // without narration. A schema problem is a failure and is handled by the caller below.
      return { kind: "degraded", detail };
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = payload?.choices?.[0]?.message?.content ?? "";
    return { kind: "text", text };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { kind: "degraded", detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The only way to call a model in this platform.
 *
 * Callers MUST narrow on the result. TypeScript makes ignoring the degraded case a
 * compile error, which is the point: every surface has to decide what it renders when
 * inference is absent.
 */
export async function callModel<T>(opts: CallOptions<T>): Promise<InferenceResult<T>> {
  const cfg = config();
  const started = Date.now();

  if (!cfg.baseUrl) {
    return {
      ok: false,
      degraded: true,
      reason: "not_configured",
      detail: "LLM_BASE_URL is empty; running without inference.",
    };
  }
  if (!cfg.model[opts.tier]) {
    return {
      ok: false,
      degraded: true,
      reason: "not_configured",
      detail: `LLM_MODEL_${opts.tier.toUpperCase()} is empty; running without inference.`,
    };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  let lastRaw = "";
  let lastErrors: string[] = [];

  // attempt 0 = the call; attempt 1 = the single repair retry.
  for (let attempt = 0; attempt <= cfg.repairRetries; attempt++) {
    const res = await postChat(cfg, opts.tier, messages, opts as CallOptions<unknown>);

    if (res.kind === "degraded") {
      return { ok: false, degraded: true, reason: "unavailable", detail: res.detail };
    }

    lastRaw = res.text;
    if (!lastRaw.trim()) {
      return {
        ok: false, degraded: false, reason: "empty",
        detail: "endpoint returned an empty completion", raw: lastRaw,
      };
    }

    const { text, salvaged } = salvageJsonText(lastRaw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      lastErrors = [e instanceof Error ? e.message : String(e)];
      if (attempt < cfg.repairRetries) {
        messages.push({ role: "assistant", content: lastRaw.slice(0, 4000) });
        messages.push({
          role: "user",
          content:
            "That response was not valid JSON: " + lastErrors.join("; ") +
            "\nReturn the same content as a single valid JSON value matching the schema. " +
            "No prose, no code fence. Do not invent values you did not have before; if a " +
            "field was unknown, use null.",
        });
        continue;
      }
      break;
    }

    const check = opts.validate(parsed);
    if (check.valid) {
      return {
        ok: true, degraded: false, data: check.value, raw: lastRaw,
        meta: {
          tier: opts.tier, model: cfg.model[opts.tier],
          attempts: attempt + 1, repaired: attempt > 0 || salvaged,
          ms: Date.now() - started,
        },
      };
    }

    lastErrors = check.errors;
    if (attempt < cfg.repairRetries) {
      messages.push({ role: "assistant", content: lastRaw.slice(0, 4000) });
      messages.push({
        role: "user",
        content:
          "That response did not satisfy the schema:\n- " + check.errors.join("\n- ") +
          "\nReturn a corrected JSON value. Fix only the listed problems. Do not invent " +
          "values; use null where a value is genuinely unknown.",
      });
      continue;
    }
  }

  // One repair retry has been spent. This is a FAILURE.
  //
  // Do not, here or in any caller, turn this into a plausible object. A fabricated fallback
  // record ("is_record: false, notes: <first 500 chars>") is indistinguishable from a real
  // result, produces no error, and removes the document from every report that filters on
  // records. The run fails; the raw response is stored; a human looks at it.
  return {
    ok: false, degraded: false, reason: "schema",
    detail: lastErrors.join("; ") || "response did not satisfy the schema",
    raw: lastRaw,
  };
}

/** Convenience guards so call sites read clearly. */
export const isOk = <T>(r: InferenceResult<T>): r is InferenceOk<T> => r.ok;
export const isDegraded = <T>(r: InferenceResult<T>): r is InferenceDegraded =>
  !r.ok && r.degraded;
export const isFailed = <T>(r: InferenceResult<T>): r is InferenceFailed => !r.ok && !r.degraded;
