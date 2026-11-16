import { TickforgeError } from "./types.js";

/**
 * The subset of the WebSocket API tickforge needs. Both the browser's
 * native `WebSocket` and the `ws` package for Node satisfy it, which is what
 * lets one code path run everywhere.
 * @public
 */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /**
   * The event is typed `unknown` on purpose: each runtime has its own event
   * classes, and a precise type here would reject some of them (e.g. `ws`).
   * tickforge reads the fields it needs defensively instead.
   */
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: unknown) => void,
  ): void;
}

/** Event fields tickforge reads, across browsers and `ws`. All optional. */
interface SocketEvent {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
  readonly error?: unknown;
  readonly message?: string;
}

/**
 * A WebSocket constructor, e.g. `globalThis.WebSocket` or `import WebSocket from "ws"`.
 * @public
 */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** Callbacks a transport reports to. */
export interface TransportHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
  onError(error: unknown): void;
}

/** A live connection. Created by {@link openTransport}. */
export interface Transport {
  send(data: string): void;
  /** Closes the socket. Resolves once it is fully closed. Idempotent. */
  close(): Promise<void>;
}

const CLOSED = 3;
const decoder = new TextDecoder();

/** Turns a frame payload into text; exchanges we support only send JSON text. */
function decodeFrame(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return decoder.decode(data);
  if (ArrayBuffer.isView(data)) return decoder.decode(data); // Node Buffer, Uint8Array
  return String(data); // Unknown frame type: the parser will reject it.
}

/**
 * Resolves the WebSocket implementation to use: an explicit one wins,
 * otherwise the runtime's global (browsers, workers, Node 22+).
 */
export function resolveWebSocket(explicit?: WebSocketConstructor): WebSocketConstructor {
  if (explicit) return explicit;
  const global = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (global) return global;
  throw new TickforgeError(
    "NO_WEBSOCKET",
    'No global WebSocket in this runtime. Install the "ws" package and pass it: ' +
      'new MarketClient({ exchange: "coinbase", WebSocket })',
  );
}

/**
 * Opens a socket and adapts its events to {@link TransportHandlers}.
 *
 * Once `close()` has been called, no further handler calls are made. That
 * guarantees a socket that is being torn down can never trigger work (such
 * as a reconnect) in the layer above.
 */
export function openTransport(
  WebSocketImpl: WebSocketConstructor,
  url: string,
  handlers: TransportHandlers,
): Transport {
  const socket = new WebSocketImpl(url);
  if ("binaryType" in socket) socket.binaryType = "arraybuffer";

  let detached = false;
  let closed = socket.readyState === CLOSED;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  socket.addEventListener("open", () => {
    if (!detached) handlers.onOpen();
  });
  socket.addEventListener("message", (event) => {
    if (!detached) handlers.onMessage(decodeFrame((event as SocketEvent).data));
  });
  socket.addEventListener("error", (event) => {
    const { error, message } = event as SocketEvent;
    if (!detached) handlers.onError(error ?? message ?? event);
  });
  socket.addEventListener("close", (event) => {
    const { code, reason } = event as SocketEvent;
    closed = true;
    resolveClosed?.();
    if (!detached) handlers.onClose(code ?? 1006, reason ?? "");
  });

  return {
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      detached = true;
      if (closed) return Promise.resolve();
      socket.close(1000, "client closed");
      return closedPromise;
    },
  };
}
