/**
 * A scriptable in-memory WebSocket for deterministic tests with fake timers.
 * Each instance is recorded so a test can drive "the current socket".
 */
type Listener = (event: unknown) => void;

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  /** The most recently constructed socket. */
  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No FakeWebSocket created yet");
    return socket;
  }

  readonly url: string;
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("FakeWebSocket: send() while not open");
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    // Real sockets report "close" asynchronously, after the closing handshake.
    queueMicrotask(() => {
      this.serverClose(1000);
    });
  }

  /** Parsed JSON of every frame the client sent. */
  get sentJson(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  // ── test controls ────────────────────────────────────────────────────────
  open(): void {
    this.readyState = 1;
    this.#dispatch("open", {});
  }

  receive(data: unknown): void {
    this.#dispatch("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  receiveRaw(data: unknown): void {
    this.#dispatch("message", { data });
  }

  error(error: unknown = new Error("boom")): void {
    this.#dispatch("error", { error });
  }

  serverClose(code = 1006, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#dispatch("close", { code, reason });
  }

  #dispatch(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}
