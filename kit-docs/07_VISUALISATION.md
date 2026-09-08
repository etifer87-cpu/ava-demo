# 07 · Visualisation — every chart in the product

Purpose: the complete chart inventory — screen, type, encodings, series, colour rule, interactions,
filters, data source, empty state — and the rules that make a chart render identically in a browser
and inside the PDF renderer.
Status: spec + scaffolded (`scaffold/components/charts/`)
Version: v1.0 · 2026-08-26

Read `docs/06_ANALYTICS.md` first. Nothing here computes anything. A chart component receives
computed rows and draws them; if a component contains arithmetic beyond turning a value into a
coordinate, the computation is in the wrong place.

---

## 1. The charting approach

**Hand-written SVG components. No charting dependency of any kind.**

| Rule | Why |
|---|---|
| Every chart is an inline `<svg>` built from computed `path`, `rect`, `circle`, `line`, `text` and `polygon` elements | a chart library is a second rendering engine that behaves differently in a headless browser than in a user's browser, and a version bump silently changes every figure in an audited report |
| No `<canvas>` anywhere | canvas output cannot be inspected, diffed, or rendered by an HTML-to-PDF service at print resolution |
| Components are **server-renderable**: no `useEffect`, no `window`, no `document`, no `ResizeObserver`, no measurement pass, no client-only date formatting | the same component is rendered to a string by the PDF path; anything client-only produces an empty box in the PDF and nobody notices until an audit |
| Geometry comes from an explicit `viewBox` and unitless coordinates; sizing is CSS on the wrapper | one component, two output sizes, no re-layout logic |
| Interactivity is added by a thin client wrapper (`"use client"`) that renders the same pure SVG component and attaches handlers | the pure component stays importable from a server module |
| Colours are read from `chart-tokens.ts`, which reads `competencies.colour` and the grade scale from config | a rebrand or a framework edit is an `UPDATE`, not a code change |
| **Never colour alone to carry meaning** | see §3 |

**The PDF constraint.** `lib/report/render.tsx` renders the *same* chart components to an HTML
string and splices it into the report document, which is posted to the headless-Chromium
HTML-to-PDF service. Consequences, all binding:

1. No external stylesheet reaches the PDF. Every chart carries its own presentational attributes
   inline (`fill`, `stroke`, `stroke-width`, `font-size`), or via a `<style>` block the report
   template owns. A chart that depends on an app-level CSS class renders unstyled.
2. No web font is assumed. Text elements declare a font stack ending in a generic family.
3. No animation, no transition, no hover-only content. Anything only visible on hover is invisible
   in the PDF, so every hover tooltip has a static counterpart: a printed label, a table row, or a
   value inside the mark.
4. Fixed pixel geometry, not percentage widths — the PDF page has no viewport.
5. The preview on screen and the PDF are produced by **one** template module. They cannot diverge
   because there is only one of them.

---

## 2. Data flow

```
SQL view (av_*)  ->  route handler  ->  lib/analytics pure function  ->  serialisable rows
                                                                     ->  chart component (pure SVG)
                                                                     ->  browser  |  PDF renderer
```

- A chart never recomputes a displayed value. Tiles read the value from the same row the chart drew.
  A tile that recomputes is a tile that will eventually disagree with the chart above it.
- Display scaling (`× rate_display.<metric>.denominator`) happens **at render only**. Views, routes
  and the status engine stay on proportions in `[0,1]`. A single positive constant cannot reorder
  values against thresholds, so no status can flip — but only because the thresholds are never
  scaled independently of the values.
- Every chart declares its source view in its props documentation. The drill-down under a chart
  reads the **same** view, so the detail cannot drift from the mark that was clicked.

---

## 3. Colour and accessibility

**Colour never carries meaning alone.** Every encoding that uses colour carries a second channel:

| Encoding | Colour | Redundant channel |
|---|---|---|
| grade 1–5 | grade scale colour | the numeral is printed in or beside the mark |
| status green / amber / red | band colour | a text label (`GREEN`, `AT ALERT 1`, `RED`) and a distinct dot shape/ring |
| SCI band | band colour | the band word plus the score to one decimal |
| competency series | `competencies.colour` | the competency **code** (`KNO`, `FPM`, …) labels the series directly; no colour-only legend |
| above / below a reference | colour | direction arrow and a signed number |
| suppressed / insufficient | grey | the literal text `n<30` or `insufficient` |

