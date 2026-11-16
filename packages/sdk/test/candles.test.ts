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
        incomplete: false,
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

  describe("markIncomplete (after a sequence gap)", () => {
    it("flags the open candle in place when the gap overlaps its minute", () => {
      const agg = new CandleAggregator();
      agg.add(trade(1_000, 100));
      const changed = agg.markIncomplete("BTC-USD", T0 + 1_000, T0 + 30_000);
      expect(changed).toEqual([
        expect.objectContaining({ openTime: T0, closed: false, incomplete: true }),
      ]);
      // Later updates to the same minute stay flagged.
      expect(agg.add(trade(40_000, 101))[0]).toMatchObject({ incomplete: true, trades: 2 });
    });

    it("re-emits the last CLOSED candle once, values unchanged, when the gap reaches back into it", () => {
      const agg = new CandleAggregator();
      agg.add(trade(50_000, 100));
      const [closed] = agg.closeUntil(T0 + 60_000); // closed by the timer during an outage
      const changed = agg.markIncomplete("BTC-USD", T0 + 50_000, T0 + 75_000);
      expect(changed).toEqual([{ ...closed, incomplete: true }]);
      // Idempotent: nothing changes a second time.
      expect(agg.markIncomplete("BTC-USD", T0 + 50_000, T0 + 75_000)).toEqual([]);
    });

    it("flags candles opened later for minutes inside the gap, and not after it", () => {
      const agg = new CandleAggregator();
      agg.add(trade(1_000, 100));
      agg.markIncomplete("BTC-USD", T0 + 1_000, T0 + 125_000); // gap reaches minute 2
      // The trade that revealed the gap lands in minute 2: its new candle starts incomplete.
      const [closedMinute0, minute2] = agg.add(trade(125_000, 110));
      expect(closedMinute0).toMatchObject({ openTime: T0, closed: true, incomplete: true });
      expect(minute2).toMatchObject({ openTime: T0 + 120_000, incomplete: true });
      expect(agg.add(trade(185_000, 111))[1]).toMatchObject({
        openTime: T0 + 180_000,
        incomplete: false,
      });
    });

    it("leaves candles outside the gap alone, and other symbols too", () => {
      const agg = new CandleAggregator();
      agg.add(trade(1_000, 100));
      agg.add(trade(1_000, 5, 1, "ETH-USD"));
      expect(agg.markIncomplete("BTC-USD", T0 + 120_000, T0 + 130_000)).toEqual([]);
      expect(agg.markIncomplete("BTC-USD", T0 + 1_000, T0 + 2_000)).toHaveLength(1);
      expect(agg.add(trade(2_000, 6, 1, "ETH-USD"))[0]).toMatchObject({ incomplete: false });
    });

    it("delete() also forgets incomplete state", () => {
      const agg = new CandleAggregator();
      agg.add(trade(1_000, 100));
      agg.markIncomplete("BTC-USD", T0, T0 + 300_000);
      agg.delete("BTC-USD");
      expect(agg.add(trade(2_000, 100))[0]).toMatchObject({ incomplete: false });
    });
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
