import { describe, expect, it, vi } from "vitest";
import { TypedEmitter } from "../src/emitter.js";

interface Events {
  tick: number;
  error: Error;
}

class TestEmitter extends TypedEmitter<Events> {
  fire<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.emit(event, payload);
  }
  clear(): void {
    this.removeAllListeners();
  }
}

describe("TypedEmitter", () => {
  it("delivers payloads to every listener of an event", () => {
    const emitter = new TestEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on("tick", a);
    emitter.on("tick", b);
    emitter.fire("tick", 42);
    expect(a).toHaveBeenCalledWith(42);
    expect(b).toHaveBeenCalledWith(42);
  });

  it("returns an unsubscribe function, and supports off()", () => {
    const emitter = new TestEmitter();
    const a = vi.fn();
    const b = vi.fn();
    const offA = emitter.on("tick", a);
    emitter.on("tick", b);
    offA();
    emitter.off("tick", b);
    emitter.fire("tick", 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(emitter.listenerCount("tick")).toBe(0);
  });

  it("does not throw when emitting 'error' with no listeners", () => {
    expect(() => {
      new TestEmitter().fire("error", new Error("x"));
    }).not.toThrow();
  });

  it("isolates a throwing listener and re-throws it asynchronously", () => {
    const deferred: (() => void)[] = [];
    const spy = vi
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation((cb) => void deferred.push(cb));
    const emitter = new TestEmitter();
    const after = vi.fn();
    const boom = new Error("listener bug");
    emitter.on("tick", () => {
      throw boom;
    });
    emitter.on("tick", after);

    expect(() => {
      emitter.fire("tick", 1);
    }).not.toThrow();
    expect(after).toHaveBeenCalledWith(1);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toThrow(boom);
    spy.mockRestore();
  });

  it("lets a listener remove itself while being called", () => {
    const emitter = new TestEmitter();
    const second = vi.fn();
    const off = emitter.on("tick", () => {
      off();
    });
    emitter.on("tick", second);
    emitter.fire("tick", 1);
    emitter.fire("tick", 2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(emitter.listenerCount("tick")).toBe(1);
  });

  it("removeAllListeners clears everything", () => {
    const emitter = new TestEmitter();
    emitter.on("tick", vi.fn());
    emitter.clear();
    expect(emitter.listenerCount("tick")).toBe(0);
  });
});
