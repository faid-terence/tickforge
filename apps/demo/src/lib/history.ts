import type { DemoSymbol } from "../worker/protocol";
import type { ChartCandle } from "./candles";

const MINUTE_MS = 60_000;
export const HISTORY_TIMEOUT_MS = 8_000;

/**
 * Loads recent 1-minute candles from Coinbase's public REST API so the chart
 * is not empty for the first minutes. This is demo-only scaffolding: the SDK
 * itself only deals with the real-time feed.
 *
 * The response is untrusted input, so every row is validated; bad rows are
 * skipped rather than trusted.
 */
export async function fetchHistory(
  symbol: DemoSymbol,
  {
    fetchImpl = fetch,
    now = Date.now(),
    timeoutMs = HISTORY_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; now?: number; timeoutMs?: number } = {},
): Promise<ChartCandle[]> {
  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=60`;
  // A hung request on a flaky mobile network must not leave the chart
  // "loading" forever: give up and fall back to live candles only.
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`History request failed: HTTP ${String(response.status)}`);
  return parseHistory(symbol, await response.json(), now);
}

/**
 * Rows are `[time (s), low, high, open, close, volume]`, newest first.
 * The in-progress minute is dropped: the live feed builds it.
 */
export function parseHistory(symbol: DemoSymbol, body: unknown, now: number): ChartCandle[] {
  if (!Array.isArray(body)) return [];
  const candles: ChartCandle[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [time, low, high, open, close, volume] = row as unknown[];
    const numbers = [time, low, high, open, close, volume];
    if (!numbers.every((n): n is number => typeof n === "number" && Number.isFinite(n))) continue;
    const openTime = (time as number) * 1000;
    if (openTime + MINUTE_MS > now) continue;
    candles.push({
      exchange: "coinbase",
      symbol,
      interval: "1m",
      openTime,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: volume as number,
      trades: 0, // not provided by the REST endpoint
      closed: true,
      incomplete: false,
      source: "history",
      partial: false,
    });
  }
  return candles.sort((a, b) => a.openTime - b.openTime);
}
