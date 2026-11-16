import { describe, expect, it } from "vitest";
import { candle, T0, trade } from "../test/fixtures";
import { BatchAccumulator } from "./batch";

const counters = { tradesReceived: 0, dropped: 0, reconnects: 0, gaps: 0, missedTrades: 0 };

describe("BatchAccumulator", () => {
  it("posts nothing when nothing happened", () => {
    const acc = new BatchAccumulator();
    expect(acc.flush("BTC-USD", counters)).toBeDefined(); // first flush carries counters
    expect(acc.flush("BTC-USD", counters)).toBeUndefined();
  });

  it("collapses many candle updates into the newest version per minute", () => {
    const acc = new BatchAccumulator();
    acc.addCandle(candle({ close: 101 }));
    acc.addCandle(candle({ close: 102 }));
    acc.addCandle(candle({ openTime: T0 - 60_000, closed: true }));
    const batch = acc.flush("BTC-USD", counters);
    expect(batch?.candles.map((c) => [c.openTime, c.close])).toEqual([
      [T0 - 60_000, 105],
      [T0, 102],
    ]);
  });

  it("keeps only the most recent trades, oldest first", () => {
    const acc = new BatchAccumulator(2);
    for (const id of ["1", "2", "3"]) acc.addTrade(trade({ id }));
    expect(acc.flush("BTC-USD", counters)?.trades.map((t) => t.id)).toEqual(["2", "3"]);
  });

  it("resets after each flush and numbers log entries uniquely", () => {
    const acc = new BatchAccumulator();
    acc.log("info", "a", 1);
    const first = acc.flush("BTC-USD", counters);
    acc.log("info", "b", 2);
    const second = acc.flush("BTC-USD", counters);
    expect(first?.log.map((l) => l.id)).toEqual([1]);
    expect(second?.log).toEqual([{ id: 2, time: 2, kind: "info", text: "b" }]);
    expect(second?.trades).toEqual([]);
  });

  it("flushes when only a counter changed", () => {
    const acc = new BatchAccumulator();
    acc.flush("BTC-USD", counters);
    expect(acc.flush("BTC-USD", { ...counters, dropped: 3 })?.counters.dropped).toBe(3);
    expect(
      acc.flush("BTC-USD", { ...counters, dropped: 3, gaps: 1, missedTrades: 12 })?.counters,
    ).toMatchObject({
      gaps: 1,
      missedTrades: 12,
    });
  });

  it("clearMarketData() discards the previous symbol's pending data", () => {
    const acc = new BatchAccumulator();
    acc.addTrade(trade());
    acc.addCandle(candle());
    acc.setLastTrade(trade());
    acc.clearMarketData();
    acc.log("info", "kept");
    const batch = acc.flush("ETH-USD", counters);
    expect(batch).toMatchObject({
      symbol: "ETH-USD",
      trades: [],
      candles: [],
      lastTrade: undefined,
    });
    expect(batch?.log).toHaveLength(1);
  });
});
