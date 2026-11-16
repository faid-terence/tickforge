---
"tickforge": minor
---

First release: a typed, resilient real-time market data client for the Coinbase Exchange feed, for Node 22+ and browsers, with no runtime dependencies.

- **`MarketClient`** with typed events (`trade`, `candle`, `status`, `error`, `warning`, `gap`), `subscribe`/`unsubscribe` promises that settle on the exchange's confirmation, and `close()` that stops every timer.
- **Resilient connection:** automatic reconnect with exponential backoff and full jitter, re-subscription after reconnect, stale-connection detection via Coinbase heartbeats, and an `idle` state with no socket when nothing is subscribed.
- **Safe subscriptions:** all-or-nothing `subscribe()`, and a failed call never removes a symbol another call owns.
- **Validated input:** malformed exchange messages become `PARSE_ERROR` events and never throw. Trade `side` is normalized to the taker's side.
- **1-minute candles** built from trades, closed on the next minute's first trade or 2 s after the minute ends. Empty minutes produce no candle.
- **Data integrity:** sequence-gap detection from Coinbase trade ids, both mid-stream and across reconnects (via `last_match`), reported as a `gap` event. Duplicate and out-of-order trades are dropped and counted. Candles affected by a gap are marked `incomplete: true`. Counters are available in `client.stats`.
- **`for await` iteration** with `client.trades(symbol)`, using a bounded buffer whose drops are counted (`iterator.dropped`) and reported (`TRADES_DROPPED` warning).
- **Pluggable candle engine** through the `candleBuilder` option; `CandleAggregator` is exported for standalone use.
- ESM and CommonJS builds with type declarations, tree-shakeable.
