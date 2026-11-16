import type { Candle } from "tickforge";

/** A candle on the chart, tagged with where it came from. */
export interface ChartCandle extends Candle {
  /** `history`: Coinbase REST backfill. `live`: built by tickforge from trades. */
  readonly source: "history" | "live";
  /** The first live minute only covers trades since streaming began. */
  readonly partial: boolean;
}

export const MAX_CANDLES = 60;

/**
 * Merges candles by minute. Live data replaces history for the same minute,
 * and a newer live version replaces an older one. Keeps the newest `max`.
 */
export function mergeCandles(
  existing: readonly ChartCandle[],
  incoming: readonly ChartCandle[],
  max = MAX_CANDLES,
): ChartCandle[] {
  const byMinute = new Map(existing.map((c) => [c.openTime, c]));
  for (const candle of incoming) {
    const current = byMinute.get(candle.openTime);
    if (current?.source === "live" && candle.source === "history") continue;
    byMinute.set(candle.openTime, candle);
  }
  return [...byMinute.values()].sort((a, b) => a.openTime - b.openTime).slice(-max);
}
