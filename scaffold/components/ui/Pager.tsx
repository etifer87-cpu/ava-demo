import Link from 'next/link';

/**
 * Pager - page navigation and page size as links. Server component, no state: the page and the
 * size live in the URL (`page`, `size`), the query does LIMIT/OFFSET, and this renders the links.
 */
export const PAGE_SIZES = [20, 60, 100] as const;

export function pageParams(sp: Record<string, string | string[] | undefined>, fallback: number = PAGE_SIZES[0]): { page: number; size: number } {
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');
  const size = (PAGE_SIZES as readonly number[]).includes(Number(one(sp.size))) ? Number(one(sp.size)) : fallback;
  const page = Math.max(1, Number.parseInt(one(sp.page), 10) || 1);
  return { page, size };
}

export function Pager({ path, params, page, size, total, noun = 'rows' }: { readonly path: string; readonly params: Readonly<Record<string, string>>; readonly page: number; readonly size: number; readonly total: number; readonly noun?: string }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const href = (p: number, s: number = size) => { const u = new URLSearchParams(params); u.set('page', String(p)); u.set('size', String(s)); return `${path}?${u}`; };
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  // A window of page numbers around the current one, with first and last always present.
  const numbers = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((p) => p >= 1 && p <= pages))].sort((a, b) => a - b);
  return (
    <nav className="pager" aria-label="Pages" data-testid="pager">
      <span className="small muted">{from}–{to} of {total} {noun}</span>
      <span className="spacer" />
      <span className="row" style={{ gap: 'var(--space-1)', alignItems: 'center' }}>
        <span className="xs muted">Show</span>
        {PAGE_SIZES.map((s) => s === size ? <span key={s} className="pager-size is-current" aria-current="true">{s}</span> : <Link key={s} href={href(1, s)} className="pager-size">{s}</Link>)}
      </span>
      <span className="row" style={{ gap: 'var(--space-1)', alignItems: 'center' }}>
        {page > 1 ? <Link href={href(page - 1)} className="button button-quiet xs" aria-label="Previous page">‹ Prev</Link> : <span className="button button-quiet xs" aria-disabled="true" style={{ opacity: 0.4 }}>‹ Prev</span>}
        {numbers.map((p, i) => (
          <span key={p} className="row" style={{ gap: 'var(--space-1)' }}>
            {i > 0 && numbers[i - 1]! < p - 1 ? <span className="xs muted">…</span> : null}
            {p === page ? <span className="pager-page is-current" aria-current="page">{p}</span> : <Link href={href(p)} className="pager-page">{p}</Link>}
          </span>
        ))}
        {page < pages ? <Link href={href(page + 1)} className="button button-quiet xs" aria-label="Next page">Next ›</Link> : <span className="button button-quiet xs" aria-disabled="true" style={{ opacity: 0.4 }}>Next ›</span>}
      </span>
    </nav>
  );
}

export default Pager;
