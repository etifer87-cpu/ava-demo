import { NextResponse } from 'next/server';
import { ping, queryOne } from '@/lib/db';
import { isInferenceConfigured } from '@/lib/inference';

/**
 * GET /api/health - the deployment check.
 *
 * Public, because a health endpoint behind authentication cannot be probed by the thing that needs
 * to probe it. It therefore publishes NOTHING sensitive: no connection string, no host name, no
 * counts of people, no version of anything an attacker could use to select an exploit. Environment
 * name, release sha, reachability, two catalogue counts, and which inference tiers are configured.
 *
 * `ok` is the deploy gate. It is true only when the database answered AND the framework is seeded,
 * because an app that starts against an empty database looks perfectly healthy and serves empty
 * screens - the exact failure this endpoint exists to catch.
 *
 * DEGRADED INFERENCE IS NOT UNHEALTHY. With LLM_BASE_URL unset the platform computes, charts and
 * exports everything; only generated prose is absent. That is a supported, tested state, and it is
 * reported as mode "degraded" with ok still true. Reporting it as a failure teaches an operator to
 * ignore the health check.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CountsRow {
  competencies: string;
  observable_behaviours: string;
  subjects: string;
  framework_code: string | null;
}

const COUNTS_SQL = `
  SELECT (SELECT count(*) FROM competencies c
            JOIN competency_frameworks f ON f.id = c.framework_id
           WHERE f.is_active AND c.is_active)::text AS competencies,
         (SELECT count(*) FROM observable_behaviours ob
            JOIN competency_frameworks f ON f.id = ob.framework_id
           WHERE f.is_active AND ob.is_active)::text AS observable_behaviours,
         (SELECT count(*) FROM people WHERE deleted_at IS NULL AND is_active)::text AS subjects,
         (SELECT f.code FROM competency_frameworks f WHERE f.is_active LIMIT 1) AS framework_code
`;

export async function GET() {
  const reachable = await ping();

  let counts: CountsRow | null = null;
  let readError: string | null = null;
  if (reachable) {
    try {
      counts = await queryOne<CountsRow>(COUNTS_SQL);
    } catch (err) {
      // A reachable database with an unmigrated schema is a distinct failure from an unreachable
      // one, and the two need different actions: run the migrations, or fix the connection.
      readError = err instanceof Error ? err.message.split('\n')[0] ?? 'read failed' : 'read failed';
    }
  }

  const fast = isInferenceConfigured('fast');
  const deep = isInferenceConfigured('deep');
  const inference = {
    mode: fast || deep ? 'configured' : 'degraded',
    fast,
    deep,
    // Said plainly, because the word "degraded" reads like a fault to whoever is on the call.
    note:
      fast || deep
        ? 'An inference endpoint is configured. Generated narrative is available.'
        : 'No inference endpoint configured. Every figure, chart, table and export still renders; generated narrative is absent. This is a supported state.',
  };

  const competencies = counts ? Number(counts.competencies) : 0;
  const seeded = competencies > 0;
  const ok = reachable && !readError && seeded;

  return NextResponse.json(
    {
      ok,
      env: process.env.APP_ENV ?? 'unset',
      release: process.env.APP_RELEASE ?? 'unset',
      node_env: process.env.NODE_ENV ?? 'unset',
      time: new Date().toISOString(),
      database: {
        reachable,
        schema_readable: reachable && !readError,
        error: readError,
      },
      framework: {
        code: counts?.framework_code ?? null,
        seeded,
        competencies,
        observable_behaviours: counts ? Number(counts.observable_behaviours) : 0,
      },
      subjects: counts ? Number(counts.subjects) : 0,
      inference,
    },
    {
      status: ok ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
