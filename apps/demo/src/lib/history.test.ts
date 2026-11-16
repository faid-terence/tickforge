import { describe, expect, it, vi } from "vitest";
import { T0 } from "../test/fixtures";
import { fetchHistory, parseHistory } from "./history";

const row = (minute: number, close = 105) => [
  (T0 + minute * 60_000) / 1000,
  90,
  110,
  100,
  close,
  2,
];

describe("parseHistory", () => {
  it("converts Coinbase rows (newest first) into closed candles, oldest first", () => {
    const candles = parseHistory("BTC-USD", [row(1), row(0)], T0 + 5 * 60_000);
    expect(candles.map((c) => c.openTime)).toEqual([T0, T0 + 60_000]);
    expect(candles[0]).toMatchObject({
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 2,
      closed: true,
      source: "history",
    });
  });

  it("drops the minute still in progress: the live feed builds it", () => {
    expect(parseHistory("BTC-USD", [row(0)], T0 + 30_000)).toEqual([]);
  });

  it("skips malformed rows from the untrusted response", () => {
    const body = [row(0), [1, 2], ["x", 1, 2, 3, 4, 5], [T0 / 1000, NaN, 1, 1, 1, 1], "nope"];
    expect(parseHistory("BTC-USD", body, T0 + 60 * 60_000)).toHaveLength(1);
    expect(parseHistory("BTC-USD", { message: "rate limited" }, T0)).toEqual([]);
  });
});

describe("fetchHistory", () => {
  it("requests 1-minute candles for the symbol", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json([row(0)])));
    const candles = await fetchHistory("ETH-USD", { fetchImpl, now: T0 + 120_000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60",
      expect.anything(),
    );
    expect(candles).toHaveLength(1);
  });

  it("gives up on a request that hangs", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    await expect(fetchHistory("BTC-USD", { fetchImpl, timeoutMs: 20 })).rejects.toThrow(
      /timed out|abort/i,
    );
  });

  it("rejects on an HTTP error", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("", { status: 429 })));
    await expect(fetchHistory("BTC-USD", { fetchImpl })).rejects.toThrow(/HTTP 429/);
  });
});
