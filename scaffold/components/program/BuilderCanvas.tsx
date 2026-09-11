'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type LiHTMLAttributes, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { PALETTE_ITEMS, type CanvasNode, type PaletteKind, type PresetItem } from './canvas-types';

/**
 * BuilderCanvas - the palette and the program canvas. Client component: drag-and-drop and inline
 * rename need the pointer and a text field; nothing else here is state that outlives a gesture.
 *
 * WHAT IT DOES NOT OWN. The tree is the server's: every drop, move and rename is one POST to the
 * elements route (JSON), then `router.refresh()` re-renders this page from the database. There is
 * no client copy of the program that can drift from what is stored. While a request is in flight
 * the affected element is dimmed; if it fails, the reason is shown inline and the tree comes back
 * as it was. Selection is the URL (`?sel=`), set with `router.replace` so the inspector - a server
 * component - renders for the element just placed.
 *
 * Placement rules are enforced on the server (lib/program/write.ts checkPlacement). The canvas
 * only refuses the obviously wrong drops early so the cursor says no before the request does.
 */

type Payload = { source: 'palette'; kind: PaletteKind } | { source: 'preset'; code: string } | { source: 'node'; key: string; kind: CanvasNode['kind'] };

const MIME = 'application/x-ava-element';

export interface BuilderCanvasProps {
  readonly templateId: string;
  readonly versionId: string;
  readonly roots: readonly CanvasNode[];
  readonly presets: readonly PresetItem[];
  readonly selected: string | null;
  readonly editable: boolean;
  /** The page path, and the query parameters to keep when the selection changes (version, lib). */
  readonly basePath: string;
  readonly carry: Readonly<Record<string, string>>;
}

function canDrop(p: Payload, parentKind: 'root' | 'section'): boolean {
  const kind = p.source === 'palette' ? p.kind : p.source === 'preset' ? 'preset' : p.kind;
  if (kind === 'section') return parentKind === 'root';
  if (kind === 'preset') return true;                       // a block preset at the root, an exercise inside; the server decides
  if (kind === 'note') return true;
  return parentKind === 'section';
}

