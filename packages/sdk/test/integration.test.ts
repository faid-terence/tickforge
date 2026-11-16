import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WS from "ws";
import {
  MarketClient,
  type StatusEvent,
  type Trade,
  type WebSocketConstructor,
} from "../src/index.js";
import * as fx from "./fixtures/coinbase.js";
import { MockCoinbaseServer } from "./helpers/mock-coinbase-server.js";

/** Resolves with the first value of `event` matching `predicate`. */
function waitFor<T>(
  subscribe: (cb: (v: T) => void) => () => void,
  predicate: (v: T) => boolean = () => true,
) {
  return new Promise<T>((resolve) => {
    const off = subscribe((value) => {
      if (predicate(value)) {
        off();
        resolve(value);
      }
    });
  });
}

const implementations: [string, WebSocketConstructor][] = [
  ["the ws package", WS],
  ["native globalThis.WebSocket", globalThis.WebSocket],
];

describe.each(implementations)(
  "end to end against a mock Coinbase server, using %s",
  (_name, WebSocketImpl) => {
    let server: MockCoinbaseServer;
    let client: MarketClient;

    beforeEach(async () => {
      server = await MockCoinbaseServer.start();
      client = new MarketClient({
        exchange: "coinbase",
        url: server.url,
        WebSocket: WebSocketImpl,
        backoff: { initialDelayMs: 20, maxDelayMs: 50 },
      });
    });

    afterEach(async () => {
      await client.close();
      await server.stop();
    });

    it("subscribes and streams trades and candles", async () => {
      await client.subscribe(["BTC-USD"]);
      expect(server.received).toEqual([
        { type: "subscribe", product_ids: ["BTC-USD"], channels: ["matches", "heartbeat"] },
      ]);

      const trade = waitFor<Trade>((cb) => client.on("trade", cb));
      const candle = waitFor((cb) => client.on("candle", cb));
      server.broadcast(fx.match({ price: "64000.5", size: "0.01" }));
      expect(await trade).toMatchObject({ symbol: "BTC-USD", price: 64000.5, size: 0.01 });
      expect(await candle).toMatchObject({ open: 64000.5, volume: 0.01, closed: false });
    });

    it("rejects unknown products with the exchange's reason", async () => {
      await expect(client.subscribe(["DOGE-XYZ"])).rejects.toMatchObject({
        code: "EXCHANGE_ERROR",
        message: expect.stringMatching(/DOGE-XYZ is not a valid product/),
      });
    });

    it("subscribes the valid part of a mixed request only if the whole request succeeds", async () => {
      await client.subscribe(["BTC-USD"]);
      await expect(client.subscribe(["ETH-USD", "DOGE-XYZ"])).rejects.toMatchObject({
        code: "EXCHANGE_ERROR",
      });
      expect(client.symbols).toEqual(["BTC-USD"]);
      // The client undid ETH-USD on the server too.
      await new Promise((r) => setTimeout(r, 30));
      expect(server.received.at(-1)).toMatchObject({
        type: "unsubscribe",
        product_ids: ["ETH-USD"],
      });
    });

    it("reconnects and re-subscribes after the server drops the connection", async () => {
      await client.subscribe(["BTC-USD", "ETH-USD"]);
      const reopened = waitFor<StatusEvent>(
        (cb) => client.on("status", cb),
        (s) => s.state === "open",
      );
      server.dropAll();
      await reopened;
      await waitFor<Trade>((cb) => {
        const off = client.on("trade", cb);
        // Wait until the server has processed the re-subscription before pushing.
        const poll = setInterval(() => {
          if (server.received.length >= 2) {
            clearInterval(poll);
            server.broadcast(fx.match({ product_id: "ETH-USD" }));
          }
        }, 5);
        return () => {
          clearInterval(poll);
          off();
        };
      });
      expect(server.connections).toBe(2);
      expect(server.received.at(-1)).toEqual({
        type: "subscribe",
        product_ids: ["BTC-USD", "ETH-USD"],
        channels: ["matches", "heartbeat"],
      });
    });

    it("survives malformed frames from the server", async () => {
      await client.subscribe(["BTC-USD"]);
      const error = waitFor((cb) => client.on("error", cb));
      server.broadcast("garbage");
      expect(await error).toMatchObject({ code: "PARSE_ERROR" });
      const trade = waitFor<Trade>((cb) => client.on("trade", cb));
      server.broadcast(fx.match());
      await trade;
    });

    it("supports for-await iteration", async () => {
      await client.subscribe(["BTC-USD"]);
      const received: number[] = [];
      const loop = (async () => {
        for await (const t of client.trades("BTC-USD")) {
          received.push(t.price);
          if (received.length === 3) break;
        }
      })();
      for (const price of ["1", "2", "3"]) server.broadcast(fx.match({ price }));
      await loop;
      expect(received).toEqual([1, 2, 3]);
    });

    it("goes idle when everything is unsubscribed, and reconnects cleanly on the next subscribe", async () => {
      await client.subscribe(["BTC-USD"]);
      await client.unsubscribe(["BTC-USD"]);
      expect(client.state).toBe("idle");
      await new Promise((r) => setTimeout(r, 20));
      expect(server.clients).toHaveLength(0);

      await client.subscribe(["ETH-USD"]);
      expect(client.state).toBe("open");
      expect(server.connections).toBe(2);
      expect(server.received.at(-1)).toEqual({
        type: "subscribe",
        product_ids: ["ETH-USD"],
        channels: ["matches", "heartbeat"],
      });
      const trade = waitFor<Trade>((cb) => client.on("trade", cb));
      server.broadcast(fx.match({ product_id: "ETH-USD" }));
      expect(await trade).toMatchObject({ symbol: "ETH-USD" });
    });

    it("close() closes the socket on the server side too", async () => {
      await client.subscribe(["BTC-USD"]);
      expect(server.clients).toHaveLength(1);
      await client.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(server.clients).toHaveLength(0);
    });
  },
);
