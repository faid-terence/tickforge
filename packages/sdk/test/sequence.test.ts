import { describe, expect, it } from "vitest";
import { SequenceTracker } from "../src/sequence.js";

describe("SequenceTracker: trades", () => {
  it("accepts the first trade as a baseline, then the next one in sequence", () => {
    const t = new SequenceTracker();
    expect(t.trade("BTC-USD", 100, 1)).toEqual({ kind: "first" });
    expect(t.trade("BTC-USD", 101, 2)).toEqual({ kind: "next" });
  });

  it("reports a gap with the missed range and its time span", () => {
    const t = new SequenceTracker();
    t.trade("BTC-USD", 100, 1_000);
    expect(t.trade("BTC-USD", 105, 9_000)).toEqual({
      kind: "gap",
      expected: 101,
      received: 105, // 101..104 missed: 4 trades
      from: 1_000,
      to: 9_000,
    });
    expect(t.trade("BTC-USD", 106, 9_100)).toEqual({ kind: "next" }); // continues from 105
  });

  it("flags duplicates and out-of-order trades without moving the position", () => {
    const t = new SequenceTracker();
    t.trade("BTC-USD", 100, 1);
    t.trade("BTC-USD", 101, 2);
    expect(t.trade("BTC-USD", 101, 2)).toEqual({ kind: "duplicate" });
    expect(t.trade("BTC-USD", 99, 0)).toEqual({ kind: "out-of-order" });
    expect(t.trade("BTC-USD", 102, 3)).toEqual({ kind: "next" });
  });

  it("tracks symbols independently", () => {
    const t = new SequenceTracker();
    t.trade("BTC-USD", 100, 1);
    expect(t.trade("ETH-USD", 5, 1)).toEqual({ kind: "first" });
    expect(t.trade("BTC-USD", 101, 2)).toEqual({ kind: "next" });
  });
});

describe("SequenceTracker: positions (Coinbase last_match)", () => {
  it("uses the first position as the baseline; the stream resumes at position + 1", () => {
    const t = new SequenceTracker();
    expect(t.position("BTC-USD", 500, 1)).toEqual({ kind: "first" });
    expect(t.trade("BTC-USD", 501, 2)).toEqual({ kind: "next" });
  });

  it("reports trades missed while disconnected, including the position's own trade", () => {
    const t = new SequenceTracker();
    t.trade("BTC-USD", 100, 1_000);
    // Reconnected: the exchange's latest trade is now 362, so 101..362 were missed.
    expect(t.position("BTC-USD", 362, 16_000)).toEqual({
      kind: "gap",
      expected: 101,
      received: 363,
      from: 1_000,
      to: 16_000,
    });
    expect(t.trade("BTC-USD", 363, 16_100)).toEqual({ kind: "next" });
  });

  it("treats a position at or behind the last trade as no gap, and never moves backwards", () => {
    const t = new SequenceTracker();
    t.trade("BTC-USD", 100, 1);
    expect(t.position("BTC-USD", 100, 2)).toEqual({ kind: "current" });
    expect(t.position("BTC-USD", 90, 2)).toEqual({ kind: "current" });
    expect(t.trade("BTC-USD", 101, 3)).toEqual({ kind: "next" });
  });

  it("delete() forgets a symbol, so a later subscription starts a fresh baseline", () => {
    const t = new SequenceTracker();
    t.trade("BTC-USD", 100, 1);
    t.delete("BTC-USD");
    expect(t.position("BTC-USD", 999, 2)).toEqual({ kind: "first" });
  });
});
