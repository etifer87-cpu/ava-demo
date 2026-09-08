#!/usr/bin/env node
/**
 * smoke-screens.mjs - fetch EVERY route and EVERY subject page, assert each one rendered.
 *
 *   node scripts/smoke-screens.mjs --base http://127.0.0.1:3000
 *   node scripts/smoke-screens.mjs --base https://<host> --token "$INTERNAL_API_TOKEN"
 *   node scripts/smoke-screens.mjs --base http://127.0.0.1:3000 --limit-subjects 50
 *
 * Two rules from docs/15_DEPLOYMENT.md section 10, and the script exists to enforce them:
 *
 *   1. It does not sample. Every static route and every subject page is fetched. The one page
 *      nobody looks at is the one an auditor opens.
 *   2. A 200 is not proof. A server-rendered error boundary, an empty state where data was
 *      expected, and a redirect chain landing on a login page all return 200. Every check
 *      declares a marker that must be present in the body, and markers that must be absent.
 *
 * THE ROUTE LIST BELOW AND scaffold/app/ROUTES.md ARE THE SAME LIST. Every row here names a file
 * that exists under scaffold/app, with the same path, the same test id and the same state. Adding
 * a route is three edits in one commit: the file, ROUTES.md, and this list. A route that is in the
 * router and not here is a route nothing checks.
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 */

import process from "node:process";

