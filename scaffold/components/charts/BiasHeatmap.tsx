import Link from 'next/link';
import type { ResidualScale } from '@/lib/config';

export interface HeatRow {
  readonly id: string;
  readonly label: string;
  readonly sublabel?: string | null;
  readonly provisional?: boolean;
  readonly cells: Record<string, { n: number; own_mean: number | null; mean_residual: number | null }>;
}

/**
 * BiasHeatmap - docs/07_VISUALISATION.md §5.8 chart 34.
 *
 * Rows are instructors, columns competency codes. The cell PRINTS the instructor's own mean for that
 * competency and is TINTED by how far that sits from the peer mean for the same competency, with the
 * footer row carrying those peer means. Colour is never the only channel: the number is in the cell
 * and the signed difference is in its tooltip.
 *
 * LABELLED RAW, deliberately (docs/06 §13.2). The expected-grade adjustment - the comparison against
 * what the same pilots scored with other instructors - is not implemented per competency, so these
 * cells are own mean versus peer mean and carry the roster effect the adjusted delta removes. An
 * unlabelled raw number sitting beside adjusted numbers is the defect; the raw number is fine.
 *
 * Server component. The tint colours come from brand.yaml `residual_scale`, never from a literal
 * here; with no scale configured the table renders uncoloured rather than inventing a palette.
 */
export function BiasHeatmap({
  rows, competencies, scale, href,
}: {
  readonly rows: readonly HeatRow[];
  readonly competencies: readonly { id: string; code: string; name: string; group_mean: number | null }[];
  readonly scale: ResidualScale | null;
  readonly href: (id: string) => string;
}) {
  const tint = (own: number | null, peer: number | null): string | undefined => {
    if (!scale || own === null || peer === null) return undefined;
    const d = own - peer;
    const a = Math.min(Math.abs(d) / (scale.full || 0.75), 1) * 0.8;
    if (a < 0.04) return scale.neutral;
    const hex = d > 0 ? scale.lenient : scale.strict;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
  };
  const ink = (own: number | null, peer: number | null): string | undefined => {
    if (!scale || own === null || peer === null) return undefined;
    return Math.min(Math.abs(own - peer) / (scale.full || 0.75), 1) * 0.8 > 0.5 ? '#FFFFFF' : undefined;
  };

  return (
    <div className="table-wrap">
      <table className="data heatmap" data-testid="bias-heatmap">
        <caption>
          Own mean per competency, tinted by distance from the peer mean · <strong>RAW</strong>
          <span className="muted"> - not adjusted for which pilots each instructor was given; the adjusted delta is</span>
        </caption>
        <thead>
          <tr>
            <th scope="col">Instructor</th>
            {competencies.map((c) => <th key={c.id} scope="col" className="num" title={c.name}><span className="ccode">{c.code}</span></th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={competencies.length + 1} className="muted small">No instructor matched these filters.</td></tr>
          ) : rows.map((r) => (
            <tr key={r.id}>
              <th scope="row" style={{ whiteSpace: 'nowrap', fontWeight: 400 }}>
                <Link href={href(r.id)}>{r.label}</Link>
                {r.sublabel ? <span className="xs muted"> · {r.sublabel}</span> : null}
                {r.provisional ? <span className="xs muted"> · provisional</span> : null}
              </th>
              {competencies.map((c) => {
                const cell = r.cells[c.id];
                const own = cell?.own_mean ?? null;
                const d = own !== null && c.group_mean !== null ? own - c.group_mean : null;
                return (
                  <td key={c.id} className="num mono heat-cell" style={{ background: tint(own, c.group_mean), color: ink(own, c.group_mean) }}
                      title={own === null ? `${c.code}: no grade awarded` : `${c.code}: own ${own.toFixed(2)}, peer ${c.group_mean?.toFixed(2) ?? '—'}${d === null ? '' : `, ${d > 0 ? '+' : ''}${d.toFixed(2)}`} over ${cell?.n ?? 0} grades`}>
                    {own === null ? <span className="muted">—</span> : own.toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" style={{ fontWeight: 600 }}>Peer mean <span className="xs muted">all instructors</span></th>
            {competencies.map((c) => (
              <td key={c.id} className="num mono"><strong>{c.group_mean === null ? '—' : c.group_mean.toFixed(2)}</strong></td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default BiasHeatmap;
