import { coinbase } from "./adapters/coinbase.js";
import type { AdapterEvent, ExchangeAdapter } from "./adapters/types.js";
import type { BackoffOptions } from "./backoff.js";
import { CandleAggregator, type CandleBuilder } from "./candles.js";
import { Connection } from "./connection.js";
import { TypedEmitter } from "./emitter.js";
import { AsyncQueue } from "./queue.js";
import { resolveWebSocket, type WebSocketConstructor } from "./transport.js";
import { SequenceTracker, type GapRange } from "./sequence.js";
import {
  TickforgeError,
  type ClientStats,
  type ExchangeId,
  type GapEvent,
  type MarketEvents,
  type Trade,
} from "./types.js";
import { preview } from "./validate.js";

/**
 * Options for {@link MarketClient}.
 * @public
 */
export interface MarketClientOptions {
  /** Which exchange to connect to. */
  exchange: ExchangeId;
  /** Override the exchange's WebSocket URL (e.g. a sandbox or a test server). */
  url?: string;
  /**
   * WebSocket implementation. Defaults to `globalThis.WebSocket`, which exists
   * in browsers, web workers and Node 22+. Pass the `ws` package to use its
   * Node-specific features (custom headers, proxies) or in runtimes without one.
   */
  WebSocket?: WebSocketConstructor;
  /** Reconnect backoff. Defaults: 500ms initial, 30s max, full jitter. */
  backoff?: BackoffOptions;
  /** Reconnect when no message arrives for this long, in ms. Default `10_000`. */
  staleTimeoutMs?: number;
  /** Reject `subscribe`/`unsubscribe` if not acknowledged within this time, in ms. Default `10_000`. */
  requestTimeoutMs?: number;
  /**
   * Builds the 1-minute candles. Defaults to {@link CandleAggregator} (pure
   * TypeScript). Pass another implementation, such as the WebAssembly one,
   * to swap the engine without changing any behaviour. Give each client its own.
   */
  candleBuilder?: CandleBuilder;
}

/**
 * Options for {@link MarketClient.trades}.
 * @public
 */
export interface IteratorOptions {
  /**
   * Max trades buffered while the loop body is busy. When full, the oldest
   * trade is dropped, counted in {@link TradeIterator.dropped}, and a
   * `warning` event is emitted. Default `1000`.
   */
  bufferSize?: number;
}

/**
 * Async iterator returned by {@link MarketClient.trades}.
 * @public
 */
export interface TradeIterator extends AsyncIterableIterator<Trade> {
  /** Trades dropped so far because the consumer fell behind and the buffer was full. */
  readonly dropped: number;
}

/**
 * How long after a minute ends (local clock) its candles are force-closed.
 * Absorbs network latency and small clock differences, so trades from the
 * last instant of the minute still make it into the candle.
 */
export const CANDLE_CLOSE_GRACE_MS = 2_000;

const ADAPTERS: Record<ExchangeId, ExchangeAdapter> = { coinbase };
/**
 * Looks up an adapter. `exchange` is typed, but JavaScript callers can pass
 * anything, and `Object.hasOwn` stops keys like "constructor" from resolving
 * to `Object.prototype` members.
 */
function getAdapter(exchange: string): ExchangeAdapter {
  if (!Object.hasOwn(ADAPTERS, exchange)) {
    throw new TypeError(`Unknown exchange: ${JSON.stringify(exchange)}`);
  }
  return ADAPTERS[exchange as ExchangeId];
}

const SYMBOL_PATTERN = /^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/;

