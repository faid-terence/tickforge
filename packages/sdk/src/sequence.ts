/**
 * Per-symbol trade sequence tracking: decides whether each trade is the
 * expected next one, a gap, a duplicate or out of order.
 *
 * It relies on the exchange numbering trades contiguously per symbol (each
 * trade exactly 1 more than the previous one). Coinbase's `trade_id` does;
 * this was verified on the live feed.
 */

/** Details of a detected gap, before the client adds symbol and reason. */
export interface GapRange {
  /** The sequence number that should have come next. */
  readonly expected: number;
  /** The sequence number the stream resumed at. `received - expected` trades were missed. */
  readonly received: number;
  /** Time of the last trade seen before the gap (ms). */
  readonly from: number;
  /** Time at which the stream resumed (ms). */
  readonly to: number;
}

export type SequenceVerdict =
  /** First sequence seen for the symbol: establishes the baseline. */
  | { readonly kind: "first" }
  /** Exactly the expected next sequence. */
  | { readonly kind: "next" }
  /** Same sequence as the last one accepted. Drop it. */
  | { readonly kind: "duplicate" }
  /** Older than the last one accepted. Drop it: the stream has moved past it. */
  | { readonly kind: "out-of-order" }
  /** Later than expected: trades in between were missed. Accept it and report. */
  | ({ readonly kind: "gap" } & GapRange)
  /** A position marker that matches or trails what we already have: nothing to do. */
  | { readonly kind: "current" };

interface Position {
  readonly sequence: number;
  readonly time: number;
}

export class SequenceTracker {
  readonly #last = new Map<string, Position>();

  /** A trade with `sequence`, executed at `time`, arrived for `symbol`. */
  trade(symbol: string, sequence: number, time: number): SequenceVerdict {
    const last = this.#last.get(symbol);
    if (!last) {
      this.#last.set(symbol, { sequence, time });
      return { kind: "first" };
    }
    if (sequence === last.sequence) return { kind: "duplicate" };
    if (sequence < last.sequence) return { kind: "out-of-order" };
    this.#last.set(symbol, { sequence, time });
    if (sequence === last.sequence + 1) return { kind: "next" };
    return {
      kind: "gap",
      expected: last.sequence + 1,
      received: sequence,
      from: last.time,
      to: time,
    };
  }

  /**
   * The exchange reports `sequence` as its latest trade for `symbol` (e.g.
   * Coinbase's `last_match` on (re)subscribe). That trade is not delivered;
   * the stream resumes at `sequence + 1`. So if we had seen up to `n`, the
   * trades `n + 1 … sequence` were missed.
   */
  position(symbol: string, sequence: number, time: number): SequenceVerdict {
    const last = this.#last.get(symbol);
    if (!last) {
      this.#last.set(symbol, { sequence, time });
      return { kind: "first" };
    }
    // Never move backwards: anything at or below what we have is already accounted for.
    if (sequence <= last.sequence) return { kind: "current" };
    this.#last.set(symbol, { sequence, time });
    return {
      kind: "gap",
      expected: last.sequence + 1,
      received: sequence + 1,
      from: last.time,
      to: time,
    };
  }

  /** Forgets a symbol, e.g. after unsubscribing: a later subscription starts a fresh baseline. */
  delete(symbol: string): void {
    this.#last.delete(symbol);
  }
}
