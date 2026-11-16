import { createSlice } from "@reduxjs/toolkit";
import type { Trade } from "@tickforge/sdk";
import { mergeCandles, type ChartCandle } from "../lib/candles";
import type { Counters, DemoSymbol } from "../worker/protocol";
import { batchReceived, historyFailed, historyLoaded } from "./actions";
import { symbolSelected } from "./settingsSlice";

export const MAX_TRADES = 30;

export interface MarketState {
  symbol: DemoSymbol;
  /** Newest first. */
  trades: Trade[];
  candles: ChartCandle[];
  history: "loading" | "loaded" | "failed";
  /** openTime of the first live candle this session (it is partial). */
  liveSince: number | undefined;
  lastPrice: number | undefined;
  /** Direction of the last price change, for the ticker's flash. */
  tick: "up" | "down" | "flat";
  counters: Counters;
}

const initialState: MarketState = {
  symbol: "BTC-USD",
  trades: [],
  candles: [],
  history: "loading",
  liveSince: undefined,
  lastPrice: undefined,
  tick: "flat",
  counters: { tradesReceived: 0, dropped: 0, reconnects: 0, gaps: 0, missedTrades: 0 },
};

export const marketSlice = createSlice({
  name: "market",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(symbolSelected, (state, action) => ({
        ...initialState,
        symbol: action.payload,
        counters: state.counters,
      }))
      .addCase(historyLoaded, (state, action) => {
        if (action.payload.symbol !== state.symbol) return;
        state.history = "loaded";
        state.candles = mergeCandles(state.candles, action.payload.candles);
      })
      .addCase(historyFailed, (state, action) => {
        if (action.payload.symbol === state.symbol) state.history = "failed";
      })
      .addCase(batchReceived, (state, { payload: batch }) => {
        state.counters = batch.counters;
        // A batch can still be in flight from before the last symbol switch.
        if (batch.symbol !== state.symbol) return;

        if (batch.trades.length > 0) {
          state.trades = [...batch.trades].reverse().concat(state.trades).slice(0, MAX_TRADES);
        }
        if (batch.lastTrade) {
          const previous = state.lastPrice;
          const price = batch.lastTrade.price;
          state.tick =
            previous === undefined || price === previous
              ? state.tick
              : price > previous
                ? "up"
                : "down";
          state.lastPrice = price;
        }
        if (batch.candles.length > 0) {
          state.liveSince ??= batch.candles[0]?.openTime;
          const live = batch.candles.map((c): ChartCandle => ({
            ...c,
            source: "live",
            partial: c.openTime === state.liveSince,
          }));
          state.candles = mergeCandles(state.candles, live);
        }
      });
  },
});
