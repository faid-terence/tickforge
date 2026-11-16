/**
 * Tiny validation helpers for untrusted exchange payloads.
 *
 * Hand-written instead of a schema library (zod, valibot…) to keep the SDK at
 * zero runtime dependencies; the shapes we check are small and flat.
 */

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a decimal string (exchanges send prices as strings to avoid float
 * drift in JSON) or number into a finite number. Returns `undefined` if invalid.
 */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Parses an ISO-8601 timestamp into epoch ms. Returns `undefined` if invalid. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Truncates a raw payload before attaching it to an error, so errors stay small. */
export function preview(raw: string, max = 200): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * A trade sequence number: a non-negative safe integer, given as a number or
 * a string of digits. Anything else (including integers too large to
 * represent exactly) returns `undefined`, which disables gap detection for
 * that message rather than risking false gaps.
 */
export function toSequence(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
