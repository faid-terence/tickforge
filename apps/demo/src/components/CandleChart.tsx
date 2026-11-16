import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { ChartCandle } from "../lib/candles";
import {
  formatChange,
  formatClock,
  formatCompact,
  formatMinute,
  formatPrice,
  niceTicks,
} from "../lib/format";

export interface CandleChartProps {
  candles: readonly ChartCandle[];
  /** Last traded price, drawn as a reference line. */
  lastPrice?: number | undefined;
  /** Shown when there are no candles yet. */
  emptyMessage?: string;
}

const PAD = { top: 16, bottom: 24, left: 4 };
/** Horizontal room per candle; fewer candles are shown on narrow screens. */
const MIN_STEP = 9;
const MAX_BODY = 12;
/** Fewer candles than this are not stretched wider than this many slots. */
const MIN_SLOTS = 30;
/** Vertical room the last-price tag (20px tall) needs around its centre line. */
const TAG_CLEARANCE = 16;
/** Approximate advance of an 11px tabular digit, used to size the price gutter. */
const CHAR_PX = 6.8;

/** Tracks an element's width, so the SVG is drawn at real pixels (crisp hairlines). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width] as const;
}

const direction = (c: ChartCandle) => (c.close >= c.open ? "up" : "down");

/**
 * 1-minute candlestick chart. Plain SVG: about 60 marks need no charting
 * library, and the colours come from CSS variables, so light and dark mode
 * each use their own validated steps.
 *
 * Up/down is a polarity encoding: blue/red (colour-blind safe), never
 * green/red, and every readout also carries ▲/▼ so colour is never alone.
 */
