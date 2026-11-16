/**
 * A push-based async iterator with a bounded buffer.
 *
 * Events are pushed in by the client; a `for await` loop pulls them out. If
 * the consumer falls behind and the buffer is full, the OLDEST item is
 * dropped. For market data, fresh data beats complete-but-stale data, and an
 * unbounded buffer would grow forever under a slow consumer.
 *
 * Drops are never silent: `dropped` counts them, and `onOverflow` fires once
 * per overflow episode (the first drop after the consumer last caught up),
 * so a struggling consumer is not flooded with one notification per item.
 */
export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #capacity: number;
  readonly #onEnd: () => void;
  readonly #onOverflow: ((dropped: number) => void) | undefined;
  #buffer: T[] = [];
  #pending: ((result: IteratorResult<T>) => void) | undefined;
  #done = false;
  #dropped = 0;
  #overflowing = false;

  /**
   * @param capacity - Max buffered items before the oldest is dropped (integer >= 1).
   * @param onEnd - Called once when the iterator ends (to detach listeners).
   * @param onOverflow - Called with the running drop total when an overflow episode starts.
   */
  constructor(capacity: number, onEnd: () => void, onOverflow?: (dropped: number) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`bufferSize must be an integer >= 1, got ${String(capacity)}`);
    }
    this.#capacity = capacity;
    this.#onEnd = onEnd;
    this.#onOverflow = onOverflow;
  }

  /** Total number of items dropped because the buffer was full. */
  get dropped(): number {
    return this.#dropped;
  }

  push(value: T): void {
    if (this.#done) return;
    if (this.#pending) {
      const resolve = this.#pending;
      this.#pending = undefined;
      resolve({ value, done: false });
      return;
    }
    if (this.#buffer.length >= this.#capacity) {
      this.#buffer.shift();
      this.#dropped += 1;
      if (!this.#overflowing) {
        this.#overflowing = true;
        this.#onOverflow?.(this.#dropped);
      }
    }
    this.#buffer.push(value);
  }

  /** Ends iteration. Buffered items are discarded. */
  end(): void {
    if (this.#done) return;
    this.#done = true;
    this.#buffer = [];
    this.#onEnd();
    const resolve = this.#pending;
    this.#pending = undefined;
    resolve?.({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift() as T;
      // The consumer has caught up: the next drop starts a new episode.
      if (this.#buffer.length === 0) this.#overflowing = false;
      return Promise.resolve({ value, done: false });
    }
    if (this.#done) return Promise.resolve({ value: undefined, done: true });
    if (this.#pending) {
      return Promise.reject(new Error("next() called before the previous call resolved"));
    }
    return new Promise((resolve) => {
      this.#pending = resolve;
    });
  }

  /** Called by `break`/`return` inside `for await`; detaches from the client. */
  return(): Promise<IteratorResult<T>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
