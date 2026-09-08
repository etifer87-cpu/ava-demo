import Link from 'next/link';

/**
 * Breadcrumbs - where the caller is, and the way back.
 *
 * The last crumb is the current page and is NOT a link. A trail whose last item is clickable
 * teaches people that the trail lies.
 */
export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

export function Breadcrumbs({ items }: { readonly items: readonly Crumb[] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} aria-current={last ? 'page' : undefined}>
              {c.href && !last ? <Link href={c.href}>{c.label}</Link> : c.label}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumbs;
