'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * LiveSearch - a text filter that applies while typing.
 *
 * Sits inside the GET FilterBar as the `q` field, so Apply and bookmarks still work exactly as
 * before; what it adds is that every pause in typing (250 ms) rewrites the URL with the new `q`
 * (and page 1) and lets the server re-render the list from SQL. The filtering stays in SQL and the
 * view stays a URL; nothing is filtered in the browser.
 */
export function LiveSearch({ name = 'q', label, value, placeholder }: { readonly name?: string; readonly label: string; readonly value: string; readonly placeholder?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(value);

  useEffect(() => { setText(value); last.current = value; }, [value]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const push = (q: string) => {
    if (q === last.current) return;
    last.current = q;
    const next = new URLSearchParams(params.toString());
    if (q) next.set(name, q); else next.delete(name);
    next.delete('page');
    router.replace(`${pathname}${next.toString() ? `?${next}` : ''}`, { scroll: false });
  };

  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{label}</label>
      <input
        id={`f-${name}`} name={name} value={text} placeholder={placeholder} autoComplete="off"
        onChange={(e) => { const q = e.target.value; setText(q); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => push(q.trim()), 250); }}
      />
    </div>
  );
}

export default LiveSearch;
