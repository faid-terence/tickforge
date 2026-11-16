import { WebSocketServer, type WebSocket } from "ws";
import { error, match, subscriptions } from "../fixtures/coinbase.js";

/**
 * A real WebSocket server that mimics the parts of the Coinbase feed tickforge
 * uses: acking subscribe/unsubscribe with the full subscription list,
 * rejecting unknown products, and pushing messages to subscribers.
 */
export class MockCoinbaseServer {
  readonly #wss: WebSocketServer;
  readonly knownProducts = new Set(["BTC-USD", "ETH-USD", "SOL-USD"]);
  /**
   * The exchange's latest trade id per product. Like the real feed, ids are
   * global per product (they keep increasing while a client is disconnected).
   */
  readonly lastTradeId = new Map<string, number>([
    ["BTC-USD", 1000],
    ["ETH-USD", 2000],
    ["SOL-USD", 3000],
  ]);
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
        const newlySubscribed: string[] = [];
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
          } else if (msg.type === "subscribe") {
            if (!subscribed.has(p)) newlySubscribed.push(p);
            subscribed.add(p);
          } else subscribed.delete(p);
        }
        socket.send(JSON.stringify(subscriptions([...subscribed])));
        // Verified live: one `last_match` per NEWLY subscribed product, after the ack.
        for (const p of newlySubscribed) {
          socket.send(
            JSON.stringify({
              ...match({
                product_id: p,
                trade_id: this.lastTradeId.get(p),
                time: new Date().toISOString(),
              }),
              type: "last_match",
            }),
          );
        }
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

  /**
   * Executes `count` trades on the exchange for `product`, numbered like the
   * real feed. `deliver: false` executes them without sending them (as if the
   * client missed them); duplicates and reordering are expressed by sending
   * specific ids with {@link MockCoinbaseServer.sendTrade}.
   */
  trade(
    product: string,
    {
      count = 1,
      deliver = true,
      fields = {},
    }: { count?: number; deliver?: boolean; fields?: Record<string, unknown> } = {},
  ): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const id = (this.lastTradeId.get(product) ?? 0) + 1;
      this.lastTradeId.set(product, id);
      ids.push(id);
      if (deliver) this.sendTrade(product, id, fields);
    }
    return ids;
  }

  /** Sends a `match` with a specific trade id (to replay duplicates or reorder). */
  sendTrade(product: string, tradeId: number, fields: Record<string, unknown> = {}): void {
    this.broadcast(
      match({ product_id: product, trade_id: tradeId, time: new Date().toISOString(), ...fields }),
    );
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
