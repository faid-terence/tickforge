import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MarketClient,
  type Candle,
  TickforgeError,
  type MarketClientOptions,
  type StatusEvent,
} from "../src/index.js";
import type { WebSocketConstructor } from "../src/transport.js";
import * as fx from "./fixtures/coinbase.js";
import { FakeWebSocket } from "./helpers/fake-websocket.js";

const FakeWS = FakeWebSocket as unknown as WebSocketConstructor;

function createClient(options: Partial<MarketClientOptions> = {}) {
  const client = new MarketClient({
    exchange: "coinbase",
    WebSocket: FakeWS,
    backoff: { initialDelayMs: 1000, maxDelayMs: 1000 },
    ...options,
  });
  const statuses: StatusEvent[] = [];
  const errors: TickforgeError[] = [];
  client.on("status", (s) => statuses.push(s));
  client.on("error", (e) => errors.push(e));
  return { client, statuses, errors };
}

/** Opens the current fake socket and acks the pending subscribe frame. */
function openAndAck(symbols: string[]) {
  const socket = FakeWebSocket.last;
  socket.open();
  socket.receive(fx.subscriptions(symbols));
  return socket;
}

/**
 * What the live Coinbase feed sends for an invalid product: one error per
 * channel (we use 2), then the full subscription snapshot.
 */
function rejectProduct(socket: FakeWebSocket, product: string, snapshot: string[]) {
  socket.receive(fx.error("Failed to subscribe", `${product} is not a valid product`));
  socket.receive(fx.error("Failed to subscribe", `${product} is not a valid product`));
  socket.receive(fx.subscriptions(snapshot));
}

/** A match fixture stamped "now", so it lands in the current fake-time minute. */
function liveMatch(overrides: Record<string, unknown> = {}) {
  return fx.match({ time: new Date().toISOString(), ...overrides });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 1, 12, 0, 0));
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MarketClient: construction", () => {
  it("does not connect until the first subscribe()", () => {
    const { client } = createClient();
    expect(client.state).toBe("idle");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("connects to the Coinbase feed by default, or to `url` if given", () => {
    createClient()
      .client.subscribe(["BTC-USD"])
      .catch(() => {});
    expect(FakeWebSocket.last.url).toBe("wss://ws-feed.exchange.coinbase.com");
    createClient({ url: "ws://localhost:1234" })
      .client.subscribe(["BTC-USD"])
      .catch(() => {});
    expect(FakeWebSocket.last.url).toBe("ws://localhost:1234");
  });

  it("rejects unknown exchanges, including Object.prototype keys", () => {
    expect(() => new MarketClient({ exchange: "kraken" as "coinbase" })).toThrow(TypeError);
    // A plain `ADAPTERS[name]` lookup would resolve this to Object's constructor.
    expect(() => new MarketClient({ exchange: "constructor" as "coinbase" })).toThrow(
      /Unknown exchange/,
    );
  });

  it("falls back to globalThis.WebSocket, and explains how to fix it when missing", () => {
    vi.stubGlobal("WebSocket", FakeWS);
    expect(() => new MarketClient({ exchange: "coinbase" })).not.toThrow();
    vi.stubGlobal("WebSocket", undefined);
    expect(() => new MarketClient({ exchange: "coinbase" })).toThrow(
      expect.objectContaining({
        code: "NO_WEBSOCKET",
        message: expect.stringMatching(/Install the "ws" package and pass it/),
      }),
    );
    vi.unstubAllGlobals();
  });
});

