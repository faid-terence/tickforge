/**
 * Exchanges supported by tickforge.
 * @public
 */
export type ExchangeId = "coinbase";

/**
 * Side of the aggressor (taker) in a trade.
 *
 * `"buy"` means a buyer lifted an ask (price likely ticked up);
 * `"sell"` means a seller hit a bid.
 * @public
 */
export type TradeSide = "buy" | "sell";

/**
 * A single executed trade, normalized across exchanges.
 *
 * Prices and sizes are JavaScript numbers (IEEE-754 doubles). That is exact
 * enough for display, charting and alerting, but not for accounting; if you
 * need exact decimals, use the exchange's REST API with a decimal library.
 * @public
 */
export interface Trade {
  readonly exchange: ExchangeId;
  /** Normalized symbol, `BASE-QUOTE` in upper case, e.g. `"BTC-USD"`. */
  readonly symbol: string;
  /** Exchange-assigned trade id, as a string so every exchange fits. */
  readonly id: string;
  readonly price: number;
  readonly size: number;
  readonly side: TradeSide;
  /** Execution time in milliseconds since the Unix epoch (UTC). */
  readonly timestamp: number;
}

/**
 * A 1-minute OHLCV candle, built by tickforge from the trade stream.
 *
 * Timing:
 * - A candle is emitted every time a trade changes it, with `closed: false`.
 * - The final version is emitted exactly once with `closed: true`, at
 *   whichever comes first: the first trade of a later minute, or about 2s
 *   after the minute ends by the local clock (the grace period absorbs
 *   network latency). So even an illiquid symbol's candle closes on time.
 * - Minutes with no trades produce no candle at all. To draw a continuous
 *   series, fill the gap yourself, e.g. with a flat candle at the previous close.
 * - A closed candle is final: trades for that minute that arrive later still
 *   emit `trade` events but are not applied to any candle.
 * - Trades missed while disconnected are missing from the candle too.
 * @public
 */
export interface Candle {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly interval: "1m";
  /** Start of the minute, in ms since the Unix epoch (UTC). */
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Base-asset volume traded during the minute. */
  readonly volume: number;
  /** Number of trades that make up the candle. */
  readonly trades: number;
  readonly closed: boolean;
}

/**
 * Lifecycle states of the underlying connection.
 *
 * ```text
 * idle ──subscribe()──► connecting ──► open ──► reconnecting ──► connecting ──► …
 *  ▲                                    │
 *  └──── unsubscribed from everything ──┘
 *
 * any state ──close()──► closed (terminal)
 * ```
 *
 * - `idle`: no socket, because nothing is subscribed. The client connects
 *   lazily on the first `subscribe()` and returns here when the last symbol is
 *   unsubscribed, so an unused client holds no socket and no timers.
 * - `closed`: `close()` was called. The client cannot be reused.
 * @public
 */
export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * Payload of the `status` event.
 * @public
 */
export interface StatusEvent {
  readonly state: ConnectionState;
  /** Reconnect attempt number (1-based). Present when `state` is `"reconnecting"`. */
  readonly attempt?: number;
  /** Delay before the next connection attempt, in ms. Present when `state` is `"reconnecting"`. */
  readonly retryInMs?: number;
}

/**
 * Machine-readable error codes. See {@link TickforgeError}.
 *
 * - `PARSE_ERROR`: a message from the exchange was malformed or failed validation. It was dropped.
 * - `EXCHANGE_ERROR`: the exchange sent an explicit error message.
 * - `TRANSPORT_ERROR`: the WebSocket reported an error (a reconnect follows automatically).
 * - `REQUEST_TIMEOUT`: a subscribe/unsubscribe was not acknowledged in time.
 * - `CLIENT_CLOSED`: the operation was attempted on, or interrupted by, a closed client.
 * - `NO_WEBSOCKET`: no WebSocket implementation is available in this runtime.
 * @public
 */
export type ErrorCode =
  | "PARSE_ERROR"
  | "EXCHANGE_ERROR"
  | "TRANSPORT_ERROR"
  | "REQUEST_TIMEOUT"
  | "CLIENT_CLOSED"
  | "NO_WEBSOCKET";

/**
 * Map of event names to payload types. This is what makes
 * `client.on(name, handler)` fully typed.
 * @public
 */
export interface MarketEvents {
  trade: Trade;
  candle: Candle;
  status: StatusEvent;
  error: TickforgeError;
  warning: WarningEvent;
}

/**
 * Payload of the `warning` event: something degraded, but nothing failed.
 *
 * - `TRADES_DROPPED`: a `trades()` iterator's buffer was full, so its oldest
 *   trades were dropped. Emitted once per overflow episode (the first drop
 *   after the consumer last caught up), not once per dropped trade.
 * @public
 */
export interface WarningEvent {
  readonly code: "TRADES_DROPPED";
  readonly message: string;
  /** Symbol of the iterator that dropped trades. */
  readonly symbol: string;
  /** Total trades this iterator has dropped so far. */
  readonly dropped: number;
}

/**
 * The single error class thrown by, and emitted from, tickforge.
 *
 * Check `code` rather than the message; messages are for humans and may change.
 * @public
 */
export class TickforgeError extends Error {
  override readonly name = "TickforgeError";
  readonly code: ErrorCode;
  /** Extra context, e.g. the raw (truncated) message for `PARSE_ERROR`. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    if (options?.details) this.details = options.details;
  }
}
