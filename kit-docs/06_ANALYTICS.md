# 06 · Analytics — the metric blueprint

Purpose: the exact definition, formula, inputs, window, units and band boundaries of every number
the platform displays, and the single place each threshold is configured.
Status: spec + scaffolded (`scaffold/config/analytics.yaml`, migrations 0100–0119,
`scaffold/lib/analytics/`)
Version: v1.0 · 2026-08-26

A reader must be able to implement every metric here without access to the system this kit was
distilled from. Where a figure appears in this document it is illustrative and synthetic.

---

## 1. Ground rules

1. **Every figure is computed deterministically.** SQL produces the counts, `lib/analytics`
   produces the derived indices, the model narrates what the deterministic core already computed.
   No number in a chart, a tile or a report may originate in a language model.
2. **No threshold, weight, window or band boundary appears in code or in SQL.** All of them live in
   `scaffold/config/analytics.yaml`, are loaded into the `analytics_config` table by
   `scripts/load-analytics-config.mjs`, and are read at runtime by both layers. Changing a band is
   a config version bump, never a deploy.
3. **Nothing keys on a competency name.** Every join, group-by and chart series keys on
   `competency_id`, scoped by `framework_id`. Names are display strings resolved late.
4. **Raw grades are never altered.** Every rate is derived on read by summing counts. There is no
   "corrected grade" column anywhere.
5. **Absence of evidence is a state, not a zero.** `INSUFFICIENT`, `n/a`, `not captured` and
   `suppressed` are first-class values that render as themselves.

---

## 2. Primitives

Every metric in this document is built from these seven objects. They are defined once.

### 2.1 Grade scale

Ordinal 1–5, defined in `docs/03_COMPETENCY_FRAMEWORK.md` §4. Stored as `TEXT`, not `INTEGER`,
because the non-scoring codes share the column.

| Value | Meaning |
|---|---|
| `1` | ineffective; unsafe situation |
| `2` | minimum acceptable |
| `3` | adequate — the standard |
| `4` | effective |
| `5` | exemplary |
| `NR` | not required |
| `NO` | not observed |
| `NA` | not applicable |

### 2.2 `grade_num(text) -> int`

The single definition of a valid grade in the whole platform.

```
grade_num(g) = CAST(g AS INT)   when trim(g) matches grade_scale.valid_pattern  (default ^[1-5]$)
             = NULL             otherwise
```

**The cast goes on the guard, not inside it.** In SQL, write it as
`(CASE WHEN trim(g) ~ <pattern> THEN trim(g) ELSE NULL END)::INT` — one expression, cast applied to
the whole `CASE`. Written the other way round, with `trim(g)::INT` inside the `THEN` arm, the
function still returns the right answer for every column in the platform and RAISES on a literal:
a single-`SELECT` `LANGUAGE sql` body is inlined, and the planner then constant-folds the cast of a
constant at plan time, before the condition that exists to prevent it. Migration
`0140_grade_num_literal_safe.sql` carries the fix, the reasoning and the regression;
`scripts/verify.mjs` asserts the literal and the column path against each other on every deploy.

`NR`, `NO`, `NA`, blank and anything unparseable all resolve to `NULL`. A `NULL` grade is excluded
from **both** the numerator and the denominator of every metric without exception. It is never
imputed, never counted as a 3, never counted as a 0.

### 2.3 Valid grade / below standard

| Term | Definition | Config |
|---|---|---|
| valid grade | `grade_num(g) IS NOT NULL` | `grade_scale.valid_pattern` |
| **below standard** | `grade_num(g) <= grade_scale.below_standard_max` — default **2**, i.e. grades 1 and 2 | `grade_scale.below_standard_max` |
| meets standard | `grade_num(g) >= grade_scale.meets_standard_min` — default 3 | `grade_scale.meets_standard_min` |
| critical grade | `grade_num(g) = grade_scale.critical_grade` — default 1 | `grade_scale.critical_grade` |

**"Below standard" is defined exactly once**, in `analytics.yaml` under `grade_scale`. Every SQL
view reads it through `analytics_int('grade_scale.below_standard_max')`; every TypeScript module
receives it in the injected config object. No view, route, component or report may restate it.

### 2.4 Grade event versus record

| Grain | One row is | Typical fan-out |
|---|---|---|
| **grade event** | one grade of one competency (or one element) on one record, on one attempt | a competency-graded record produces one event per competency in the framework that was graded |
| **record** | one `records` row: one subject, one session, signed | one |

This distinction is load-bearing and is the single most common source of a wrong denominator.
A rate computed over grade events and a rate computed over records are different measurements that
happen to be built from the same grades. See §4.2 and the Traps section.

### 2.5 Attempt expansion

`element_grades.attempt INT NOT NULL DEFAULT 1`. A repeat of an element is a **row**, and every
attempt is its own grade event.

```
av_element_grade_events emits one row per (record_id, element_key, attempt)
```

Rules:

- A repeated element graded `2` then `4` contributes **two** events: one below standard, one not.
  It must not contribute a single "meets standard" event. Last-attempt-only counting hides exactly
  the failures the metric exists to surface.
- An element with a single attempt contributes exactly one event carrying its recorded grade.
- Where an import supplies an attempt array that contains no parseable grade while the recorded
  grade *is* set, the **recorded grade wins** and one event is emitted. Naively unnesting the array
  and trusting it drops those grades silently.
- Metrics that are deliberately *instance*-based — `elements_attempted`, `repeat_count`,
  `repeat_rate` — filter `attempt = 1` so that the denominator stays "distinct elements", not
  "attempts". Mixing the two makes `repeat_rate` meaningless.
- Introducing attempt expansion into an existing dataset **shifts every mean downward** and raises
  every below-standard count. Figures either side of that change are not comparable and must be
  labelled as a break in series, not smoothed over.

### 2.6 Result

`records.outcome ∈ {PASS, PARTIAL_PASS, FAIL, INCOMPLETE}` (a label, not an enum).

Read from the explicit result field only. **A result is never inferred from grades.** A record can
carry a below-standard competency grade and still be a PASS; a record can be a FAIL with no grade
below 3. Any code that derives one from the other invents an assessor's decision.

Precedence, evaluated in order, first non-null wins:

```
records.outcome_override  ->  records.outcome  ->  NULL (rendered "not recorded")
```

`outcome_override` is a nullable outcome value, not a boolean. Storing a boolean override flag and
then using it where an outcome value is expected produces a silently wrong precedence chain that
no test catches, because both forms are truthy.

### 2.7 Framework scoping and dimensions

Every grade event carries `framework_id`. **Analytics scope to one framework at a time.** Grades
recorded under a superseded framework stay readable exactly as graded and are never force-mapped
onto the current one; a framework change starts a new baseline.

Standard dimensions available on every grade event, resolved in `av_record_dim`:

| Dimension | Source | Note |
|---|---|---|
| `subject_id` | `records.person_id` -> `people` | the schema column is `person_id`; the analytics vocabulary is `subject` |
| `assessor_id` | `records.assessor_person_id`, falling back to the session's | may be unresolved on an imported record; the row is KEPT with a NULL assessor |
| `org_unit_id` | **the record's org unit at session time**, falling back to the subject's current | never the subject's current unit alone |
| `asset_class_id` | the record's asset class, falling back to the template's, then the subject's | see Traps |
| `position` | `records.snapshot->>'position'` — the seat held **on that record** | never the roster's current position |
| `template_code` / `template_kind` | `session_templates` via the record's template version | scope membership keys on `template_kind` |
| `source` | `records.source ∈ {app, import, ingest}` | every "all data" aggregate must read all three |
| `occurred_on` | `records.training_date` | |
| `period` | `date_trunc(<scope period>, occurred_on)` | month or quarter, per scope config |

