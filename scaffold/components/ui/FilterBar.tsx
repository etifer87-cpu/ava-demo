import type { ReactNode } from 'react';

/**
 * FilterBar - filters as a plain GET form. No client component, no state, no JavaScript.
 *
 * WHY IT IS A GET FORM: every filtered view is then a URL. It can be bookmarked, pasted into a
 * ticket, opened by an auditor a year later, and fetched by scripts/smoke-screens.mjs. A filter
 * held in client state produces a screen that nobody else can reach, and a support conversation
 * that starts "which filters did you have set?".
 *
 * The FILTERING ITSELF HAPPENS IN SQL. This component only puts values into the query string; a
 * page that fetches every row and filters in the render is a page that will page-cap silently.
 */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterBarProps {
  /** The route the form submits to; usually the current path. */
  readonly action: string;
  readonly children: ReactNode;
  /** Rendered as hidden inputs so an unrelated parameter survives a filter submit. */
  readonly carry?: Readonly<Record<string, string | undefined>>;
  readonly resetHref?: string;
}

export function FilterBar({ action, children, carry, resetHref }: FilterBarProps) {
  return (
    <form className="filters" method="get" action={action} data-testid="filter-bar">
      {carry
        ? Object.entries(carry)
            .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
            .map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)
        : null}
      {children}
      <div className="field">
        <span className="sr-only">Apply the filters above</span>
        <button className="button" type="submit">Apply</button>
      </div>
      {resetHref ? (
        <div className="field">
          <a className="button button-quiet" href={resetHref} style={{ textDecoration: 'none' }}>
            Reset
          </a>
        </div>
      ) : null}
    </form>
  );
}

/**
 * WHY THESE CONTROLS CARRY A `key` OF THEIR OWN VALUE.
 *
 * They are uncontrolled - `defaultValue`, so the browser owns the value and typing is not a round
 * trip. React only reads `defaultValue` when it CREATES the node. On a client-side navigation to the
 * same route with different search params - which is what every counter, chip and status tab on these
 * screens is - React re-renders the same element and reuses the same DOM node, so the select keeps
 * whatever it was showing before and silently disagrees with the URL. Pressing Apply then submits the
 * stale value and throws the filter away.
 *
 * Keying on the value forces a new node whenever the URL value changes, which is the only moment the
 * control should be reset. Do not "simplify" this by removing the key, and do not fix it by making
 * these controlled - that would need a client component and would break typing.
 */

/** A labelled text input. The label is a real <label>, not a placeholder. */
export function TextFilter({
  name,
  label,
  value,
  placeholder,
}: {
  readonly name: string;
  readonly label: string;
  readonly value?: string;
  readonly placeholder?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{label}</label>
      <input key={value ?? ''} id={`f-${name}`} name={name} defaultValue={value ?? ''} placeholder={placeholder} />
    </div>
  );
}

/** A labelled select. The first option is the "no filter" option and is always present. */
export function SelectFilter({
  name,
  label,
  value,
  options,
  anyLabel = 'Any',
}: {
  readonly name: string;
  readonly label: string;
  readonly value?: string;
  readonly options: readonly SelectOption[];
  readonly anyLabel?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{label}</label>
      <select key={value ?? ''} id={`f-${name}`} name={name} defaultValue={value ?? ''}>
        <option value="">{anyLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default FilterBar;
