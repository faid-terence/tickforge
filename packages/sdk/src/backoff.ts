/**
 * Reconnect backoff settings.
 * @public
 */
export interface BackoffOptions {
  /** Delay cap for the first retry, in ms. Default `500`. */
  initialDelayMs?: number;
  /** Upper bound for any single delay, in ms. Default `30_000`. */
  maxDelayMs?: number;
}

export const DEFAULT_BACKOFF = { initialDelayMs: 500, maxDelayMs: 30_000 } as const;

/**
 * Exponential backoff with "full jitter":
 *
 *   delay = random(0, min(maxDelay, initialDelay * 2^(attempt - 1)))
 *
 * Full jitter spreads reconnects from many clients evenly over the window,
 * which avoids a thundering herd when an exchange restarts.
 * See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 *
 * @param attempt - 1-based retry attempt.
 * @param random - Source of randomness in [0, 1); injectable for tests.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const initial = options.initialDelayMs ?? DEFAULT_BACKOFF.initialDelayMs;
  const max = options.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs;
  // Clamp the exponent so 2 ** n never overflows to Infinity on long outages.
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const ceiling = Math.min(max, initial * 2 ** exponent);
  return Math.floor(random() * ceiling);
}
