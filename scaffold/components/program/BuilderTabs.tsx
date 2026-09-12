import Link from 'next/link';

/**
 * BuilderTabs - Builder · As instructor · Review, top right of the three program screens.
 * Server component; the active tab is the page that rendered it.
 */
export function BuilderTabs({ templateId, active, versionQuery }: { readonly templateId: string; readonly active: 'builder' | 'instructor' | 'review'; readonly versionQuery: string }) {
  const base = `/templates/${templateId}`;
  const tabs = [
    { id: 'builder', label: 'Builder', href: `${base}${versionQuery}` },
    { id: 'instructor', label: 'As instructor', href: `${base}/instructor${versionQuery}` },
    { id: 'review', label: 'Review', href: `${base}/review${versionQuery}` },
  ] as const;
  return (
    <nav className="tabbar" aria-label="Program views" data-testid="builder-tabs">
      {tabs.map((t) => <Link key={t.id} href={t.href} className={`tab${t.id === active ? ' is-active' : ''}`} aria-current={t.id === active ? 'page' : undefined}>{t.label}</Link>)}
    </nav>
  );
}

export default BuilderTabs;
