/** A listener for an event whose payload type is `T`. */
export type Listener<T> = (payload: T) => void;

/**
 * Minimal, fully typed event emitter.
 *
 * Differences from Node's `EventEmitter`, all deliberate:
 * - Runs unchanged in browsers, workers and Node.
 * - Emitting `error` with no listeners is a no-op instead of a throw, so a
 *   malformed exchange message can never crash the host process.
 * - A listener that throws does not stop other listeners or corrupt the
 *   emitter's caller; the exception is re-thrown on a microtask so it still
 *   surfaces as an uncaught error (the same contract as DOM `EventTarget`).
 */
export class TypedEmitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  /**
   * Registers `listener` for `event`.
   * @returns A function that removes the listener.
   */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      this.off(event, listener);
    };
  }

  /** Removes a listener previously added with {@link TypedEmitter.on}. */
  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.#listeners.get(event)?.delete(listener);
  }

  /** Number of listeners currently registered for `event`. */
  listenerCount(event: keyof Events): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy so listeners can unsubscribe themselves while we iterate.
    for (const listener of [...set] as Listener<Events[K]>[]) {
      try {
        listener(payload);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  protected removeAllListeners(): void {
    this.#listeners.clear();
  }
}
