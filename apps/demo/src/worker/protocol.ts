/**
 * Messages between the main thread and the market-data worker.
 *
 * Only plain, structured-cloneable data crosses the boundary. The SDK
 * client itself lives entirely inside the worker, so its socket, timers and
 * parsing never compete with React for the main thread.
 */
import type { Candle, ConnectionState, Trade } from "@tickforge/sdk";

export const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
export type DemoSymbol = (typeof SYMBOLS)[number];

/** Main thread → worker. */
export type Command =
  | { type: "select"; symbol: DemoSymbol }
  | { type: "simulate-disconnect" }
  | { type: "slow-consumer"; enabled: boolean };

/** One line of the connection log shown in the UI. */
export interface LogEntry {
  readonly id: number;
  readonly time: number;
  readonly kind: "status" | "wire-out" | "wire-in" | "gap" | "error" | "warning" | "info";
  readonly text: string;
}

export interface StatusSnapshot {
  readonly state: ConnectionState;
  readonly attempt?: number;
  readonly retryInMs?: number;
  readonly since: number;
}

/**
 * Worker → main thread, at most once per flush interval (100ms).
 * Everything is a delta since the previous batch, except the counters.
 */
export interface Batch {
  readonly type: "batch";
  readonly symbol: DemoSymbol;
  /** Newest last. Capped: the UI only shows the most recent trades. */
  readonly trades: readonly Trade[];
  /** Latest version of every candle that changed, oldest first. */
  readonly candles: readonly Candle[];
  /** Most recent trade seen on the `trade` event (unaffected by the slow consumer). */
  readonly lastTrade: Trade | undefined;
  readonly status: StatusSnapshot | undefined;
  readonly log: readonly LogEntry[];
  readonly counters: Counters;
}

export interface Counters {
  /** Trades received on the `trade` event since the worker started. */
  readonly tradesReceived: number;
  /** Trades the `for await` loop has dropped for the current symbol. */
  readonly dropped: number;
  /** Times the connection has been re-established after a drop. */
  readonly reconnects: number;
  /** Sequence gaps the SDK detected (its `stats.gaps`). */
  readonly gaps: number;
  /** Trades missed across those gaps (its `stats.missedTrades`). */
  readonly missedTrades: number;
}

export type WorkerMessage = Batch;