---

## 3. Metric register

| # | Metric | Grain | Denominator | Window | Units | Config root |
|---|---|---|---|---|---|---|
| 1 | Below-standard rate (BSR) | period × competency × scope | grade events | period | proportion; displayed × `rate_display.below_standard_rate.denominator` | `grade_scale`, `rate_display` |
| 2 | Adverse-competency rate (ACR) | period × scope, **overall grain only** | records | period | proportion; displayed × `rate_display.adverse_competency_rate.denominator` | `rate_display` |
| 3 | First-attempt vs after-remedial | element × cohort | grade events, split by attempt | any | two proportions + delta | `grade_scale` |
| 4 | Program-level indicator (PLI) | period × metric × grain × scope | as its base metric | fixed base window + rolling display window | proportion + status | `program_indicator` |
| 5 | Rolling control chart (RCC) | calendar period × competency | below-standard **count** per rolling window | rolling `window_events` | count; displayed per `control_chart.display.denominator` | `control_chart` |
| 6 | Screening index (SCI) | **subject × competency** | weighted grade events in window | last `window_sessions` graded sessions | score + band | `screening_index` |
| 7 | Concern level | subject | observations | configurable lookback | ordinal band | `concern` |
| 8 | Flagged record | record | competency grades on that record | n/a | boolean | `flagged_record` |
| 9 | Coverage | record / period / catalogue | see §11 | any | proportion | `coverage` |
| 10 | Trend / delta | subject × competency, assessor × month | points in window | window | signed slope + arrow | `trend` |
| 11 | Currency status | person × qualification type | n/a | as-at date | ordinal state | `currency` |
| 12 | Assessor adjusted leniency | assessor (× competency, raw only) | residuals | window | grade points + CI | `assessor_fairness.adjusted_delta` |
| 13 | Assessor standardisation index (ASI) | assessor | available deduction terms | window | 0–100 + band | `assessor_fairness.standardisation_index` |
| 14 | Cohort comparison | subject vs group | grades each side | any | mean, delta, CI, d, percentile | `comparison` |

---

## 4. Rate metrics

### 4.1 BSR — below-standard rate

**Definition.** The share of valid competency grade events that were below standard.

**Formula.**

```
below(p, c, s) = count of grade events where period = p, competency_id = c, scope = s
                 and grade_num(grade) <= below_standard_max
n(p, c, s)     = count of grade events where period = p, competency_id = c, scope = s
                 and grade_num(grade) IS NOT NULL

BSR(p, c, s)   = below(p, c, s) / n(p, c, s)          -- NULL when n = 0
```

**Inputs.** `av_competency_grade_events` (one row per record × competency), joined to
`av_record_dim` for period and scope.

**Grain.** period × competency × scope. An `overall` grain pools all competencies:
`Σbelow / Σn` across competencies — **not** the mean of the per-competency rates.

**Window.** One period. Period length is per scope: `program_indicator.scopes.<scope>.period`
(`month` or `quarter`).

**Units.** Stored and compared as a proportion in `[0,1]`. Multiplied by
`rate_display.below_standard_rate.denominator` **at render only** (default 1000, labelled
"per 1000 grades"). Scaling at render is safe because a single positive constant cannot reorder
values against thresholds — but only if the thresholds are scaled with them, which is why the
comparison always happens on proportions.

**Suppression.** `n < suppression.min_n_rate` (default 30) renders `n<30` and the value is `NULL`.
It is not rendered as 0 and it is not interpolated.

**Uncertainty.** Wilson 95 % interval on every displayed rate — `comparison.ci_level`. Never the
naive normal approximation; at the rates this metric operates at the normal approximation produces
intervals that cross zero.

### 4.2 ACR — adverse-competency rate

**Definition.** The share of graded records that contained at least one below-standard competency
grade.

**Formula.**

```
adverse(p, s) = count of records where period = p, scope = s
                and the record has >= 1 competency grade event with grade_num <= below_standard_max
den(p, s)     = count of records where period = p, scope = s
                and the record has >= 1 valid competency grade event

ACR(p, s)     = adverse(p, s) / den(p, s)
```

**The denominator is records, not grade events.** This is the whole point of the metric: it answers
"how often does a session go wrong" rather than "how often does a grade go wrong".

**Grain restriction: overall only.** At competency grain each record grades a given competency once,
so "records with at least one below-standard grade in competency c" is identical to "below-standard
grade events in competency c" and ACR collapses onto BSR. Publishing an ACR at competency grain
prints BSR under a second name. The view enforces this by emitting the ACR metric rows only at
`grain = 'overall'`.

**Units.** Proportion; displayed × `rate_display.adverse_competency_rate.denominator`, labelled
"per 1000 records".

**The exposure trap.** BSR and ACR have different denominators, so their display denominators
describe different exposures even when the number is the same. A record carries roughly as many
competency grades as the framework has competencies, so 1000 grade events and 1000 records are an
order of magnitude apart in real exposure. Consequences, all mandatory:

- The formatter takes the metric as an argument and returns unit, axis label and denominator
  together. There is no shared "per 1000" string.
- The two series never share a y-axis.
- A tile that shows both prints both units.

### 4.3 First-attempt versus after-remedial

**Definition.** The same below-standard rate computed twice over element grade events, split by
attempt number, so that the effect of remedial work is visible rather than absorbed.

```
first_attempt_rate = below(events where attempt = 1) / n(events where attempt = 1)
after_remedial_rate = below(events where attempt > 1) / n(events where attempt > 1)
remedial_recovery   = first_attempt_rate - after_remedial_rate
```

**Inputs.** `av_element_grade_events`, `av_first_attempt`.

**Grain.** element × cohort, and rolled up to cohort.

**Reading it.** `after_remedial_rate` is computed only over elements that were actually repeated,
so it is not a like-for-like population and must be labelled "of elements repeated". A positive
`remedial_recovery` means repeated elements ended better than they started; it is not a measure of
the training programme's overall quality and must not be reported as one.

**Never report only the last attempt.** A metric that reads the final grade of each element counts
an element graded 2 then 4 as meeting standard and makes the initial failure invisible.

---

## 5. PLI — the program-level indicator

The formal, governance-facing indicator. It is the only metric in the platform that carries an
alert status, and the only one whose baseline is frozen.

It is a wrapper: it takes any rate metric (BSR or ACR) at any grain and any scope and adds a fixed
baseline, three alert levels, a target, and a status engine with run rules.

### 5.1 Base statistics

Computed once over the configured base window and then **stored**, not recomputed on read.