export const CandleChart = memo(function CandleChart({
  candles,
  lastPrice,
  emptyMessage = "Waiting for the first trade…",
}: CandleChartProps) {
  const [containerRef, width] = useWidth<HTMLDivElement>();
  const height = Math.round(Math.min(320, Math.max(220, width * 0.55)));
  const [active, setActive] = useState<number | undefined>();

  const layout = useMemo(() => {
    if (candles.length === 0 || width === 0) return undefined;
    // The price gutter fits the widest label, so tags are never clipped.
    const widest = Math.max(
      ...candles.map((c) => formatPrice(c.high).length),
      lastPrice === undefined ? 0 : formatPrice(lastPrice).length,
    );
    const right = Math.ceil(widest * CHAR_PX) + 18;
    const plotW = Math.max(0, width - PAD.left - right);
    const plotH = height - PAD.top - PAD.bottom;
    const fit = Math.max(10, Math.floor(plotW / MIN_STEP));
    const visible = candles.slice(-fit);
    // Spread the candles over the width, but don't make a few candles huge.
    const capacity = Math.min(fit, Math.max(visible.length, MIN_SLOTS));
    if (plotW <= 0) return undefined;

    let lo = Math.min(...visible.map((c) => c.low));
    let hi = Math.max(...visible.map((c) => c.high));
    if (lastPrice !== undefined) {
      lo = Math.min(lo, lastPrice);
      hi = Math.max(hi, lastPrice);
    }
    const span = hi - lo || hi * 0.001 || 1;
    lo -= span * 0.08;
    hi += span * 0.08;

    const step = plotW / capacity;
    // Right-align: the newest candle sits at the right edge, as on any trading chart.
    const offset = capacity - visible.length;
    const x = (i: number) => PAD.left + (offset + i + 0.5) * step;
    const y = (price: number) => PAD.top + ((hi - price) / (hi - lo)) * plotH;
    const body = Math.max(3, Math.min(MAX_BODY, step * 0.65));
    const ticks = niceTicks(lo, hi, plotH < 200 ? 3 : 4).filter((t) => t >= lo && t <= hi);
    const timeLabels = visible
      .map((c, i) => ({ i, t: c.openTime }))
      .filter(({ t }) => new Date(t).getMinutes() % (step < 12 ? 15 : 10) === 0);
    return { visible, step, x, y, body, ticks, timeLabels, plotW, plotH, right };
  }, [candles, lastPrice, width, height]);

  // Keep a selection on the same candle index from the right as new ones arrive.
  const visibleCount = layout?.visible.length ?? 0;
  const activeIndex = active !== undefined && active < visibleCount ? active : undefined;
  const activeCandle = activeIndex !== undefined ? layout?.visible[activeIndex] : undefined;

  function indexAt(clientX: number, svg: SVGSVGElement): number | undefined {
    if (!layout) return undefined;
    const rect = svg.getBoundingClientRect();
    const px = clientX - rect.left;
    let best: number | undefined;
    let bestDist = Infinity;
    layout.visible.forEach((_, i) => {
      const d = Math.abs(layout.x(i) - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  function onPointer(event: PointerEvent<SVGSVGElement>) {
    setActive(indexAt(event.clientX, event.currentTarget));
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (visibleCount === 0) return;
    const last = visibleCount - 1;
    if (event.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? last + 1) - 1));
    else if (event.key === "ArrowRight") setActive((a) => Math.min(last, (a ?? last - 1) + 1));
    else if (event.key === "Escape") setActive(undefined);
    else return;
    event.preventDefault();
  }

  const latest = candles.at(-1);
  const summary = latest
    ? `1-minute candles, ${String(candles.length)} minutes. Latest ${formatMinute(latest.openTime)}: close ${formatPrice(latest.close)}.`
    : "1-minute candle chart, no data yet.";

  return (
    <div className="chart">
      <div className="chart__plot" ref={containerRef}>
        {!layout ? (
          <div className="chart__empty" style={{ height }}>
            {emptyMessage}
          </div>
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse") setActive(undefined);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              setActive(undefined);
            }}
          >
            {layout.ticks.map((t) => (
              <g key={t}>
                <line
                  className="chart__grid"
                  x1={PAD.left}
                  x2={PAD.left + layout.plotW}
                  y1={Math.round(layout.y(t)) + 0.5}
                  y2={Math.round(layout.y(t)) + 0.5}
                />
                {/* The last-price tag wins; a tick label it would cover is hidden. */}
                {(lastPrice === undefined ||
                  Math.abs(layout.y(t) - layout.y(lastPrice)) > TAG_CLEARANCE) && (
                  <text
                    className="chart__tick"
                    x={width - layout.right + 8}
                    y={layout.y(t)}
                    dy="0.32em"
                  >
                    {formatPrice(t)}
                  </text>
                )}
              </g>
            ))}
            {layout.timeLabels.map(({ i, t }) => (
              <text
                key={t}
                className="chart__tick"
                x={layout.x(i)}
                y={height - 6}
                textAnchor="middle"
              >
                {formatMinute(t)}
              </text>
            ))}

            {activeIndex !== undefined && (
              <line
                className="chart__crosshair"
                x1={Math.round(layout.x(activeIndex)) + 0.5}
                x2={Math.round(layout.x(activeIndex)) + 0.5}
                y1={PAD.top}
                y2={PAD.top + layout.plotH}
              />
            )}

            {layout.visible.map((c, i) => {
              const cx = Math.round(layout.x(i)) + 0.5;
              const top = layout.y(Math.max(c.open, c.close));
              const bottom = layout.y(Math.min(c.open, c.close));
              const forming = c.source === "live" && !c.closed;
              return (
                <g
                  key={c.openTime}
                  className={`candle candle--${direction(c)}${forming ? " candle--forming" : ""}${
                    activeIndex !== undefined && activeIndex !== i ? " candle--dim" : ""
                  }`}
                >
                  <line x1={cx} x2={cx} y1={layout.y(c.high)} y2={layout.y(c.low)} />
                  <rect
                    x={cx - layout.body / 2}
                    y={top}
                    width={layout.body}
                    height={Math.max(1, bottom - top)}
                    rx={1.5}
                  />
                </g>
              );
            })}

            {lastPrice !== undefined && (
              <g className="chart__last">
                <line
                  x1={PAD.left}
                  x2={width - layout.right + 2}
                  y1={Math.round(layout.y(lastPrice)) + 0.5}
                  y2={Math.round(layout.y(lastPrice)) + 0.5}
                />
                <rect
                  x={width - layout.right + 2}
                  y={layout.y(lastPrice) - 10}
                  width={layout.right - 4}
                  height={20}
                  rx={4}
                />
                <text x={width - layout.right + 8} y={layout.y(lastPrice)} dy="0.32em">
                  {formatPrice(lastPrice)}
                </text>
              </g>
            )}

            {(() => {
              const i = layout.visible.length - 1;
              const c = layout.visible[i];
              if (!c || c.source !== "live" || c.closed) return null;
              return (
                <circle
                  className="chart__pulse"
                  cx={Math.round(layout.x(i)) + 0.5}
                  cy={layout.y(c.close)}
                  r={4}
                />
              );
            })()}
          </svg>
        )}

        {layout && activeCandle && activeIndex !== undefined && (
          <CandleTooltip candle={activeCandle} left={layout.x(activeIndex)} width={width} />
        )}
      </div>

      <div className="chart__legend" aria-hidden="true">
        <span>
          <i className="swatch swatch--up" /> Close ≥ open
        </span>
        <span>
          <i className="swatch swatch--down" /> Close &lt; open
        </span>
        <span>
          <i className="swatch swatch--live" /> Forming now
        </span>
      </div>

      <CandleTable candles={candles} />
    </div>
  );
});

