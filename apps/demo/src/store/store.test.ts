import { describe, expect, it, vi } from "vitest";
import { candle, chartCandle, T0, trade } from "../test/fixtures";
import type { Batch } from "../worker/protocol";
import { batchReceived, disconnectSimulated } from "./actions";
import { MAX_LOG } from "./connectionSlice";
import { MAX_TRADES } from "./marketSlice";
import { selectChange } from "./selectors";
import { slowConsumerToggled, symbolSelected, themeChanged } from "./settingsSlice";
import { createAppStore, type StoreDeps } from "./store";

function setup(fetchHistory: StoreDeps["fetchHistory"] = () => Promise.resolve([])) {
  const deps = { send: vi.fn(), fetchHistory: vi.fn(fetchHistory), applyTheme: vi.fn() };
  return { store: createAppStore(deps), deps };
}

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    type: "batch",
    symbol: "BTC-USD",
    trades: [],
    candles: [],
    lastTrade: undefined,
    status: undefined,
    log: [],
    counters: { tradesReceived: 0, dropped: 0, reconnects: 0 },
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("store side effects", () => {
  it("selecting a symbol tells the worker and loads that symbol's history", async () => {
    const history = [chartCandle({ source: "history", closed: true })];
    const { store, deps } = setup(() => Promise.resolve(history));
    store.dispatch(symbolSelected("ETH-USD"));
    expect(deps.send).toHaveBeenCalledWith({ type: "select", symbol: "ETH-USD" });
    await flush();
    expect(deps.fetchHistory).toHaveBeenCalledWith("ETH-USD");
    expect(store.getState().market).toMatchObject({ history: "loaded", candles: history });
  });

  it("drops history that arrives after the visitor switched symbols", async () => {
    let resolveBtc: (v: ReturnType<typeof chartCandle>[]) => void = () => {};
    const { store } = setup((symbol) =>
      symbol === "BTC-USD"
        ? new Promise((r) => (resolveBtc = r))
        : Promise.resolve([chartCandle({ symbol: "SOL-USD", source: "history" })]),
    );
    store.dispatch(symbolSelected("BTC-USD"));
    store.dispatch(symbolSelected("SOL-USD"));
    resolveBtc([chartCandle({ source: "history" })]);
    await flush();
    expect(store.getState().market.candles.map((c) => c.symbol)).toEqual(["SOL-USD"]);
  });

  it("marks history as failed without breaking live data", async () => {
    const { store } = setup(() => Promise.reject(new Error("offline")));
    store.dispatch(symbolSelected("BTC-USD"));
    await flush();
    expect(store.getState().market.history).toBe("failed");
  });

  it("forwards the disconnect button, the slow-consumer switch and the theme", () => {
    const { store, deps } = setup();
    store.dispatch(disconnectSimulated());
    store.dispatch(slowConsumerToggled());
    store.dispatch(themeChanged("dark"));
    expect(deps.send).toHaveBeenCalledWith({ type: "simulate-disconnect" });
    expect(deps.send).toHaveBeenCalledWith({ type: "slow-consumer", enabled: true });
    expect(deps.applyTheme).toHaveBeenCalledWith("dark");
  });
});

describe("applying worker batches", () => {
  it("shows newest trades first and caps the list", () => {
    const { store } = setup();
    const trades = Array.from({ length: MAX_TRADES + 5 }, (_, i) => trade({ id: String(i) }));
    store.dispatch(batchReceived(batch({ trades })));
    const shown = store.getState().market.trades;
    expect(shown).toHaveLength(MAX_TRADES);
    expect(shown[0]?.id).toBe(String(MAX_TRADES + 4));
  });

  it("tracks the last price and its direction", () => {
    const { store } = setup();
    store.dispatch(batchReceived(batch({ lastTrade: trade({ price: 100 }) })));
    store.dispatch(batchReceived(batch({ lastTrade: trade({ price: 99 }) })));
    expect(store.getState().market).toMatchObject({ lastPrice: 99, tick: "down" });
    store.dispatch(batchReceived(batch({ lastTrade: trade({ price: 99 }) })));
    expect(store.getState().market.tick).toBe("down"); // unchanged price keeps the direction
  });

  it("flags the first live candle as partial and later ones as complete", () => {
    const { store } = setup();
    store.dispatch(batchReceived(batch({ candles: [candle()] })));
    store.dispatch(
      batchReceived(
        batch({ candles: [candle({ closed: true }), candle({ openTime: T0 + 60_000 })] }),
      ),
    );
    expect(store.getState().market.candles.map((c) => [c.source, c.partial, c.closed])).toEqual([
      ["live", true, true],
      ["live", false, false],
    ]);
  });

  it("ignores market data from a batch for the previous symbol, but keeps its counters", () => {
    const { store } = setup();
    store.dispatch(symbolSelected("ETH-USD"));
    store.dispatch(
      batchReceived(
        batch({
          symbol: "BTC-USD",
          trades: [trade()],
          counters: { tradesReceived: 9, dropped: 0, reconnects: 1 },
        }),
      ),
    );
    expect(store.getState().market.trades).toEqual([]);
    expect(store.getState().market.counters.reconnects).toBe(1);
  });

  it("keeps the latest status and a capped, newest-first log", () => {
    const { store } = setup();
    const log = Array.from({ length: MAX_LOG + 3 }, (_, i) => ({
      id: i,
      time: i,
      kind: "info" as const,
      text: String(i),
    }));
    store.dispatch(batchReceived(batch({ status: { state: "open", since: 1 }, log })));
    const { connection } = store.getState();
    expect(connection.status.state).toBe("open");
    expect(connection.log).toHaveLength(MAX_LOG);
    expect(connection.log[0]?.id).toBe(MAX_LOG + 2);
  });

  it("derives the change over the visible window", () => {
    const { store } = setup();
    store.dispatch(
      batchReceived(
        batch({
          candles: [candle({ open: 100 }), candle({ openTime: T0 + 9 * 60_000, open: 104 })],
          lastTrade: trade({ price: 110 }),
        }),
      ),
    );
    expect(selectChange(store.getState())).toEqual({ fraction: 0.1, minutes: 10 });
  });
});