| Term | Formula | Note |
|---|---|---|
| `base_rate` | `Σ below over the base window / Σ n over the base window` | **pooled**, not the mean of the per-period rates |
| `base_periods` | count of periods in the base window that produced a row | must equal the configured `base_periods`; this is the deploy assertion |
| `sd_p` | sample standard deviation of the **per-period rates** in the base window | population sd understates the alert spacing |
| `alert1` | `base_rate + 1 * sd_p` | |
| `alert2` | `base_rate + 2 * sd_p` | |
| `alert3` | `base_rate + 3 * sd_p` | |
| `target` | `target.type = 'absolute'` -> `target.value`; `target.type = 'relative'` -> `base_rate * (1 - target.value)` | default relative, `value: 0.05` = a 5 % improvement on base |

Alert multipliers are `program_indicator.alert_sigma: [1, 2, 3]`. Adding a fourth level is a config
edit.

### 5.2 Status engine

Evaluated in `lib/analytics/program-indicator.ts` over the series **sorted ascending by period**,
on proportions, never on displayed values.

```
for each period, in order:
  if n < suppression.min_n_rate:
     status = SUPPRESSED; rate = null; break every open run; continue
  if rate <= target:
     status = GREEN; reset run_above_target; reset run_at_alert1; continue
  if rate >= alert2 or run_at_alert1 + 1 >= status_rules.consecutive_at_alert1:
     status = RED
  else if rate > target or run_above_target + 1 >= status_rules.consecutive_above_target:
     status = AMBER
  increment run_above_target
  if rate >= alert1: increment run_at_alert1 else reset run_at_alert1
```

| Status | Rule |
|---|---|
| GREEN | `rate <= target` |
| AMBER | `target < rate < alert2`, or `consecutive_above_target` (default 3) consecutive periods above target |
| RED | `rate >= alert2`, or `consecutive_at_alert1` (default 2) consecutive periods at or above `alert1` |
| SUPPRESSED | `n < min_n_rate` |

Two asymmetries that are deliberate and must be preserved:

- **A period at or below target resets both runs.** Improvement is allowed to clear the record.
- **A suppressed period breaks a run rather than continuing it.** Absence of evidence must not
  accumulate as evidence. This is the single most important line in the engine.

The `consecutive_above_target` clause is subsumed while the target sits below `alert1` — any period
above target is already amber — and only becomes load-bearing when an operator sets an ambitious
target above `alert1`. It is kept because the rule set, not the arithmetic, is what an authority
reviews.

### 5.3 Rebasing

`program_indicator.rebase: manual_only`. The base is **never** recomputed automatically, on any
schedule, by any job.

A base that drifts with the data makes improvement permanently invisible, because the yardstick
moves with the thing it measures. Rebasing is a deliberate act: edit the base window in
`analytics.yaml`, bump `version`, reload the config, and record who and when in `config_versions`.
The chart prints the base window and the config version it is drawn against.

### 5.4 Scopes

A scope is a named slice with its own period length, its own record families and its own base.
One parameterised component renders every scope; scopes are never copied into new components.

| Scope key | Period | Base periods | Default display window | Source families |
|---|---|---|---|---|
| `simulator` | `month` | 12 | 24 periods | the simulator and proficiency template families |
| `line_operations` | `quarter` | 12 | 12 periods | the line-evaluation template family |

`base_periods` counts **periods, not months**. A quarterly indicator needs the same number of
*points* to estimate a standard deviation from, which costs three times the calendar. Do not
"correct" a quarterly base window to twelve months.

Pooling: a `pooled` series may pool the families **within** one scope. Scopes are never pooled with
each other — different period lengths and different bases make the pooled number meaningless.

Excluding a source family or an asset class from a scope is a config list, never a WHERE clause in
a view.

### 5.5 Choosing the period length

Before publishing a scope at a given period length, compute the overdispersion ratio over the base
window:

```
poisson_sd      = sqrt(mean below-standard count per period)
observed_sd     = sample sd of the per-period below-standard counts
overdispersion  = observed_sd / poisson_sd
```

| Ratio | Reading | Action |
|---|---|---|
| `>= program_indicator.overdispersion_warn_below` (default 1.2) | real period-to-period variation exists | publish at this period |
| `~ 1.0` | movement is indistinguishable from counting noise | **aggregate to a longer period** |

A near-Poisson series is not a failure. A stable, near-constant exposure is exactly what makes a
genuine future shift visible. Frame such an indicator as a detector for future change, not as an
explanation of past variation. What a monthly chart of a Poisson series produces is peaks and
troughs that mean nothing and invite explanations of randomness.

Related automatic caveat: when `sd_p > base_rate * program_indicator.sd_caveat_ratio` (default 0.5)
the surface prints, without being asked, that single-period movements are weak evidence and that
the run rules carry the signal.

### 5.6 Multiple comparisons

Comparing two source families per competency (a template-equivalence test) is a two-proportion
z-test over the base window. With one test per competency, the significance threshold is Bonferroni
corrected:

```
alpha_adjusted = comparison.multiple_comparison.alpha / <number of active competencies in the framework>
```

The divisor is `comparison.multiple_comparison.divisor: competency_count` — **read from the
framework table at runtime**, never a literal. Testing nine competencies at an uncorrected
alpha of 0.05 produces at least one false positive well over a third of the time.

---

## 6. RCC — the rolling control chart

An early-warning instrument, deliberately **not** reconciled with the PLI.

| Property | Value |
|---|---|
| Measures | below-standard **count**, not a rate |
| Grain | calendar period × competency |
| Rolling window | `control_chart.window_events` (default 100) grade events |
| Base | the below-standard rate measured over the first `control_chart.estimation_sample_events` (default 400) consecutive grade events from the configured start period, then `* window_events`, then floored |
| `limit_1` | `base_count + control_chart.limit_1_offset` (default +2) |
| `limit_2` | `base_count + control_chart.limit_2_offset` (default +4) |
| Overlay | a mean line drawn over **actual history only**, never extrapolated backwards, plus a forward projection of `control_chart.forecast_periods` periods drawn as a dashed line and labelled a projection |
| Display | per `control_chart.display.denominator` (default 100 records) |

**Limits are counts, not rates.** They are integers and they move only when the base is re-estimated.

**Sizing the estimation sample.** At the low rates this instrument operates at, a small estimation
sample produces degenerate bases: a sample containing zero below-standard events gives a base of 0
and the competency alerts permanently; a sample that happens to contain several gives a base far
above the true rate and the competency never alerts. The sample must be large enough that the
expected count in it is comfortably above single digits. `estimation_sample_events` is the knob;
it is a config value precisely so it can be raised without a deploy.

**Never let the estimation sample and a display denominator share a number.** They are unrelated
ideas — one is how many events the base was measured over, the other is a presentation multiplier —
and if they share a value someone will eventually write a sentence that treats them as the same
quantity. The defaults in this kit (400 and 100/1000) are deliberately different.

---

## 7. SCI — the subject-competency screening index

A per-subject, per-competency screening signal. Its purpose is to decide **where to look**, not to
decide an outcome. It never appears on a subject's own surface and it never determines a result.

Grain: **one score per (subject_id, competency_id)**. There is no subject-level SCI: averaging
across competencies is exactly the compensation the index exists to prevent.

### 7.1 The four ideas

**(a) Non-compensatory critical flag.** A grade of `grade_scale.critical_grade` (1) is a critical
failure and must never average away.

```
if the subject has any grade-1 event in this competency:
    let recovery = number of consecutive valid grade events, in chronological order,
                   strictly AFTER the most recent grade-1 event,
                   all with grade >= screening_index.clean_run_min_grade   (default 3)
    if recovery < screening_index.clean_run_n     (default 3):
        band = RED, regardless of score
        companion text = "recovery <recovery>/<clean_run_n>"
    else:
        the flag has lifted; band is decided by score
```

