import type { Candle, Trade } from "@tickforge/sdk";
import type { Batch, Counters, DemoSymbol, LogEntry, StatusSnapshot } from "./protocol";

/**
 * Collects everything that happened since the last flush, so the worker can
 * post ONE message per interval instead of one per trade. On a busy market
 * that turns dozens of main-thread wake-ups (and React renders) per second
 * into at most ten.
 *
 * Pure and timer-free: the worker owns the interval; tests call `flush()`.
 */
export class BatchAccumulator {
  readonly #maxTrades: number;
  #trades: Trade[] = [];
  #candles = new Map<number, Candle>();
  #lastTrade: Trade | undefined;
  #status: StatusSnapshot | undefined;
  #log: LogEntry[] = [];
  #nextLogId = 1;
  #lastCounters: Counters | undefined;

  /** @param maxTrades - Most recent trades kept per batch; older ones are superseded. */
  constructor(maxTrades = 50) {
    this.#maxTrades = maxTrades;
  }

  addTrade(trade: Trade): void {
    this.#trades.push(trade);
    if (this.#trades.length > this.#maxTrades) this.#trades.shift();
  }

  setLastTrade(trade: Trade): void {
    this.#lastTrade = trade;
  }

  /** Keeps only the newest version of each candle (keyed by its minute). */
  addCandle(candle: Candle): void {
    this.#candles.set(candle.openTime, candle);
  }

  setStatus(status: StatusSnapshot): void {
    this.#status = status;
  }

  log(kind: LogEntry["kind"], text: string, time = Date.now()): void {
    this.#log.push({ id: this.#nextLogId++, time, kind, text });
  }

  /** Drops pending data for the previous symbol (e.g. after switching). */
  clearMarketData(): void {
    this.#trades = [];
    this.#candles.clear();
    this.#lastTrade = undefined;
  }

  /**
   * Returns the batch and resets, or `undefined` if nothing changed, so an
   * idle feed costs no messages at all.
   */
  flush(symbol: DemoSymbol, counters: Counters): Batch | undefined {
    const countersChanged =
      !this.#lastCounters ||
      this.#lastCounters.tradesReceived !== counters.tradesReceived ||
      this.#lastCounters.dropped !== counters.dropped ||
      this.#lastCounters.reconnects !== counters.reconnects ||
      this.#lastCounters.gaps !== counters.gaps;
    const empty =
      this.#trades.length === 0 &&
      this.#candles.size === 0 &&
      !this.#lastTrade &&
      !this.#status &&
      this.#log.length === 0;
    if (empty && !countersChanged) return undefined;

    const batch: Batch = {
      type: "batch",
      symbol,
      trades: this.#trades,
      candles: [...this.#candles.values()].sort((a, b) => a.openTime - b.openTime),
      lastTrade: this.#lastTrade,
      status: this.#status,
      log: this.#log,
      counters,
    };
    this.#trades = [];
    this.#candles = new Map();
    this.#lastTrade = undefined;
    this.#status = undefined;
    this.#log = [];
    this.#lastCounters = counters;
    return batch;
  }
}
