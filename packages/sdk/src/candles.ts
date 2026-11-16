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
  /**
   * Flags every candle for `symbol` whose minute overlaps the time range
   * `[from, to]` (ms epoch) as `incomplete`, including candles opened later
   * for minutes up to `to`. Returns the candles whose flag changed.
   */
  markIncomplete(symbol: string, from: number, to: number): Candle[];
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
 * - After a gap, {@link CandleAggregator.markIncomplete} flags the affected
 *   candles. Only the most recently closed candle per symbol can still be
 *   affected (earlier ones end before the last trade seen), so only that one
 *   is kept after closing.
 * @public
 */
export class CandleAggregator implements CandleBuilder {
  readonly #open = new Map<string, Mutable<Candle>>();
  /** Per symbol, the `openTime` of the newest closed candle. */
  readonly #closedThrough = new Map<string, number>();
  /** Per symbol, the newest closed candle (the only one a gap can still reach). */
  readonly #lastClosed = new Map<string, Candle>();
  /** Per symbol, candles opening at or before this minute start out incomplete. */
  readonly #incompleteThrough = new Map<string, number>();

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
      incomplete: openTime <= (this.#incompleteThrough.get(trade.symbol) ?? -Infinity),
    };
    this.#open.set(trade.symbol, next);
    if (!current) return [{ ...next }];
    const closed = this.#close(current);
    return [closed, { ...next }];
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
      closed.push(this.#close(candle));
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

  markIncomplete(symbol: string, from: number, to: number): Candle[] {
    const first = minuteStart(from);
    const last = minuteStart(to);
    this.#incompleteThrough.set(
      symbol,
      Math.max(last, this.#incompleteThrough.get(symbol) ?? -Infinity),
    );
    const inRange = (c: Candle) => !c.incomplete && c.openTime >= first && c.openTime <= last;

    const changed: Candle[] = [];
    const closed = this.#lastClosed.get(symbol);
    if (closed && inRange(closed)) {
      const flagged = { ...closed, incomplete: true };
      this.#lastClosed.set(symbol, flagged);
      changed.push(flagged);
    }
    const open = this.#open.get(symbol);
    if (open && inRange(open)) {
      open.incomplete = true;
      changed.push({ ...open });
    }
    return changed;
  }

  /** Forgets everything about `symbol` (e.g. after unsubscribing). */
  delete(symbol: string): void {
    this.#open.delete(symbol);
    this.#closedThrough.delete(symbol);
    this.#lastClosed.delete(symbol);
    this.#incompleteThrough.delete(symbol);
  }

  #close(candle: Candle): Candle {
    const closed = { ...candle, closed: true };
    this.#closedThrough.set(candle.symbol, candle.openTime);
    this.#lastClosed.set(candle.symbol, closed);
    return closed;
  }
}