A grade of 2 occurring after the grade-1 **breaks** the recovery run and the counter restarts at
zero. A `NULL`/non-scoring grade is not an event and neither continues nor breaks the run.

**A grade-1 event never enters the score arithmetic.** It drives the flag only. If it also
contributed points it would be partially compensable by later good grades, which is the failure
mode being designed out.

**(b) Asymmetric points.** Grades are converted to points, not averaged as ordinals:

| Grade | Points | Config key |
|---|---|---|
| 2 | **-5.0** | `screening_index.points["2"]` |
| 3 | 0.0 | `screening_index.points["3"]` |
| 4 | +1.0 | `screening_index.points["4"]` |
| 5 | +2.0 | `screening_index.points["5"]` |
| 1 | not scored | flag only |

The asymmetry is the design: one below-standard grade is not cancelled by one above-standard grade.
Symmetric points reproduce a mean, which is the thing being replaced.

**(c) Assessor-leniency adjustment.** Each event's grade is adjusted by the grading tendency of the
assessor who awarded it, so that a subject is not penalised for having drawn strict assessors or
flattered for having drawn lenient ones.

```
delta(a)  = mean grade awarded by assessor a  -  mean grade awarded by all assessors
            (both means over valid grades only, over the same competency framework)

if assessor is resolved AND assessor has >= screening_index.leniency.min_sessions
                                        (default 30) graded sessions:
    adjusted_grade = clamp( round(grade - delta(a)),
                            screening_index.leniency.clamp_min,   -- 2
                            screening_index.leniency.clamp_max )  -- 5
    weight = 1.0
else:
    adjusted_grade = grade                                   -- no adjustment
    weight = screening_index.leniency.reduced_weight          -- default 0.5
```

The **minimum sample is mandatory**. Below it, an assessor's mean is dominated by which subjects
they happened to assess, and adjusting by it injects more noise than it removes. The event is not
discarded — it contributes at reduced weight, and the surface marks it as such.

Rounding then clamping, in that order, keeps the adjusted value on the ordinal scale so that the
points table still applies. Clamping at 2 (not 1) prevents an adjustment from manufacturing a
critical grade that no assessor awarded.

**(d) Recency weighting.** Over the last `screening_index.window_sessions` (default 8) valid grade
events in that competency, newest first, at zero-based index `i`:

```
w(i) = 0.5 ^ ( i / screening_index.recency_half_life )     -- default half-life 3.5 events
```

So the newest event carries weight 1.0 and an event 3.5 events back carries 0.5. The half-life is
expressed in **events, not days**, because a subject who flies rarely should not have their history
decay to nothing.

### 7.2 Score

Over the events in the window, **excluding grade-1 events**:

```
SCI = Σ( w(i) * points(adjusted_grade(i)) * weight(i) )  /  Σ( w(i) * weight(i) )
```

Denominator is the same weighted count, so the score stays on the points scale regardless of how
many events are in the window. If the denominator is zero the state is `INSUFFICIENT`.

### 7.3 Bands

Evaluated in this order. The first match wins.

| Band | Rule | Config |
|---|---|---|
| `INSUFFICIENT` | fewer than `screening_index.min_valid_grades` (default 3) valid grade events in the window | `screening_index.min_valid_grades` |
| `RED` | an unrecovered critical grade — §7.1(a) | `screening_index.clean_run_n` |
| `AMBER` | `SCI < screening_index.bands.amber_below` (default **-1.5**) | |
| `ABOVE` | `SCI > screening_index.bands.above_over` (default **+0.5**) | |
| `STANDARD` | otherwise (`-1.5 <= SCI <= 0.5`) | |

`INSUFFICIENT` is evaluated **before** `RED` only for the score path; a critical grade with fewer
than the minimum events still raises `RED`, because the flag does not depend on the score. The
implementation encodes this explicitly: insufficient evidence for a *score* is not insufficient
evidence for a *grade of 1 having been awarded*.

**A competency with no grades at all is returned as `INSUFFICIENT` and is never dropped from the
response.** The response always carries one row per active competency in the framework. A missing
row would render as a gap that reads like "fine".

### 7.4 Companions

Rendered beside each band, all deterministic:

| Companion | Definition |
|---|---|
| `since_below` | number of valid grade events since the most recent event at or below `below_standard_max` |
| `recovery` | `x / clean_run_n` while RED |
| trend arrow | see §10; threshold `screening_index.trend_threshold` (default 0.05 points) |
| grade chips | the last `window_sessions` grades, oldest to newest, each linking to its record; a chip is marked when its grade was leniency-adjusted and faded when it contributed at reduced weight |

### 7.5 Which records feed it

Every graded record type feeds the SCI — recurrent, proficiency, line evaluation, remedial and
additional training — with exclusions expressed as a config list of template codes
(`screening_index.exclude_template_codes`, empty by default), never as a predicate in a view.

Where the same (subject, competency, date) appears from both an in-app session and an imported
record, the **in-app session shadows the import**. Both sources land in `records`; the shadow rule
lives in `av_competency_grade_events` and is stated in its comment.

Any surface that shows the SCI must state which record types feed it and which are excluded.

---

## 8. Concern level

**Definition.** A subject-level triage band derived from grades, computed by one function and read
by every surface.

**Grain:** subject. **Window:** `concern.lookback_days` (default 730; `null` means all history).

```
deriveConcern(observations, override):
  if override is not null:                     return override
  if count(grade == critical_grade) >= concern.high.grade_1_count_at_least:      return HIGH
  if count(grade == 2)              >= concern.medium.grade_2_count_at_least:    return MEDIUM
  if count(valid grades)            >= concern.low.min_observations:             return LOW
  return NULL   -- no observations; renders "no data", never "Low"
```

Defaults: `HIGH` at one or more grade-1 events; `MEDIUM` at two or more grade-2 events;
`LOW` when there is any valid grade; `NULL` otherwise.

**One derivation, one endpoint.** `av_concern_input` produces the counts, `lib/analytics/concern.ts`
applies the rule, one route serves it, and the roster list, the dashboard, the subject profile and
the admin statistics page all read that route. Two surfaces computing the same concept from two
different sources will disagree, and the disagreement is invisible until someone puts the two
screens side by side.

**Effective value**, where a model-produced narrative concern also exists:

```
effective = derived ?? concern_override ?? latest_analysis_run.concern_level ?? NULL
```

The derived, deterministic value ranks first. A model-produced concern level is a fallback for
subjects with no gradable history, is labelled as model-derived on the surface, and never
overrides a computed one.

**Colour** comes from `chart-tokens`, never from a literal in a component.

---

## 9. Flagged record and advisory flags

**Definition.** A record is flagged when its competency grades meet either trigger:

```
is_flagged =  count(grade == critical_grade) >= flagged_record.grade_1_at_least   (default 1)
           OR count(grade == 2)              >= flagged_record.grade_2_at_least   (default 3)
```

**Grain:** record. **Window:** none — it is a property of the record.

A flagged record is a pointer, not a judgement: it says "this record contains a pattern worth
reading", and it never changes the record's `result`. The advisory panel on a subject profile lists
one row per flagged record with the competencies that triggered it.

