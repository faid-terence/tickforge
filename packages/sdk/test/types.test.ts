import { describe, expectTypeOf, it } from "vitest";
import WS from "ws";
import type {
  Candle,
  MarketClient,
  StatusEvent,
  TickforgeError,
  Trade,
  TradeIterator,
  WarningEvent,
  WebSocketConstructor,
} from "../src/index.js";

// Compile-time checks: these fail `pnpm typecheck` if the public types regress.
describe("public types", () => {
  it("accept both the `ws` package and the native WebSocket", () => {
    expectTypeOf(WS).toExtend<WebSocketConstructor>();
    expectTypeOf(globalThis.WebSocket).toExtend<WebSocketConstructor>();
  });

  it("type event payloads by event name", () => {
    // Type-checked, never executed.
    const _check = (client: MarketClient) => {
      client.on("trade", (t) => expectTypeOf(t).toEqualTypeOf<Trade>());
      client.on("candle", (c) => expectTypeOf(c).toEqualTypeOf<Candle>());
      client.on("status", (s) => expectTypeOf(s).toEqualTypeOf<StatusEvent>());
      client.on("error", (e) => expectTypeOf(e).toEqualTypeOf<TickforgeError>());
      client.on("warning", (w) => expectTypeOf(w).toEqualTypeOf<WarningEvent>());
      // @ts-expect-error: unknown event names are rejected.
      client.on("trades", () => {});
      // @ts-expect-error: a "trade" handler cannot expect a Candle-only field.
      client.on("trade", (t: Candle) => t.openTime);
      const iterator = client.trades("BTC-USD");
      expectTypeOf(iterator).toEqualTypeOf<TradeIterator>();
      expectTypeOf(iterator).toExtend<AsyncIterableIterator<Trade>>();
      expectTypeOf(iterator.dropped).toEqualTypeOf<number>();
    };
  });
});
