/**
 * verify/analytics.mjs - does the analytics layer answer, and does it reach its own bands?
 *
 * Three questions, in the order they fail in practice:
 *   1. does the one function that defines a valid grade behave the same on a literal as on a
 *      column? (It did not, until migration 0140; see that file for why, and why the regression
 *      belongs in a gate rather than in a comment.)
 *   2. does every av_* view SELECT without raising? A view whose config key is missing raises
 *      no_data_found the first time a chart asks for it, which is in front of a user.
 *   3. did the seeded population actually reach the bands the configuration defines? A band that
 *      never occurs has never been seen to work. The generator asserts this over the data it is
 *      about to write; this asserts it over the rows the VIEWS return, which is the path a
 *      surface takes and a different question.
 */

export const checks = [
  {
    name: 'grade_num is literal-safe and column-safe, and agrees with itself',
    async run({ client, analytics }) {
      const nonScoring = analytics.json('grade_scale.non_scoring') ?? [];
      // Literals first: this is the exact call that raised
      // "invalid input syntax for type integer" while the same value from a column returned NULL,
      // because a LANGUAGE sql body is inlined and then constant-folded before its own guard runs.
      const { rows: literal } = await client.query(
        `SELECT grade_num($1) AS non_scoring,
                grade_num(' 4 ') AS padded,
                grade_num('') AS blank,
                grade_num(NULL) AS nul,
                grade_num('6') AS out_of_scale,
                grade_num('x') AS nonsense,
                grade_is_below_standard($1) AS below_non_scoring,
                grade_is_below_standard('2') AS below_two,
                grade_is_critical($1) AS critical_non_scoring,
                grade_is_critical('1') AS critical_one`,
        [nonScoring[0] ?? 'NR'],
      );
      const l = literal[0];
      const literalProblems = [];
      if (l.non_scoring !== null) literalProblems.push('a non-scoring literal did not resolve to NULL');
      if (l.padded !== 4) literalProblems.push('a padded valid literal did not resolve to its int');
      if (l.blank !== null || l.nul !== null) literalProblems.push('blank or NULL did not resolve to NULL');
      if (l.out_of_scale !== null || l.nonsense !== null) {
        literalProblems.push('a value outside the scale did not resolve to NULL');
      }
      if (l.below_non_scoring !== false) literalProblems.push('grade_is_below_standard on a non-scoring literal was not false');
      if (l.below_two !== true) literalProblems.push('grade_is_below_standard on a below-standard literal was not true');
      if (l.critical_non_scoring !== null) literalProblems.push('grade_is_critical on a non-scoring literal was not NULL');
      if (l.critical_one !== true) literalProblems.push('grade_is_critical on the critical grade was not true');

      // Then the same values driven by a COLUMN, and the two answers compared. A regression that
      // only tests literals cannot see the inverse defect, where a rewrite makes the literal path
      // right and the column path wrong.
      const { rows: column } = await client.query(`
        WITH sample(g) AS (
          SELECT DISTINCT grade FROM element_grades WHERE grade IS NOT NULL
          UNION SELECT DISTINCT grade FROM competency_grades WHERE grade IS NOT NULL
        )
        SELECT count(*)::int AS distinct_values,
               count(*) FILTER (WHERE grade_num(g) IS NOT NULL)::int AS numeric_values,
               count(*) FILTER (
                 WHERE grade_num(g) IS DISTINCT FROM
                       (CASE WHEN btrim(g) ~ analytics_text('grade_scale.valid_pattern')
                             THEN btrim(g)::INT END))::int AS disagreements
          FROM sample`);
      const c = column[0];
      if (c.distinct_values === 0) literalProblems.push('no graded rows to drive the column path');
      if (c.disagreements !== 0) literalProblems.push(`${c.disagreements} column values disagree with the pattern`);

      return {
        ok: literalProblems.length === 0,
        detail: literalProblems.length === 0
          ? `literals and ${c.distinct_values} distinct stored values agree; ${c.numeric_values} are numeric`
          : literalProblems.join('; '),
      };
    },
  },
  {
    name: 'every av_* view is selectable within the configured time',
    async run({ client, analytics }) {
      // EVERY PROBE IS BOUNDED, and the bound is the assertion. A view that does not return
      // inside gate.view_probe_timeout_ms fails BY NAME and the deploy stops - which is what an
      // unbounded probe could never do. On 2026-09-19 av_assessor_adjusted ran for two hours and
      // twenty-five minutes without returning, holding read locks that queued a migration behind
      // it and every later reader behind that: the gate did not fail, it stopped, and it took the
      // database with it. "Returns within N seconds" is a stronger claim than "returns
      // eventually", so this narrows nothing; it makes an assertion out of something that was
      // previously only a hope.
      const timeoutMs = analytics.int('gate.view_probe_timeout_ms');
      const { rows: views } = await client.query(
        `SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'av\\_%' ORDER BY 1`,
      );
      const broken = [];
      const slow = [];
      await client.query(`SET statement_timeout = ${Number(timeoutMs)}`);
      try {
        for (const { viewname } of views) {
          const started = Date.now();
          try {
            // LIMIT 1 through a subquery: the view must plan AND execute, and a view whose config
            // key is missing raises at execution rather than at plan time.
            await client.query(`SELECT count(*) FROM (SELECT * FROM ${viewname} LIMIT 1) probe`);
            const ms = Date.now() - started;
            if (ms > timeoutMs / 3) slow.push(`${viewname} ${(ms / 1000).toFixed(1)}s`);
          } catch (err) {
            // 57014 is query_canceled: the statement timeout fired. Report it as the timing
            // failure it is rather than as an unreadable view, because the two have different fixes.
            broken.push(err.code === '57014'
              ? `${viewname}: no first row in ${(timeoutMs / 1000).toFixed(0)}s`
              : `${viewname}: ${err.message.split('\n')[0]}`);
          }
        }
      } finally {
        // Back to unbounded for every later assertion: this limit is this check's, not the suite's.
        await client.query('SET statement_timeout = 0');
      }
      const note = slow.length > 0 ? `; slowest ${slow.slice(0, 3).join(', ')}` : '';
      return {
        ok: views.length > 0 && broken.length === 0,
        detail: views.length === 0 ? 'no av_* views exist; the analytics migrations did not run'
          : broken.length === 0 ? `${views.length} views, all selectable${note}`
          : `${broken.length} of ${views.length} failed: ` + broken.slice(0, 3).join('; ')
            + (broken.length > 3 ? ` (+${broken.length - 3})` : ''),
      };
    },
  },
  {
    name: 'the indicator bands occur in the data the views return',
    async run({ client }) {
      // Read through av_indicator_series and av_indicator_base, which is the path a surface
      // takes. Every boundary comes from the base row; nothing is restated here.
      const { rows } = await client.query(`
        SELECT b.scope,
               count(*)::int AS periods,
               count(*) FILTER (WHERE s.is_suppressed)::int AS suppressed,
               count(*) FILTER (WHERE NOT s.is_suppressed AND s.rate > b.target)::int AS above_target,
               count(*) FILTER (WHERE NOT s.is_suppressed AND s.rate <= b.target)::int AS at_or_below,
               count(*) FILTER (WHERE NOT s.is_suppressed AND s.rate >= b.alert1)::int AS at_alert1
          FROM av_indicator_base b
          JOIN av_indicator_series s
            ON s.scope = b.scope AND s.metric = b.metric AND s.grain = b.grain
           AND s.competency_id IS NOT DISTINCT FROM b.competency_id
         WHERE b.grain = 'overall'
         GROUP BY b.scope ORDER BY b.scope`);
      if (rows.length === 0) {
        return { ok: false, detail: 'no indicator scope produced a single period; there is nothing to band' };
      }
      const problems = [];
      for (const r of rows) {
        const missing = [];
        if (r.above_target === 0) missing.push('above target');
        if (r.at_or_below === 0) missing.push('at or below target');
        if (r.suppressed === 0) missing.push('suppressed');
        if (r.at_alert1 === 0) missing.push('at alert 1');
        if (missing.length > 0) problems.push(`${r.scope}: never ${missing.join(', never ')}`);
      }
      return {
        ok: problems.length === 0,
        detail: problems.length === 0
          ? rows.map((r) => `${r.scope} ${r.periods}p (${r.above_target} above, ${r.at_or_below} at/below, `
            + `${r.at_alert1} at alert 1, ${r.suppressed} suppressed)`).join('; ')
          : problems.join('; '),
      };
    },
  },
  {
    name: 'the analysis runs a fresh install ships include the states that must work',
    async run({ client }) {
      // The provenance gate is the control that keeps a model figure out of a report. A fresh
      // install carries a worked example of it REJECTING a narrative, and one of degraded mode -
      // figures computed, no prose - because both are supported states and neither is ever
      // exercised by a happy-path install.
      const { rows } = await client.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status = 'complete' AND narrative_html IS NOT NULL)::int AS narrated,
               count(*) FILTER (WHERE status = 'failed' AND narrative_html IS NULL AND error IS NOT NULL)::int AS rejected,
               count(*) FILTER (WHERE status = 'complete' AND narrative_html IS NULL)::int AS degraded,
               count(*) FILTER (WHERE status = 'queued')::int AS queued,
               count(*) FILTER (WHERE figures IS NULL AND status <> 'queued')::int AS figureless
          FROM analysis_runs`);
      const r = rows[0];
      const missing = [];
      if (r.narrated === 0) missing.push('a narrated run');
      if (r.rejected === 0) missing.push('a run the provenance gate rejected');
      if (r.degraded === 0) missing.push('a degraded run');
      if (r.queued === 0) missing.push('a queued run');
      if (r.figureless > 0) missing.push(`${r.figureless} run(s) with no computed figures`);
      return {
        ok: missing.length === 0,
        detail: missing.length === 0
          ? `${r.total} runs: ${r.narrated} narrated, ${r.rejected} rejected by the gate, ${r.degraded} degraded, ${r.queued} queued`
          : `missing ${missing.join(', ')}`,
      };
    },
  },
];