**Tokens.** `scaffold/components/charts/chart-tokens.ts` is the only place a chart colour is
resolved. It takes the competency catalogue (id, code, colour) and the grade-scale colours from
config and returns typed accessors. A component that writes a hex literal is a defect.

**Contrast.** Every foreground colour used for text or for a 1 px stroke must reach 4.5:1 against
the surface it is drawn on; large marks and fills must reach 3:1. `chart-tokens` exports
`onColour(bg)` returning the readable ink for a filled mark, and the framework seeder rejects a
competency colour that fails the rule (`docs/13_DESIGN_SYSTEM.md`).

**Theme.** Tokens are defined for both light and dark surfaces. The PDF always renders on the light
surface — the report template sets it explicitly rather than inheriting.

**Text alternatives.** Every chart root carries `role="img"` and an `aria-label` that states what it
shows and its headline value, plus a visually-hidden data table for anything above five marks.

---

## 4. Empty and insufficient states

There are four distinct states and they render differently. Collapsing them is a defect.

| State | When | Render |
|---|---|---|
| **no data** | zero rows | the literal text `No data` centred in the plot area, axes still drawn, in the muted ink. **Never a blank box, never a zero line.** |
| **insufficient** | rows exist but below the configured minimum (`suppression.min_n_rate`, `comparison.min_n_per_side`, `screening_index.min_valid_grades`) | the mark is drawn as a hollow outline, the value replaced by `n<30` / `insufficient`, and the point excluded from any line path — the line breaks rather than bridging |
| **not captured** | the input does not exist in this deployment (for example a signature timestamp) | the tile renders `not captured` with a note; never `0` |
| **not applicable** | the term cannot fire for this row (an ASI term with no inputs) | `n/a`, excluded from any denominator |

Nulls inside a series are **skipped, not zero-filled**. A line path is built only from consecutive
valid points, and a series with fewer than two valid points draws its dots without a line.

---

## 5. Chart inventory

Every chart below is one of the components in `scaffold/components/charts/` or a composition of
them. `CompetencyRadar`, `TrendSparkline`, `GradeDistributionBar` and `KpiTile` are scaffolded;
the rest are specified here and carry a `TODO(kit):` stub referencing this section.

### 5.1 Subject profile — overview

| # | Chart | Type | Encodings / series | Colour rule | Interactions | Filters | Source view | Empty state |
|---|---|---|---|---|---|---|---|---|
| 1 | **Competency radar** | radar polygon | one spoke per **active competency in the framework** (spoke count comes from the row count — nothing is fixed to nine); radius = grade 1..5; one closed polygon per series | vertex dots take the **grade-scale** colour of the value; the polygon fill is the subject series colour at low opacity | click a spoke to open that competency; click the chart to enlarge | record selector (Average + records newest-first), session-type, period | `av_competency_grade_events` -> subject aggregate | polygon omitted, spokes and rings drawn, `No data` centred |
| 2 | **Competency profile bars** | horizontal bars, one per competency | y = competency code + name, x = grade 1..5, reference tick at meets-standard | bar fill = grade-scale colour of the value; numeral printed at the bar end | click a bar to open the competency | same as #1 | same | `No data` per row, bar omitted |
| 3 | **Headline tiles** | KPI tiles | records, grades, below-standard rate, concern level | band colour with the band word | click to drill in | none | `av_record_rollup` | `not recorded` |

### 5.2 Subject profile — competency performance

