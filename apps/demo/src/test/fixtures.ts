import type { Candle, Trade } from "tickforge";
import type { ChartCandle } from "../lib/candles";

export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

export function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    exchange: "coinbase",
    symbol: "BTC-USD",
    id: "1",
    price: 100,
    size: 1,
    side: "buy",
    timestamp: T0,
    ...overrides,
  };
}

export function candle(overrides: Partial<Candle> = {}): Candle {
  return {
    exchange: "coinbase",
    symbol: "BTC-USD",
    interval: "1m",
    openTime: T0,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 2,
    trades: 3,
    closed: false,
    ...overrides,
  };
}

export function chartCandle(overrides: Partial<ChartCandle> = {}): ChartCandle {
  return { ...candle(), source: "live", partial: false, ...overrides };
}
