'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';

/** A select that rewrites one URL parameter on change; the server re-renders from SQL. */
export function AutoSubmitSelect({ name, value, options, label, resetParams = [] }: { readonly name: string; readonly value: string; readonly options: readonly { value: string; label: string }[]; readonly label: string; readonly resetParams?: readonly string[] }) {
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  return (
    <label className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
      <span className="small muted">{label}</span>
      <select value={value} onChange={(e) => { const next = new URLSearchParams(params.toString()); if (e.target.value) next.set(name, e.target.value); else next.delete(name); for (const r of resetParams) next.delete(r); router.replace(`${pathname}${next.toString() ? `?${next}` : ''}`, { scroll: false }); }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export default AutoSubmitSelect;
