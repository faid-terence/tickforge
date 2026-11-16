import { createSelector } from "@reduxjs/toolkit";
import type { RootState } from "./store";

/** Price change from the first candle on the chart to the last trade. */
export const selectChange = createSelector(
  [(s: RootState) => s.market.candles, (s: RootState) => s.market.lastPrice],
  (candles, lastPrice) => {
    const first = candles[0];
    const last = candles.at(-1);
    const price = lastPrice ?? last?.close;
    if (!first || !last || price === undefined || first.open === 0) return undefined;
    return {
      fraction: (price - first.open) / first.open,
      minutes: Math.round((last.openTime - first.openTime) / 60_000) + 1,
    };
  },
);
