import type { ExchangeId, Trade } from "../types.js";

/**
 * What an adapter turns one raw message into. A discriminated union on `type`,
 * so the client's `switch` is exhaustively type-checked.
 */
export type AdapterEvent =
  | { type: "trade"; trade: Trade }
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