describe("MarketClient: subscribe / unsubscribe", () => {
  it("subscribes once the socket opens and resolves on the ack", async () => {
    const { client } = createClient();
    let resolved = false;
    const done = client
      .subscribe(["btc-usd", " ETH-USD ", "BTC-USD"])
      .then(() => (resolved = true));
    expect(client.state).toBe("connecting");
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sentJson).toEqual([
      {
        type: "subscribe",
        product_ids: ["BTC-USD", "ETH-USD"],
        channels: ["matches", "heartbeat"],
      },
    ]);
    await Promise.resolve();
    expect(resolved).toBe(false); // waits for the ack
    FakeWebSocket.last.receive(fx.subscriptions(["BTC-USD", "ETH-USD"]));
    await done;
    expect(client.symbols).toEqual(["BTC-USD", "ETH-USD"]);
  });

  it("sends only new symbols when already connected, and ignores duplicates", async () => {
    const { client } = createClient();
    const first = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await first;

    const second = client.subscribe(["BTC-USD", "ETH-USD"]);
    expect(socket.sentJson.at(-1)).toMatchObject({ type: "subscribe", product_ids: ["ETH-USD"] });
    socket.receive(fx.subscriptions(["BTC-USD", "ETH-USD"]));
    await second;

    await client.subscribe(["ETH-USD"]); // already subscribed: resolves without a frame
    await client.subscribe([]);
    expect(socket.sent).toHaveLength(2);
  });

  it("matches acks to requests in order", async () => {
    const { client } = createClient();
    const a = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await a;
    const order: string[] = [];
    const b = client.subscribe(["ETH-USD"]).then(() => order.push("eth"));
    const c = client.subscribe(["SOL-USD"]).then(() => order.push("sol"));
    socket.receive(fx.subscriptions(["BTC-USD", "ETH-USD"]));
    await b;
    expect(order).toEqual(["eth"]);
    socket.receive(fx.subscriptions(["BTC-USD", "ETH-USD", "SOL-USD"]));
    await c;
    expect(order).toEqual(["eth", "sol"]);
  });

  it("rejects malformed symbols with a TypeError", async () => {
    const { client } = createClient();
    await expect(client.subscribe(["BTCUSD"])).rejects.toThrow(TypeError);
    await expect(client.subscribe(["BTC-USD; DROP"])).rejects.toThrow(/Invalid symbol/);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("rejects with EXCHANGE_ERROR and un-subscribes the failed symbols", async () => {
    const { client, errors } = createClient();
    const ok = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await ok;

    const bad = client.subscribe(["FOO-BAR"]);
    rejectProduct(socket, "FOO-BAR", ["BTC-USD"]);
    await expect(bad).rejects.toMatchObject({
      code: "EXCHANGE_ERROR",
      message: /not a valid product/,
    });
    expect(client.symbols).toEqual(["BTC-USD"]);
    expect(errors).toHaveLength(0); // reported via the rejection, not twice
  });

  it("does not let one bad request's extra messages settle the next request (regression)", async () => {
    // Coinbase sends 2 errors + 1 snapshot for a bad product. Settling on the
    // first error used to make the 2nd error / snapshot settle the WRONG request.
    const { client } = createClient();
    const ok = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await ok;
    const bad = client.subscribe(["FOO-BAR"]);
    const good = client.subscribe(["ETH-USD"]);
    rejectProduct(socket, "FOO-BAR", ["BTC-USD"]);
    socket.receive(fx.subscriptions(["BTC-USD", "ETH-USD"]));
    await expect(bad).rejects.toMatchObject({ code: "EXCHANGE_ERROR" });
    await expect(good).resolves.toBeUndefined();
    expect(client.symbols).toEqual(["BTC-USD", "ETH-USD"]);
  });

  it("is all-or-nothing on partial success: undoes the accepted part on the exchange", async () => {
    const { client } = createClient();
    const ok = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await ok;
    const mixed = client.subscribe(["ETH-USD", "FOO-BAR"]);
    rejectProduct(socket, "FOO-BAR", ["BTC-USD", "ETH-USD"]); // ETH accepted, FOO not
    await expect(mixed).rejects.toMatchObject({ code: "EXCHANGE_ERROR" });
    expect(client.symbols).toEqual(["BTC-USD"]);
    expect(socket.sentJson.at(-1)).toMatchObject({ type: "unsubscribe", product_ids: ["ETH-USD"] });
    socket.receive(fx.subscriptions(["BTC-USD"])); // ack of the cleanup frame is absorbed
  });

  it("reports symbols the exchange dropped during a re-subscription", async () => {
    const { client, errors } = createClient();
    const ok = client.subscribe(["BTC-USD", "ETH-USD"]);
    openAndAck(["BTC-USD", "ETH-USD"]);
    await ok;
    FakeWebSocket.last.serverClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.last.open();
    rejectProduct(FakeWebSocket.last, "ETH-USD", ["BTC-USD"]); // e.g. delisted meanwhile
    expect(client.symbols).toEqual(["BTC-USD"]);
    expect(errors).toEqual([
      expect.objectContaining({
        code: "EXCHANGE_ERROR",
        message: expect.stringMatching(/dropped: ETH-USD/),
        details: { symbols: ["ETH-USD"] },
      }),
    ]);
  });

  it("goes idle if a re-subscription loses every symbol", async () => {
    const { client } = createClient();
    const ok = client.subscribe(["ETH-USD"]);
    openAndAck(["ETH-USD"]);
    await ok;
    FakeWebSocket.last.serverClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.last.open();
    rejectProduct(FakeWebSocket.last, "ETH-USD", []);
    expect(client.state).toBe("idle");
  });

  it("still surfaces an exchange error that did not cause any request to fail", async () => {
    const { client, errors } = createClient();
    const ok = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await ok;
    const pending = client.subscribe(["ETH-USD"]);
    socket.receive(fx.error("Rate limit warning"));
    socket.receive(fx.subscriptions(["BTC-USD", "ETH-USD"]));
    await expect(pending).resolves.toBeUndefined();
    expect(errors).toEqual([expect.objectContaining({ message: "Rate limit warning" })]);
  });

  it("emits unsolicited exchange errors as `error` events", async () => {
    const { client, errors } = createClient();
    const ok = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await ok;
    socket.receive(fx.error("Something odd"));
    expect(errors).toEqual([
      expect.objectContaining({ code: "EXCHANGE_ERROR", message: "Something odd" }),
    ]);
  });

  it("times out an unacknowledged subscribe, and rolls it back", async () => {
    const { client } = createClient({ requestTimeoutMs: 3000, staleTimeoutMs: 60_000 });
    const keep = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await keep;
    const lost = client.subscribe(["ETH-USD"]);
    const assertion = expect(lost).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    vi.advanceTimersByTime(3000);
    await assertion;
    expect(client.symbols).toEqual(["BTC-USD"]);
    // A late ack for the timed-out frame is consumed without side effects.
    socket.receive(fx.subscriptions(["BTC-USD", "ETH-USD"]));
  });

  it("goes idle when a failed subscribe leaves nothing subscribed", async () => {
    const { client } = createClient({ requestTimeoutMs: 3000 });
    const lost = client.subscribe(["BTC-USD"]);
    const assertion = expect(lost).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    vi.advanceTimersByTime(3000); // exchange unreachable: socket never opens
    await assertion;
    expect(client.state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unsubscribes and resolves on the ack", async () => {
    const { client } = createClient();
    const sub = client.subscribe(["BTC-USD", "ETH-USD"]);
    const socket = openAndAck(["BTC-USD", "ETH-USD"]);
    await sub;
    const unsub = client.unsubscribe(["eth-usd", "SOL-USD"]); // SOL not subscribed: ignored
    expect(socket.sentJson.at(-1)).toMatchObject({ type: "unsubscribe", product_ids: ["ETH-USD"] });
    socket.receive(fx.subscriptions(["BTC-USD"]));
    await unsub;
    expect(client.symbols).toEqual(["BTC-USD"]);
    await client.unsubscribe(["SOL-USD"]);
  });

  it("times out an unacknowledged unsubscribe, but the symbol stays unsubscribed locally", async () => {
    const { client } = createClient({ requestTimeoutMs: 3000, staleTimeoutMs: 60_000 });
    const sub = client.subscribe(["BTC-USD", "ETH-USD"]);
    const socket = openAndAck(["BTC-USD", "ETH-USD"]);
    await sub;
    const trades = vi.fn();
    client.on("trade", trades);
    const unsub = client.unsubscribe(["ETH-USD"]);
    const assertion = expect(unsub).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    vi.advanceTimersByTime(3000);
    await assertion;
    socket.receive(liveMatch({ product_id: "ETH-USD" }));
    expect(trades).not.toHaveBeenCalled();
    expect(client.symbols).toEqual(["BTC-USD"]);
  });

  it("goes idle (no socket, no timers) after unsubscribing from everything", async () => {
    const { client, statuses } = createClient();
    const sub = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await sub;
    await client.unsubscribe(["BTC-USD"]);
    expect(client.state).toBe("idle");
    expect(statuses.at(-1)).toEqual({ state: "idle" });
    expect(socket.readyState).toBeGreaterThanOrEqual(2);
    expect(vi.getTimerCount()).toBe(0);

    // …and wakes up again on the next subscribe.
    const again = client.subscribe(["ETH-USD"]);
    expect(FakeWebSocket.instances).toHaveLength(2);
    openAndAck(["ETH-USD"]);
    await again;
  });

  it("unsubscribing while disconnected just drops the symbol locally", async () => {
    const { client } = createClient();
    const sub = client.subscribe(["BTC-USD", "ETH-USD"]);
    openAndAck(["BTC-USD", "ETH-USD"]);
    await sub;
    FakeWebSocket.last.serverClose();
    await client.unsubscribe(["ETH-USD"]);
    vi.advanceTimersByTime(1000);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sentJson).toEqual([
      expect.objectContaining({ product_ids: ["BTC-USD"] }),
    ]);
  });

  it("unsubscribing everything before the socket opens resolves the pending subscribe", async () => {
    const { client } = createClient();
    const sub = client.subscribe(["BTC-USD"]);
    await client.unsubscribe(["BTC-USD"]);
    await expect(sub).resolves.toBeUndefined();
    expect(client.state).toBe("idle");
  });
});

describe("MarketClient: reconnect", () => {
  it("re-subscribes to every active symbol in one frame after a drop", async () => {
    const { client, statuses } = createClient();
    const sub = client.subscribe(["BTC-USD", "ETH-USD"]);
    openAndAck(["BTC-USD", "ETH-USD"]);
    await sub;

    FakeWebSocket.last.serverClose(1006);
    expect(statuses.at(-1)).toEqual({ state: "reconnecting", attempt: 1, retryInMs: 500 });
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sentJson).toEqual([
      {
        type: "subscribe",
        product_ids: ["BTC-USD", "ETH-USD"],
        channels: ["matches", "heartbeat"],
      },
    ]);
    expect(statuses.map((s) => s.state)).toEqual([
      "connecting",
      "open",
      "reconnecting",
      "connecting",
      "open",
    ]);
  });

  it("carries an unacknowledged subscribe over to the re-subscription", async () => {
    const { client } = createClient();
    const first = client.subscribe(["BTC-USD"]);
    openAndAck(["BTC-USD"]);
    await first;
    const pending = client.subscribe(["ETH-USD"]);
    FakeWebSocket.last.serverClose(); // dropped before the ack
    vi.advanceTimersByTime(1000);
    openAndAck(["BTC-USD", "ETH-USD"]);
    await expect(pending).resolves.toBeUndefined();
  });

  it("an unacknowledged unsubscribe is complete once the socket drops", async () => {
    const { client } = createClient();
    const first = client.subscribe(["BTC-USD", "ETH-USD"]);
    openAndAck(["BTC-USD", "ETH-USD"]);
    await first;
    const pending = client.unsubscribe(["ETH-USD"]);
    FakeWebSocket.last.serverClose();
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects requests that were waiting on a re-subscription that failed", async () => {
    const { client } = createClient();
    const first = client.subscribe(["BTC-USD"]);
    openAndAck(["BTC-USD"]);
    await first;
    const pending = client.subscribe(["ETH-USD"]);
    FakeWebSocket.last.serverClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.last.open();
    rejectProduct(FakeWebSocket.last, "ETH-USD", ["BTC-USD"]);
    await expect(pending).rejects.toMatchObject({ code: "EXCHANGE_ERROR" });
    expect(client.symbols).toEqual(["BTC-USD"]);
  });

  it("reconnects when the feed goes silent (heartbeat timeout)", async () => {
    const { client, statuses } = createClient({ staleTimeoutMs: 5000 });
    const sub = client.subscribe(["BTC-USD"]);
    openAndAck(["BTC-USD"]);
    await sub;
    vi.advanceTimersByTime(4999);
    FakeWebSocket.last.receive(fx.heartbeat); // heartbeats keep it alive
    vi.advanceTimersByTime(4999);
    expect(client.state).toBe("open");
    vi.advanceTimersByTime(1);
    expect(statuses.at(-1)?.state).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sentJson[0]).toMatchObject({
      type: "subscribe",
      product_ids: ["BTC-USD"],
    });
  });
});

