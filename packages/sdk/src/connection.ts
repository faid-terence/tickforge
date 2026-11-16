import { backoffDelay, type BackoffOptions } from "./backoff.js";
import { openTransport, type Transport, type WebSocketConstructor } from "./transport.js";
import { TickforgeError, type ConnectionState, type StatusEvent } from "./types.js";

export interface ConnectionOptions {
  url: string;
  WebSocket: WebSocketConstructor;
  backoff?: BackoffOptions;
  /** Reconnect if no message arrives for this long, in ms. */
  staleTimeoutMs: number;
  /** Max time `close()` waits for the socket's closing handshake, in ms. */
  closeTimeoutMs?: number;
  /** Injectable randomness for deterministic backoff in tests. */
  random?: () => number;
}

export interface ConnectionCallbacks {
  /** The socket is open (first connect or any reconnect). Re-subscribe here. */
  onOpen(): void;
  onMessage(data: string): void;
  /** The socket was lost; a reconnect is already scheduled. */
  onDisconnect(): void;
  onStatus(event: StatusEvent): void;
  onError(error: TickforgeError): void;
}

/**
 * Owns one logical connection: opening the socket, detecting stale
 * connections, reconnecting with backoff, and tearing everything down.
 *
 * It knows nothing about exchanges; it moves strings. That separation keeps
 * the reconnect logic testable in isolation and reusable for every adapter.
 *
 * Invariant: at most one timer of each kind (reconnect, stale) exists at a
 * time, and after `close()` none exist and no callbacks fire.
 */
export class Connection {
  readonly #options: ConnectionOptions;
  readonly #callbacks: ConnectionCallbacks;
  #state: ConnectionState = "idle";
  #transport: Transport | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #staleTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #receivedSinceOpen = false;

  constructor(options: ConnectionOptions, callbacks: ConnectionCallbacks) {
    this.#options = options;
    this.#callbacks = callbacks;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Starts connecting. Does nothing unless the connection is idle. */
  connect(): void {
    if (this.#state === "idle") this.#open();
  }

  /** Sends `data` if the socket is open. Returns whether it was sent. */
  send(data: string): boolean {
    if (this.#state !== "open" || !this.#transport) return false;
    this.#transport.send(data);
    return true;
  }

  /**
   * Returns to `idle`: closes the socket and stops all timers, but unlike
   * `close()` the connection can be started again with `connect()`.
   */
  suspend(): void {
    if (this.#state === "idle" || this.#state === "closed") return;
    this.#clearTimers();
    const transport = this.#transport;
    this.#transport = undefined;
    void transport?.close();
    this.#attempt = 0;
    this.#setState({ state: "idle" });
  }

  /** Permanently closes the connection and stops every timer. Idempotent. */
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#clearTimers();
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport) await this.#closeWithTimeout(transport);
    this.#callbacks.onStatus({ state: "closed" });
  }

  #open(): void {
    this.#setState({ state: "connecting" });
    this.#receivedSinceOpen = false;
    try {
      this.#transport = openTransport(this.#options.WebSocket, this.#options.url, {
        onOpen: () => {
          this.#handleOpen();
        },
        onMessage: (data) => {
          this.#handleMessage(data);
        },
        onError: (error) => {
          this.#callbacks.onError(
            new TickforgeError("TRANSPORT_ERROR", "WebSocket error", { cause: error }),
          );
        },
        onClose: () => {
          this.#handleDrop();
        },
      });
    } catch (error) {
      // e.g. the constructor threw synchronously. Treat like a failed connect.
      this.#callbacks.onError(
        new TickforgeError("TRANSPORT_ERROR", "Failed to open WebSocket", { cause: error }),
      );
      this.#transport = undefined;
      this.#scheduleReconnect();
    }
  }

  #handleOpen(): void {
    this.#setState({ state: "open" });
    this.#armStaleTimer();
    this.#callbacks.onOpen();
  }

  #handleMessage(data: string): void {
    if (!this.#receivedSinceOpen) {
      // Only now do we trust the connection; resetting on "open" alone would
      // let a server that accepts then immediately drops us cause a hot loop.
      this.#receivedSinceOpen = true;
      this.#attempt = 0;
    }
    this.#armStaleTimer();
    this.#callbacks.onMessage(data);
  }

  #handleDrop(): void {
    if (this.#state === "closed") return;
    clearTimeout(this.#staleTimer);
    this.#staleTimer = undefined;
    const transport = this.#transport;
    this.#transport = undefined;
    // For a stale socket we initiate the close; it's detached, so it can't re-enter here.
    void transport?.close();
    this.#callbacks.onDisconnect();
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    this.#attempt += 1;
    const delay = backoffDelay(this.#attempt, this.#options.backoff, this.#options.random);
    this.#setState({ state: "reconnecting", attempt: this.#attempt, retryInMs: delay });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#open();
    }, delay);
  }

  #armStaleTimer(): void {
    clearTimeout(this.#staleTimer);
    const timeout = this.#options.staleTimeoutMs;
    this.#staleTimer = setTimeout(() => {
      this.#staleTimer = undefined;
      this.#callbacks.onError(
        new TickforgeError("TRANSPORT_ERROR", `No message received for ${timeout}ms; reconnecting`),
      );
      this.#handleDrop();
    }, timeout);
  }

  #setState(event: StatusEvent): void {
    // "reconnecting" repeats on purpose: each attempt carries new attempt/delay info.
    if (event.state === this.#state && event.state !== "reconnecting") return;
    this.#state = event.state;
    this.#callbacks.onStatus(event);
  }

  #clearTimers(): void {
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#staleTimer);
    this.#reconnectTimer = undefined;
    this.#staleTimer = undefined;
  }

  async #closeWithTimeout(transport: Transport): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#options.closeTimeoutMs ?? 1000);
    });
    try {
      await Promise.race([transport.close(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