function CandleTooltip({
  candle,
  left,
  width,
}: {
  candle: ChartCandle;
  left: number;
  width: number;
}) {
  const change = (candle.close - candle.open) / candle.open;
  const onRight = left < width / 2;
  const status =
    candle.source === "history"
      ? "History (Coinbase REST)"
      : candle.closed
        ? "Closed, built by tickforge"
        : "Forming, built by tickforge";
  return (
    <div
      className="tooltip"
      role="status"
      style={onRight ? { left: left + 12 } : { right: width - left + 12 }}
    >
      <div className="tooltip__value">{formatPrice(candle.close)}</div>
      <div className="tooltip__muted">
        {formatMinute(candle.openTime)} · {formatChange(change)}
      </div>
      <dl>
        <dt>Open</dt>
        <dd>{formatPrice(candle.open)}</dd>
        <dt>High</dt>
        <dd>{formatPrice(candle.high)}</dd>
        <dt>Low</dt>
        <dd>{formatPrice(candle.low)}</dd>
        <dt>Volume</dt>
        <dd>{formatCompact(candle.volume)}</dd>
        {candle.source === "live" && (
          <>
            <dt>Trades</dt>
            <dd>{candle.trades}</dd>
          </>
        )}
      </dl>
      <div className="tooltip__muted">{status}</div>
      {candle.partial && <div className="tooltip__muted">Partial: streaming began mid-minute</div>}
    </div>
  );
}

/** The accessible, no-hover way to read every value. */
function CandleTable({ candles }: { candles: readonly ChartCandle[] }) {
  const rows = candles.slice(-10).reverse();
  return (
    <details className="chart__table">
      <summary>Show the last 10 candles as a table</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Minute</th>
            <th scope="col">Open</th>
            <th scope="col">High</th>
            <th scope="col">Low</th>
            <th scope="col">Close</th>
            <th scope="col">Change</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.openTime}>
              <td>{formatClock(c.openTime).slice(0, 5)}</td>
              <td>{formatPrice(c.open)}</td>
              <td>{formatPrice(c.high)}</td>
              <td>{formatPrice(c.low)}</td>
              <td>{formatPrice(c.close)}</td>
              <td>{formatChange((c.close - c.open) / c.open)}</td>
              <td>{c.source === "history" ? "REST" : c.closed ? "live" : "forming"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
