import { describe, expect, it, vi } from "vitest";
import { AsyncQueue } from "../src/queue.js";

describe("AsyncQueue", () => {
  it("yields buffered values in order", async () => {
    const q = new AsyncQueue<number>(10, () => {});
    q.push(1);
    q.push(2);
    expect(await q.next()).toEqual({ value: 1, done: false });
    expect(await q.next()).toEqual({ value: 2, done: false });
  });

  it("resolves a waiting next() when a value arrives", async () => {
    const q = new AsyncQueue<number>(10, () => {});
    const pending = q.next();
    q.push(7);
    expect(await pending).toEqual({ value: 7, done: false });
  });

  it("drops the oldest value when full", async () => {
    const q = new AsyncQueue<number>(2, () => {});
    q.push(1);
    q.push(2);
    q.push(3);
    expect((await q.next()).value).toBe(2);
    expect((await q.next()).value).toBe(3);
  });

  it("counts drops and reports each overflow episode once", async () => {
    const onOverflow = vi.fn();
    const q = new AsyncQueue<number>(2, () => {}, onOverflow);
    for (const n of [1, 2, 3, 4, 5]) q.push(n); // 3 drops, one episode
    expect(q.dropped).toBe(3);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenLastCalledWith(1);

    await q.next(); // took one, but has not caught up: same episode
    q.push(6);
    q.push(7);
    expect(q.dropped).toBe(4);
    expect(onOverflow).toHaveBeenCalledTimes(1);

    await q.next();
    await q.next(); // drained: the consumer caught up
    for (const n of [8, 9, 10]) q.push(n);
    expect(q.dropped).toBe(5);
    expect(onOverflow).toHaveBeenCalledTimes(2);
    expect(onOverflow).toHaveBeenLastCalledWith(5);
  });

  it("rejects a capacity that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new AsyncQueue(bad, () => {})).toThrow(RangeError);
    }
  });

  it("end() finishes a pending next(), calls onEnd once, and ignores later pushes", async () => {
    const onEnd = vi.fn();
    const q = new AsyncQueue<number>(10, onEnd);
    const pending = q.next();
    q.end();
    q.end();
    q.push(1);
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(await q.next()).toEqual({ value: undefined, done: true });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("supports break in for-await via return()", async () => {
    const onEnd = vi.fn();
    const q = new AsyncQueue<number>(10, onEnd);
    q.push(1);
    q.push(2);
    const seen: number[] = [];
    for await (const n of q) {
      seen.push(n);
      break;
    }
    expect(seen).toEqual([1]);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent next() calls", async () => {
    const q = new AsyncQueue<number>(10, () => {});
    void q.next();
    await expect(q.next()).rejects.toThrow(/previous call/);
  });
});
