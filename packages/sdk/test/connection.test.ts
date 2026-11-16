import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, type ConnectionCallbacks } from "../src/connection.js";
import type { WebSocketConstructor } from "../src/transport.js";
import { FakeWebSocket } from "./helpers/fake-websocket.js";

const FakeWS = FakeWebSocket as unknown as WebSocketConstructor;

function setup(overrides: Partial<ConstructorParameters<typeof Connection>[0]> = {}) {
  const callbacks = {
    onOpen: vi.fn<ConnectionCallbacks["onOpen"]>(),
    onMessage: vi.fn<ConnectionCallbacks["onMessage"]>(),
    onDisconnect: vi.fn<ConnectionCallbacks["onDisconnect"]>(),
    onStatus: vi.fn<ConnectionCallbacks["onStatus"]>(),
    onError: vi.fn<ConnectionCallbacks["onError"]>(),
  } satisfies ConnectionCallbacks;
  const connection = new Connection(
    {
      url: "wss://example.test",
      WebSocket: FakeWS,
      staleTimeoutMs: 5000,
      backoff: { initialDelayMs: 1000, maxDelayMs: 8000 },
      random: () => 0.999, // deterministic: delay ≈ ceiling
      ...overrides,
    },
    callbacks,
  );
  const states = () => callbacks.onStatus.mock.calls.map(([s]) => s.state);
  return { connection, callbacks, states };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Connection", () => {
  it("starts idle and connects on connect()", () => {
    const { connection, callbacks, states } = setup();
    expect(connection.state).toBe("idle");
    connection.connect();
    connection.connect(); // idempotent
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last.url).toBe("wss://example.test");
    FakeWebSocket.last.open();
    expect(states()).toEqual(["connecting", "open"]);
    expect(callbacks.onOpen).toHaveBeenCalledTimes(1);
  });

  it("asks for ArrayBuffer frames and decodes binary frames as UTF-8", () => {
    const { connection, callbacks } = setup();
    connection.connect();
    const socket = FakeWebSocket.last;
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    socket.receiveRaw(new TextEncoder().encode('{"a":1}').buffer);
    socket.receiveRaw(new TextEncoder().encode('{"b":2}'));
    socket.receiveRaw(12345);
    expect(callbacks.onMessage.mock.calls.map(([d]) => d)).toEqual(['{"a":1}', '{"b":2}', "12345"]);
  });

  it("send() only works while open", () => {
    const { connection } = setup();
    expect(connection.send("x")).toBe(false);
    connection.connect();
    expect(connection.send("x")).toBe(false);
    FakeWebSocket.last.open();
    expect(connection.send("x")).toBe(true);
    expect(FakeWebSocket.last.sent).toEqual(["x"]);
  });

  it("reconnects with exponential backoff after drops", () => {
    const { connection, callbacks } = setup();
    connection.connect();

    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      FakeWebSocket.last.serverClose(1006); // fails before ever opening
      const last = callbacks.onStatus.mock.calls.at(-1)![0];
      expect(last.state).toBe("reconnecting");
      expect(last.attempt).toBe(i + 1);
      delays.push(last.retryInMs!);
      const before = FakeWebSocket.instances.length;
      vi.advanceTimersByTime(last.retryInMs! - 1);
      expect(FakeWebSocket.instances.length).toBe(before); // not yet
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances.length).toBe(before + 1);
    }
    expect(delays).toEqual([999, 1998, 3996, 7992, 7992]); // doubles, then capped at 8000
    expect(callbacks.onDisconnect).toHaveBeenCalledTimes(5);
  });

  it("resets the backoff only after a message is received, not merely on open", () => {
    const { connection, callbacks } = setup();
    const lastDelay = () => callbacks.onStatus.mock.calls.at(-1)![0].retryInMs!;
    connection.connect();
    FakeWebSocket.last.serverClose();
    vi.advanceTimersByTime(lastDelay());

    // Opens, then drops without a message: the attempt counter keeps growing.
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose();
    expect(lastDelay()).toBe(1998);
    vi.advanceTimersByTime(lastDelay());

    // Opens and receives data: healthy, so the next drop starts over.
    FakeWebSocket.last.open();
    FakeWebSocket.last.receive({ type: "heartbeat" });
    FakeWebSocket.last.serverClose();
    expect(lastDelay()).toBe(999);
  });

  it("treats a silent connection as stale and reconnects", () => {
    const { connection, callbacks, states } = setup();
    connection.connect();
    const first = FakeWebSocket.last;
    first.open();

    // Messages keep it alive.
    vi.advanceTimersByTime(4000);
    first.receive({ type: "heartbeat" });
    vi.advanceTimersByTime(4000);
    expect(states().at(-1)).toBe("open");

    // Then silence.
    vi.advanceTimersByTime(1000);
    expect(states().at(-1)).toBe("reconnecting");
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "TRANSPORT_ERROR",
        message: expect.stringMatching(/No message/),
      }),
    );
    expect(first.readyState).toBeGreaterThanOrEqual(2); // we closed the stale socket
  });

  it("does not react to events from a socket it already abandoned", async () => {
    const { connection, callbacks } = setup();
    connection.connect();
    const stale = FakeWebSocket.last;
    stale.open();
    vi.advanceTimersByTime(5000); // stale → reconnect scheduled
    const disconnects = callbacks.onDisconnect.mock.calls.length;
    await Promise.resolve(); // let the fake close event fire
    stale.receive({ late: true });
    stale.error();
    expect(callbacks.onDisconnect).toHaveBeenCalledTimes(disconnects);
    expect(callbacks.onMessage).not.toHaveBeenCalled();
  });

  it("reports socket errors as TRANSPORT_ERROR", () => {
    const { connection, callbacks } = setup();
    connection.connect();
    FakeWebSocket.last.error(new Error("ECONNREFUSED"));
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TRANSPORT_ERROR" }),
    );
  });

  it("retries when the WebSocket constructor throws", () => {
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a constructor that throws is the point
    const Throwing = class {
      constructor() {
        calls += 1;
        throw new SyntaxError("bad url");
      }
    } as unknown as WebSocketConstructor;
    const { connection, callbacks, states } = setup({ WebSocket: Throwing });
    connection.connect();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TRANSPORT_ERROR" }),
    );
    expect(states()).toEqual(["connecting", "reconnecting"]);
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(2);
  });

  it("close() stops all timers, closes the socket, and is idempotent", async () => {
    const { connection, callbacks, states } = setup();
    connection.connect();
    FakeWebSocket.last.open();
    expect(vi.getTimerCount()).toBeGreaterThan(0); // stale timer armed

    await Promise.all([connection.close(), connection.close()]);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.last.readyState).toBe(3);
    expect(states().at(-1)).toBe("closed");
    expect(states().filter((s) => s === "closed")).toHaveLength(1);
    connection.connect();
    expect(FakeWebSocket.instances).toHaveLength(1); // cannot be reopened
    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
  });

  it("close() cancels a pending reconnect", async () => {
    const { connection } = setup();
    connection.connect();
    FakeWebSocket.last.serverClose();
    await connection.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("close() gives up waiting for a socket that never finishes closing", async () => {
    const { connection } = setup({ closeTimeoutMs: 1000 });
    connection.connect();
    const socket = FakeWebSocket.last;
    socket.open();
    socket.close = () => {}; // never emits "close"
    const closed = connection.close();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(closed).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suspend() returns to idle with no timers, and can connect again", () => {
    const { connection, states } = setup();
    connection.connect();
    FakeWebSocket.last.open();
    connection.suspend();
    connection.suspend(); // idempotent
    expect(connection.state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
    expect(states().at(-1)).toBe("idle");
    connection.connect();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
