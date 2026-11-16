/**
 * Opt-in smoke test against the REAL Coinbase Exchange feed.
 *
 * Run with `pnpm test:live`. Excluded from `pnpm test` and CI on purpose:
 * it needs network access, depends on a third party being up, and on a
 * liquid market actually trading, so it is not deterministic.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MarketClient, type Candle, type StatusEvent, type Trade } from "../../src/index.js";

function next<T>(on: (cb: (v: T) => void) => () => void): Promise<T> {
  return new Promise((resolve) => {
    const off = on((value) => {
      off();
      resolve(value);
    });
  });
}

describe("live Coinbase feed", () => {
  let client: MarketClient | undefined;
  afterEach(async () => {
    await client?.close();
  });

  it("streams normalized trades and candles for BTC-USD", async () => {
    client = new MarketClient({ exchange: "coinbase" });
    const errors: unknown[] = [];
    client.on("error", (e) => errors.push(e));
    const trade = next<Trade>((cb) => client!.on("trade", cb));
    const candle = next<Candle>((cb) => client!.on("candle", cb));

    await client.subscribe(["BTC-USD"]);
    expect(client.state).toBe("open");

    const t = await trade;
    expect(t).toMatchObject({ exchange: "coinbase", symbol: "BTC-USD" });
    expect(t.price).toBeGreaterThan(0);
    expect(t.size).toBeGreaterThan(0);
    expect(["buy", "sell"]).toContain(t.side);
    expect(Math.abs(Date.now() - t.timestamp)).toBeLessThan(60_000);
    expect(await candle).toMatchObject({ symbol: "BTC-USD", interval: "1m", closed: false });
    expect(errors).toEqual([]);
  });

  it("rejects an unknown product but keeps the valid subscription", async () => {
    client = new MarketClient({ exchange: "coinbase" });
    await client.subscribe(["BTC-USD"]);
    await expect(client.subscribe(["NOPE-NOPE"])).rejects.toMatchObject({
      code: "EXCHANGE_ERROR",
    });
    expect(client.symbols).toEqual(["BTC-USD"]);
    expect(client.state).toBe("open");
  });

  it("goes idle after unsubscribing everything, then reconnects on subscribe", async () => {
    client = new MarketClient({ exchange: "coinbase" });
    await client.subscribe(["BTC-USD"]);
    await client.unsubscribe(["BTC-USD"]);
    expect(client.state).toBe("idle");

    const opened = next<StatusEvent>((cb) => client!.on("status", cb));
    await client.subscribe(["ETH-USD"]);
    expect((await opened).state).toBe("connecting");
    await next<Trade>((cb) => client!.on("trade", cb));
  });
});
