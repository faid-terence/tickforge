import { memo } from "react";
import { formatChange, formatPrice } from "../lib/format";

export interface TickerProps {
  symbol: string;
  price: number | undefined;
  /** Direction of the last price change; drives a brief flash. */
  tick: "up" | "down" | "flat";
  /** Change over `changeSpanMinutes`, as a fraction (0.01 = 1%). */
  change: number | undefined;
  changeSpanMinutes: number;
}

/** The view's single hero figure: the last traded price. */
export const Ticker = memo(function Ticker({
  symbol,
  price,
  tick,
  change,
  changeSpanMinutes,
}: TickerProps) {
  const [base, quote] = symbol.split("-");
  return (
    <div className="ticker">
      <div className="ticker__symbol">
        {base}
        <span className="ticker__quote"> / {quote}</span>
      </div>
      <div
        // Re-keying on the price restarts the flash animation for every new tick.
        key={price}
        className={`ticker__price ticker__price--${tick}`}
        aria-live="off"
      >
        {price === undefined ? "–" : formatPrice(price)}
      </div>
      <div className="ticker__change">
        {change === undefined ? (
          <span className="muted">Waiting for data…</span>
        ) : (
          <>
            <span className={`delta delta--${change >= 0 ? "up" : "down"}`}>
              {formatChange(change)}
            </span>
            <span className="muted"> last {changeSpanMinutes} min</span>
          </>
        )}
      </div>
    </div>
  );
});