/* --------------------------------------------------------------------- */
/* arguments                                                              */
/* --------------------------------------------------------------------- */

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = (arg("base") ?? process.env.APP_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = arg("token") ?? process.env.INTERNAL_API_TOKEN ?? "";
const TIMEOUT_MS = Number(arg("timeout", "20000"));
const CONCURRENCY = Number(arg("concurrency", "6"));
const LIMIT_SUBJECTS = Number(arg("limit-subjects", "0")); // 0 = no limit; use only for a fast local loop
const VERBOSE = flag("verbose");

/* --------------------------------------------------------------------- */
/* what "rendered" means                                                  */
/* --------------------------------------------------------------------- */

/**
 * Markers present in EVERY successfully rendered page. If one of these is missing the page
 * did not render, whatever the status code said. Stamped by app/layout.tsx.
 */
const GLOBAL_REQUIRED = ['data-app-shell="ready"'];

/**
 * Markers that must NOT appear. These are the 200-responses-that-are-really-failures.
 * A check may exempt one by name in `allowMarkers`; only /login does, because the login form is
 * what /login is supposed to render.
 */
const GLOBAL_FORBIDDEN = [
  'data-error-boundary="true"',
  'data-testid="login-form"',      // an authenticated route that redirected to login
  "Application error",
  "Internal Server Error",
  "This page could not be rendered",
];

/**
 * Every GET-able route in scaffold/app, in the order ROUTES.md lists them.
 * `state` mirrors ROUTES.md: a stub is a real page and must render like one.
 */
const ROUTES = [
  // public
  { path: "/login",                     marker: 'data-testid="login-form"', state: "built",
    allowMarkers: ['data-testid="login-form"'] },
  { path: "/api/health",                marker: '"ok":true', json: true, shell: false, state: "built" },

  // landing
  { path: "/",                          marker: 'data-testid="dashboard"',        state: "built" },
  { path: "/change-password",           marker: 'data-testid="change-password"',  state: "stub"  },

  // ETR, route group (training), served flat
  { path: "/subjects",                  marker: 'data-testid="subject-list"',     state: "built" },
  { path: "/sessions",                  marker: 'data-testid="session-list"',     state: "stub"  },
  { path: "/records",                   marker: 'data-testid="record-list"',      state: "built" },
  { path: "/templates",                 marker: 'data-testid="template-list"',    state: "stub"  },
  { path: "/templates/builder",         marker: 'data-testid="template-builder"', state: "stub"  },
  { path: "/analytics",                 marker: 'data-testid="analytics-overview"', state: "stub" },
  { path: "/analytics/competencies",    marker: 'data-testid="competency-matrix"', state: "stub" },
  { path: "/analytics/trends",          marker: 'data-testid="trend-charts"',     state: "stub"  },

  // QMS
  { path: "/qms/qualifications",        marker: 'data-testid="qualification-list"', state: "stub" },
  { path: "/qms/types",                 marker: 'data-testid="qualtype-list"',    state: "stub"  },
  { path: "/qms/approvals",             marker: 'data-testid="approval-list"',    state: "stub"  },
  { path: "/qms/certificates",          marker: 'data-testid="certificate-list"', state: "stub"  },
  { path: "/qms/attestations",          marker: 'data-testid="attestation-list"', state: "stub"  },
  { path: "/qms/events",                marker: 'data-testid="qms-event-list"',   state: "stub"  },

  // DMS
  { path: "/dms/documents",             marker: 'data-testid="document-list"',    state: "stub"  },
  { path: "/dms/upload",                marker: 'data-testid="document-upload"',  state: "stub"  },
  { path: "/dms/retention",             marker: 'data-testid="retention-rules"',  state: "stub"  },

  // planning
  { path: "/planning",                  marker: 'data-testid="planning-overview"', state: "stub" },

  // admin
  { path: "/admin/people",              marker: 'data-testid="people-admin"',     state: "stub"  },
  { path: "/admin/users",               marker: 'data-testid="user-list"',        state: "stub"  },
  { path: "/admin/roles",               marker: 'data-testid="role-matrix"',      state: "stub"  },
  { path: "/admin/audit",               marker: 'data-testid="audit-log"',        state: "stub"  },
  { path: "/admin/config",              marker: 'data-testid="config-admin"',     state: "stub"  },
  { path: "/admin/org",                 marker: 'data-testid="org-admin"',        state: "stub"  },
  { path: "/admin/tickets",             marker: 'data-testid="ticket-list"',      state: "stub"  },
];

/**
 * Routes that exist and are deliberately NOT fetched, with the reason. Printed on every run, so an
 * omission is a stated decision rather than a gap nobody noticed. ROUTES.md carries the same table.
 */
const NOT_FETCHED = [
  ["/api/auth/login",  "POST only; a GET returns 405, which is correct behaviour and not a render"],
  ["/api/auth/logout", "POST only, and fetching it would end the session this run is using"],
  ["/api/subjects",    "fetched as the subject enumeration source, below, rather than as a checked route"],
];

/** Per-subject pages. Every one is fetched, for every subject. */
const SUBJECT_PAGES = [
  { suffix: "",              marker: 'data-testid="subject-profile"' },
  { suffix: "/records",      marker: 'data-testid="subject-records"' },
  { suffix: "/competencies", marker: 'data-testid="subject-competencies"' },
  { suffix: "/analysis",     marker: 'data-testid="subject-analysis"' },
];

/* --------------------------------------------------------------------- */
/* fetching                                                               */
/* --------------------------------------------------------------------- */

async function get(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: TOKEN ? { "x-internal-token": TOKEN, accept: "text/html,application/json" } : {},
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status, finalUrl: res.url, body, ms: Date.now() - started };
  } catch (err) {
    return {
      status: 0,
      finalUrl: `${BASE}${path}`,
      body: "",
      ms: Date.now() - started,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function evaluate(check, res) {
  if (res.error) return { ok: false, reason: res.error };
  if (res.status !== 200) return { ok: false, reason: `status ${res.status}` };
  if (!res.body || res.body.trim().length < 32) return { ok: false, reason: "empty body" };

  const allowed = new Set(check.allowMarkers ?? []);
  for (const bad of GLOBAL_FORBIDDEN) {
    if (allowed.has(bad)) continue;
    if (res.body.includes(bad)) return { ok: false, reason: `forbidden marker: ${bad}` };
  }
  if (check.shell !== false) {
    for (const need of GLOBAL_REQUIRED) {
      if (!res.body.includes(need)) return { ok: false, reason: `missing shell marker: ${need}` };
    }
  }
  if (check.marker && !res.body.includes(check.marker)) {
    return { ok: false, reason: `missing marker: ${check.marker}` };
  }
  // A page that redirected somewhere else returned 200 for a different page.
  if (!res.finalUrl.includes(check.path.split("?")[0])) {
    return { ok: false, reason: `redirected to ${res.finalUrl}` };
  }
  return { ok: true, reason: "" };
}

async function runAll(checks) {
  const results = new Array(checks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, checks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= checks.length) return;
      const check = checks[i];
      const res = await get(check.path);
      const verdict = evaluate(check, res);
      results[i] = { ...check, status: res.status, ms: res.ms, ...verdict };
      if (VERBOSE) {
        process.stderr.write(`${verdict.ok ? "ok  " : "FAIL"} ${check.path}\n`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* --------------------------------------------------------------------- */
/* subject enumeration                                                    */
/* --------------------------------------------------------------------- */

async function listSubjects() {
  const res = await get("/api/subjects?fields=id,label&include_inactive=true");
  if (res.status !== 200) {
    throw new Error(
      `cannot enumerate subjects: /api/subjects returned ${res.status}${res.error ? ` (${res.error})` : ""}. ` +
        `Without the full list this script would be sampling, which it must not do.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error("/api/subjects did not return JSON");
  }
  const rows = Array.isArray(parsed) ? parsed : parsed.data;
  if (!Array.isArray(rows)) throw new Error("/api/subjects returned an unexpected shape");
  return LIMIT_SUBJECTS > 0 ? rows.slice(0, LIMIT_SUBJECTS) : rows;
}

/* --------------------------------------------------------------------- */
/* output                                                                 */
/* --------------------------------------------------------------------- */

function table(rows) {
  const cols = [
    { key: "path",   head: "ROUTE" },
    { key: "status", head: "HTTP" },
    { key: "ms",     head: "MS" },
    { key: "verdict",head: "RESULT" },
    { key: "reason", head: "DETAIL" },
  ];
  const data = rows.map((r) => ({
    path: r.path,
    status: String(r.status),
    ms: String(r.ms),
    verdict: r.ok ? "PASS" : "FAIL",
    reason: r.reason || "",
  }));
  const width = {};
  for (const c of cols) {
    width[c.key] = Math.max(c.head.length, ...data.map((d) => d[c.key].length));
  }
  const line = (cells) => cols.map((c) => cells[c.key].padEnd(width[c.key])).join("  ");
  const out = [line(Object.fromEntries(cols.map((c) => [c.key, c.head])))];
  out.push(cols.map((c) => "-".repeat(width[c.key])).join("  "));
  for (const d of data) out.push(line(d));
  return out.join("\n");
}

/* --------------------------------------------------------------------- */

async function main() {
  process.stdout.write(`smoke-screens: ${BASE}\n\n`);

  process.stdout.write("not fetched, deliberately:\n");
  for (const [path, why] of NOT_FETCHED) process.stdout.write(`  ${path.padEnd(20)} ${why}\n`);
  process.stdout.write("\n");

  const subjects = await listSubjects();

  const checks = [
    ...ROUTES,
    ...subjects.flatMap((s) =>
      SUBJECT_PAGES.map((p) => ({
        path: `/subjects/${s.id}${p.suffix}`,
        marker: p.marker,
      })),
    ),
  ];

  process.stdout.write(
    `${ROUTES.length} routes + ${subjects.length} subjects x ${SUBJECT_PAGES.length} pages ` +
      `= ${checks.length} checks (no sampling)\n\n`,
  );
  if (LIMIT_SUBJECTS > 0) {
    process.stdout.write(
      `WARNING: --limit-subjects ${LIMIT_SUBJECTS} is set. This IS sampling and must not be ` +
        `used as a deploy gate.\n\n`,
    );
  }

  const results = await runAll(checks);
  const failures = results.filter((r) => !r.ok);

  // Print failures in full; print the pass table only when it is small or asked for.
  if (failures.length > 0) {
    process.stdout.write(table(failures) + "\n\n");
  }
  if (VERBOSE || results.length <= 40) {
    process.stdout.write(table(results) + "\n\n");
  }

  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
  process.stdout.write("slowest:\n" + table(slowest) + "\n\n");

  process.stdout.write(
    `${results.length - failures.length}/${results.length} passed, ${failures.length} failed\n`,
  );

  if (failures.length > 0) {
    process.stdout.write("\nsmoke-screens FAILED\n");
    process.exit(1);
  }
  process.stdout.write("smoke-screens passed\n");
}

main().catch((err) => {
  process.stderr.write(`smoke-screens error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