/** One pending subscribe/unsubscribe call. */
interface Request {
  readonly kind: "subscribe" | "unsubscribe";
  /** Symbols this request is responsible for (newly added / removed). */
  readonly symbols: readonly string[];
  readonly resolve: () => void;
  readonly reject: (error: TickforgeError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** One frame sent to the exchange that still awaits its ack. */
interface InFlightFrame {
  readonly kind: Request["kind"];
  readonly symbols: readonly string[];
  /** User calls waiting on this frame (empty for internal frames). */
  readonly requests: Request[];
  /** First error the exchange reported for this frame, if any. */
  error?: string;
}

/**
 * Real-time market data client for one exchange.
 *
 * @example
 * ```ts
 * const client = new MarketClient({ exchange: "coinbase" });
 * client.on("trade", (t) => console.log(t.symbol, t.price));
 * await client.subscribe(["BTC-USD"]);
 * // …later
 * await client.close();
 * ```
 * @public
 */
export class MarketClient extends TypedEmitter<MarketEvents> {
  readonly #adapter: ExchangeAdapter;
  readonly #connection: Connection;
  readonly #requestTimeoutMs: number;
  readonly #candles: CandleBuilder;
  /** Symbols the user wants. The source of truth for re-subscribing. */
  readonly #desired = new Set<string>();
  /**
   * Subset of `#desired` that a subscribe() has resolved for. Those symbols
   * are owned by an earlier, successful caller and are never rolled back by
   * another caller's failure.
   */
  readonly #active = new Set<string>();
  /** Subscribe requests waiting for a connection to open. */
  #awaitingOpen: Request[] = [];
  /** Frames sent on the current socket, in order, awaiting an ack. */
  #inFlight: InFlightFrame[] = [];
  /** The frame whose ack is being processed (already removed from `#inFlight`). */
  #completing: InFlightFrame | undefined;
  /** Per-symbol trade sequence, for gap / duplicate / out-of-order detection. */
  readonly #sequences = new SequenceTracker();
  readonly #stats = { gaps: 0, missedTrades: 0, duplicateTrades: 0, outOfOrderTrades: 0 };
  readonly #iterators = new Set<AsyncQueue<Trade>>();
  #candleTimer: ReturnType<typeof setTimeout> | undefined;
  #closing: Promise<void> | undefined;

  /**
   * @throws {@link TickforgeError} with code `NO_WEBSOCKET` if no WebSocket
   * implementation is available.
   * @throws `TypeError` for an unknown exchange.
   */
  constructor(options: MarketClientOptions) {
    super();
    this.#adapter = getAdapter(options.exchange);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#candles = options.candleBuilder ?? new CandleAggregator();
    this.#connection = new Connection(
      {
        url: options.url ?? this.#adapter.defaultUrl,
        WebSocket: resolveWebSocket(options.WebSocket),
        staleTimeoutMs: options.staleTimeoutMs ?? 10_000,
        ...(options.backoff && { backoff: options.backoff }),
      },
      {
        onOpen: () => {
          this.#resubscribe();
        },
        onMessage: (raw) => {
          this.#handleMessage(raw);
        },
        onDisconnect: () => {
          this.#handleDisconnect();
        },
        onStatus: (status) => {
          this.emit("status", status);
        },
        onError: (error) => {
          this.emit("error", error);
        },
      },
    );
  }

  /** Current connection state. */
  get state(): MarketEvents["status"]["state"] {
    return this.#connection.state;
  }

  /** Symbols currently subscribed (or being subscribed), in normalized form. */
  /**
   * Data-integrity counters since the client was created: gaps, missed,
   * duplicate and out-of-order trades. Returns a snapshot.
   */
  get stats(): ClientStats {
    return { ...this.#stats };
  }

  get symbols(): readonly string[] {
    return [...this.#desired];
  }

  /**
   * Subscribes to trades (and derived 1m candles) for `symbols`.
   *
   * Connects on first use. Resolves once the exchange has confirmed every
   * requested symbol. Symbols a previous call already confirmed are skipped;
   * symbols still pending from another call are requested again, so this call
   * also waits for (and is judged on) them. If the connection drops before the
   * ack, the request rides along with the automatic re-subscription.
   *
   * All-or-nothing: if the promise rejects, the symbols this call asked for
   * are not subscribed, except those another successful or still-pending call
   * also asked for. A failure never removes a symbol someone else owns.
   *
   * @param symbols - Symbols in `BASE-QUOTE` form, e.g. `["BTC-USD"]`. Case-insensitive.
   * @throws `TypeError` for a malformed symbol.
   * @throws {@link TickforgeError} `REQUEST_TIMEOUT`, `EXCHANGE_ERROR` or `CLIENT_CLOSED`.
   */
  async subscribe(symbols: readonly string[]): Promise<void> {
    const wanted = this.#prepare(symbols).filter((s) => !this.#active.has(s));
    if (wanted.length === 0) return;
    for (const s of wanted) this.#desired.add(s);

    return new Promise<void>((resolve, reject) => {
      const request = this.#createRequest("subscribe", wanted, resolve, reject);
      if (this.#connection.state === "open") {
        // Re-requesting a symbol that is already pending is harmless (the
        // exchange treats it as a no-op) and gives this call its own ack.
        this.#sendFrame("subscribe", wanted, [request]);
      } else {
        this.#awaitingOpen.push(request);
        this.#connection.connect();
      }
    });
  }

  /**
   * Unsubscribes from `symbols`. Events for them stop immediately, even before
   * the exchange acknowledges. Unsubscribing from the last symbol closes the
   * socket and returns the client to `idle`.
   *
   * @throws `TypeError` for a malformed symbol.
   * @throws {@link TickforgeError} `REQUEST_TIMEOUT`, `EXCHANGE_ERROR` or `CLIENT_CLOSED`.
   */
  async unsubscribe(symbols: readonly string[]): Promise<void> {
    const normalized = this.#prepare(symbols);
    const removed = normalized.filter((s) => this.#desired.has(s));
    if (removed.length === 0) return;
    this.#forget(removed);

    if (this.#goIdleIfEmpty()) return;
    // Not connected: the next (re)connect simply won't include these symbols.
    if (this.#connection.state !== "open") return;

    return new Promise<void>((resolve, reject) => {
      const request = this.#createRequest("unsubscribe", removed, resolve, reject);
      this.#sendFrame("unsubscribe", removed, [request]);
    });
  }

  /**
   * Async iterator over trades for one symbol.
   *
   * It is a view over the `trade` event; it does not subscribe for you. The
   * loop ends when you `break` or when the client is closed.
   *
   * If the loop body is slower than the feed, at most `bufferSize` trades are
   * buffered and the oldest are dropped. Check `iterator.dropped`, or listen
   * for the `warning` event, to detect this.
   *
   * @throws `RangeError` if `bufferSize` is not an integer >= 1.
   * @example
   * ```ts
   * await client.subscribe(["BTC-USD"]);
   * for await (const trade of client.trades("BTC-USD")) {
   *   if (trade.price > 100_000) break;
   * }
   * ```
   */
  trades(symbol: string, options: IteratorOptions = {}): TradeIterator {
    const [normalized = ""] = this.#prepare([symbol]);
    const queue: AsyncQueue<Trade> = new AsyncQueue(
      options.bufferSize ?? 1000,
      () => {
        off();
        this.#iterators.delete(queue);
      },
      (dropped) => {
        this.emit("warning", {
          code: "TRADES_DROPPED",
          message:
            `trades("${normalized}") is consuming slower than the feed; ` +
            `oldest trades were dropped (${dropped} so far). ` +
            "Process trades faster or raise bufferSize.",
          symbol: normalized,
          dropped,
        });
      },
    );
    const off = this.on("trade", (trade) => {
      if (trade.symbol === normalized) queue.push(trade);
    });
    this.#iterators.add(queue);
    return queue;
  }

  /**
   * Closes the connection, stops every timer, rejects pending requests, ends
   * all iterators and removes all listeners after emitting `closed`.
   * Idempotent: calling it again returns the same promise.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#settleAll(new TickforgeError("CLIENT_CLOSED", "Client was closed"));
      this.#stopCandleTimer();
      for (const queue of [...this.#iterators]) queue.end();
      await this.#connection.close();
      this.removeAllListeners();
    })();
    return this.#closing;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #prepare(symbols: readonly string[]): string[] {
    if (this.#closing) throw new TickforgeError("CLIENT_CLOSED", "Client was closed");
    const normalized = symbols.map((raw: unknown) => {
      // Typed as string, but JavaScript callers can pass anything.
      const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
      if (!SYMBOL_PATTERN.test(s)) {
        throw new TypeError(
          `Invalid symbol ${JSON.stringify(raw)}. Expected BASE-QUOTE, e.g. "BTC-USD".`,
        );
      }
      return s;
    });
    return [...new Set(normalized)];
  }

  #createRequest(
    kind: Request["kind"],
    symbols: string[],
    resolve: () => void,
    reject: (error: TickforgeError) => void,
  ): Request {
    const request: Request = {
      kind,
      symbols,
      resolve,
      reject,
      settled: false,
      timer: setTimeout(() => {
        this.#settle(
          request,
          new TickforgeError(
            "REQUEST_TIMEOUT",
            `${kind} not acknowledged within ${this.#requestTimeoutMs}ms`,
            {
              details: { symbols },
            },
          ),
        );
      }, this.#requestTimeoutMs),
    };
    return request;
  }

  /**
   * Resolves or rejects a request exactly once.
   *
   * A successful subscribe makes its symbols owned (`#active`). A failed one
   * rolls back, so reconnects never re-subscribe a symbol the caller was told
   * failed, but it only releases symbols nobody else has a claim on.
   */
  #settle(request: Request, error?: TickforgeError): void {
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    if (request.kind === "subscribe") {
      if (error) {
        this.#forget(request.symbols.filter((s) => !this.#isClaimed(s)));
        // While an ack is being processed, #completeFrame goes idle once at the end.
        if (!this.#closing && !this.#completing) this.#goIdleIfEmpty();
      } else {
        for (const s of request.symbols) if (this.#desired.has(s)) this.#active.add(s);
      }
    }
    if (error) request.reject(error);
    else request.resolve();
  }

  /**
   * Whether a symbol must survive a rollback: a resolved subscribe owns it,
   * or another subscribe that has not been settled yet is still asking for it.
   */
  #isClaimed(symbol: string): boolean {
    return this.#active.has(symbol) || this.#hasPendingClaim(symbol);
  }

  #hasPendingClaim(symbol: string): boolean {
    const pending = [
      ...this.#awaitingOpen,
      ...this.#inFlight.flatMap((f) => f.requests),
      ...(this.#completing?.requests ?? []),
    ];
    return pending.some((r) => !r.settled && r.kind === "subscribe" && r.symbols.includes(symbol));
  }

  /** Removes symbols from every piece of local state. */
  #forget(symbols: Iterable<string>): void {
    for (const s of symbols) {
      this.#desired.delete(s);
      this.#active.delete(s);
      this.#candles.delete(s);
      this.#sequences.delete(s);
    }
  }

  /**
   * With nothing subscribed, drop the socket instead of keeping an empty one
   * that the exchange (and our stale detector) would keep killing, which
   * would cause an endless reconnect loop. Returns whether it went idle.
   */
  #goIdleIfEmpty(): boolean {
    if (this.#desired.size > 0) return false;
    this.#settleAll();
    this.#stopCandleTimer();
    this.#connection.suspend();
    return true;
  }

  /** Settles every pending request, e.g. on close() or when going idle. */
  #settleAll(error?: TickforgeError): void {
    const pending = [...this.#awaitingOpen, ...this.#inFlight.flatMap((f) => f.requests)];
    this.#awaitingOpen = [];
    this.#inFlight = [];
    for (const request of pending) this.#settle(request, error);
  }

  #sendFrame(kind: Request["kind"], symbols: readonly string[], requests: Request[]): void {
    const frame =
      kind === "subscribe"
        ? this.#adapter.subscribeMessage(symbols)
        : this.#adapter.unsubscribeMessage(symbols);
    this.#inFlight.push({ kind, symbols, requests });
    this.#connection.send(frame);
  }

  /**
   * Called on every (re)connect: one frame restores the full subscription set.
   * `#desired` is never empty here: the client goes idle (no socket) whenever
   * it becomes empty, so a connection only exists while something is wanted.
   */
  #resubscribe(): void {
    const waiting = this.#awaitingOpen;
    this.#awaitingOpen = [];
    this.#sendFrame("subscribe", [...this.#desired], waiting);
  }

  /**
   * The socket dropped. Frames in flight will never be acked on it. Pending
   * subscribes are carried over to the re-subscription after reconnecting;
   * pending unsubscribes are already done (the new socket won't include them).
   */
  #handleDisconnect(): void {
    for (const frame of this.#inFlight) {
      for (const request of frame.requests) {
        if (request.settled) continue;
        if (request.kind === "subscribe") this.#awaitingOpen.push(request);
        else this.#settle(request);
      }
    }
    this.#inFlight = [];
  }

  /**
   * An exchange error is NOT a final answer: Coinbase sends one error per
   * channel and then still sends the `subscriptions` snapshot. So the error is
   * attached to the oldest pending frame and judged when that frame's ack
   * arrives. With nothing pending, it is surfaced as an `error` event.
   */
  #handleExchangeError(message: string): void {
    const head = this.#inFlight[0];
    if (head) head.error ??= message;
    else this.#emitExchangeError(message);
  }

  /**
   * Settles the requests behind an acknowledged frame. Acks arrive in the
   * order frames were sent, and each carries the exchange's FULL subscription
   * snapshot, so success is decided per symbol from that snapshot. That is
   * robust to partial failures and to how many errors preceded the ack.
   */
  #completeFrame(frame: InFlightFrame, snapshot: readonly string[]): void {
    this.#completing = frame;
    try {
      if (frame.kind === "unsubscribe") {
        for (const request of frame.requests) this.#settle(request);
        if (frame.error) this.#emitExchangeError(frame.error);
        return;
      }
      this.#completeSubscribe(frame, new Set(snapshot));
    } finally {
      this.#completing = undefined;
    }
    this.#goIdleIfEmpty();
  }