Any surface that uses a looser trigger than the one above must read it from a **different config
key**, so that two triggers cannot be mistaken for one. Two panels quietly using "1 grade-1 or 3
grade-2" and "1 grade-1 or 2 grade-2" under the same label is a defect, not a nuance.

---

## 10. Trend and delta

**Definition.** A direction, computed from points, expressed as an arrow plus the number behind it.

**Half-split trend (used by the SCI companion and the sparkline grid).** Over the window's valid
events ordered oldest to newest, split into an older half and a newer half (an odd count puts the
middle event in neither):

```
delta = mean(points of newer half) - mean(points of older half)

arrow =  UP    when delta >  trend.flat_band     (default +0.05)
         DOWN  when delta < -trend.flat_band
         FLAT  otherwise
```

Requires `trend.min_points` (default 4) events; below that the arrow is omitted, not drawn flat.

**Slope trend (used for assessor drift and for report sparklines).** Ordinary least-squares slope of
the value against days, rescaled to the configured interval:

```
slope_per_interval = OLS_slope(value ~ day_offset) * trend.slope_interval_days   (default 90)
```

Reported as a number with its `n`, never as the word "improving" on its own. A trajectory arrow
without the slope and the sample size behind it is an assertion, not a measurement.

**Delta pills** elsewhere (subject versus cohort mean, assessor versus peer median) are a plain
difference of two means with both `n`s printed. A delta whose either side is below
`comparison.min_n_per_side` renders `insufficient`.

---

## 11. Coverage

Four separate things are called coverage. They are different metrics and are labelled distinctly.

| Metric | Definition | Grain | Config |
|---|---|---|---|
| **Competency coverage** | valid competency grades on a record / active competencies in the framework | record | `coverage.targets.competency_coverage_min` |
| **Observable-behaviour coverage** | competency grades carrying at least one `observable_behaviour_id` / competency grades | record, period | `coverage.targets.ob_coverage_min` (default 0.8) |
| **Remark coverage** | grade events carrying a non-empty remark / grade events | assessor, period | `coverage.targets.remark_coverage_min` (default 0.6) |
| **Catalogue match rate** | recorded behaviour rows matched to a catalogue OB / recorded behaviour rows | catalogue | monitored, target 1.0 |

Catalogue matching is **containment on a normalised key**, not equality: a recorded string matches
a catalogue OB when the normalised catalogue text appears within the normalised recorded text. This
recovers concatenated selections. Normalisation lowercases, collapses whitespace, normalises the
conjunction and slash spacing, and trims. **Display always uses the canonical catalogue text.**

Catalogue match rate is itself a monitored metric, and a drop in it is a data-quality alarm, not a
finding about training. In this kit the problem largely disappears because OB selections are stored
as `observable_behaviour_id` — the matcher exists only for imported free-text.

**Do not derive the canonical catalogue from whatever data happens to be present.** The catalogue is
seeded as data from `docs/03_COMPETENCY_FRAMEWORK.md`; a derivation script run against a different
dataset produces a different catalogue. `scripts/migrate.mjs` refuses to run a derivation step.

---

## 12. Currency and expiry status

**Definition.** The validity state of one qualification for one person, derived **on read** by a
pure function `deriveStatus(qualification, qual_type, asOf)`. It is never stored, because a stored
status is wrong the day after it is written.

Evaluated in order, first match wins:

| Order | Status | Rule |
|---|---|---|
| 1 | `SUSPENDED` / `INACTIVE` | manual `status_override` — wins over everything |
| 2 | `MISSING` | no completion date and no validity date |
| 3 | `VALID` | one-time type (`validity_months IS NULL`) with a completion date |
| 4 | `EXPIRED` | `valid_until < asOf`, and beyond any `grace_days` |
| 5 | `PLANNED` | not expired, and an approved future plan exists for renewal |
| 6 | `WARNING` | `valid_until <= asOf + warning_days` (per type; default `currency.default_warning_days`) |
| 7 | `VALID` | otherwise |

Derived aggregate, computed separately because it is a different question:

```
DUE = valid_until <= asOf + currency.due_soon_days   (default 90)
      AND status != PLANNED                          (currency.planned_excluded_from_due: true)
```

`valid_until` is computed, not trusted blindly:

```
computeValidUntil(type, last_completed_on, stored_valid_until):
  interval type (validity_months set)   -> last_completed_on + validity_months
  date-driven type                      -> stored_valid_until
  one-time type                         -> NULL
```

**Config home:** `qual_types` rows carry `validity_months`, `warning_days`, `grace_days`,
`early_renewal_days`, `requires` (dependency codes) and `source ∈ {document, event, experience}`.
`analytics.yaml` carries only the defaults used when a type leaves a field null.

**Aggregates:** people tracked · pending approvals · expiring within `due_soon_days` · expired ·
compliance percentage · breakdowns by org unit, asset class and position. Compliance percentage is
`count(status IN (VALID, WARNING, PLANNED)) / count(required qualifications)`; the numerator set is
config (`currency.compliant_statuses`) because operators disagree about whether PLANNED counts.

---

## 13. Assessor grading fairness

Management instruments for a standardisation conversation. Six layers, every constant in
`analytics.yaml` under `assessor_fairness`.

An assessor never sees their own page. These instruments exist to open a conversation; a self-view
lets an assessor watch their own alert queue and infer which records are under review before that
conversation happens.

### 13.1 Expected grade — the same-subject comparison

**Never compare an assessor to the fleet mean.** A raw comparison punishes an assessor assigned
weaker subjects and flatters one assigned stronger subjects, with no way to tell either from a
genuine bias. The comparison is: **what did these same subjects score in these same competencies
with other assessors?**

For each grade event `(subject, competency, occurrence)` by assessor `a`:

```
peers = that subject's valid grade events in that competency awarded by any assessor != a,
        within expected.window_rank ranks of this occurrence in that subject's own sequence

w(d)  = 0.5 ^ ( |d| / expected.half_life )        d = rank distance, half_life default 3.5
expected = Σ( w(d) * peer_grade ) / Σ( w(d) )
```

- The weighting is **symmetric in rank distance**. This is a leave-one-out estimate of the subject's
  ability around that point in time, not a forecast, so later evidence is as relevant as earlier.
- `expected.window_rank` (default 12) bounds the self-join. It is a performance guard, not a
  statistical choice: without it the pair join is quadratic in each subject's history. At the
  default half-life the weight at the window edge is small, and the result is renormalised by the
  weights actually used, so the truncation is unbiased.

**Fallback chain**, applied when fewer than `expected.min_grades` (default 3) qualifying peer
grades exist. The **level used is recorded on every row**, so any aggregate can be filtered or
audited by it:

| Level | Estimate |
|---|---|
| 1 | same subject, same competency, other assessors — as above |
| 2 | that subject's mean over all competencies, other assessors |
| 3 | the peer group's mean for that competency |
| 4 | the peer group's overall mean |

A population where a large share of rows resolve above level 1 is not fit for banding, and the
surface says so rather than banding it.

### 13.2 Adjusted leniency delta, with shrinkage

```
residual(i)   = grade(i) - expected(i)
delta_raw     = mean(residual)                       over the assessor's events in the window
n             = number of residuals
delta         = delta_raw * n / ( n + adjusted_delta.k_shrink )     -- default k_shrink 20
ci_half_width = adjusted_delta.ci_z * sd(residual) / sqrt(n)        -- default z 1.96
```

