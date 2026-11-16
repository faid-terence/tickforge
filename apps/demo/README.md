# tickforge demo

**Live: https://faid-terence.github.io/tickforge/**

A React + Redux Toolkit app that streams Coinbase market data through the
`tickforge` SDK and makes its guarantees visible:

| On screen                | What it shows                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status pill              | The SDK's `status` events: `connecting`, `open`, `reconnecting` (with attempt number and jittered delay), `idle`.                                                                              |
| **Simulate disconnect**  | Closes the socket like a network failure. The connection log shows the backoff, the reconnect, and the re-subscribe frame.                                                                     |
| **Slow consumer** switch | Throttles the `for await` loop to ~4 trades/s with a 20-trade buffer. The _Dropped by loop_ counter and `TRADES_DROPPED` warning show the iterator's drop policy, while candles stay complete. |
| Candle chart             | 1-minute candles. The newest one forms live from trades, closing on the next minute's first trade or 2s after the minute ends.                                                                 |
| Connection log           | Status changes plus every subscribe/unsubscribe frame sent and acknowledged, read off the wire.                                                                                                |

## How it is built

```text
 main thread                            Web Worker
┌──────────────────────────┐  commands  ┌─────────────────────────────────┐
│ React + Redux Toolkit    │ ─────────► │ MarketClient (tickforge)        │
│                          │            │   ├─ instrumented WebSocket     │
│ listener middleware:     │  1 batch   │   │   (wire log, drop button)   │
│ worker commands, REST    │ ◄───────── │   └─ BatchAccumulator           │
│ history, theme           │  / 100ms   │       flushes every 100ms       │
└──────────────────────────┘            └─────────────────────────────────┘
```

- **The SDK runs in a worker.** Socket handling, JSON parsing and validation
  never compete with rendering.
- **One message per 100ms.** The worker folds every event into a
  `BatchAccumulator` and posts a single batch per interval (or nothing, if
  nothing changed), so React renders at most 10 times a second however busy the market is.
- **Disconnects are real.** The worker passes the SDK an instrumented
  `WebSocket` class through the SDK's public `WebSocket` option. The SDK has
  no test hooks; to it, a simulated drop is a real one.
- **History is demo scaffolding.** The last hour of candles comes from
  Coinbase's REST API so the chart is not empty on load. Live candles from the
  SDK replace REST candles for the same minute. The SDK itself is real-time only.
- **Colours are validated.** Up/down candles use a blue/red pair checked for
  colour-blind separation and contrast in both themes; direction is also shown
  with ▲/▼, never colour alone.

## Develop

```sh
pnpm install
pnpm dev     # from the repo root; SDK edits hot-reload too
pnpm --filter @tickforge/demo test
```

The demo imports the SDK's source (see `vite.config.ts`), so there is no
build step between editing the SDK and seeing the change.
