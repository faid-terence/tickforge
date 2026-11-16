# tickforge

[![CI](https://github.com/faid-terence/tickforge/actions/workflows/ci.yml/badge.svg)](https://github.com/faid-terence/tickforge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40tickforge%2Fsdk)](https://www.npmjs.com/package/@tickforge/sdk)
[![types](https://img.shields.io/npm/types/%40tickforge%2Fsdk)](https://www.npmjs.com/package/@tickforge/sdk)
[![license](https://img.shields.io/npm/l/%40tickforge%2Fsdk)](./LICENSE)

Typed, resilient real-time market data for crypto exchange WebSocket feeds.
One small client for Node and the browser: normalized trades, 1-minute
candles, automatic reconnects, and no runtime dependencies.

**[▶ Live demo](https://tickforge.pages.dev)**: watch it stream, drop the connection on purpose,
and see it recover.

```ts
import { MarketClient } from "@tickforge/sdk";

const client = new MarketClient({ exchange: "coinbase" });
client.on("trade", (t) => console.log(t.symbol, t.side, t.price, t.size));
client.on("status", (s) => console.log("connection:", s.state));

await client.subscribe(["BTC-USD", "ETH-USD"]);
```

- **Typed end to end:** event names and payloads are checked by the compiler.
- **Resilient:** reconnects with exponential backoff and jitter, restores
  subscriptions, and detects silent ("stale") connections.
- **Safe on bad input:** every exchange message is validated; malformed ones
  become `error` events and never crash your process.
- **Small:** zero dependencies, about 4.6 KB min+gzip, tree-shakeable, ESM and CommonJS.

**Exchanges:** Coinbase Exchange. Binance is planned.

## Install

```sh
npm install @tickforge/sdk
```

Requires Node 22+ or any modern browser or web worker. Both have a global
`WebSocket`, which tickforge uses by default. To use the
[`ws`](https://github.com/websockets/ws) package instead (for proxies, custom
headers or older runtimes), pass it in:

```ts
import WebSocket from "ws";
const client = new MarketClient({ exchange: "coinbase", WebSocket });
```

## Usage

### Events

```ts
client.on("trade", (trade) => {}); // Trade
client.on("candle", (candle) => {}); // Candle
client.on("status", (status) => {}); // StatusEvent
client.on("error", (error) => {}); // TickforgeError
client.on("warning", (warning) => {}); // WarningEvent
client.on("gap", (gap) => {}); // GapEvent: trades were missed

const off = client.on("trade", handler);
off(); // remove the listener
```

Unlike Node's `EventEmitter`, an `error` with no listener does not throw.
Listen to `error` anyway: it tells you about dropped symbols and malformed messages.

### Async iteration

```ts
await client.subscribe(["BTC-USD"]);

for await (const trade of client.trades("BTC-USD")) {
  console.log(trade.price);
  if (trade.price > 100_000) break; // detaches the iterator
}
```

`trades()` is a view over the `trade` event; it does not subscribe for you.
The loop ends on `break` or when the client is closed.

### Shutting down

```ts
await client.close();
```

`close()` rejects pending requests with `CLIENT_CLOSED`, ends all iterators,
closes the socket, clears every timer and removes all listeners, so your
process can exit. It is idempotent.

## API

### `new MarketClient(options)`

| Option             | Type                               | Default                | Description                                                    |
| ------------------ | ---------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `exchange`         | `"coinbase"`                       | required               | Which exchange to connect to.                                  |
| `url`              | `string`                           | the exchange's feed    | Override the WebSocket URL, e.g. for a sandbox or test server. |
| `WebSocket`        | `WebSocketConstructor`             | `globalThis.WebSocket` | WebSocket implementation, e.g. the `ws` package.               |
| `backoff`          | `{ initialDelayMs?, maxDelayMs? }` | `500`, `30_000`        | Reconnect delay bounds (full jitter, see below).               |
| `staleTimeoutMs`   | `number`                           | `10_000`               | Reconnect if no message arrives for this long.                 |
| `requestTimeoutMs` | `number`                           | `10_000`               | Reject `subscribe`/`unsubscribe` if not acknowledged in time.  |

Throws a `TickforgeError` with code `NO_WEBSOCKET` if no WebSocket is available,
and a `TypeError` for an unknown exchange.

### Methods and properties

| Member                                | Description                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `subscribe(symbols): Promise<void>`   | Subscribes; connects on first use. Resolves when the exchange confirms every symbol. |
| `unsubscribe(symbols): Promise<void>` | Unsubscribes. Events stop immediately. With nothing left, the client goes `idle`.    |
| `trades(symbol, { bufferSize? })`     | Returns a `TradeIterator` (async iterator of `Trade`).                               |
| `close(): Promise<void>`              | Shuts down permanently.                                                              |
| `on(event, listener)`                 | Adds a listener; returns a function that removes it.                                 |
| `off(event, listener)`                | Removes a listener.                                                                  |
| `state`                               | Current `ConnectionState`.                                                           |
| `symbols`                             | Symbols subscribed or being subscribed.                                              |
| `stats`                               | `{ gaps, missedTrades, duplicateTrades, outOfOrderTrades }` since creation.          |

Symbols use `BASE-QUOTE` form (`"BTC-USD"`), case-insensitive. A malformed
symbol throws a `TypeError` before anything is sent.

### Data types

```ts
interface Trade {
  exchange: "coinbase";
  symbol: string; // "BTC-USD"
  id: string;
  price: number;
  size: number; // base-asset quantity
  side: "buy" | "sell"; // the TAKER's side (the aggressor)
  timestamp: number; // ms since epoch, UTC
}

interface Candle {
  exchange: "coinbase";
  symbol: string;
  interval: "1m";
  openTime: number; // start of the minute, ms since epoch, UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number; // number of trades in the candle
  closed: boolean; // true for the final version
  incomplete: boolean; // true if a sequence gap means trades are missing
}
```

> **`side` is the taker's side.** Coinbase reports the _maker's_ side in its
> `match` messages; tickforge flips it so `"buy"` means a buyer lifted the offer,
> which is what most charting and analytics code expects.

## Behaviour you can rely on

### Subscriptions are all-or-nothing

`subscribe(["ETH-USD", "NOPE-USD"])` rejects with `EXCHANGE_ERROR`, and neither
symbol stays subscribed, even though the exchange accepted ETH-USD (tickforge
unsubscribes it again). A failed call never removes a symbol that another call
subscribed successfully or is still subscribing.

Calling `subscribe` for a symbol another call is still waiting on does not
resolve early; it waits for the exchange to confirm it too.

### Reconnects

When the socket drops, or no message arrives for `staleTimeoutMs` (the client
subscribes to the exchange's heartbeat channel, so a healthy feed is never silent),
tickforge reconnects and restores every subscription in one request.

Delays use exponential backoff with **full jitter**:
`random(0, min(maxDelayMs, initialDelayMs × 2^(attempt − 1)))`. Without the
randomness, every client disconnected by the same outage would retry in
lockstep. The attempt counter resets only after the new connection delivers a
message, so a server that accepts and immediately drops connections cannot
cause a tight retry loop.

A `subscribe` waiting for an ack when the socket drops is carried over to the
re-subscription instead of failing.

### Connection states

```text
idle ──subscribe()──► connecting ──► open ──► reconnecting ──► connecting ──► …
 ▲                                    │
 └──── unsubscribed from everything ──┘

any state ──close()──► closed
```

The client connects lazily on the first `subscribe()` and returns to `idle`
(no socket, no timers) when nothing is subscribed. A later `subscribe()`
connects again immediately.

### Candles

Candles are built from the trade stream; Coinbase's feed has no candle channel.

- Every trade that changes a candle emits it with `closed: false`.
- The final version is emitted once with `closed: true`, at **whichever comes
  first**: the first trade of a later minute, or 2 seconds after the minute
  ends by the local clock. The grace period absorbs network latency, and the
  timer means a symbol that stops trading still gets its final candle on time.
- **Minutes with no trades produce no candle.** There is no price information
  to build one from. To draw a continuous series, fill gaps yourself, e.g.
  with a flat candle at the previous close.
- Closed candles are final. A trade for an already closed minute still emits a
  `trade` event but changes no candle.
- If trades are missed (see below), the affected candles get
  `incomplete: true`, including one that already closed, which is emitted once
  more with the flag set and its values unchanged.

### Knowing when data is missing: `gap`

Exchanges drop messages, and anything that trades while you are
reconnecting is missed. tickforge detects both from Coinbase's trade ids,
which increase by exactly 1 per trade per product, and from the `last_match`
position Coinbase sends when (re)subscribing:

```ts
client.on("gap", (gap) => {
  // { symbol: "BTC-USD", reason: "reconnect", expected: 1001, received: 1063,
  //   missed: 62, from: 1767268800000, to: 1767268815000 }
  console.warn(`${gap.symbol}: ${gap.missed} trades missed (${gap.reason})`);
});
console.log(client.stats); // { gaps, missedTrades, duplicateTrades, outOfOrderTrades }
```

- Candles overlapping the gap's `from`–`to` range get `incomplete: true`.
  Minutes inside the range with no candle are unknown, not quiet.
- **Duplicate** and **out-of-order** trades are dropped, never emitted, so they
  can't double-count volume or rewind a close. They're counted in `stats`.
- Missed trades are reported, not recovered. The event gives you the symbol and
  id range if you want to backfill them from Coinbase's REST API yourself.

### Slow `for await` loops

Each iterator buffers up to `bufferSize` trades (default `1000`) while your
loop body is busy. When full, the **oldest** trades are dropped: for live
market data, fresh beats complete-but-stale, and an unbounded buffer would
grow forever. Drops are observable:

```ts
const iterator = client.trades("BTC-USD", { bufferSize: 500 });
client.on("warning", (w) => console.warn(w.code, w.symbol, w.dropped));

for await (const trade of iterator) {
  await slowWork(trade);
  if (iterator.dropped > 0) console.log(`${iterator.dropped} trades skipped so far`);
}
```

The `warning` (`TRADES_DROPPED`) fires once per overflow episode, not once per
dropped trade, so it does not add load to a consumer that is already behind.

If you must not lose trades, use `client.on("trade", …)` and queue them yourself.

## Errors

All errors are `TickforgeError` instances. Check `code`, not the message.

| `code`            | When                                                                                   | Where               |
| ----------------- | -------------------------------------------------------------------------------------- | ------------------- |
| `EXCHANGE_ERROR`  | The exchange rejected a request, or dropped a symbol on reconnect (`details.symbols`). | rejection / `error` |
| `REQUEST_TIMEOUT` | No ack within `requestTimeoutMs`.                                                      | rejection           |
| `CLIENT_CLOSED`   | Used after, or interrupted by, `close()`.                                              | rejection / throw   |
| `PARSE_ERROR`     | A malformed exchange message was dropped (`details.raw` holds a truncated copy).       | `error` event       |
| `TRANSPORT_ERROR` | Socket error or stale connection; a reconnect follows automatically.                   | `error` event       |
| `NO_WEBSOCKET`    | No WebSocket implementation is available.                                              | constructor         |

## License

[MIT](./LICENSE)
