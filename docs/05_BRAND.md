# 05 · Brand — Avianca identity on the platform

Measured 2026-09-08 from avianca.com (computed CSS variables) and from the supplied logo file.
Everything below is applied through `scaffold/config/brand.yaml` only (`kit-docs/13`). No component,
chart or report carries a literal.

## Assets

| Asset | Path in repo | Source |
|---|---|---|
| Logo, colour on light | `scaffold/public/brand/avianca-logo.png` (lowercase wordmark + bird, red on transparent) | `Media/Logo/ava_logo.png` (replaced the earlier `avianca_logo_png.png` on 2026-09-08) |
| Logo, vector | `Media/Logo/avianca-logo.ai` (not shipped; export SVG for the header if needed) | supplied |
| Logo, on dark | derive a white version from the .ai for the dark header / PDF footer | to do |

## Typography

| Role | Value |
|---|---|
| Family | **Red Hat Display**, weights 300–900 (their site loads exactly this) |
| Fallback | `system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif` |
| Body sizes on their site | 17 / 19 / 22 px — large; the platform uses its own scale, family only |
| Licence | Red Hat Display is SIL Open Font License → self-host the woff2 in `scaffold/public/fonts/`; never load from a third-party CDN in the demo |

## Colour

| Token (brand.yaml) | Hex | Where they use it | Use on the platform |
|---|---|---|---|
| `brand.primary` | `#1B1B1B` | buttons, borders, logo variable | header, primary buttons, focus rings |
| `brand.accent` | `#DA291C` | the logo (sampled), links on red | logo, one accent per screen (active nav, primary CTA on light), never body text |
| `brand.accent_dark` | `#C20000` | negative icons | hover on accent, negative state |
| `text.primary` | `#131313` | body text | body |
| `text.secondary` | `#5A5A5A` | secondary text | captions, table meta |
| `surface.page` | `#FFFFFF` | page | page |
| `surface.raised` | `#F8F8F8` | light sections | cards, table headers |
| `surface.muted` | `#FAFAFA` | card accents | zebra rows |
| `border` | `#D9D9D9` | disabled / borders | borders, disabled |
| `state.positive` | `#1EA93C` | positive | pass / valid |
| `state.warning` | `#EF5B06` | warning | expiring / monitor |
| `state.negative` | `#C20000` | negative | expired / priority |
| `state.info` | `#0190A0` | secondary links (teal) | informational chips |
| `link` | `#3B63FB` | links | in-text links |

Contrast checked (WCAG AA): `#1B1B1B`/white 17.4:1 · `#131313`/white 18.1:1 · `#5A5A5A`/white 6.9:1 ·
`#DA291C`/white 4.9:1 (AA for body, use for large text and accents) · `#EF5B06`/white 3.4:1 (large
text and indicators only — pair with a dark label for body) · `#1EA93C`/white 3.0:1 (indicator only).
`contrastRatio()` in the kit is the checker; the pairs in `kit-docs/13` §7 must pass before publish.

## Look

Their site is white, high-contrast, near-black type, generous radius (pill buttons, 24 px cards),
red used sparingly (logo, one accent). The platform matches that: white pages, `#1B1B1B` header
with the white logo, red only on the active item and the primary action, no gradients.

Competency colours are data (`competencies.colour`), not brand, and stay at the kit defaults.

## Identity strings (`brand.yaml` §1)

| Key | Value |
|---|---|
| `product.name` | `Avianca Training Management System` |
| `product.short_name` | `Avianca TMS` |
| `product.tagline` | `Powered by Corvanox` |
| Report footer | `Avianca TMS · demo instance · synthetic data` |

Use of the Avianca name and logo is for this demonstration to Avianca only. Do not reuse the brand
configuration in any other instance.
