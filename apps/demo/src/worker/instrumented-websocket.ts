/**
 * Wraps a WebSocket class so the demo can (1) show the subscribe /
 * unsubscribe frames on the wire and (2) cut the connection on demand.
 *
 * It plugs into the SDK through its public `WebSocket` option: the same
 * transport abstraction that lets Node users pass the `ws` package. The SDK
 * needs no test-only hooks; to it, a simulated drop is indistinguishable
 * from a real network failure.
 */

/** The parts of a WebSocket class this wrapper needs. */
export interface BaseSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close", listener: (event: { data?: unknown }) => void): void;
}
export type BaseSocketClass = new (url: string) => BaseSocket;

export interface WireHooks {
  onSend(data: string): void;
  onReceive(data: unknown): void;
}

/** Close code for simulated drops (4000–4999 is reserved for applications). */
export const SIMULATED_DROP_CODE = 4000;

/** Thrown by the constructor during a simulated outage, like an unreachable network. */
export class SimulatedOutageError extends Error {
  override readonly name = "SimulatedOutageError";
}

export function instrumentWebSocket<T extends BaseSocketClass>(
  Base: T,
  hooks: WireHooks,
  now: () => number = Date.now,
) {
  const open = new Set<BaseSocket>();
  let refuseUntil = 0;

  // A mixin subclass keeps the native class's full behaviour (readyState,
  // binaryType, event dispatch) and only intercepts what the demo needs.
  class InstrumentedWebSocket extends (Base as BaseSocketClass) {
    constructor(url: string) {
      // During a simulated outage, connecting fails the way an unreachable
      // network does; the SDK catches it and retries with backoff.
      if (now() < refuseUntil)
        throw new SimulatedOutageError("simulated outage: network unreachable");
      super(url);
      open.add(this);
      this.addEventListener("message", (event) => {
        hooks.onReceive(event.data);
      });
      this.addEventListener("close", () => {
        open.delete(this);
      });
    }

    override send(data: string): void {
      hooks.onSend(data);
      super.send(data);
    }
  }

  return {
    WebSocket: InstrumentedWebSocket as unknown as T,
    /**
     * Closes every live socket, as if the network had dropped, and refuses new
     * connections for `outageMs`. Returns how many sockets were closed.
     */
    dropAll: (outageMs = 0): number => {
      refuseUntil = now() + outageMs;
      const count = open.size;
      for (const socket of open) socket.close(SIMULATED_DROP_CODE, "simulated disconnect");
      return count;
    },
  };
}

/**
 * Turns a raw frame into a one-line description for the connection log, or
 * `undefined` for high-volume frames (trades, heartbeats) that would drown it.
 */
export function describeFrame(direction: "out" | "in", data: unknown): string | undefined {
  if (typeof data !== "string") return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, unknown>;
  const ids = (value: unknown) =>
    Array.isArray(value) && value.every((v) => typeof v === "string") ? value.join(", ") : "";

  if (direction === "out" && (m.type === "subscribe" || m.type === "unsubscribe")) {
    return `${m.type} [${ids(m.product_ids)}]`;
  }
  if (direction === "in" && m.type === "subscriptions" && Array.isArray(m.channels)) {
    const matches = (m.channels as unknown[]).find(
      (c): c is { product_ids: unknown } =>
        typeof c === "object" && c !== null && (c as { name?: unknown }).name === "matches",
    );
    return `subscriptions ack [${ids(matches?.product_ids)}]`;
  }
  if (direction === "in" && m.type === "last_match" && typeof m.product_id === "string") {
    const id =
      typeof m.trade_id === "number" || typeof m.trade_id === "string" ? String(m.trade_id) : "?";
    return `last_match ${m.product_id} #${id} (exchange's latest trade)`;
  }
  if (direction === "in" && m.type === "error") {
    return `error: ${typeof m.message === "string" ? m.message : "unknown"}`;
  }
  return undefined;
}
