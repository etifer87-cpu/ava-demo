/**
 * KpiTile.tsx - docs/07_VISUALISATION.md §5.5 chart 18, §5.8 chart 38.
 *
 * A tile READS a value. It never computes one: a tile that recomputes will
 * eventually disagree with the chart above it, and the disagreement is invisible
 * until someone checks.
 *
 * The unit always travels with the number, because the two headline rates have
 * different denominators and a shared unit string overstates one of them.
 *
 * Rendered as SVG rather than HTML so the same component can be spliced into the
 * report document, which receives no stylesheet.
 *
 * NO HOOKS. The SVG element ids come from the required `id` prop through
 * chartId(), not from React's id hook, so this is a genuine server component and
 * its markup is byte-identical on the server, in the browser and in the PDF.
 */

import type { ChartTokens } from './chart-tokens';
import { chartId } from './chart-tokens';

export type TileState = 'value' | 'suppressed' | 'insufficient' | 'not_captured' | 'not_applicable';

export interface KpiTileProps {
  /**
   * Required. Namespaces this tile's SVG element ids. A row of tiles passes one value per
   * tile - the metric key is the natural choice.
   */
  readonly id: string;
  readonly caption: string;
  /** Pre-formatted by lib/analytics/display.ts. The tile does no arithmetic. */
  readonly value: string | null;
  readonly unit?: string | null;
  readonly state?: TileState;
  /** Band colour plus the band WORD; colour never carries the state alone. */
  readonly band?: 'green' | 'amber' | 'red' | 'neutral' | null;
  readonly bandLabel?: string | null;
  /** e.g. "MAY 26 (selected)" or "(latest)". */
  readonly context?: string | null;
  /** e.g. the peer median, printed under the value. */
  readonly reference?: string | null;
  readonly tokens: ChartTokens;
  readonly width?: number;
  readonly height?: number;
}

const STATE_TEXT: Record<Exclude<TileState, 'value'>, string> = {
  suppressed: 'n too low',
  insufficient: 'insufficient',
  not_captured: 'not captured',
  not_applicable: 'n/a',
};

export function KpiTile({
  id,
  caption,
  value,
  unit = null,
  state = 'value',
  band = null,
  bandLabel = null,
  context = null,
  reference = null,
  tokens,
  width = 220,
  height = 104,
}: KpiTileProps) {
  const uid = chartId(id);
  const bandColour = band ? tokens.bands[band] : tokens.surface.ink;
  const showValue = state === 'value' && value !== null;
  const stateText = state === 'value' ? null : STATE_TEXT[state as Exclude<TileState, 'value'>];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-labelledby={`${uid}-title`}
      style={{ display: 'block', maxWidth: '100%', background: tokens.surface.bg }}
      fontFamily={tokens.fontStack}
    >
      <title id={`${uid}-title`}>
        {`${caption}: ${showValue ? `${value}${unit ? ` ${unit}` : ''}` : stateText}`}
      </title>

      <rect
        x={0.5} y={0.5} width={width - 1} height={height - 1}
        rx={6} fill="none" stroke={tokens.surface.border}
      />

      <text x={12} y={20} fontSize={10} fill={tokens.surface.inkMuted}>
        {caption}
      </text>

      {showValue ? (
        <>
          <text x={12} y={54} fontSize={28} fill={bandColour}>
            {value}
          </text>
          {unit && (
            <text x={12} y={70} fontSize={9} fill={tokens.surface.inkMuted}>
              {unit}
            </text>
          )}
        </>
      ) : (
        // An unmeasured tile says so. It never renders 0: a zero here reads as
        // "measured, and nothing found", which is a different claim entirely.
        <text x={12} y={54} fontSize={16} fill={tokens.surface.inkMuted}>
          {stateText}
        </text>
      )}

      {bandLabel && (
        <g>
          <rect
            x={width - 12 - bandLabel.length * 7 - 10} y={10}
            width={bandLabel.length * 7 + 10} height={17} rx={8}
            fill={bandColour} opacity={0.14}
          />
          <text
            x={width - 17} y={22}
            fontSize={9} fill={bandColour} textAnchor="end"
          >
            {bandLabel}
          </text>
        </g>
      )}

      {context && (
        <text x={12} y={height - 22} fontSize={9} fill={tokens.surface.inkMuted}>
          {context}
        </text>
      )}
      {reference && (
        <text x={12} y={height - 9} fontSize={9} fill={tokens.surface.inkMuted}>
          {reference}
        </text>
      )}
    </svg>
  );
}

export default KpiTile;