**Shrinkage toward zero is mandatory.** Without it, the assessors with the fewest events occupy
both ends of the ranking every time, purely as an artefact of variance. `k_shrink` is the number of
events at which an assessor's own evidence carries half the weight.

The **unadjusted** delta (own mean minus group mean) is retained and shown as a small secondary
figure. It is the number people expect to see, and showing both is how the correction gets
explained. It is never used for banding or flagging.

| State | Rule | Consequence |
|---|---|---|
| `provisional` | records < `adjusted_delta.min_records_banded` (default 10) | excluded from outlier flags; **never banded**; shown with the label |
| outlier | `abs(delta) >= adjusted_delta.outlier_abs` (default 0.5 grade points) **and** not provisional | listed for review |

The correction runs both ways: an assessor who looks strict against the fleet mean routinely moves
back inside the band once their roster is accounted for, and an assessor who looks unremarkable can
move out.

**Per-competency deltas are raw.** The expected-grade machinery is not implemented per competency
in this scaffold, so the per-competency heatmap shows own mean versus group mean per competency and
is **labelled RAW on the surface**. An unlabelled raw number beside adjusted numbers is the defect;
the raw number itself is fine.

### 13.3 Grade / remark justification

Two layers, in strict order.

**Layer 1 — deterministic, nominates.**

| Rule | Trigger | Config |
|---|---|---|
| `unjustified_low` | `grade <= justification.grade_max` (default 2) **and** remark word count `< justification.min_words` (default 8) | definitional; stands alone |
| `masking` (candidate) | `grade >= justification.never_penalise_grade_min` (default 4) **and** the remark matches a negative-cue list | **candidate only** |

**Layer 2 — model, decides, and only for `masking`.** Every `masking` candidate plus a random
`justification.random_sample_pct` (default 5 %) sample of clean rows with remarks is sent to the
model. The model receives **only an ordinal index, the numeric grade and the remark text** — no
assessor id, no subject id, no record id, no names. It returns strict JSON
`{severity, remark_type, mismatch, confidence}` where `severity` is the grade the text alone
implies, judged **independently of the awarded grade**. This is a bias-mitigation design, not an
efficiency one.

`justification.masking_requires_model: true`. A keyword rule alone must never cap a score: a
single domain-ambiguous word produces a large majority of false positives, and those false
positives hold assessors below the band their evidence supports. `unjustified_low` stays purely
deterministic because the rule is definitional — a low grade with no substantive remark is
unjustified by definition, whatever the text says.

**Grades at or above `never_penalise_grade_min` with no comment are never penalised anywhere**, in
any metric, on any surface. A good grade with no essay is not a finding.

Alerts land in `instructor_remark_audit` equivalent (`assessor_remark_audit`), `status ∈ {open,
dismissed, confirmed}`. A decision **requires a reviewer note**, enforced both in the route and by a
`CHECK` constraint, and writes an `audit_log` row.

**Justification rate**

```
justification_rate = substantive_below_standard_remarks / total_below_standard_grades
```

where substantive means word count `>= justification.min_words` and not confirmed as a mismatch.
Grain: assessor × window. Reported against the peer median, never against 100 %.

### 13.4 Habit measures

| Habit | Definition | Config |
|---|---|---|
| Central tendency | share of an assessor's valid grades that are 3 or 4 | `habits.central_grades` |
| Halo | share of that assessor's records on which **every** graded competency carries the identical grade, over records with at least `halo.min_competencies_graded` (default 6) competencies graded | `habits.halo` |
| Drift | OLS slope of that assessor's residuals per `trend.slope_interval_days` (default 90) | `habits.drift` |
| Not-observed excess | `max(actual_not_observed_rate - expected_not_observed_rate, 0)` | `habits.not_observed` |
| Template reuse | maximum Jaccard similarity of `template_reuse.shingle`-word shingles (default 3) between an assessor's remarks, flagged at `template_reuse.jaccard` | `habits.template_reuse` |
| Signature lag | **not computable** where no signature timestamp is captured | emitted `null` |

Two of these carry rules that must not be softened:

- **Never use a raw not-observed rate.** `av_assessor_nr_baseline` holds the expected rate per
  `(template_code, asset_class)`; only the excess over that expectation counts. Some session types
  are entirely not-required by design, so a raw rate penalises an assessor for the roster they were
  given — which is exactly the bias the module exists to remove.
- **Signature lag is emitted as `null` with a "not captured" note, never as a fabricated zero.**
  A zero here reads as instant signing, which is the opposite of the truth.

Central tendency is close to universal in most populations and is readable **only** against the peer
median; presenting it as an absolute is noise.

### 13.5 ASI — the assessor standardisation index

A 0–100 score: base 100, less six deductions, **rescaled over the terms that could actually fire**.

| Term | Max points | Scale to 0–1 | Config |
|---|---|---|---|
| Adjusted leniency | 15 | `min( abs(delta) / leniency.scale_full, 1 )`, `scale_full` 0.5 | `standardisation_index.terms.leniency` |
| Grade spread (sigma) | 20 | **two-sided**, see below | `...terms.spread` |
| Justification | 25 | `1 - justification_rate` | `...terms.justification` |
| Halo | 15 | `min( halo_rate / halo.scale_full, 1 )`, `scale_full` 0.5 | `...terms.halo` |
| Drift | 15 | `min( abs(drift) / drift.scale_full, 1 )`, `scale_full` 0.3 | `...terms.drift` |
| Not-observed excess | 10 | `min( excess / not_observed.scale_full, 1 )`, `scale_full` 0.35 | `...terms.not_observed` |

**Two-sided spread.** The spread term penalises both directions:

```
sigma = sample sd of the assessor's valid grades
excess  = max( sigma - spread.sigma_floor, 0 )   / spread.sigma_floor    -- floor default 0.60
deficit = max( spread.sigma_min - sigma, 0 )     / spread.sigma_min      -- min   default 0.35
spread_scaled = min( max( excess, deficit ), 1 )
```

A one-sided term scores perfect non-discrimination identically to good calibration. An assessor who
awarded the same grade to every competency on every record has a sigma of zero and, under a
one-sided term, loses nothing — and lands comfortably green. Both tails are a standardisation
problem.

**Rescaling over available terms.**

```
available_points = Σ( term.points  for each term whose inputs exist )
deductions       = Σ( term.points * term.scaled  for those same terms )
ASI              = 100 * ( 1 - deductions / available_points )
```

A term is **unavailable** when its input cannot exist: no below-standard grades awarded means no
justification rate; no record with enough competencies graded means no halo rate; too few residuals
means no drift slope. Unavailable terms are shown as `n/a` in the breakdown and **excluded from the
denominator**.

**An unmeasurable term must never act as free credit.** Without rescaling, an assessor who never
awards a low grade and never grades a full set carries a large block of points that cannot be lost,
and scores green on the terms they avoided rather than the terms they passed. With rescaling the
same assessor is scored on the evidence that exists — and typically lands in a very different band.

**Bands.**

| Band | Rule |
|---|---|
| green | `ASI >= standardisation_index.bands.green_min` (default 75) |
| amber | `ASI >= standardisation_index.bands.amber_min` (default 50) |
| red | below that |
| not banded | `provisional` — records < `adjusted_delta.min_records_banded` |

