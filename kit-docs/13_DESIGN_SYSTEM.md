# 13 · Design system

Purpose: the token system, the type and spacing scales, the colour rules and the table and form
conventions that every screen and every generated report obey.
Status: scaffolded (`scaffold/app/globals.css`, `scaffold/config/brand.yaml`, `scaffold/components/ui/`)
Version: v1.0 · 2026-08-26

Read with `docs/07_VISUALISATION.md` (chart grammar) and `docs/12_ROLES_AND_PERMISSIONS.md` (what
is rendered at all).

---

## 1. The one rule

**A colour, a size or a font is declared once, in one place, and read everywhere else.**

| Kind of value | Declared in | Reaches the screen as |
|---|---|---|
| Brand colours, fonts, radii, product name | `scaffold/config/brand.yaml` | CSS custom properties written onto `:root` by `app/layout.tsx` |
| Neutral fallbacks for the same properties | `scaffold/app/globals.css` | the `:root` block, overridden by the above |
| Competency colours, codes, names | the database (`competencies.colour`) | props, via `components/charts/chart-tokens.ts` |
| Grade colours and grade words | `brand.yaml` `grade_palette` | props, via the same token builder |
| Thresholds, bands, windows, weights | `scaffold/config/analytics.yaml` | injected config objects |

A hex literal in a component is a defect. A font name in a component is a defect. A threshold in a
component is a defect. Each of the three has a home, and the home is not the component.

## 2. Colour tokens

Defined once on bare `:root`, redefined — same names, different values — inside the dark override.
No component knows which scheme it is in, and no component defines a colour of its own.

```
--brand-primary  --brand-primary-ink  --brand-accent  --brand-accent-ink
--surface  --surface-raised  --surface-sunken
--ink  --ink-muted
--border  --border-strong
--state-good  --state-warn  --state-bad  --state-info  --state-neutral
```

The dark scheme is a `prefers-color-scheme` media query, not a class toggle: nothing in the
platform asks the viewer to choose a theme, and a stored preference is one more thing that can
disagree with the printed output.

`*-ink` tokens exist so that text drawn ON a filled surface has a declared colour rather than an
inherited one. `onColour()` in `chart-tokens.ts` does the same job inside SVG, by luminance, so an
operator's substituted colour still yields legible labels.

## 3. Type scale

Six steps, 16px base, 1.200 ratio. Nothing between the steps.

| Token | Size | Used for |
|---|---|---|
| `--text-xs` | 12px | chip text, table meta, captions under a figure. Never body copy |
| `--text-sm` | 14px | dense table cells, form labels, secondary text |
| `--text-base` | 16px | body |
| `--text-lg` | 18px | section and card headings |
| `--text-xl` | 24px | page title |
| `--text-2xl` | 32px | the single figure on a KPI tile |

Two line heights: `--leading-tight` (1.25) for headings, `--leading-normal` (1.5) for everything
else. Weight has two useful values, 400 and 600. A third weight is a decision nobody can apply
consistently across a hundred screens.

## 4. Spacing

A 4px base, seven steps: `--space-1` … `--space-7` (4, 8, 12, 16, 24, 32, 48). A gap that is not
one of these is a defect. Layout primitives, all in `globals.css`, are `.page`, `.stack`, `.row`,
`.grid` and its three column presets. A screen that needs a fourth grid preset adds it there, not
inline.

## 5. The competency palette comes from the database

`competencies.colour` is seeded from `docs/03_COMPETENCY_FRAMEWORK.md` and read at runtime.

Consequences that are the whole point:

- **Nothing hardcodes nine of anything.** Every chart derives its spoke count, its legend and its
  series list from the rows it was given. A framework with ten competencies renders a ten-spoke
  radar with no code change and no migration.
- **A rebrand is an `UPDATE`.** Changing a competency's colour is a single statement; changing its
  name is another, and nothing breaks, because nothing keys on the name — grades reference
  `competency_id`.
- **The code is the redundant channel.** Wherever a competency colour appears, its three-letter
  code appears next to it. See section 6.

The palette is checked, not assumed: a colour an operator substitutes must still reach 3:1 against
both `--surface` and `--surface-raised` in both schemes. `contrastRatio()` in `chart-tokens.ts` is
the checker; the framework seeder runs it and refuses a colour that fails.

## 6. Colour never carries meaning alone

Every place a colour encodes something, a word, a numeral or a shape encodes the same thing.

| Encoding | The redundant channel |
|---|---|
| competency series | the competency code, printed at the spoke, the bar and the legend |
| grade | the numeral, printed in or beside the mark |
| band (green/amber/red) | the band word on the tile — `Chip` renders it always |
| validity | the status word and the date, never a coloured dot alone |
| below-standard emphasis in a table | weight and the count, never a red cell fill alone |

This is not only an accessibility rule. Reports print in monochrome, get photocopied into an audit
pack, and get read on a projector that renders amber as grey.

