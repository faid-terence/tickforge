import { WebSocketServer, type WebSocket } from "ws";
import { error, subscriptions } from "../fixtures/coinbase.js";

/**
 * A real WebSocket server that mimics the parts of the Coinbase feed tickforge
 * uses: acking subscribe/unsubscribe with the full subscription list,
 * rejecting unknown products, and pushing messages to subscribers.
 */
export class MockCoinbaseServer {
  readonly #wss: WebSocketServer;
  readonly knownProducts = new Set(["BTC-USD", "ETH-USD", "SOL-USD"]);
  /** Every JSON frame received, across all connections. */
  readonly received: Record<string, unknown>[] = [];
  connections = 0;

  private constructor(wss: WebSocketServer) {
    this.#wss = wss;
    wss.on("connection", (socket) => {
      this.connections += 1;
      const subscribed = new Set<string>();
      socket.on("message", (data) => {
        const msg = JSON.parse((data as Buffer).toString("utf8")) as {
          type: string;
          product_ids: string[];
          channels: string[];
        };
        this.received.push(msg);
        // Mirrors the live feed (verified 2026-11): valid products in a request
        // are applied, each invalid one yields one error PER CHANNEL, and every
        // request ends with exactly one full `subscriptions` snapshot.
        for (const p of msg.product_ids) {
          if (!this.knownProducts.has(p)) {
            for (const _channel of msg.channels) {
              socket.send(
                JSON.stringify(error("Failed to subscribe", `${p} is not a valid product`)),
              );
            }
          } else if (msg.type === "subscribe") subscribed.add(p);
          else subscribed.delete(p);
        }
        socket.send(JSON.stringify(subscriptions([...subscribed])));
      });
    });
  }

  static async start(): Promise<MockCoinbaseServer> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return new MockCoinbaseServer(wss);
  }

  get url(): string {
    const address = this.#wss.address();
    if (address === null || typeof address === "string") throw new Error("unexpected address");
    return `ws://127.0.0.1:${address.port}`;
  }

  get clients(): WebSocket[] {
    return [...this.#wss.clients];
  }

  /** Sends a message (object → JSON, string → as-is) to every client. */
  broadcast(message: unknown): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    for (const client of this.#wss.clients) client.send(data);
  }

  /** Abruptly kills every connection, like a network failure. */
  dropAll(): void {
    for (const client of this.#wss.clients) client.terminate();
  }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve, reject) => {
      this.#wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
