import { describe, expect, it } from "vitest";
import { formatChange, formatDuration, formatPrice, formatSize, niceTicks } from "./format";

describe("format", () => {
  it("never rounds a real trade size down to zero", () => {
    expect(formatSize(0.00000001)).toBe("0.00000001");
    expect(formatSize(1.5)).toBe("1.5");
  });

  it("gives small prices more decimals", () => {
    expect(formatPrice(64091.734)).toBe("64,091.73");
    expect(formatPrice(0.5)).toBe("0.5000");
  });

  it("carries the sign in a glyph, not only in colour", () => {
    expect(formatChange(0.0042)).toBe("▲ 0.42%");
    expect(formatChange(-0.01)).toBe("▼ 1.00%");
    expect(formatChange(0)).toBe("■ 0.00%");
  });

  it("formats durations", () => {
    expect(formatDuration(412)).toBe("412ms");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(30_000)).toBe("30s");
  });

  it("produces round axis ticks inside the range", () => {
    // (64,390 − 63,810) / 4 = 145 → rounded up to the nice step 200.
    expect(niceTicks(63_810, 64_390)).toEqual([64_000, 64_200]);
    expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});
