/**
 * Runs the tickforge client off the main thread.
 *
 * The SDK pushes events as they arrive; this worker folds them into a
 * BatchAccumulator and posts one message every FLUSH_MS. The UI therefore
 * re-renders at most 10 times a second however busy the market is.
 */
import { MarketClient, type StatusEvent, type TradeIterator } from "tickforge";
import { BatchAccumulator } from "./batch";
import { describeFrame, instrumentWebSocket } from "./instrumented-websocket";
import type { Command, DemoSymbol, WorkerMessage } from "./protocol";

const FLUSH_MS = 100;
/** Small on purpose, so the slow-consumer switch visibly overflows it. */
const ITERATOR_BUFFER = 20;
/** With the slow consumer on, the loop handles at most ~4 trades per second. */
const SLOW_CONSUMER_DELAY_MS = 250;

const batch = new BatchAccumulator();
const post = (message: WorkerMessage) => {
  self.postMessage(message);
};

const socket = instrumentWebSocket(WebSocket, {
  onSend: (data) => {
    const text = describeFrame("out", data);
    if (text) batch.log("wire-out", text);
  },
  onReceive: (data) => {
    const text = describeFrame("in", data);
    if (text) batch.log("wire-in", text);
  },
});

const client = new MarketClient({ exchange: "coinbase", WebSocket: socket.WebSocket });

let symbol: DemoSymbol | undefined;
let iterator: TradeIterator | undefined;
let slowConsumer = false;
let tradesReceived = 0;
let reconnects = 0;
let wasDropped = false;

function describeStatus(s: StatusEvent): string {
  if (s.state === "reconnecting") {
    return `reconnecting: attempt ${String(s.attempt)} in ${String(s.retryInMs)}ms (jittered backoff)`;
  }
  return s.state;
}

client.on("status", (s) => {
  if (s.state === "reconnecting") wasDropped = true;
  if (s.state === "open" && wasDropped) {
    wasDropped = false;
    reconnects += 1;
  }
  batch.setStatus({ ...s, since: Date.now() });
  batch.log("status", describeStatus(s));
});

client.on("trade", (trade) => {
  tradesReceived += 1;
  if (trade.symbol === symbol) batch.setLastTrade(trade);
});

client.on("candle", (candle) => {
  if (candle.symbol === symbol) batch.addCandle(candle);
});

client.on("error", (error) => {
  batch.log("error", `${error.code}: ${error.message}`);
});

client.on("warning", (warning) => {
  batch.log(
    "warning",
    `${warning.code}: ${warning.dropped} dropped so far (buffer of ${ITERATOR_BUFFER})`,
  );
});

/** Feeds the trade list through the SDK's async iterator, optionally slowly. */
async function consume(it: TradeIterator): Promise<void> {
  for await (const trade of it) {
    batch.addTrade(trade);
    if (slowConsumer) await new Promise((r) => setTimeout(r, SLOW_CONSUMER_DELAY_MS));
  }
}

// Commands are applied one at a time so a fast series of symbol switches
// cannot interleave its subscribe/unsubscribe calls.
let queue: Promise<void> = Promise.resolve();

async function select(next: DemoSymbol): Promise<void> {
  if (next === symbol) return;
  const previous = symbol;
  symbol = next;
  batch.clearMarketData();

  // Start the new view before subscribing so no early trade is missed.
  void iterator?.return?.();
  iterator = client.trades(next, { bufferSize: ITERATOR_BUFFER });
  void consume(iterator);

  try {
    // Subscribe to the new symbol before dropping the old one, so the client
    // never has an empty subscription set (which would close the socket).
    await client.subscribe([next]);
    batch.log("info", `${next} subscribed`);
    if (previous) await client.unsubscribe([previous]);
  } catch (error) {
    batch.log("error", error instanceof Error ? error.message : String(error));
  }
}

function handle(command: Command): void {
  switch (command.type) {
    case "select":
      queue = queue.then(() => select(command.symbol));
      return;
    case "simulate-disconnect": {
      const dropped = socket.dropAll();
      batch.log(
        "info",
        dropped > 0 ? "simulated network drop: socket closed" : "no open socket to drop",
      );
      return;
    }
    case "slow-consumer":
      slowConsumer = command.enabled;
      batch.log(
        "info",
        command.enabled
          ? `slow consumer on: loop handles ~${String(1000 / SLOW_CONSUMER_DELAY_MS)} trades/s`
          : "slow consumer off",
      );
      return;
  }
}

self.addEventListener("message", (event: MessageEvent<Command>) => {
  handle(event.data);
});

setInterval(() => {
  if (!symbol) return;
  const message = batch.flush(symbol, {
    tradesReceived,
    dropped: iterator?.dropped ?? 0,
    reconnects,
  });
  if (message) post(message);
}, FLUSH_MS);
