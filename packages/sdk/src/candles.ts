import type { Candle, Trade } from "./types.js";

export const MINUTE_MS = 60_000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Start of the UTC minute containing `timestamp`. */
export function minuteStart(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

/**
 * Builds 1-minute candles from trades. {@link CandleAggregator} is the
 * default; an alternative (e.g. the WebAssembly one in
 * `@tickforge/aggregator-wasm`) can be passed as `candleBuilder` in
 * {@link MarketClientOptions}. Implementations must follow the same rules,
 * which are documented on {@link CandleAggregator}.
 * @public
 */
export interface CandleBuilder {
  /** Applies one trade; returns the candles that changed, oldest first. */
  add(trade: Trade): Candle[];
  /** Closes every candle whose minute ended at or before `time` (ms epoch). */
  closeUntil(time: number): Candle[];
  /** When the earliest open candle's minute ends (ms epoch), or `undefined`. */
  nextMinuteEnd(): number | undefined;
  /** Forgets everything about `symbol`. */
  delete(symbol: string): void;
}

/**
 * Incrementally builds 1-minute OHLCV candles from a live trade stream, one
 * candle in progress per symbol. The default {@link CandleBuilder}; also
 * usable on its own, e.g. to build candles from historical trades.
 *
 * It is pure (no timers, no clock); the client decides when time has passed
 * by calling {@link CandleAggregator.closeUntil}.
 *
 * Rules:
 * - A candle closes at whichever comes first: a trade from a later minute
 *   ({@link CandleAggregator.add}), or the caller declaring that the minute
 *   is over ({@link CandleAggregator.closeUntil}).
 * - Minutes without trades produce no candle. There is no price information
 *   for them, and inventing a flat candle would be a guess.
 * - A closed candle is final. Trades for a minute that is already closed
 *   (late or out of order) are not applied to any candle.
 * - Candles closed by {@link CandleAggregator.closeUntil} come out in the
 *   order their symbols' current candles were opened.
 * @public
 */
export class CandleAggregator implements CandleBuilder {
  readonly #open = new Map<string, Mutable<Candle>>();
  /** Per symbol, the `openTime` of the newest closed candle. */
  readonly #closedThrough = new Map<string, number>();

  /**
   * Applies one trade. Returns the candles that changed, oldest first: the
   * previous candle (now `closed: true`) if the minute rolled over, then the
   * candle in progress. Returns `[]` for a late trade.
   */
  add(trade: Trade): Candle[] {
    const openTime = minuteStart(trade.timestamp);
    const closedThrough = this.#closedThrough.get(trade.symbol);
    if (closedThrough !== undefined && openTime <= closedThrough) return [];

    const current = this.#open.get(trade.symbol);
    if (current && openTime < current.openTime) return [];

    if (current && openTime === current.openTime) {
      current.high = Math.max(current.high, trade.price);
      current.low = Math.min(current.low, trade.price);
      current.close = trade.price;
      current.volume += trade.size;
      current.trades += 1;
      return [{ ...current }];
    }

    const next: Mutable<Candle> = {
      exchange: trade.exchange,
      symbol: trade.symbol,
      interval: "1m",
      openTime,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.size,
      trades: 1,
      closed: false,
    };
    this.#open.set(trade.symbol, next);
    if (!current) return [{ ...next }];
    this.#closedThrough.set(trade.symbol, current.openTime);
    return [{ ...current, closed: true }, { ...next }];
  }

  /**
   * Closes every candle whose minute ended at or before `time` (ms epoch).
   * @returns The closed candles, with `closed: true`.
   */
  closeUntil(time: number): Candle[] {
    const closed: Candle[] = [];
    for (const [symbol, candle] of this.#open) {
      if (candle.openTime + MINUTE_MS > time) continue;
      this.#open.delete(symbol);
      this.#closedThrough.set(symbol, candle.openTime);
      closed.push({ ...candle, closed: true });
    }
    return closed;
  }

  /** When the earliest open candle's minute ends (ms epoch), or `undefined` if none is open. */
  nextMinuteEnd(): number | undefined {
    let earliest: number | undefined;
    for (const candle of this.#open.values()) {
      if (earliest === undefined || candle.openTime < earliest) earliest = candle.openTime;
    }
    return earliest === undefined ? undefined : earliest + MINUTE_MS;
  }

  /** Forgets everything about `symbol` (e.g. after unsubscribing). */
  delete(symbol: string): void {
    this.#open.delete(symbol);
    this.#closedThrough.delete(symbol);
  }
}
