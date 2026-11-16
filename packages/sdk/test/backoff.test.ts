import { describe, expect, it } from "vitest";
import { backoffDelay } from "../src/backoff.js";

const max = () => 0.999999; // just under 1, so delay ≈ the exponential ceiling

describe("backoffDelay", () => {
  it("doubles the ceiling with each attempt", () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 1_000_000 };
    expect(backoffDelay(1, opts, max)).toBe(99);
    expect(backoffDelay(2, opts, max)).toBe(199);
    expect(backoffDelay(3, opts, max)).toBe(399);
    expect(backoffDelay(4, opts, max)).toBe(799);
  });

  it("never exceeds maxDelayMs", () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 1000 };
    for (let attempt = 1; attempt < 100; attempt++) {
      expect(backoffDelay(attempt, opts, max)).toBeLessThanOrEqual(1000);
    }
  });

  it("applies full jitter: a delay anywhere in [0, ceiling)", () => {
    const opts = { initialDelayMs: 1000, maxDelayMs: 30_000 };
    expect(backoffDelay(1, opts, () => 0)).toBe(0);
    expect(backoffDelay(1, opts, () => 0.5)).toBe(500);
    for (let i = 0; i < 500; i++) {
      const d = backoffDelay(3, opts);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(4000);
    }
  });

  it("stays finite on very long outages", () => {
    expect(backoffDelay(10_000, { initialDelayMs: 500, maxDelayMs: 30_000 }, max)).toBe(29_999);
  });

  it("uses defaults of 500ms initial and 30s max", () => {
    expect(backoffDelay(1, undefined, max)).toBe(499);
    expect(backoffDelay(50, undefined, max)).toBe(29_999);
  });
});
