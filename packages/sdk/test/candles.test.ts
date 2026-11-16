import { describe, expect, it } from "vitest";
import { CandleAggregator, minuteStart } from "../src/candles.js";
import type { Trade } from "../src/types.js";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // a minute boundary

function trade(offsetMs: number, price: number, size = 1, symbol = "BTC-USD"): Trade {
  return {
    exchange: "coinbase",
    symbol,
    id: String(offsetMs),
    price,
    size,
    side: "buy",
    timestamp: T0 + offsetMs,
  };
}

describe("minuteStart", () => {
  it("floors to the UTC minute, inclusive of the boundary", () => {
    expect(minuteStart(T0)).toBe(T0);
    expect(minuteStart(T0 + 59_999)).toBe(T0);
    expect(minuteStart(T0 + 60_000)).toBe(T0 + 60_000);
  });
});

describe("CandleAggregator", () => {
  it("opens a candle from the first trade", () => {
    const agg = new CandleAggregator();
    expect(agg.add(trade(1000, 100, 2))).toEqual([
      {
        exchange: "coinbase",
        symbol: "BTC-USD",
        interval: "1m",
        openTime: T0,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 2,
        trades: 1,
        closed: false,
      },
    ]);
  });

  it("updates high/low/close/volume within the minute", () => {
    const agg = new CandleAggregator();
    agg.add(trade(0, 100));
    agg.add(trade(10_000, 105));
    agg.add(trade(20_000, 95));
    const [candle] = agg.add(trade(59_999, 101, 0.5));
    expect(candle).toMatchObject({
      open: 100,
      high: 105,
      low: 95,
      close: 101,
      volume: 3.5,
      trades: 4,
    });
  });

  it("closes the previous candle when a trade lands in a later minute", () => {
    const agg = new CandleAggregator();
    agg.add(trade(0, 100));
    const out = agg.add(trade(60_000, 110));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ openTime: T0, close: 100, closed: true });
    expect(out[1]).toMatchObject({ openTime: T0 + 60_000, open: 110, closed: false });
  });

  it("skips empty minutes rather than inventing flat candles", () => {
    const agg = new CandleAggregator();
    agg.add(trade(0, 100));
    const out = agg.add(trade(5 * 60_000, 120));
    expect(out.map((c) => c.openTime)).toEqual([T0, T0 + 5 * 60_000]);
  });

  it("drops trades older than the candle in progress", () => {
    const agg = new CandleAggregator();
    agg.add(trade(60_000, 100));
    expect(agg.add(trade(59_999, 1))).toEqual([]);
  });

  it("tracks symbols independently", () => {
    const agg = new CandleAggregator();
    agg.add(trade(0, 100, 1, "BTC-USD"));
    const [eth] = agg.add(trade(0, 5, 1, "ETH-USD"));
    expect(eth).toMatchObject({ symbol: "ETH-USD", open: 5 });
  });

  it("returns snapshots that later trades do not mutate", () => {
    const agg = new CandleAggregator();
    const [first] = agg.add(trade(0, 100));
    agg.add(trade(1000, 200));
    expect(first).toMatchObject({ high: 100, trades: 1 });
  });

  it("closeUntil() closes candles whose minute has ended, and only those", () => {
    const agg = new CandleAggregator();
    agg.add(trade(0, 100, 1, "BTC-USD"));
    agg.add(trade(30_000, 5, 1, "ETH-USD"));
    expect(agg.nextMinuteEnd()).toBe(T0 + 60_000);
    expect(agg.closeUntil(T0 + 59_999)).toEqual([]);
    const closed = agg.closeUntil(T0 + 60_000);
    expect(closed.map((c) => [c.symbol, c.closed])).toEqual([
      ["BTC-USD", true],
      ["ETH-USD", true],
    ]);
    expect(agg.nextMinuteEnd()).toBeUndefined();
    expect(agg.closeUntil(T0 + 10 * 60_000)).toEqual([]); // nothing open: no empty candles
  });

  it("never revises a closed candle: late trades for its minute are ignored", () => {
    const agg = new CandleAggregator();
    agg.add(trade(0, 100));
    agg.closeUntil(T0 + 60_000);
    expect(agg.add(trade(59_000, 999))).toEqual([]);
    // The next minute starts fresh, with no candle to roll over.
    expect(agg.add(trade(61_000, 101))).toEqual([
      expect.objectContaining({ openTime: T0 + 60_000, open: 101, closed: false }),
    ]);
  });

  it("delete() forgets the candle in progress", () => {
    const agg = new CandleAggregator();
    agg.add(trade(0, 100));
    agg.delete("BTC-USD");
    expect(agg.add(trade(1000, 50))).toEqual([expect.objectContaining({ open: 50, trades: 1 })]);
    agg.closeUntil(T0 + 60_000);
    agg.delete("BTC-USD"); // also forgets which minutes were closed
    expect(agg.add(trade(2000, 7))).toHaveLength(1);
  });
});
