/**
 * Runs the tickforge client off the main thread.
 *
 * The SDK pushes events as they arrive; this worker folds them into a
 * BatchAccumulator and posts one message every FLUSH_MS. The UI therefore
 * re-renders at most 10 times a second however busy the market is.
 */
import { MarketClient, type StatusEvent, type TradeIterator } from "@tickforge/sdk";
import { BatchAccumulator } from "./batch";
import { describeFrame, instrumentWebSocket } from "./instrumented-websocket";
import type { Command, DemoSymbol, WorkerMessage } from "./protocol";

const FLUSH_MS = 100;
/** Small on purpose, so the slow-consumer switch visibly overflows it. */
const ITERATOR_BUFFER = 20;
/** With the slow consumer on, the loop handles at most ~4 trades per second. */
const SLOW_CONSUMER_DELAY_MS = 250;
/**
 * How long "Simulate disconnect" keeps the network down. Long enough for the
 * SDK to retry with backoff a few times and for trades to happen meanwhile,
 * so the resulting sequence gap is visible.
 */
const OUTAGE_MS = 3_000;

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
/** After a simulated outage: has the SDK reported a gap since reconnecting? */
let awaitingGapCheck = false;
let gapsAtReconnect = 0;

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
    if (awaitingGapCheck) {
      awaitingGapCheck = false;
      gapsAtReconnect = client.stats.gaps;
      // last_match arrives right after the re-subscription ack. If no gap was
      // reported by then, say so explicitly: "no gap" is also a verified result.
      setTimeout(() => {
        if (client.stats.gaps === gapsAtReconnect) {
          batch.log(
            "info",
            "re-subscribed: last_match continues the sequence, no trades were missed",
          );
        }
      }, 2_000);
    }
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

client.on("gap", (g) => {
  const where = g.reason === "reconnect" ? "while disconnected" : "mid-stream";
  const range = g.missed === 1 ? `#${g.expected}` : `#${g.expected}–#${g.received - 1}`;
  batch.log(
    "gap",
    `${g.symbol}: ${g.missed} trade${g.missed === 1 ? "" : "s"} missed ${where} (${range}); affected candles marked incomplete`,
  );
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
      const dropped = socket.dropAll(OUTAGE_MS);
      if (dropped > 0) awaitingGapCheck = true;
      batch.log(
        "info",
        dropped > 0
          ? `simulated outage: socket closed, network down for ${String(OUTAGE_MS / 1000)}s; trades keep happening on the exchange`
          : "no open socket to drop",
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
  const { gaps, missedTrades } = client.stats;
  const message = batch.flush(symbol, {
    tradesReceived,
    dropped: iterator?.dropped ?? 0,
    reconnects,
    gaps,
    missedTrades,
  });
  if (message) post(message);
}, FLUSH_MS);