**Caps, applied after the score and independently of it.** A cap is a ceiling on the band, and every
cap is displayed with its reason:

| Cap | Ceiling |
|---|---|
| an open confirmed `masking` alert | amber |
| the assessor's own SCI band is RED (as a subject) | amber |
| halo ineligible — no records with enough competencies graded, despite sufficient record count | amber |
| **two or more caps active** | red |

The ASI breakdown is rendered as a full deduction list headed "why not green": every term, its
scaled value, its points lost, the terms that were `n/a`, the available-points denominator, and the
active caps. A single score with no breakdown is not defensible in a standardisation conversation.

### 13.6 Assessor status

Derived, never stored, and **nobody is hidden**.

| Status | Rule |
|---|---|
| `former` | login deactivated (`users.is_active = false`) |
| `dormant` | no grading in `assessor_fairness.status.dormant_after_days` (default 365) |
| `current` | otherwise |

Orthogonal data-hygiene tags — `unregistered` (grades exist, no `users` row), `role_missing` — are
**tags, not exclusions**.

- **Do not filter the roster by instructor role.** In a real population a substantial share of the
  people who award grades hold no formal instructor role, and they own a substantial share of the
  corpus. Filtering by role silently deletes part of the picture.
- **Status is a display filter only.** Grades from dormant and former assessors stay in the peer
  mean *and* in every current assessor's expected-grade calculation. Removing them changes every
  other assessor's number.

### 13.7 Benchmark definitions must be stated on the surface

Two different peer groups are legitimate and both are used:

| Surface | Peer group |
|---|---|
| the comparison grid | all assessors **including** self — it is a grid, and excluding self makes each row's baseline different |
| the individual drill-down | all assessors **excluding** self — an audit-defensible comparison |

This is a defensible distinction only if it is written on both surfaces. Unlabelled, it is a bug
report waiting to happen.

---

## 14. Cohort comparison statistics

Subject versus a constructed peer group, over either element grades or competency grades.

| Statistic | Definition |
|---|---|
| mean, `n` | per side, over valid grades |
| difference | `mean_subject - mean_group` |
| Welch 95 % CI | `diff ± ci_z * sqrt( s1²/n1 + s2²/n2 )`, Welch–Satterthwaite degrees of freedom |
| significance pill | `significant` / `not significant` / **`insufficient`** when either side has `n < comparison.min_n_per_side` (default 8) |
| percentile | the subject's mean's rank within the distribution of group members' means |
| effect size | Cohen's *d* with pooled sd |
| trend | subject mean and group mean per `comparison.trend_period` (default quarter) |
| per-competency delta | one difference per `competency_id`, with `n` on both sides |
| low-grade concentration | elements or competencies ranked by frequency of grades at or below `below_standard_max` |

**"Insufficient" is not "not significant".** Reporting a small sample as "no significant difference"
asserts an absence that was never tested. The pill has three states for that reason.

**Group construction.** Default group is same-position peers within the same asset class and a
seniority window (`comparison.seniority_windows`: all, ±2, ±5, ±10 years of `people.joined_on`).
When a position filter is applied the candidate group **widens** to all matching peers and **both
sides are then filtered to that position**. Position is read **per record**, from the record
snapshot, so a subject's history in a different seat is isolated from their current-seat history.
`group.size` reports the number of people actually compared, not the number matched.

**Early-warning signals** exposed alongside the comparison, each defined in `lib/analytics`:
exponentially-weighted moving-average direction, consecutive-below run length, and CUSUM drift
against the subject's own baseline. They are described in the help panel in the same words as here.

---

## 15. Program and cohort metrics

| Metric | Definition | Grain |
|---|---|---|
| `n` | valid grade events, attempt-expanded | cohort × competency × period |
| `below_n` | events at or below `below_standard_max` | as above |
| below-standard rate | `below_n / n` | as above |
| `mean` | mean of **attempt** grades | as above; not comparable across the attempt-expansion change |
| `elements_attempted` | distinct elements, `attempt = 1` only | cohort |
| `repeat_n` | elements with any `attempt > 1`, counted once | cohort |
| `repeat_rate` | `repeat_n / elements_attempted` | cohort — meaningful only because both sides are instance-based |
| outcome mix | PASS / PARTIAL_PASS / FAIL counts and rates; PARTIAL_PASS never folded into either neighbour | cohort |
| grade-band trend | share of grades in each band 1–5 per period | cohort × competency × period |
| behaviour drivers | `observable_behaviour_id` selection counts, windowed current / previous / previous 3 / all | cohort × competency |
| contribution by position | below-standard and above-standard counts split by position held on the record | cohort × position |
| summary panel | the **worst `program_summary.top_n` and best `program_summary.top_n`** competencies by the latest period's below-standard rate, requiring `n >= program_summary.min_n` (default 30), each with its top `program_summary.driving_behaviours` OBs and their selection counts | cohort |

Rules on the summary panel:

- It is **always** worst-N and best-N. A competency appearing under "address" does not by itself mean
  it is out of tolerance, and the panel says so. A threshold-gated version ("show competencies above
  X %") renders an empty panel on a good period, which reads as "nothing to see" rather than "nothing
  exceeded the threshold".
- A competency never appears in both lists. With fewer than `2 * top_n` competencies meeting
  `min_n`, the lists shrink rather than overlap.

**Distinct counts are not additive across periods.** `count(DISTINCT subject_id)` for a period cannot
be recovered by summing the unpartitioned view. A period-filtered distinct count needs its own view,
grouped at the period grain. This is the reason `av_period_subject_counts` exists separately.

---

## 16. Grain, and the indices that must never be reconciled

| Metric | One row / one value is | Base |
|---|---|---|
| BSR | one period × competency × scope | none |
| ACR | one period × scope | none |
| PLI | one period × metric × grain × scope, plus a status | a **fixed calendar base window**, pooled |
| RCC | one calendar period × competency, in counts | a **fixed estimation sample of events** |
| SCI | one **subject × competency** | the subject's own recent window, recency-weighted |
| Concern | one subject | no base |
| ASI | one assessor | the peer group's expected grades |
| Currency | one person × qualification type | no base |
| Cohort comparison | one subject against one constructed group | the group |

**The PLI and the SCI must never be reconciled.**

They are the two indices most likely to be put side by side, because both produce a red/amber/green
band and both are ultimately built from the same grades. They answer different questions on
different grains against different baselines:

| | PLI | SCI |
|---|---|---|
| Grain | the programme, per period | one subject, per competency |
| Base | a frozen calendar window, pooled across everyone | that subject's own last few events |
| Weighting | none — every event counts once | recency-weighted, asymmetric points, assessor-adjusted |
| Critical grades | counted like any other below-standard grade | removed from the arithmetic entirely and handled as a flag |
| Purpose | governance and audit: is the programme's rate moving | screening: where should a manager look next |

A sentence of the form "the programme is amber but only *n* subjects are red, so the indicator is
wrong" is a category error. Neither number is derivable from the other, and any surface that places
them adjacent must label them as separate instruments.

The RCC is a third independent index with a third independent base and is subject to the same rule.
Three indices, three bases, deliberately not reconciled.

---

## 17. Where every threshold is configured

Nothing in this table appears as a literal in any `.ts`, `.tsx` or `.sql` file.

| Config path (`scaffold/config/analytics.yaml`) | Governs |
|---|---|
| `grade_scale.*` | valid-grade pattern, the **one** definition of below standard, meets-standard, critical grade, non-scoring codes |
| `rate_display.*` | display denominator, unit string and axis label, **per metric** |
| `suppression.*` | `min_n_rate`, summary minimum n, comparison minimum n per side |
| `program_indicator.*` | scopes, period lengths, base windows, base period counts, alert sigmas, target type and value, run-rule lengths, rebase policy, overdispersion and sd caveat ratios |
| `control_chart.*` | rolling window events, estimation sample, limit offsets, forecast periods, display denominator |
| `screening_index.*` | window, minimum grades, half-life, points per grade, critical grade handling, clean-run length and minimum grade, leniency minimum sample / reduced weight / clamps, band boundaries, trend threshold, excluded template codes |
| `concern.*` | band triggers, lookback |
| `flagged_record.*` | flag triggers |
| `assessor_fairness.expected.*` | half-life, window rank, minimum grades, fallback order |
| `assessor_fairness.adjusted_delta.*` | `k_shrink`, CI z, outlier threshold, minimum records to band |
| `assessor_fairness.spread.*` | `sigma_floor`, `sigma_min` |
| `assessor_fairness.justification.*` | grade max, minimum words, never-penalise grade, sample percentage, model-required flag |
| `assessor_fairness.habits.*` | halo minimum competencies and scale, drift scale, not-observed scale and excess flag, template-reuse shingle and threshold |
| `assessor_fairness.standardisation_index.*` | term points, term scales, band boundaries, cap rules, rescale flag |
| `assessor_fairness.status.*` | `dormant_after_days` |
| `comparison.*` | minimum n per side, CI z, effect size, trend period, seniority windows, multiple-comparison method and divisor |
| `coverage.*` | match method, coverage targets |
| `trend.*` | flat band, minimum points, slope interval |
| `currency.*` | default warning days, due-soon days, planned handling, compliant statuses |
| `program_summary.*` | top N, minimum n, driving-behaviour count |
| `qual_types` rows (database) | per-type validity months, warning days, grace days, early-renewal days, dependencies |

Loading path: `analytics.yaml` -> `scripts/load-analytics-config.mjs` -> `analytics_config` table
-> `analytics_num()` / `analytics_int()` / `analytics_text()` in SQL, and -> the injected
`AnalyticsConfig` object in TypeScript. Both layers read the **same** version, and the version is
printed on every governance surface.

---

## 18. Traps

Each trap is: what happens, why it happens, what to do instead. All of them also appear in
`docs/16_TRAPS.md`.

1. **A duplicate row inflates numerator and denominator equally, so the rate stays plausible.**
   A join that fans out silently doubles counts while the percentage barely moves, so no rate check
   detects it. *Instead:* assert on a **structural** quantity. `base_periods` must equal the
   configured period count on every row; row counts must match a pre-taken baseline. A rate
   assertion cannot catch join fan-out; a period-count assertion catches it immediately.

2. **Two `× N` display denominators are not the same exposure.** Labelling a grade-denominated rate
   and a record-denominated rate with the same unit string overstates one of them by roughly the
   number of competencies per record. *Instead:* the formatter takes the metric and returns unit,
   label and denominator together; the two series never share an axis.

3. **Last-attempt grading hides first-attempt failures.** An element graded 2 then 4 reads as
   meeting standard. *Instead:* expand attempts; every attempt is a grade event. Then flag the
   change as a break in series — means shift down and below-standard counts rise, and figures
   either side are not comparable.

4. **A grade of 1 averages away.** Any index that converts grades to points and takes a mean lets
   later good grades cancel a critical failure. *Instead:* remove critical grades from the
   arithmetic and handle them as a flag with an explicit recovery run.

5. **An unmeasurable term acts as free credit.** A composite score that deducts from a fixed base
   rewards the assessor who never generated the evidence a term needs. *Instead:* rescale over
   available points and render unavailable terms as `n/a`.

6. **A one-sided spread term scores non-discrimination as excellence.** *Instead:* penalise both
   tails, against `sigma_floor` and `sigma_min`.

7. **A raw not-observed rate penalises a roster, not an assessor.** Some session types are entirely
   not-required by design. *Instead:* measure excess over an expected rate per
   `(template_code, asset_class)`.

8. **Comparing an assessor to the fleet mean measures their roster.** *Instead:* compare against
   what the same subjects scored in the same competencies with other assessors, then shrink toward
   zero by `n / (n + k)` and mark low-volume assessors provisional.

9. **A suppressed period continuing a run turns absence of evidence into evidence.** *Instead:* a
   suppressed period breaks the run.

10. **An auto-recomputed base makes improvement invisible.** The yardstick moves with the thing it
    measures. *Instead:* freeze the base; rebasing is a config edit recorded in `config_versions`.

11. **A small estimation sample produces degenerate control limits.** At low rates, a short sample
    yields either a zero base (permanently alerting) or an inflated base (never alerting).
    *Instead:* size the sample so the expected count in it is well into double digits, and keep it
    configurable.

12. **The estimation sample and the display denominator get conflated when they share a number.**
    *Instead:* choose different values on purpose and label them in different sentences.

13. **Two data homes for one measurement.** Records arriving by import and records created in-app
    live in the same table with different `source` values; a view that filters to one reports zeros
    for the other and disagrees with the roster. *Instead:* every "all data" aggregate reads all
    sources, and any deliberate restriction is named in the view comment.

14. **Two surfaces deriving the same concept from two sources will disagree.** *Instead:* one
    function, one endpoint, every surface reads it.

15. **A distinct count is not additive across periods.** *Instead:* a period-grained view of its own.

16. **Grouping by a label that carries a version number ranks fragments.** Item numbers embedded in
    element names get renumbered between template versions, so one real element is stored under
    several names. *Instead:* group on `element_key`, which is stable and author-assigned. Where a
    normalisation of legacy names is unavoidable, prove **zero collisions within any single record**
    before applying it.

17. **Bucketing by the subject's current org unit or asset class rewrites history.** A reassigned
    subject's old grades follow them to the new unit. *Instead:* bucket by the record's dimensions
    at session time, falling back to the template's, and only then to the person's current values.

18. **Uncorrected multiple comparisons manufacture findings.** Testing one hypothesis per competency
    at alpha 0.05 produces a false positive most of the time across a framework of nine.
    *Instead:* Bonferroni-correct by the active competency count, read from the framework table.

19. **A drill-down that recomputes its own totals drifts from the chart above it.** *Instead:* the
    drill-down reads the same view the chart reads, holds exactly the same capability — no wider —
    and its header labels every number it shows, because a grade count and a record count in the
    same sentence will otherwise be read as one over the other.

20. **Deduplication chosen silently corrupts the distribution.** Where imports have produced
    duplicate `(record_id, element_key, attempt)` rows, some with conflicting grades, there is no
    obviously correct survivor. *Instead:* report the duplicate count as a data-quality metric and
    refuse to dedupe until a rule is chosen and written down.

21. **A model producing a figure.** Any number a language model emits is a token sequence that
    resembles a number. *Instead:* the deterministic core computes every figure; narration is
    validated against the computed figure set before it is stored, and a narrative figure that does
    not appear in that set fails the record.