| # | Chart | Type | Encodings | Colour rule | Interactions | Source | Empty |
|---|---|---|---|---|---|---|---|
| 4 | **Per-competency trend sparkline grid** | small multiples, `TrendSparkline`, laid out in a responsive grid (3 across on desktop, 1 on narrow, **3 across fixed in the PDF**) | x = record sequence, y = grade 1..5; gridlines at each integer; line plus a low-opacity area fill closed to the baseline | line and area in the **competency's own colour**; dots in the **grade-scale** colour of the value, white halo stroke | click a card to enlarge; hover grows the dot | `av_competency_grade_events` per subject | `No data` label inside the card |
| 5 | **Enlarged trend** | line chart | x axis labelled `MMM YY`, y = 1..5 | as #4 | one-year window slider, auto-hidden when the series spans a year or less; the path is **clipped, not re-sliced**, so it stays continuous while the window moves | same | as #4 |
| 6 | **Session timeline** | strip | one marker per record on a date axis; marker shape by result | result colour + shape; flagged records carry a left rule | click a marker to open the record; a static caption row carries the same text as the hover tooltip | `av_record_dim` | `No records` |
| 7 | **Element analysis** | horizontal bars | per-element mean grade, ordered by template position | grade-scale band colour; a dark tick marks the cohort mean | `All / weakest 10 / strongest 10` toggle appears above a configurable element count | `av_element_grade_events` | `No data` |

### 5.3 Subject profile — screening card

| # | Element | Type | Detail |
|---|---|---|---|
| 8 | **Screening strip** | one row per **active competency**, always the full set | per row: competency colour dot + code + name · band pill (`RED` / `AMBER` / `STANDARD` / `ABOVE` / `INSUFFICIENT`) with the **band word printed**, never a bare colour · score to one decimal in the band ink · trend arrow · companion text (`recovery 1/3` when RED, otherwise `n since dip`) · the last `window_sessions` grade chips |
| | Chip encoding | | grade-scale fill with the numeral printed; a ring marks a leniency-adjusted grade; reduced opacity marks a reduced-weight contribution; each chip links to its record |
| | Affordances | | a help control opens the method panel; a footer note appears whenever any grade in view was adjusted or down-weighted; a data-source note lists which record types feed the index and which are excluded |
| | Empty | | a competency with no grades renders `INSUFFICIENT` and stays in the list — it is never dropped |

### 5.4 Subject versus cohort

| # | Chart | Type | Encodings | Colour rule | Interactions | Empty / insufficient |
|---|---|---|---|---|---|---|
| 9 | **Distribution pair** | two 100 % stacked bars, group above, subject below | segment width = share of grades, one segment per grade band | grade-scale colours; the peer bar is drawn at reduced emphasis (a translucent veil) so the subject bar reads as primary while the percentage labels stay legible | enlarge | fewer than `min_n_per_side` on a side: that bar is replaced by `insufficient (n=<n>)` |
| 10 | **Diverging distribution** | diverging stacked bar centred on the meets-standard boundary | below-standard mass extends left, meets-and-above right | grade-scale colours with a printed legend | help panel explains the centring, the Wilson interval and the marker | as #9 |
| 11 | **Subject-versus-peer radar** | radar, two polygons | one spoke per competency | subject in the primary ink; **peer deliberately secondary** — a neutral grey stroke, a low-opacity grey fill, and the same grey in the legend swatch | — | spoke drawn, polygon omitted |
| 12 | **Quarter trend** | dual line | x = quarter, y = mean grade; two series | subject primary, group neutral; both series labelled at their last point, no colour-only legend | compact axis shows two-digit years; the enlarged view shows full quarter labels and scrolls horizontally inside its own container | line breaks across suppressed quarters |
| 13 | **Percentile strip** | one-dimensional strip | the group's distribution of member means as ticks, the subject's position as a labelled marker | neutral ticks, primary marker | hover shows the percentile; the percentile is also printed | `insufficient` |
| 14 | **Cohort delta with confidence interval** | point plus error bar, one row per competency | x = `mean_subject - mean_group`, zero line drawn and labelled; the bar is the Welch 95 % interval | the point takes the direction colour **and** the row prints the signed delta and both `n`s; an interval crossing zero is drawn hollow | click a row to filter the records below | a row below `min_n_per_side` prints `insufficient`, no point, no bar |
| 15 | **Low-grade concentration** | ranked horizontal bars | elements or competencies by count of grades at or below the below-standard boundary | single hue, count printed at the bar end | toggle element / competency | `No below-standard grades in this window` |
| 16 | **First-attempt versus after-remedial** | paired bars | two bars per element: first attempt, after remedial | grade-scale band of each value; the delta printed between them | — | a missing side renders as an empty slot labelled `no repeats` |

Exports: CSV of the underlying rows, and a server-rendered PDF using the same components.

### 5.5 Program-level indicator

