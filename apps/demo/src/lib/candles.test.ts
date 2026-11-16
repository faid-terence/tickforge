import { describe, expect, it } from "vitest";
import { chartCandle, T0 } from "../test/fixtures";
import { mergeCandles } from "./candles";

describe("mergeCandles", () => {
  it("live data replaces history for the same minute, never the reverse", () => {
    const history = chartCandle({ source: "history", close: 1, closed: true });
    const live = chartCandle({ source: "live", close: 2 });
    expect(mergeCandles([history], [live])).toEqual([live]);
    expect(mergeCandles([live], [history])).toEqual([live]);
  });

  it("a newer live version replaces the older one", () => {
    const older = chartCandle({ close: 1 });
    const newer = chartCandle({ close: 2, closed: true });
    expect(mergeCandles([older], [newer])).toEqual([newer]);
  });

  it("keeps the newest `max` candles in time order", () => {
    const candles = [2, 0, 1].map((m) => chartCandle({ openTime: T0 + m * 60_000 }));
    expect(mergeCandles([], candles, 2).map((c) => c.openTime)).toEqual([
      T0 + 60_000,
      T0 + 120_000,
    ]);
  });
});
