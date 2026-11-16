import { createAction } from "@reduxjs/toolkit";
import type { ChartCandle } from "../lib/candles";
import type { Batch, DemoSymbol } from "../worker/protocol";

/** One 100ms batch from the worker. */
export const batchReceived = createAction<Batch>("worker/batchReceived");
/** The visitor asked to cut the connection. */
export const disconnectSimulated = createAction("connection/disconnectSimulated");
export const historyLoaded = createAction<{ symbol: DemoSymbol; candles: ChartCandle[] }>(
  "market/historyLoaded",
);
export const historyFailed = createAction<{ symbol: DemoSymbol; message: string }>(
  "market/historyFailed",
);
