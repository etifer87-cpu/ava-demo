/**
 * GradeChip - a grade as the operator's colour with the numeral on it. One component, so the record
 * pop-up, the grading screen and anything added later cannot drift apart.
 *
 * IT READS NO CONFIG, ON PURPOSE. lib/config.ts already emits --grade-1 .. --grade-5 from
 * brand.yaml onto :root, with a comment saying it exists so a CLIENT component can colour a grade.
 * This is that component: half its callers are client components that cannot import server-only
 * config, and passing a palette down through every one of them would be a prop threaded through the
 * whole record tree for a colour the stylesheet already knows.
 *
 * THE NUMERAL IS ALWAYS PRINTED. The palette is an ordered 1-5 ramp whose adjacent steps are close
 * by design, so colour is never the only thing carrying the value - on screen, in greyscale, or to a
 * colour-blind reader. brand.yaml says the same where the palette is declared.
 *
 * A NON-SCORING CODE IS NOT A GRADE and gets no colour. NR, NO and NA are an ABSENCE of a grade, not
 * a low one, and a swatch would put them on the same scale as a 2. The test is structural rather
 * than a list of codes - a grade is digits, a code is not, which is the same line grade_num() draws
 * in SQL - so an operator who adds a code does not have to come back here.
 */
import type React from 'react';

export function GradeChip({
  value, title,
}: {
  readonly value: string | number | null | undefined;
  readonly title?: string;
}) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  const key = String(value).trim();
  if (!/^\d+$/.test(key)) return <span className="ccode xs muted" title={title}>{key}</span>;
  /* Both custom properties, together: the fill AND the ink that is readable on it. Setting only the
     fill is how a numeral ends up at 1.40:1 on a pale grade. The cast is because React's CSS types
     do not know about custom properties. */
  const style = {
    background: `var(--grade-${key}, var(--ink-muted))`,
    ['--grade-ink' as string]: `var(--grade-${key}-ink, #FFFFFF)`,
  } as React.CSSProperties;
  return <span className="grade-chip" style={style} title={title}>{key}</span>;
}

export default GradeChip;
