import type { ExchangeId, Trade } from "../types.js";

/**
 * What an adapter turns one raw message into. A discriminated union on `type`,
 * so the client's `switch` is exhaustively type-checked.
 */
export type AdapterEvent =
  /**
   * `sequence`: the exchange's per-symbol trade number, if it numbers trades
   * contiguously (each trade is exactly 1 more than the previous one for the
   * same symbol). Enables gap and duplicate detection. Omitted otherwise.
   */
  | { type: "trade"; trade: Trade; sequence?: number }
  /**
   * The exchange's latest trade sequence number for a symbol at the moment we
   * (re)subscribed, without a trade to emit. Lets the client detect trades
   * missed while it was disconnected. `timestamp` is that trade's time.
   */
  | { type: "position"; symbol: string; sequence: number; timestamp: number }
  /**
   * The exchange answered the oldest pending subscribe/unsubscribe request.
   * `subscribed` is the exchange's full subscription list after applying it;
   * the client decides success per symbol from it.
   */
  | { type: "ack"; subscribed: readonly string[] }
  /**
   * The exchange reported an error. It is attached to the oldest pending
   * request and judged when that request's ack arrives.
   */
  | { type: "exchange-error"; message: string }
  /** The message was malformed. It is dropped and surfaced as an `error` event. */
  | { type: "invalid"; reason: string }
  /** Valid but irrelevant (heartbeats, unknown future message types…). */
  | { type: "ignored" };

/**
 * Everything exchange-specific lives behind this interface: URLs, request
 * framing, symbol formats and message parsing. The connection manager and
 * client stay exchange-agnostic.
 */
export interface ExchangeAdapter {
  readonly id: ExchangeId;
  readonly defaultUrl: string;
  subscribeMessage(symbols: readonly string[]): string;
  unsubscribeMessage(symbols: readonly string[]): string;
  /** Parses one raw frame. Must never throw. */
  parse(raw: string): AdapterEvent;
}