describe("MarketClient: data events", () => {
  async function subscribed(symbols = ["BTC-USD"]) {
    const ctx = createClient();
    const sub = ctx.client.subscribe(symbols);
    const socket = openAndAck(symbols);
    await sub;
    return { ...ctx, socket };
  }

  it("emits normalized trades and derived 1m candles", async () => {
    const { client, socket } = await subscribed();
    const trades = vi.fn();
    const candles = vi.fn<(c: Candle) => void>();
    client.on("trade", trades);
    client.on("candle", candles);

    socket.receive(liveMatch({ price: "100", size: "1" }));
    vi.setSystemTime(Date.now() + 60_000); // next minute, without firing the stale timer
    socket.receive(liveMatch({ price: "110", size: "2", trade_id: 11 }));

    expect(trades).toHaveBeenCalledTimes(2);
    expect(trades.mock.calls[0]![0]).toMatchObject({ symbol: "BTC-USD", price: 100, size: 1 });
    expect(candles.mock.calls.map(([c]) => [c.open, c.closed])).toEqual([
      [100, false],
      [100, true],
      [110, false],
    ]);
  });

  it("drops trades for symbols that were unsubscribed but are still in flight", async () => {
    const { client, socket } = await subscribed(["BTC-USD", "ETH-USD"]);
    const trades = vi.fn();
    client.on("trade", trades);
    void client.unsubscribe(["ETH-USD"]);
    socket.receive(liveMatch({ product_id: "ETH-USD" }));
    expect(trades).not.toHaveBeenCalled();
  });

  it("emits PARSE_ERROR for malformed input and keeps working", async () => {
    const { client, socket, errors } = await subscribed();
    const trades = vi.fn();
    client.on("trade", trades);
    socket.receive("{{{not json");
    socket.receive(liveMatch({ price: "NaN" }));
    socket.receive(liveMatch());
    expect(errors.map((e) => e.code)).toEqual(["PARSE_ERROR", "PARSE_ERROR"]);
    expect(errors[0]!.details).toEqual({ raw: "{{{not json" });
    expect(trades).toHaveBeenCalledTimes(1);
    expect(client.state).toBe("open");
  });

  it("truncates huge malformed payloads in error details", async () => {
    const { socket, errors } = await subscribed();
    socket.receive("x".repeat(10_000));
    expect((errors[0]!.details!.raw as string).length).toBeLessThan(250);
  });

  it("a throwing user listener does not break the client", async () => {
    const { client, socket } = await subscribed();
    const deferred: (() => void)[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((cb) => void deferred.push(cb));
    const bug = new Error("user bug");
    client.on("trade", () => {
      throw bug;
    });
    const second = vi.fn();
    client.on("trade", second);
    expect(() => {
      socket.receive(liveMatch());
    }).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    expect(client.state).toBe("open");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toThrow(bug); // surfaced asynchronously, not swallowed
  });
});

describe("MarketClient: async iteration", () => {
  it("yields trades for one symbol and detaches on break", async () => {
    const { client } = createClient();
    const sub = client.subscribe(["BTC-USD", "ETH-USD"]);
    const socket = openAndAck(["BTC-USD", "ETH-USD"]);
    await sub;

    const iterator = client.trades("btc-usd");
    socket.receive(liveMatch({ product_id: "ETH-USD" }));
    socket.receive(liveMatch({ price: "1" }));
    socket.receive(liveMatch({ price: "2" }));

    const prices: number[] = [];
    for await (const trade of iterator) {
      prices.push(trade.price);
      if (prices.length === 2) break;
    }
    expect(prices).toEqual([1, 2]);
    expect(client.listenerCount("trade")).toBe(0);
  });

  it("ends iterators when the client closes", async () => {
    const { client } = createClient();
    const iterator = client.trades("BTC-USD");
    const next = iterator.next();
    await client.close();
    await expect(next).resolves.toEqual({ value: undefined, done: true });
  });

  it("respects bufferSize by dropping the oldest trades", async () => {
    const { client } = createClient();
    const sub = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await sub;
    const iterator = client.trades("BTC-USD", { bufferSize: 2 });
    for (const price of ["1", "2", "3"]) socket.receive(liveMatch({ price }));
    expect((await iterator.next()).value?.price).toBe(2);
  });
});

describe("MarketClient: close()", () => {
  it("rejects pending requests, stops all timers, emits closed, and removes listeners", async () => {
    const { client, statuses } = createClient();
    const pending = client.subscribe(["BTC-USD"]);
    FakeWebSocket.last.open(); // subscribe sent, ack never arrives
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    const closing = client.close();
    await expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await closing;

    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.last.readyState).toBe(3);
    expect(statuses.at(-1)).toEqual({ state: "closed" });
    expect(client.listenerCount("status")).toBe(0);
    expect(client.state).toBe("closed");
  });

  it("is idempotent", async () => {
    const { client } = createClient();
    expect(client.close()).toBe(client.close());
    await client.close();
  });

  it("closes cleanly while waiting to reconnect", async () => {
    const { client } = createClient();
    const sub = client.subscribe(["BTC-USD"]);
    openAndAck(["BTC-USD"]);
    await sub;
    FakeWebSocket.last.serverClose();
    await client.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("makes the client unusable afterwards", async () => {
    const { client } = createClient();
    await client.close();
    await expect(client.subscribe(["BTC-USD"])).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(client.unsubscribe(["BTC-USD"])).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(() => client.trades("BTC-USD")).toThrow(TickforgeError);
  });
});

describe("MarketClient: rollback never removes a symbol someone else owns", () => {
  it("a failed request leaves symbols that an earlier successful subscribe() owns", async () => {
    const { client } = createClient();
    const owner = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await owner;

    const failing = client.subscribe(["BTC-USD", "FOO-BAR"]);
    // Only the symbol this call is responsible for goes on the wire.
    expect(socket.sentJson.at(-1)).toMatchObject({ type: "subscribe", product_ids: ["FOO-BAR"] });
    rejectProduct(socket, "FOO-BAR", ["BTC-USD"]);
    await expect(failing).rejects.toMatchObject({ code: "EXCHANGE_ERROR" });

    expect(client.symbols).toEqual(["BTC-USD"]);
    expect(socket.sentJson.filter((m) => m.type === "unsubscribe")).toEqual([]);
  });

  it("a later call overlapping a still-pending one is not resolved early, nor undone by it", async () => {
    const { client } = createClient();
    const first = client.subscribe(["SOL-USD"]);
    const socket = openAndAck(["SOL-USD"]);
    await first;

    const a = client.subscribe(["BTC-USD", "FOO-BAR"]); // will fail because of FOO-BAR
    const b = client.subscribe(["BTC-USD"]); // overlaps A while A is pending
    let bSettled = false;
    void b.then(() => (bSettled = true));
    expect(socket.sentJson.at(-1)).toMatchObject({ type: "subscribe", product_ids: ["BTC-USD"] });

    rejectProduct(socket, "FOO-BAR", ["SOL-USD", "BTC-USD"]); // ack for A
    await expect(a).rejects.toMatchObject({ code: "EXCHANGE_ERROR" });
    await Promise.resolve();
    expect(bSettled).toBe(false); // B waits for its own ack
    expect(client.symbols).toContain("BTC-USD"); // B's claim kept it
    expect(socket.sentJson.filter((m) => m.type === "unsubscribe")).toEqual([]);

    socket.receive(fx.subscriptions(["SOL-USD", "BTC-USD"])); // ack for B
    await expect(b).resolves.toBeUndefined();
    expect(client.symbols).toEqual(["SOL-USD", "BTC-USD"]);
  });

  it("a later failing call does not undo a symbol an earlier pending call then confirms", async () => {
    const { client } = createClient();
    const first = client.subscribe(["SOL-USD"]);
    const socket = openAndAck(["SOL-USD"]);
    await first;

    const a = client.subscribe(["BTC-USD"]);
    const b = client.subscribe(["BTC-USD", "FOO-BAR"]);
    socket.receive(fx.subscriptions(["SOL-USD", "BTC-USD"])); // A succeeds
    rejectProduct(socket, "FOO-BAR", ["SOL-USD", "BTC-USD"]); // B fails
    await expect(a).resolves.toBeUndefined();
    await expect(b).rejects.toMatchObject({ code: "EXCHANGE_ERROR" });
    expect(client.symbols).toEqual(["SOL-USD", "BTC-USD"]);
  });

  it("requests judged by the same re-subscription frame respect each other's claims", async () => {
    const { client } = createClient();
    const a = client.subscribe(["BTC-USD", "FOO-BAR"]);
    const b = client.subscribe(["BTC-USD"]);
    const socket = FakeWebSocket.last;
    socket.open(); // one frame carries both waiting requests
    expect(socket.sentJson).toEqual([
      expect.objectContaining({ product_ids: ["BTC-USD", "FOO-BAR"] }),
    ]);
    rejectProduct(socket, "FOO-BAR", ["BTC-USD"]);
    await expect(a).rejects.toMatchObject({ code: "EXCHANGE_ERROR" });
    await expect(b).resolves.toBeUndefined();
    expect(client.symbols).toEqual(["BTC-USD"]);
    expect(client.state).toBe("open");
  });

  it("undoes on the exchange a symbol confirmed only after its request timed out", async () => {
    const { client } = createClient({ requestTimeoutMs: 3000, staleTimeoutMs: 60_000 });
    const keep = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await keep;
    const late = client.subscribe(["ETH-USD"]);
    const assertion = expect(late).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    vi.advanceTimersByTime(3000);
    await assertion;
    socket.receive(fx.subscriptions(["BTC-USD", "ETH-USD"])); // the late ack
    expect(socket.sentJson.at(-1)).toMatchObject({ type: "unsubscribe", product_ids: ["ETH-USD"] });
    expect(client.symbols).toEqual(["BTC-USD"]);
  });

  it("does not send a duplicate unsubscribe if the user already unsubscribed while pending", async () => {
    const { client } = createClient();
    const first = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await first;
    const sub = client.subscribe(["ETH-USD"]);
    const unsub = client.unsubscribe(["ETH-USD"]);
    socket.receive(fx.subscriptions(["BTC-USD", "ETH-USD"])); // ack for the subscribe
    socket.receive(fx.subscriptions(["BTC-USD"])); // ack for the unsubscribe
    await sub;
    await unsub;
    expect(socket.sentJson.filter((m) => m.type === "unsubscribe")).toHaveLength(1);
  });
});

describe("MarketClient: observable drops in trades()", () => {
  it("counts dropped trades and emits one warning per overflow episode", async () => {
    const { client } = createClient();
    const sub = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await sub;
    const warnings = vi.fn();
    client.on("warning", warnings);

    const iterator = client.trades("btc-usd", { bufferSize: 2 });
    for (const price of ["1", "2", "3", "4", "5"]) socket.receive(liveMatch({ price }));

    expect(iterator.dropped).toBe(3);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith({
      code: "TRADES_DROPPED",
      symbol: "BTC-USD",
      dropped: 1,
      message: expect.stringMatching(/raise bufferSize/),
    });
    expect((await iterator.next()).value?.price).toBe(4);
  });

  it("rejects an invalid bufferSize", () => {
    const { client } = createClient();
    expect(() => client.trades("BTC-USD", { bufferSize: 0 })).toThrow(RangeError);
  });
});

describe("MarketClient: candle timing", () => {
  async function subscribedForMinutes() {
    // Long stale timeout so advancing minutes of fake time does not reconnect.
    const ctx = createClient({ staleTimeoutMs: 600_000 });
    const sub = ctx.client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await sub;
    const candles: Candle[] = [];
    ctx.client.on("candle", (c) => candles.push(c));
    return { ...ctx, socket, candles };
  }
  const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("closes a candle 2s after its minute ends even if no further trade arrives", async () => {
    const { socket, candles } = await subscribedForMinutes();
    vi.advanceTimersByTime(10_000);
    socket.receive(liveMatch({ price: "100" }));
    expect(candles).toEqual([expect.objectContaining({ openTime: T0, closed: false })]);

    vi.advanceTimersByTime(60_000 - 10_000 + 2_000 - 1); // 12:01:01.999
    expect(candles).toHaveLength(1);
    vi.advanceTimersByTime(1); // 12:01:02.000
    expect(candles.at(-1)).toMatchObject({ openTime: T0, close: 100, closed: true });

    vi.advanceTimersByTime(5 * 60_000); // quiet minutes: no empty candles
    expect(candles).toHaveLength(2);
  });

  it("closes on the first trade of a later minute, exactly once", async () => {
    const { socket, candles } = await subscribedForMinutes();
    socket.receive(liveMatch({ price: "100" }));
    vi.setSystemTime(T0 + 60_500); // inside the grace period of minute 0
    socket.receive(liveMatch({ price: "110" }));
    expect(candles.map((c) => [c.openTime, c.closed])).toEqual([
      [T0, false],
      [T0, true],
      [T0 + 60_000, false],
    ]);
    vi.advanceTimersByTime(2_000); // the timer finds nothing left to close for minute 0
    expect(candles.filter((c) => c.closed)).toHaveLength(1);
  });

  it("emits a late trade but leaves the closed candle untouched", async () => {
    const { client, socket, candles } = await subscribedForMinutes();
    const trades = vi.fn();
    client.on("trade", trades);
    socket.receive(liveMatch({ price: "100" }));
    vi.advanceTimersByTime(62_000);
    socket.receive(fx.match({ time: new Date(T0 + 59_000).toISOString(), price: "999" }));
    expect(trades).toHaveBeenCalledTimes(2);
    expect(candles.at(-1)).toMatchObject({ closed: true, high: 100 });
    expect(candles).toHaveLength(2);
  });

  it("leaves no candle timer running after going idle or closing", async () => {
    const { client, socket } = await subscribedForMinutes();
    socket.receive(liveMatch());
    await client.unsubscribe(["BTC-USD"]);
    expect(vi.getTimerCount()).toBe(0);

    const again = client.subscribe(["BTC-USD"]);
    openAndAck(["BTC-USD"]);
    await again;
    FakeWebSocket.last.receive(liveMatch());
    await client.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("MarketClient: subscribing again after idle", () => {
  it("opens a fresh connection that carries only the new symbols", async () => {
    const { client, statuses } = createClient();
    const first = client.subscribe(["BTC-USD"]);
    const oldSocket = openAndAck(["BTC-USD"]);
    await first;
    await client.unsubscribe(["BTC-USD"]);
    expect(client.state).toBe("idle");
    statuses.length = 0;

    const trades = vi.fn();
    client.on("trade", trades);
    const again = client.subscribe(["ETH-USD"]);
    const newSocket = FakeWebSocket.last;
    expect(newSocket).not.toBe(oldSocket);
    newSocket.open();
    expect(newSocket.sentJson).toEqual([
      { type: "subscribe", product_ids: ["ETH-USD"], channels: ["matches", "heartbeat"] },
    ]);
    newSocket.receive(fx.subscriptions(["ETH-USD"]));
    await again;

    expect(statuses.map((s) => s.state)).toEqual(["connecting", "open"]);
    expect(client.symbols).toEqual(["ETH-USD"]);
    newSocket.receive(liveMatch({ product_id: "ETH-USD" }));
    expect(trades).toHaveBeenCalledTimes(1);
  });

  it("ignores the old socket even if it is still closing when the new one opens", async () => {
    const { client } = createClient();
    const first = client.subscribe(["BTC-USD"]);
    const oldSocket = openAndAck(["BTC-USD"]);
    await first;
    const unsub = client.unsubscribe(["BTC-USD"]);
    const again = client.subscribe(["BTC-USD"]); // same tick: old close not finished yet
    await unsub;
    openAndAck(["BTC-USD"]);
    await again;

    // Late events from the old socket must not trigger a reconnect or a duplicate trade.
    const trades = vi.fn();
    client.on("trade", trades);
    oldSocket.receive(liveMatch());
    oldSocket.serverClose(1006);
    expect(client.state).toBe("open");
    expect(trades).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("connects immediately, without backoff, after going idle from `reconnecting`", async () => {
    const { client } = createClient({ backoff: { initialDelayMs: 30_000, maxDelayMs: 30_000 } });
    const first = client.subscribe(["BTC-USD"]);
    openAndAck(["BTC-USD"]);
    await first;
    FakeWebSocket.last.serverClose();
    expect(client.state).toBe("reconnecting");
    await client.unsubscribe(["BTC-USD"]);
    expect(client.state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);

    const again = client.subscribe(["ETH-USD"]);
    expect(client.state).toBe("connecting");
    expect(FakeWebSocket.instances).toHaveLength(2);
    openAndAck(["ETH-USD"]);
    await again;
  });
});

describe("MarketClient: custom candle builder", () => {
  it("routes trades through the supplied builder and emits what it returns", async () => {
    const built = { open: 1 } as unknown as Candle;
    const builder = {
      add: vi.fn(() => [built]),
      closeUntil: vi.fn(() => []),
      nextMinuteEnd: vi.fn(() => undefined),
      delete: vi.fn(),
    };
    const { client } = createClient({ candleBuilder: builder });
    const candles = vi.fn();
    client.on("candle", candles);
    const sub = client.subscribe(["BTC-USD"]);
    const socket = openAndAck(["BTC-USD"]);
    await sub;
    socket.receive(liveMatch());
    expect(builder.add).toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTC-USD" }));
    expect(candles).toHaveBeenCalledWith(built);
    await client.unsubscribe(["BTC-USD"]);
    expect(builder.delete).toHaveBeenCalledWith("BTC-USD");
  });
});
