import { describe, expect, it, vi } from "vitest";
import {
  describeFrame,
  instrumentWebSocket,
  SIMULATED_DROP_CODE,
  type BaseSocket,
} from "./instrumented-websocket";

class FakeSocket implements BaseSocket {
  sent: string[] = [];
  closedWith: [number?, string?] | undefined;
  listeners: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (e: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, event: { data?: unknown }) {
    for (const l of this.listeners[type] ?? []) l(event);
  }
}

describe("instrumentWebSocket", () => {
  it("reports frames in both directions and still sends them", () => {
    const hooks = { onSend: vi.fn(), onReceive: vi.fn() };
    const { WebSocket } = instrumentWebSocket(FakeSocket, hooks);
    const socket = new WebSocket("wss://x");
    socket.send("out");
    socket.emit("message", { data: "in" });
    expect(socket.sent).toEqual(["out"]);
    expect(hooks.onSend).toHaveBeenCalledWith("out");
    expect(hooks.onReceive).toHaveBeenCalledWith("in");
  });

  it("dropAll() closes every open socket with the application close code", () => {
    const { WebSocket, dropAll } = instrumentWebSocket(FakeSocket, {
      onSend: () => {},
      onReceive: () => {},
    });
    const a = new WebSocket("wss://a");
    const b = new WebSocket("wss://b");
    expect(dropAll()).toBe(2);
    expect(a.closedWith).toEqual([SIMULATED_DROP_CODE, "simulated disconnect"]);
    expect(b.closedWith?.[0]).toBe(SIMULATED_DROP_CODE);
    expect(dropAll()).toBe(0); // closed sockets are forgotten
  });
});

describe("describeFrame", () => {
  it("summarises subscription traffic", () => {
    expect(
      describeFrame("out", JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"] })),
    ).toBe("subscribe [BTC-USD]");
    expect(
      describeFrame(
        "in",
        JSON.stringify({
          type: "subscriptions",
          channels: [{ name: "matches", product_ids: ["BTC-USD", "ETH-USD"] }],
        }),
      ),
    ).toBe("subscriptions ack [BTC-USD, ETH-USD]");
    expect(describeFrame("in", JSON.stringify({ type: "error", message: "nope" }))).toBe(
      "error: nope",
    );
  });

  it("ignores high-volume and malformed frames", () => {
    expect(describeFrame("in", JSON.stringify({ type: "match" }))).toBeUndefined();
    expect(describeFrame("in", "{{{")).toBeUndefined();
    expect(describeFrame("in", new ArrayBuffer(1))).toBeUndefined();
    expect(describeFrame("in", "null")).toBeUndefined();
  });
});
