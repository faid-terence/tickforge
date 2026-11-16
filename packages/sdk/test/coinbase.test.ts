import { describe, expect, it } from "vitest";
import { coinbase } from "../src/adapters/coinbase.js";
import * as fx from "./fixtures/coinbase.js";

const parse = (msg: unknown) => coinbase.parse(typeof msg === "string" ? msg : JSON.stringify(msg));

describe("coinbase adapter: requests", () => {
  it("subscribes to matches and heartbeat for the given products", () => {
    expect(JSON.parse(coinbase.subscribeMessage(["BTC-USD", "ETH-USD"]))).toEqual({
      type: "subscribe",
      product_ids: ["BTC-USD", "ETH-USD"],
      channels: ["matches", "heartbeat"],
    });
  });

  it("builds unsubscribe frames with the same shape", () => {
    expect(JSON.parse(coinbase.unsubscribeMessage(["BTC-USD"]))).toMatchObject({
      type: "unsubscribe",
      product_ids: ["BTC-USD"],
    });
  });
});

describe("coinbase adapter: parsing", () => {
  it("normalizes a match into a Trade, with trade_id as its sequence", () => {
    expect(parse(fx.match({ trade_id: 10 }))).toEqual({
      type: "trade",
      sequence: 10,
      trade: {
        exchange: "coinbase",
        symbol: "BTC-USD",
        id: "10",
        price: 400.23,
        size: 5.23512,
        side: "buy",
        timestamp: Date.UTC(2014, 10, 7, 8, 19, 27, 28),
      },
    });
  });

  it("reports the taker side (Coinbase's `side` is the maker's)", () => {
    const side = (makerSide: string) => {
      const event = parse(fx.match({ side: makerSide }));
      return event.type === "trade" ? event.trade.side : undefined;
    };
    expect(side("sell")).toBe("buy");
    expect(side("buy")).toBe("sell");
  });

  it("accepts a string trade_id", () => {
    const event = parse(fx.match({ trade_id: "abc" }));
    expect(event.type === "trade" && event.trade.id).toBe("abc");
  });

  it("treats `subscriptions` as an ack carrying the full `matches` snapshot", () => {
    expect(parse(fx.subscriptions(["BTC-USD", "ETH-USD"]))).toEqual({
      type: "ack",
      subscribed: ["BTC-USD", "ETH-USD"],
    });
  });

  it("reads an empty `channels` list (after unsubscribing everything) as nothing subscribed", () => {
    expect(parse({ type: "subscriptions", channels: [] })).toEqual({ type: "ack", subscribed: [] });
  });

  it("maps `error` messages, including the reason", () => {
    expect(parse(fx.error("Failed to subscribe", "FOO-BAR is not a valid product"))).toEqual({
      type: "exchange-error",
      message: "Failed to subscribe: FOO-BAR is not a valid product",
    });
    expect(parse({ type: "error" })).toEqual({
      type: "exchange-error",
      message: "Unknown exchange error",
    });
  });

  it.each([
    ["heartbeat", fx.heartbeat],
    ["unknown future message types", { type: "brand_new_channel" }],
  ])("ignores %s", (_name, msg) => {
    expect(parse(msg)).toEqual({ type: "ignored" });
  });
});

describe("coinbase adapter: sequence numbers", () => {
  it("uses trade_id (numbers or digit strings) as the per-product sequence", () => {
    expect(parse(fx.match({ trade_id: 42 }))).toMatchObject({ type: "trade", sequence: 42 });
    expect(parse(fx.match({ trade_id: "42" }))).toMatchObject({ type: "trade", sequence: 42 });
  });

  it("emits trades without a sequence when trade_id is not a safe integer", () => {
    for (const tradeId of ["abc", "9007199254740993", -1, 1.5]) {
      const event = parse(fx.match({ trade_id: tradeId }));
      expect(event.type).toBe("trade");
      expect(event).not.toHaveProperty("sequence");
    }
  });

  it("turns last_match into a position marker, never a trade", () => {
    expect(
      parse(fx.lastMatch({ trade_id: 777, product_id: "ETH-USD", time: "2026-01-01T12:00:00Z" })),
    ).toEqual({
      type: "position",
      symbol: "ETH-USD",
      sequence: 777,
      timestamp: Date.UTC(2026, 0, 1, 12),
    });
  });

  it.each([
    ["no product_id", { product_id: undefined }, /product_id/],
    ["a non-integer trade_id", { trade_id: "x" }, /trade_id/],
    ["a bad time", { time: "yesterday" }, /time/],
  ])("rejects a last_match with %s", (_name, overrides, reason) => {
    expect(parse(fx.lastMatch(overrides))).toEqual({
      type: "invalid",
      reason: expect.stringMatching(reason),
    });
  });
});

describe("coinbase adapter: malformed input never throws", () => {
  it.each([
    ["non-JSON", "not json{", /not valid JSON/],
    ["a JSON array", "[1,2]", /missing message type/],
    ["JSON null", "null", /missing message type/],
    ["a non-string type", { type: 5 }, /missing message type/],
    ["subscriptions without channels", { type: "subscriptions" }, /no channels/],
    [
      "subscriptions with bad product_ids",
      { type: "subscriptions", channels: [{ name: "matches", product_ids: [1] }] },
      /product_ids/,
    ],
    ["match without product_id", fx.match({ product_id: undefined }), /product_id/],
    ["match with empty product_id", fx.match({ product_id: "" }), /product_id/],
    ["match with non-numeric price", fx.match({ price: "abc" }), /price/],
    ["match with zero price", fx.match({ price: "0" }), /price/],
    ["match with empty-string price", fx.match({ price: " " }), /price/],
    ["match with Infinity price", fx.match({ price: "Infinity" }), /price/],
    ["match with negative size", fx.match({ size: "-1" }), /size/],
    ["match with object size", fx.match({ size: {} }), /size/],
    ["match with a bad time", fx.match({ time: "yesterday" }), /time/],
    ["match with numeric time", fx.match({ time: 123 }), /time/],
    ["match with an unknown side", fx.match({ side: "hold" }), /side/],
    ["match without trade_id", fx.match({ trade_id: null }), /trade_id/],
  ])("rejects %s", (_name, msg, reason) => {
    const event = parse(msg);
    expect(event.type).toBe("invalid");
    expect(event.type === "invalid" && event.reason).toMatch(reason);
  });

  it("accepts numeric prices and sizes too", () => {
    expect(parse(fx.match({ price: 1.5, size: 2 }))).toMatchObject({
      trade: { price: 1.5, size: 2 },
    });
  });

  it("rejects non-finite numeric values", () => {
    // NaN serializes to null; 1e999 parses to Infinity.
    expect(parse(fx.match({ price: Number.NaN })).type).toBe("invalid");
    expect(coinbase.parse('{"type":"match","price":1e999}').type).toBe("invalid");
  });
});
