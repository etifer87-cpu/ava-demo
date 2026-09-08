import type { ReactNode } from 'react';

/**
 * Chip - a small labelled state.
 *
 * THE RULE THIS COMPONENT EXISTS TO ENFORCE: colour never carries meaning alone. The chip renders
 * the WORD in every case; the tone only tints the word and its border. A viewer with a colour
 * vision deficiency, a monochrome print of a report, and a screen reader all receive the same
 * information as a viewer looking at the screen.
 */
export type ChipTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export interface ChipProps {
  readonly children: ReactNode;
  readonly tone?: ChipTone;
  /** Extra context for assistive technology, e.g. "concern level". */
  readonly srPrefix?: string;
  readonly title?: string;
}

export function Chip({ children, tone = 'neutral', srPrefix, title }: ChipProps) {
  const cls = tone === 'neutral' ? 'chip' : `chip chip-${tone}`;
  return (
    <span className={cls} title={title}>
      {srPrefix ? <span className="sr-only">{srPrefix}: </span> : null}
      <span className="chip-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export default Chip;