## 7. Contrast

| Pair | Requirement |
|---|---|
| `--ink` on `--surface`, `--surface-raised`, `--surface-sunken` | 4.5:1 |
| `--ink-muted` on the same three | 4.5:1 — muted means quieter, not unreadable |
| `--brand-primary-ink` on `--brand-primary` | 4.5:1 |
| `--state-*` used as text | 4.5:1 on the surface it sits on |
| `--state-*` used as a border, dot or mark | 3:1 |
| competency colour as a mark | 3:1 on both surfaces, both schemes |
| focus ring against the adjacent background | 3:1 |

**A base style that already passes must not be overridden to express emphasis.** Emphasis is
weight, size, position, a rule or whitespace. Darkening an already-passing ink to say "this one
matters" produces two body inks that differ by a step nobody can name, and the second one is the
one that fails on the next palette change. The corollary: there is no `--ink-strong`.

## 8. Tables

One table style, in `.data`, used by `components/ui/DataTable.tsx`. Nothing else styles a table.

- A real `<caption>`, always, saying what the table holds and how many rows it has.
- `<th scope="col">` on every header cell.
- Numeric columns are right-aligned, monospaced and tabular-lining, so digits line up down the
  column. Text columns are left-aligned. There is no centre.
- Dates are ISO (`YYYY-MM-DD`) everywhere, in every table, in every export. A locale-formatted date
  in a record that crosses a border is a date read wrong.
- Sorting and filtering are server-side, expressed in the URL. Client-side sorting sorts the page
  in view and silently lies about page two.
- An empty result renders `EmptyState` with a reason, never a headed table with no rows.
- Wide tables scroll inside `.table-wrap`. The page body never scrolls sideways.

## 9. Forms

- Filters are a plain `GET` form (`components/ui/FilterBar.tsx`). Every filtered view is therefore
  a URL that can be bookmarked, pasted into a ticket and fetched by the smoke run.
- Every input has a real `<label>`. A placeholder is not a label: it disappears exactly when the
  user needs it, and it is invisible to a screen reader in some combinations.
- The submit button is a real `<button type="submit">`, so the form submits on Enter.
- Destructive actions are `POST`, never a link. Sign-out included.
- An action the caller lacks the capability for is **not rendered**. Not disabled, not greyed. A
  disabled control advertises a permission and invites a support ticket; the server re-checks
  regardless, so the disabled control buys nothing.

## 10. Applying an operator's brand

One file, no component edits:

1. Edit `scaffold/config/brand.yaml`: product name, logo path, the light and dark colour sets, the
   state colours, the grade palette, the font stacks, the radii.
2. Put the logo and any self-hosted font under `scaffold/public/`.
3. Check every pair in section 7 with `contrastRatio()`. A brand colour that fails is used as an
   accent on a surface where it passes, never as body text.
4. Restart. `lib/config.ts` caches per process, deliberately: a config that re-reads per request
   makes two figures in one report disagree.

Competency colours are not part of this: they are data, and they change with an `UPDATE`.

## 11. Traps

**A colour defined inside a media query only.** A token whose only definition is in the dark block
disappears in light mode, and the failure is a black-on-black card that nobody sees on the
developer's machine. Every token is defined on bare `:root` first and redefined in the override.

**A component reaching for a CSS custom property at render time.** The PDF renderer receives no
stylesheet. `getComputedStyle` in a chart returns an empty string there, the mark is drawn in the
default fill, and the on-screen preview and the PDF diverge in a way nobody catches until an
auditor holds the printout. Charts receive resolved colours as props; that is what
`chart-tokens.ts` is for.

**Hardcoding the competency count.** A layout that reserves nine columns, an array of nine
labels, or a nine-branch switch, all work perfectly until a framework edition adds one. The count
comes from the rows.

**Keying anything on a competency or grade NAME.** A display string is editable without a
migration precisely because nothing keys on it. The moment a stylesheet has a `.competency-com`
class or a component switches on `name === 'Communication'`, a rename becomes a code change — and
in the system this kit is distilled from, that mistake cost a fourteen-table rename.

**Expressing state with colour alone.** A red row with no word is invisible in a monochrome
printout, ambiguous to a colour-blind reader, and meaningless in a screen reader. Every state
carries its word.

**Overriding a passing base style to add emphasis.** See section 7. It produces a second ink, a
second body size or a second border weight that nobody can name a rule for, and the ad-hoc value
is the one that fails the next contrast check.

**Adding a spacing or type value between the steps.** "Just 13px here" is how a scale dies. The
next screen copies it, and within a month there are four sizes between 12 and 16.

**A filter held in client state.** It produces a screen that cannot be linked, cannot be
reproduced from a support ticket, and cannot be fetched by the smoke run. Filters live in the URL.

**A disabled control standing in for a permission check.** It tells the caller what they are
missing, it is trivially re-enabled in the browser, and it makes the server check look optional.
Do not render it.