  #completeSubscribe(frame: InFlightFrame, confirmed: ReadonlySet<string>): void {
    const isFailed = (r: Request) => r.symbols.some((s) => !confirmed.has(s));
    const error = new TickforgeError(
      "EXCHANGE_ERROR",
      frame.error ?? "Subscription was not confirmed by the exchange",
    );
    // Successes first, so their symbols count as owned when failures roll back.
    for (const request of frame.requests) if (!isFailed(request)) this.#settle(request);
    const failed = frame.requests.filter(isFailed);
    for (const request of failed) this.#settle(request, error);

    // Symbols missing from the snapshot that no request is answerable for,
    // e.g. a product delisted while we were reconnecting.
    const dropped = frame.symbols.filter(
      (s) => !confirmed.has(s) && this.#desired.has(s) && !this.#hasPendingClaim(s),
    );
    if (dropped.length > 0) {
      this.#forget(dropped);
      this.emit(
        "error",
        new TickforgeError("EXCHANGE_ERROR", `${error.message} (dropped: ${dropped.join(", ")})`, {
          details: { symbols: dropped },
        }),
      );
    } else if (frame.error && failed.length === 0) {
      // An error that did not belong to any failed request is still surfaced.
      this.#emitExchangeError(frame.error);
    }

    // Confirmed but no longer wanted (rolled back, timed out, or unsubscribed
    // while pending): undo it on the exchange, unless an unsubscribe is already queued.
    const orphans = frame.symbols.filter(
      (s) =>
        confirmed.has(s) &&
        !this.#desired.has(s) &&
        !this.#inFlight.some((f) => f.kind === "unsubscribe" && f.symbols.includes(s)),
    );
    if (orphans.length > 0 && this.#connection.state === "open") {
      this.#sendFrame("unsubscribe", orphans, []);
    }
  }

  #emitExchangeError(message: string): void {
    this.emit("error", new TickforgeError("EXCHANGE_ERROR", message));
  }

  /**
   * Makes sure a timer will close candles once their minute (plus a grace
   * period) is over, so a symbol that stops trading still gets its final
   * candle on time. One timer for all symbols, armed only while a candle is open.
   */
  #scheduleCandleClose(): void {
    if (this.#candleTimer) return;
    const minuteEnd = this.#candles.nextMinuteEnd();
    if (minuteEnd === undefined) return;
    const delay = Math.max(0, minuteEnd + CANDLE_CLOSE_GRACE_MS - Date.now());
    this.#candleTimer = setTimeout(() => {
      this.#candleTimer = undefined;
      for (const candle of this.#candles.closeUntil(Date.now() - CANDLE_CLOSE_GRACE_MS)) {
        this.emit("candle", candle);
      }
      this.#scheduleCandleClose();
    }, delay);
  }

  #stopCandleTimer(): void {
    clearTimeout(this.#candleTimer);
    this.#candleTimer = undefined;
  }

  /**
   * Trades are known to be missing: count it, tell the user, and flag every
   * candle the missing range could have touched, so no candle silently
   * understates volume or misses a high/low.
   */
  #reportGap(symbol: string, reason: GapEvent["reason"], range: GapRange): void {
    const missed = range.received - range.expected;
    this.#stats.gaps += 1;
    this.#stats.missedTrades += missed;
    this.emit("gap", {
      symbol,
      reason,
      expected: range.expected,
      received: range.received,
      missed,
      from: range.from,
      to: range.to,
    });
    for (const candle of this.#candles.markIncomplete(symbol, range.from, range.to)) {
      this.emit("candle", candle);
    }
  }

  #handleMessage(raw: string): void {
    const event: AdapterEvent = this.#adapter.parse(raw);
    switch (event.type) {
      case "trade": {
        const { trade } = event;
        // Drop trades for symbols just unsubscribed but not yet acknowledged.
        if (!this.#desired.has(trade.symbol)) return;
        if (event.sequence !== undefined) {
          const verdict = this.#sequences.trade(trade.symbol, event.sequence, trade.timestamp);
          if (verdict.kind === "duplicate") {
            this.#stats.duplicateTrades += 1;
            return;
          }
          if (verdict.kind === "out-of-order") {
            this.#stats.outOfOrderTrades += 1;
            return;
          }
          if (verdict.kind === "gap") this.#reportGap(trade.symbol, "stream", verdict);
        }
        this.emit("trade", trade);
        for (const candle of this.#candles.add(trade)) this.emit("candle", candle);
        this.#scheduleCandleClose();
        return;
      }
      case "ack": {
        const frame = this.#inFlight.shift();
        if (frame) this.#completeFrame(frame, event.subscribed);
        return;
      }
      case "exchange-error":
        this.#handleExchangeError(event.message);
        return;
      case "invalid":
        this.emit(
          "error",
          new TickforgeError("PARSE_ERROR", `Dropped malformed message: ${event.reason}`, {
            details: { raw: preview(raw) },
          }),
        );
        return;
      case "position": {
        if (!this.#desired.has(event.symbol)) return;
        const verdict = this.#sequences.position(event.symbol, event.sequence, event.timestamp);
        if (verdict.kind === "gap") this.#reportGap(event.symbol, "reconnect", verdict);
        return;
      }
      case "ignored":
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }
}
