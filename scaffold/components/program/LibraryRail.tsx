import { LIBRARY_KINDS, type LibraryRow } from '@/lib/program/library';

/**
 * LibraryRail - the left pane of the builder. Server component.
 *
 * Collapsible groups, one per library kind, each row with a Place button that posts to the
 * elements route with the currently selected section as the parent. With no section selected
 * the buttons are not drawn; the text says why. "+ New" at the foot opens the create form, which
 * is how a malfunction is added by hand until the reference ingestion lands.
 */
export interface LibraryRailProps {
  readonly rows: readonly LibraryRow[];
  readonly q: string;
  readonly templateId: string;
  readonly versionId: string | null;
  /** The section a placed element lands in, or null when nothing placeable is selected. */
  readonly targetKey: string | null;
  readonly targetTitle: string | null;
  readonly canPlace: boolean;
  readonly canCreate: boolean;
  readonly fleets: readonly { value: string; label: string }[];
  /** The page path without query, for the GET search form. */
  readonly basePath: string;
  /** Query parameters the search must keep (version, sel), rendered as hidden inputs: a GET form drops its action's query string. */
  readonly carry: Readonly<Record<string, string | undefined>>;
  /** The page path with query, for the library create form's return. */
  readonly currentPath: string;
  readonly highlight: string | null;
}

export function LibraryRail({ rows, q, templateId, versionId, targetKey, targetTitle, canPlace, canCreate, fleets, basePath, carry, currentPath, highlight }: LibraryRailProps) {
  const groups = LIBRARY_KINDS.map((k) => ({ ...k, rows: rows.filter((r) => r.kind === k.tag) })).filter((g) => g.rows.length > 0 || q === '');
  const untagged = rows.filter((r) => !r.kind);
  return (
    <aside className="rail" data-testid="library-rail" aria-label="Library">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h2 className="card-title" style={{ margin: 0 }}>Library</h2>
        <span className="spacer" />
        <span className="xs muted">{rows.length}</span>
      </div>
      <form method="get" action={basePath} className="row" style={{ gap: 'var(--space-2)' }}>
        {Object.entries(carry).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '').map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <input name="lib" defaultValue={q} placeholder="Search the library" aria-label="Search the library" style={{ flex: 1 }} />
        <button className="button button-quiet xs" type="submit">Find</button>
      </form>
      <p className="xs muted" style={{ margin: 0 }}>
        {targetKey ? <>Placing into <strong>{targetTitle ?? targetKey}</strong>.</> : 'Select a section in the program to place into it.'}
      </p>

      {groups.map((g) => (
        <details key={g.tag} className="collapse rail-group" open={g.rows.length > 0 && (q !== '' || (g.placeable && g.rows.length <= 40))}>
          <summary>{g.label} <span className="xs muted">{g.rows.length}</span></summary>
          {g.rows.length === 0 ? <p className="xs muted" style={{ margin: 'var(--space-1) 0 0' }}>Nothing here yet.</p> : (
            <ul className="rail-list">
              {g.rows.map((r) => (
                <li key={r.id} className={`rail-item${highlight === r.code ? ' is-highlight' : ''}`} title={r.summary ?? r.code}>
                  <span className="rail-item-title">{r.title}</span>
                  {r.fleet ? <span className="xs muted">{r.fleet}</span> : null}
                  {g.placeable && canPlace && targetKey && versionId ? (
                    <form method="post" action={`/api/templates/${templateId}/elements`} style={{ display: 'inline' }}>
                      <input type="hidden" name="_action" value="add_library" />
                      <input type="hidden" name="version" value={versionId} />
                      <input type="hidden" name="parent" value={targetKey} />
                      <input type="hidden" name="code" value={r.code} />
                      <button className="button button-quiet xs" type="submit" title={`Place "${r.title}" into ${targetTitle ?? targetKey}`}>Place</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </details>
      ))}
      {untagged.length ? (
        <details className="collapse rail-group"><summary>Untagged <span className="xs muted">{untagged.length}</span></summary>
          <ul className="rail-list">{untagged.map((r) => <li key={r.id} className="rail-item"><span className="rail-item-title">{r.title}</span><span className="xs muted mono">{r.element_type}</span></li>)}</ul>
        </details>
      ) : null}

      {canCreate ? (
        <details className="collapse rail-group" open={rows.length === 0}>
          <summary>+ New library element</summary>
          <form method="post" action="/api/library" className="stack" style={{ marginTop: 'var(--space-2)', gap: 'var(--space-2)' }} data-testid="library-new-form">
            <input type="hidden" name="_action" value="create" />
            <input type="hidden" name="return" value={currentPath} />
            <div className="field"><label htmlFor="lib-kind">Kind *</label>
              <select id="lib-kind" name="kind" required defaultValue="malfunction">{LIBRARY_KINDS.map((k) => <option key={k.tag} value={k.tag}>{k.label}</option>)}</select>
            </div>
            <div className="field"><label htmlFor="lib-title">Title *</label><input id="lib-title" name="title" required minLength={2} maxLength={200} placeholder="e.g. A/THR channel 1 fault" /></div>
            <div className="field"><label htmlFor="lib-fleet">Fleet</label>
              <select id="lib-fleet" name="fleet" defaultValue=""><option value="">Every fleet</option>{fleets.map((f) => <option key={f.value} value={f.value}>{f.value}</option>)}</select>
            </div>
            <div className="field"><label htmlFor="lib-text">Detail</label><textarea id="lib-text" name="text" rows={3} maxLength={2000} placeholder="Malfunction: the IOS name and the trigger. Weather: the METAR line. ATC: the phrase." /></div>
            <div className="field"><label htmlFor="lib-summary">Summary</label><input id="lib-summary" name="summary" maxLength={300} placeholder="One line, shown in the rail" /></div>
            <div className="field"><label htmlFor="lib-code">Code</label><input id="lib-code" name="code" maxLength={63} className="mono" pattern="[a-z0-9][a-z0-9_.-]{0,62}" placeholder="left empty: made from kind and title" /></div>
            <div><button className="button xs" type="submit">Add to library</button></div>
          </form>
        </details>
      ) : null}
    </aside>
  );
}

export default LibraryRail;