| # | Element | Type | Detail |
|---|---|---|---|
| 17 | **Indicator series** | SVG line with dots and Wilson interval whiskers | x = period (`APR 26` monthly, `Q2 26` quarterly, read from the scope's period config); y = rate **scaled to the display unit at render only**. Horizontal reference lines for `target`, `alert1`, `alert2`, `alert3`, each labelled at the right edge with its name and value. Dot fill = the period's status; the status word appears in the tooltip **and** in the tile below, so colour is never the only carrier. A suppressed period is drawn as a hollow dot at the axis with the label `n<30`, and **the line breaks across it**. |
| | Windowing | | window chips (12 / 24 / 36 / all), a range slider, a "now" control, and the printed range, e.g. `AUG 24 – JUL 26 · 24 of 115 periods`. The **full** series is fetched once and windowed client-side; panning never refetches. |
| | Zoom and pan | | y-zoom 1x–8x; when zoomed, drag pans vertically always and horizontally when the window is narrower than the series. A reset control restores the default window and auto-y. **y ticks span the visible range, not a fixed zero-to-max**, so they stay truthful when zoomed. |
| | Clipping | | **a `<clipPath>` over the plot rectangle is load-bearing.** It wraps the reference lines, the whiskers, the series path and the dots. Without it, a pan pushes the target and alert lines over the axis labels and outside the card. |
| | Pointer handling | | pointer events, not mouse events, so mouse, touch and pen take one path; `touch-action: pan-y` keeps the page scrollable on tablets; **drag state lives in a ref, not in state** — see Traps. |
| | Header | | base window, base rate, sd, the config version, and the scope's period length are printed above the chart. A chart whose baseline is not on screen cannot be audited. |
| 18 | **Metric tiles (ACR, BSR)** | KPI tiles | follow the **selected** period, labelled `MAY 26 (selected)`, reverting to `(latest)` on deselect. Values are read from the same rows the chart drew, **never recomputed**. The headline falls back to the last **complete** period and flags a partial one. Each tile prints its own unit — the two units are different (§06 4.2). |
| 19 | **Competency strip** | mini status strip, one cell per active competency | per-period below-standard rate per competency, band-coloured, with the competency code printed in each cell; a marker appears on a competency flagged by the equivalence test |
| 20 | **Drill-down table** | table | one row per below-standard grade event: subject, org unit, position, assessor, asset class, session type, date, context (template name), link to the record. Reads the **same view** as the chart and holds **exactly the same capability — no wider**. |
| | Header wording | | the header deliberately shows two different counts, each footnoted: the number of below-standard **grade events** (the row count of this table) and the number of **records affected** (what ACR is computed from). Pairing the grade count with the record-denominated rate implies a division that was never performed. |
| | No element-to-competency link | | competency grades and element grades are graded separately and share no key. There is no honest "element that caused this competency grade". The context column names the session and the row opens the full record. **Do not invent an association here.** |

### 5.6 Rolling control chart

| # | Chart | Type | Detail |
|---|---|---|---|
| 21 | **Control chart** | step/line chart | x = calendar period, y = below-standard **count** in the rolling window; horizontal `limit 1` and `limit 2` lines labelled with their values; a mean line drawn over **actual history only**, never extrapolated backwards; a forward projection of `control_chart.forecast_periods` periods drawn dashed and labelled `projection`. Counts are printed on marks that breach a limit. |

### 5.7 Program and cohort analytics

| # | Chart | Type | Detail |
|---|---|---|---|
| 22 | **Result mix** | stacked bar per cohort | PASS / PARTIAL_PASS / FAIL; partial pass always on its own segment with its own label, never folded into either neighbour |
| 23 | **Competency performance and trend by period** | bars plus overlaid line | bars = below-standard rate per competency for the latest period, line = the same competency across periods |
| 24 | **Grade-band trend** | stacked area / bars per period | share of each grade band over periods, with a competency multi-select; series labelled directly |
| 25 | **Behaviour drivers** | ranked horizontal bars | `observable_behaviour_id` selection counts with the canonical OB text as the label and the count printed; window dropdown (current / previous / previous 3 / all) |
| 26 | **Training effectiveness** | centred diverging bars | period-over-period movement per competency, zero line labelled, sign printed |
| 27 | **Cross-period competency trend** | multi-line | x = period, y = below-standard rate, one series per competency in the competency's own colour, each labelled at its last point |
| 28 | **Cohort matrix** | heatmap | rows = cohorts, columns = competencies (column headers are competency **codes**); cell = below-standard rate; **the value is printed in every cell** so the colour ramp is decoration, not the datum; a diverging ramp is centred on the cohort mean and the centre value is stated in the legend |
| 29 | **Contribution by position** | grouped bars | below-standard and above-standard counts split by the position held **on the record**; bars are clickable and filter the behaviour list beneath |
| 30 | **Summary panel** | two ranked lists | worst N and best N competencies by the latest period's below-standard rate at `n >= program_summary.min_n`, each with its top driving behaviours and selection counts, one per line. The panel states in its subtitle that it is always worst-N and best-N and that appearing in it does not by itself mean a competency is out of tolerance. |

### 5.8 Assessor standardisation

| # | Chart | Type | Detail |
|---|---|---|---|
| 31 | **Roster table** | sortable table | assessor, sessions, subjects, last active, mean grade, **adjusted delta pill with the raw delta printed small beneath**, ASI band pill **with a cap marker**, spread sigma, remark coverage, pass rate. Column filters, then sort, then pagination, composing in that order. Row opens the individual view. Provisional rows show `provisional` in place of a band. |
| 32 | **ASI histogram** | histogram | x = ASI bucket, y = count; bars band-coloured with the band names printed on the axis |
| 33 | **Adjusted-delta scatter** | scatter | x = adjusted delta with **zero centred and labelled**, y = events graded; the outlier threshold drawn as two vertical rules; provisional points drawn hollow |
| 34 | **Grading bias heatmap** | heatmap | rows = assessors, columns = competency codes; cell = own mean for that competency, cell colour = difference from the peer mean for that competency, value printed in the cell; a footer row carries the peer mean. **Labelled RAW on the surface** — the expected-grade adjustment is not applied per competency. |
| 35 | **Adjusted leniency with interval** | point plus error bar | the assessor's adjusted delta with its 95 % interval, the peer median drawn as a reference rule, the raw delta printed beneath |
| 36 | **Monthly residual strip** | sparkline strip | mean residual per month from the additive monthly rollup; months with no grading are gaps, not zeros |
| 37 | **Justification rate** | KPI plus gauge | the definition from `docs/06_ANALYTICS.md` §13.3 printed verbatim beside the number, and the peer median marked on the gauge |
| 38 | **Habit tiles** | KPI tiles | central tendency, halo, drift, not-observed excess, template reuse — each carrying the peer median; signature lag renders `not captured` |
| 39 | **ASI breakdown** | deduction list, headed "why not green" | every term with its scaled value and points lost, the terms that are `n/a`, the available-points denominator, the resulting score, and every active cap with its reason |
| 40 | **Per-competency residual** | horizontal bars | adjusted residual per competency, zero line labelled |
| 41 | **Alert queue** | grouped list plus decision modal | grouped by alert type; a decision requires a reviewer note before it can be submitted |

### 5.9 Operations dashboard

| # | Chart | Type | Source |
|---|---|---|---|
| 42 | **Header count tiles** | KPI tiles | `av_period_overall` and record counts |
| 43 | **Concern distribution** | stat pills, clickable to filter the roster | the concern endpoint — the derived rule, never a stored value |
| 44 | **Competency performance, overall and per org unit** | grouped bars, one row per unit plus an overall row | `av_period_competency` grouped in one call |
| 45 | **Behaviour performance** | ranked bars | OB selection counts matched to the catalogue |
| 46 | **Program performance** | pass/fail buckets per template | `av_record_rollup` |
| 47 | **Watch list** | list | `people.watch_list` |
| | Global control | a privileged toggle includes inactive people; included rows carry a muted `Former` badge and the toggle state is visible in the header, not only remembered | |

### 5.10 Currency and progression

| # | Chart | Type | Detail |
|---|---|---|---|
| 48 | **Currency KPI tiles** | tiles, every one drill-in | people tracked · pending approvals · due within `due_soon_days` · expired · compliance % |
| 49 | **Currency timeline** | horizontal timeline, one row per person or per qualification type | x = date axis with a **today marker**; each qualification drawn as a bar from `last_completed_on` to `valid_until`; the bar is split at the warning boundary so the warning window is visibly a different segment; expired bars extend past today in the expired ink and are hatched so the state survives greyscale printing; `PLANNED` renewals drawn as an outlined bar; `MISSING` drawn as an empty track with the label `missing`. Hovering a bar shows the dates; the dates are also printed in the row's trailing column. |
| 50 | **Compliance by org unit / position** | grouped bars | percentage with the numerator and denominator printed |
| 51 | **Expiry table** | table | status-coloured rows **with the status word in a column** |
| 52 | **Progression board** | swimlane board | card = subject, position, org unit, progress bar, counters (`10/56` sectors, `4/30` role), next milestone with date, RAG dot **plus the RAG word** |
| 53 | **Progression timeline** | Gantt rows on a month axis | today marker, status-coloured bars, click-through |

### 5.11 Report charts (server-rendered)

| # | Chart | Type | Detail |
|---|---|---|---|
| 54 | **Per-competency sparkline grid** | `TrendSparkline` in a fixed 3-across grid | identical component and identical output to #4; the grid is fixed-width because the PDF has no viewport |
| 55 | **Report radar with peer band** | radar plus a shaded band | the peer interquartile band drawn behind the subject polygon in a neutral fill, labelled in the legend |
| 56 | **Strengths and development diverging bar** | diverging bars, sorted by deviation from the subject's **own** baseline | zero line labelled `own baseline`; sign printed |
| 57 | **Moved-competency sparklines** | sparklines with a trajectory annotation | only competencies whose slope exceeds `trend.flat_band`; each annotated with the slope per interval and its `n`, so the chart states a measurement rather than the word "improving" |
| 58 | **Record timeline table** | table | flagged rows carry a wash **and** a left rule **and** a `flagged` cell, so the flag survives greyscale |

---

## 6. Component contract

Every component in `scaffold/components/charts/` obeys the same shape.

```ts
type ChartProps<Row> = {
  data: Row[];                 // already computed; the component performs no aggregation
  tokens: ChartTokens;         // colours resolved from the framework + grade scale
  width?: number;              // viewBox width, default per component
  height?: number;
  label: string;               // becomes aria-label; required, not optional
  emptyText?: string;          // default "No data"
};
```

Rules:

1. **Pure and synchronous.** No hooks at all. No fetching. No `Date.now()` — anything
   time-relative receives an `asOf` prop. A hook makes the component a client component, and a
   client component cannot render inside the PDF path, where there is no client runtime.
2. **Deterministic ids.** A required `id` prop, slugified by `chartId()` in `chart-tokens.ts`,
   namespaces every `<title>`, gradient and clip-path id, so server and client markup match byte
   for byte and two instances on one page do not collide. The caller owns the value: a per-subject
   chart passes the subject id, a small-multiple grid passes the competency id. An id derived
   inside the component - from a hook or from a counter - is a different string on every render and
   makes the browser output and the PDF output undiffable.
3. **No layout measurement.** Text is positioned from known font sizes and `text-anchor`; long
   labels are truncated by character budget, not by measuring.
4. **One numeric formatter**, injected, so the axis, the tooltip and the tile print the same string.
5. **Every value that is drawn is also available as text** — in the mark, in an adjacent label, or
   in the hidden data table.

### Geometry convention

Shared by every cartesian chart, and reproduced verbatim in the sparkline scaffold:

```ts
const padL = 22, padR = 8, padT = 8, padB = 20;
const innerW = width  - padL - padR;
const innerH = height - padT - padB;

const px = (i: number, n: number) => padL + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
const py = (g: number, lo: number, hi: number) =>
  padT + innerH - ((g - lo) / (hi - lo)) * innerH;
```

- Gridlines at each integer of the grade scale, hairline stroke in the muted border ink, with a
  small right-aligned tick label.
- The series path is built only from valid points and only drawn when at least two exist; the area
  path is the line path closed to the baseline at low opacity.
- Dots carry a white halo stroke so they stay legible over the area fill and over gridlines.
- Only the first and last category labels are drawn on a compact chart; the enlarged variant draws
  all of them.

---

## 7. Interaction rules

| Rule | Detail |
|---|---|
| **Drag state lives in a ref, not in React state** | a first implementation rendered the interactive dots conditionally on a `dragging` state value; `pointerdown` set the state, which unmounted the dot mid-press, so the click never fired and every dot appeared dead. Keep the marks mounted; record movement in a ref and consult it in the click handler. |
| **Do not call `setPointerCapture` on a mark you want clickable** | it retargets the subsequent click away from the element. |
| **Pointer events, not mouse events** | one code path for mouse, touch and pen. Set `touch-action: pan-y` so the page still scrolls on a tablet. |
| **Click-to-source everywhere** | every mark that represents records opens those records. Depth one click away is what lets a short surface feel complete. |
| **A drill-down holds the same capability as the chart above it — no wider** | and opening a record writes one audit row, fired **after** the record is confirmed to exist so that probes for records that do not exist leave no trail. |
| **Filters compose in a stated order** | filter, then sort, then paginate. Any other order produces a page of results that does not match the filter chips. |
| **Selection is reversible and visible** | clicking a selected mark deselects it and the tiles revert to `(latest)`. |
| **Enlarging never refetches** | the enlarged view renders the same rows at a different size. |

---

## 8. Layout and responsiveness

- Every chart is wrapped in a container with `overflow-x: auto`; the page body never scrolls
  horizontally.
- Grids collapse by breakpoint (3 across, 2, 1). The **PDF grid is fixed at 3** and does not consult
  a breakpoint.
- A table that cannot fit scrolls inside its own container with a sticky header row.
- Minimum touch target for an interactive mark is 24 px; where the mark itself is smaller, an
  invisible hit rectangle provides the target.

---

## 9. Traps

1. **A client-only chart renders as an empty box in the PDF.** A `useEffect` that sets state used
   for geometry, a `window.innerWidth` read, or a locale-dependent date format produces nothing in
   the headless renderer, and the failure is silent because the PDF is still produced.
   *Instead:* pure, server-renderable components; interactivity added by a thin wrapper.

2. **Missing the clip path lets a pan draw over the axis.** Reference lines and series escape the
   plot rectangle and overlap the labels and the card edge. *Instead:* a `<clipPath>` over the plot
   rect wrapping reference lines, whiskers, path and dots.

3. **Conditional rendering of interactive marks kills the click.** See §7.
   *Instead:* keep marks mounted; track movement in a ref.

4. **Scaling values without scaling thresholds corrupts every status.** Applying a display
   denominator to the plotted values while the reference lines stay on proportions turns a healthy
   series red. *Instead:* keep everything on proportions until the render step, then scale values
   and reference lines together, in one place.

5. **A tile that recomputes drifts from the chart.** *Instead:* tiles read the row the chart drew.

6. **Zero-filling a null draws a failure that never happened.** A missing grade plotted at the axis
   reads as the worst possible outcome. *Instead:* skip nulls; break the line.

7. **A blank plot area reads as "everything is fine".** *Instead:* the four explicit states in §4.

8. **Colour-only encoding fails for a colour-blind reader and for every greyscale print of the
   report.** *Instead:* a second channel on every meaningful encoding — the numeral, the band word,
   the shape, or the hatch.

9. **A hover-only tooltip is invisible in the PDF and to a keyboard user.** *Instead:* every tooltip
   has a static counterpart.

10. **A colour-only legend forces a lookup.** *Instead:* label series at their last point, or print
    the competency code in the mark.

11. **A heatmap without printed values is decoration.** A reader cannot recover a number from a
    ramp. *Instead:* print the value in the cell and state the ramp's centre in the legend.

12. **A hex literal in a component survives a rebrand and a framework edit.** *Instead:* every
    colour through `chart-tokens.ts`.

13. **A chart with its baseline off screen cannot be audited.** *Instead:* print the base window,
    base rate, sd and config version in the indicator's header.

14. **Two counts in one header sentence get read as a ratio.** *Instead:* label and footnote each
    count, and never place a grade count adjacent to a record-denominated rate without saying so.

15. **Adding a competency breaks a chart that assumed nine.** A fixed 3-by-3 grid, a nine-row strip,
    a nine-column heatmap and a nine-spoke radar all silently drop or duplicate a competency.
    *Instead:* every count derives from the framework row count; the grid wraps; the radar computes
    its spoke angles from `data.length`.
