/**
 * tickforge — typed, resilient real-time market data for crypto exchanges.
 * @packageDocumentation
 */
export { MarketClient } from "./client.js";
export type { MarketClientOptions, IteratorOptions, TradeIterator } from "./client.js";
export type { BackoffOptions } from "./backoff.js";
export { CandleAggregator } from "./candles.js";
export type { CandleBuilder } from "./candles.js";
export type { WebSocketConstructor, WebSocketLike } from "./transport.js";
export { TickforgeError } from "./types.js";
export type {
  Candle,
  ConnectionState,
  ErrorCode,
  ExchangeId,
  MarketEvents,
  StatusEvent,
  Trade,
  TradeSide,
  WarningEvent,
} from "./types.js";
