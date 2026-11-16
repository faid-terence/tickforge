import { memo } from "react";
import type { Trade } from "@tickforge/sdk";
import { formatClock, formatPrice, formatSize } from "../lib/format";

export interface TradesListProps {
  trades: readonly Trade[];
}

/** Most recent trades, newest first. Side is a marker plus a word, never colour alone. */
export const TradesList = memo(function TradesList({ trades }: TradesListProps) {
  if (trades.length === 0) return <p className="muted empty">No trades yet.</p>;
  return (
    <table className="trades">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Side</th>
          <th scope="col" className="num">
            Price
          </th>
          <th scope="col" className="num">
            Size
          </th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id} className="trades__row">
            <td>{formatClock(t.timestamp)}</td>
            <td>
              <span className={`side side--${t.side}`}>
                <i aria-hidden="true" />
                {t.side === "buy" ? "Buy" : "Sell"}
              </span>
            </td>
            <td className="num">{formatPrice(t.price)}</td>
            <td className="num">{formatSize(t.size)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});
