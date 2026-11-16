const priceFormats = new Map<number, Intl.NumberFormat>();

/** Price with 2 decimals at or above $1, more for small prices. */
export function formatPrice(value: number): string {
  const decimals = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  let format = priceFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    priceFormats.set(decimals, format);
  }
  return format.format(value);
}

// 8 decimals: BTC trades can be as small as one satoshi (0.00000001).
const sizeFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
export function formatSize(value: number): string {
  return sizeFormat.format(value);
}

const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
/** 1,284 → "1.3K". Used for axis-free counters and volumes. */
export function formatCompact(value: number): string {
  return value < 10_000 ? Math.round(value).toLocaleString("en-US") : compactFormat.format(value);
}

/** Signed percent with a direction glyph, so the sign never relies on color: "▲ 0.42%". */
export function formatChange(fraction: number): string {
  const glyph = fraction > 0 ? "▲" : fraction < 0 ? "▼" : "■";
  return `${glyph} ${Math.abs(fraction * 100).toFixed(2)}%`;
}

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const minuteFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const formatClock = (ms: number) => clockFormat.format(ms);
export const formatMinute = (ms: number) => minuteFormat.format(ms);

/** "412ms", "1.2s", "30s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}s`;
}

/** Evenly spaced "nice" axis ticks (1, 2, 2.5 or 5 × 10ⁿ) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}