export function BuilderCanvas({ templateId, versionId, roots, presets, selected, editable, basePath, carry }: BuilderCanvasProps) {
  const selectHref = useCallback((key: string | null) => {
    const u = new URLSearchParams(carry);
    if (key) u.set('sel', key); else u.delete('sel');
    const q = u.toString();
    return q ? `${basePath}?${q}` : basePath;
  }, [basePath, carry]);
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Payload | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const post = useCallback(async (body: Record<string, unknown>, busy: string | null = null): Promise<string | null> => {
    setBusyKey(busy ?? '*');
    setError(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/elements`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ version: versionId, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; key?: string | null; message?: string };
      if (!res.ok || !data.ok) { setError(data.message ?? `The change was not made (${res.status}).`); return null; }
      return data.key ?? null;
    } catch {
      setError('The change was not saved: the server could not be reached.');
      return null;
    } finally {
      setBusyKey(null);
    }
  }, [templateId, versionId]);

  const refreshTo = useCallback((key: string | null) => {
    router.replace(selectHref(key), { scroll: false });
    router.refresh();
  }, [router, selectHref]);

  // ---- drops --------------------------------------------------------------
  const onDrop = useCallback(async (e: DragEvent, parent: string | null, index: number) => {
    e.preventDefault();
    setOver(null);
    const raw = e.dataTransfer.getData(MIME);
    setDragging(null);
    if (!raw || !editable) return;
    let p: Payload;
    try { p = JSON.parse(raw) as Payload; } catch { return; }
    if (!canDrop(p, parent === null ? 'root' : 'section')) { setError(p.source === 'palette' && p.kind === 'section' ? 'A section lives at the top level.' : 'Drop this inside a section.'); return; }
    let key: string | null = null;
    if (p.source === 'palette') key = await post({ _action: 'add', kind: p.kind, parent: parent ?? '', index });
    else if (p.source === 'preset') key = await post({ _action: 'add_library', code: p.code, parent: parent ?? '', index });
    else key = await post({ _action: 'place', key: p.key, parent: parent ?? '', index }, p.key);
    if (key) refreshTo(key);
  }, [editable, post, refreshTo]);

  const dragStart = (p: Payload) => (e: DragEvent) => {
    if (!editable) { e.preventDefault(); return; }
    e.dataTransfer.setData(MIME, JSON.stringify(p));
    e.dataTransfer.effectAllowed = p.source === 'node' ? 'move' : 'copy';
    setDragging(p);
  };
  const dragEnd = () => { setDragging(null); setOver(null); };

  const gapProps = (parent: string | null, index: number, parentKind: 'root' | 'section'): LiHTMLAttributes<HTMLLIElement> & { 'data-drop': string } => {
    const id = `${parent ?? ''}#${index}`;
    const allowed = dragging ? canDrop(dragging, parentKind) : true;
    return {
      'data-drop': id,
      className: `drop-gap${over === id ? ' is-over' : ''}${dragging && !allowed ? ' is-refused' : ''}${dragging ? ' is-live' : ''}`,
      onDragOver: (e: DragEvent) => { if (!dragging || !allowed) return; e.preventDefault(); e.dataTransfer.dropEffect = dragging.source === 'node' ? 'move' : 'copy'; if (over !== id) setOver(id); },
      onDragLeave: () => { if (over === id) setOver(null); },
      onDrop: (e: DragEvent) => { void onDrop(e, parent, index); },
    };
  };

  // ---- palette Add button (keyboard / touch) --------------------------------
  const addViaButton = async (kind: PaletteKind) => {
    // Into the selected section (or the selected element's section); sections and notes at the root when nothing fits.
    const sel = selected ? find(roots, selected) : null;
    const section = sel ? (sel.kind === 'section' ? sel : sel.parentKey ? find(roots, sel.parentKey) : null) : null;
    const parent = kind === 'section' ? null : section ? section.key : (kind === 'note' ? null : null);
    if (kind !== 'section' && kind !== 'note' && !parent) { setError('Select a section first, then add.'); return; }
    const key = await post({ _action: 'add', kind, parent: parent ?? '', index: null });
    if (key) refreshTo(key);
  };
  const addPresetViaButton = async (code: string, kind: PresetItem['kind']) => {
    const sel = selected ? find(roots, selected) : null;
    const section = sel ? (sel.kind === 'section' ? sel : sel.parentKey ? find(roots, sel.parentKey) : null) : null;
    const parent = kind === 'block' ? null : section?.key ?? null;
    if (kind === 'exercise' && !parent) { setError('Select a section first, then add the exercise.'); return; }
    const key = await post({ _action: 'add_library', code, parent: parent ?? '', index: null });
    if (key) refreshTo(key);
  };

  // ---- rename -------------------------------------------------------------
  const rename = async (key: string, title: string) => {
    const k = await post({ _action: 'rename', key, title }, key);
    if (k) router.refresh();
  };

  useEffect(() => { if (error) { const t = setTimeout(() => setError(null), 8000); return () => clearTimeout(t); } return undefined; }, [error]);

  return (
    <div className="builder-main" data-testid="builder-canvas">
      <aside className="rail palette" aria-label="Palette" data-testid="palette">
        <h2 className="card-title" style={{ margin: 0 }}>Add</h2>
        <p className="xs muted" style={{ margin: 0 }}>{editable ? 'Drag into the program, or select a section and press Add.' : 'This version is not a draft; nothing can be added.'}</p>
        <ul className="palette-list">
          {PALETTE_ITEMS.map((item) => (
            <li key={item.kind} className={`palette-item palette-${item.kind}`} draggable={editable} onDragStart={dragStart({ source: 'palette', kind: item.kind })} onDragEnd={dragEnd} title={item.hint}>
              <span className="palette-grip" aria-hidden="true">⋮⋮</span>
              <span className="palette-label">{item.label}</span>
              {editable ? <button type="button" className="button button-quiet xs" onClick={() => void addViaButton(item.kind)} aria-label={`Add ${item.label}`}>Add</button> : null}
            </li>
          ))}
        </ul>
        {presets.length ? (
          <details className="collapse">
            <summary>Presets <span className="xs muted">{presets.length}</span></summary>
            <ul className="palette-list">
              {presets.map((p) => (
                <li key={p.code} className={`palette-item palette-preset-${p.kind}`} draggable={editable} onDragStart={dragStart({ source: 'preset', code: p.code })} onDragEnd={dragEnd} title={p.summary ?? p.code}>
                  <span className="palette-grip" aria-hidden="true">⋮⋮</span>
                  <span className="palette-label">{p.title}<span className="xs muted"> · {p.kind}</span></span>
                  {editable ? <button type="button" className="button button-quiet xs" onClick={() => void addPresetViaButton(p.code, p.kind)} aria-label={`Add ${p.title}`}>Add</button> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </aside>

      <section className="canvas" aria-label="Program" data-testid="program-outline" aria-busy={busyKey !== null}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h2 className="card-title" style={{ margin: 0 }}>Program</h2>
          <span className="spacer" />
          {busyKey ? <span className="xs muted">saving…</span> : null}
          {selected ? <a href={selectHref(null)} className="xs" onClick={(e) => { e.preventDefault(); refreshTo(null); }}>Clear selection</a> : null}
        </div>
        {error ? <div className="notice notice-bad" role="alert"><p style={{ margin: 0 }}>{error}</p></div> : null}
        <ol className={`outline${dragging ? ' is-dragging' : ''}`}>
          <li {...gapProps(null, 0, 'root')} />
          {roots.length === 0 && !dragging ? <li className="xs muted" style={{ padding: 'var(--space-2)' }}>Nothing yet. Drag a Section here to start, or press Add beside it.</li> : null}
          {roots.map((n, i) => (
            <Node key={n.key} node={n} index={i} selected={selected} editable={editable} busyKey={busyKey} dragging={dragging}
              dragStart={dragStart} dragEnd={dragEnd} gapProps={gapProps} onSelect={(k) => router.replace(selectHref(k), { scroll: false })} onRename={rename} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function find(nodes: readonly CanvasNode[], key: string): CanvasNode | null {
  for (const n of nodes) { if (n.key === key) return n; const c = find(n.children, key); if (c) return c; }
  return null;
}

interface NodeProps {
  node: CanvasNode; index: number; selected: string | null; editable: boolean; busyKey: string | null; dragging: Payload | null;
  dragStart: (p: Payload) => (e: DragEvent) => void; dragEnd: () => void;
  gapProps: (parent: string | null, index: number, parentKind: 'root' | 'section') => LiHTMLAttributes<HTMLLIElement> & { 'data-drop': string };
  onSelect: (key: string) => void; onRename: (key: string, title: string) => Promise<void>;
}

function Node({ node, index, selected, editable, busyKey, dragging, dragStart, dragEnd, gapProps, onSelect, onRename }: NodeProps) {
  const isSel = node.key === selected;
  const busy = busyKey === node.key || busyKey === '*';
  const common = {
    draggable: editable,
    onDragStart: dragStart({ source: 'node', key: node.key, kind: node.kind }),
    onDragEnd: dragEnd,
    'data-key': node.key,
    onClick: (e: MouseEvent<HTMLLIElement>) => { if ((e.target as HTMLElement).closest('input,button,a')) return; onSelect(node.key); },
  };
  if (node.kind === 'section') {
    return (
      <>
        <li className={`outline-section${isSel ? ' is-selected' : ''}${busy ? ' is-busy' : ''}`} style={node.phaseColour ? { borderLeftColor: node.phaseColour } : undefined} data-phase={node.phase ?? undefined} {...common}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            {editable ? <span className="grip" aria-hidden="true">⋮⋮</span> : null}
            <Title node={node} editable={editable} onRename={onRename} className="outline-title" />
            {node.phaseLabel ? <span className="xs muted">{node.phaseLabel}</span> : null}
            {node.trainingOnly ? <span className="xs muted">training only</span> : null}
            {node.badges.map((b) => <span key={b} className="xs muted">{b}</span>)}
            <span className="spacer" />
            <span className="mono xs">{node.minutes ?? '-'}</span>
          </div>
          <ol className="outline" style={{ marginTop: 'var(--space-2)' }}>
            <li {...gapProps(node.key, 0, 'section')} />
            {node.children.length === 0 && !dragging ? <li className="xs muted" style={{ padding: '0 var(--space-2)' }}>Empty. Drop an exercise, a set-up, a malfunction, an event or a note here.</li> : null}
            {node.children.map((c, i) => (
              <Node key={c.key} node={c} index={i} selected={selected} editable={editable} busyKey={busyKey} dragging={dragging} dragStart={dragStart} dragEnd={dragEnd} gapProps={gapProps} onSelect={onSelect} onRename={onRename} />
            ))}
          </ol>
        </li>
        <li {...gapProps(node.parentKey, index + 1, node.parentKey === null ? 'root' : 'section')} />
      </>
    );
  }
  return (
    <>
      <li className={`outline-item outline-${node.kind}${isSel ? ' is-selected' : ''}${busy ? ' is-busy' : ''}`} {...common}>
        {editable ? <span className="grip" aria-hidden="true">⋮⋮</span> : null}
        <span className="mono xs muted outline-kind">{node.kind}</span>
        <Title node={node} editable={editable} onRename={onRename} className="" />
        {node.badges.map((b) => <span key={b} className="xs muted">{b}</span>)}
        <span className="spacer" />
        <span className="mono xs">{node.minutes ?? ''}</span>
      </li>
      <li {...gapProps(node.parentKey, index + 1, node.parentKey === null ? 'root' : 'section')} />
    </>
  );
}

/** Click to edit; Enter or blur saves; Escape cancels. The key never changes. */
function Title({ node, editable, onRename, className }: { node: CanvasNode; editable: boolean; onRename: (key: string, title: string) => Promise<void>; className: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(node.title);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { setValue(node.title); }, [node.title]);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);
  if (!editable) return <span className={className}>{node.title || node.key}</span>;
  if (!editing) {
    return <button type="button" className={`title-button ${className}`} onClick={(e) => { e.stopPropagation(); setEditing(true); }} title="Click to rename">{node.title || node.key}</button>;
  }
  const commit = async () => { setEditing(false); const t = value.trim(); if (t.length >= 2 && t !== node.title) await onRename(node.key, t); else setValue(node.title); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } if (e.key === 'Escape') { setValue(node.title); setEditing(false); } };
  return <input ref={ref} className={`title-input ${className}`} value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => void commit()} onKeyDown={onKey} onClick={(e) => e.stopPropagation()} maxLength={200} aria-label="Title" />;
}

export default BuilderCanvas;
