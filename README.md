# tickforge

[![CI](https://github.com/faid-terence/tickforge/actions/workflows/ci.yml/badge.svg)](https://github.com/faid-terence/tickforge/actions/workflows/ci.yml)
[![Release](https://github.com/faid-terence/tickforge/actions/workflows/release.yml/badge.svg)](https://github.com/faid-terence/tickforge/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/%40tickforge%2Fsdk)](https://www.npmjs.com/package/@tickforge/sdk)
[![license](https://img.shields.io/github/license/faid-terence/tickforge)](./LICENSE)

A TypeScript SDK for real-time crypto market data: typed, resilient, and
dependency-free, for Node and the browser.

**[▶ Live demo](https://tickforge.pages.dev)**: the SDK streaming Coinbase in a Web Worker.
Pull the plug with _Simulate disconnect_ and watch it reconnect and re-subscribe.

```ts
import { MarketClient } from "@tickforge/sdk";

const client = new MarketClient({ exchange: "coinbase" });
client.on("trade", (t) => console.log(t.symbol, t.price));
await client.subscribe(["BTC-USD"]);
```

**[SDK documentation →](./packages/sdk/README.md)** · **[Architecture and design decisions →](./ARCHITECTURE.md)**

## Repository layout

This is a pnpm workspace.

| Path                             | What                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`packages/sdk`](./packages/sdk) | The `tickforge` npm package: client, adapters, candles.                                                               |
| [`apps/demo`](./apps/demo)       | React + Redux Toolkit demo; the SDK runs in a Web Worker. Live at [tickforge.pages.dev](https://tickforge.pages.dev). |

## Development

Requires Node 22+ and pnpm 10 (`corepack enable` picks up the pinned version).

```sh
pnpm install
pnpm dev             # the demo at http://localhost:5173, hot-reloading SDK edits too
pnpm test            # unit + end-to-end tests against a mock exchange server
pnpm test:coverage   # same, enforcing 90% coverage thresholds
pnpm test:live       # opt-in smoke test against the REAL Coinbase feed (needs network)
pnpm lint            # ESLint (typescript-eslint strict, type-checked)
pnpm format          # Prettier
pnpm typecheck
pnpm build           # ESM + CJS + .d.ts via tsup
pnpm check:package   # publint + are-the-types-wrong on the packed tarball
pnpm check:all       # everything CI runs, in the same order: run it before every push
pnpm deploy:demo     # deploy the demo from origin/main to tickforge.pages.dev
```

### How it is tested

- **Unit tests** drive the connection manager and client with a scripted fake
  WebSocket and fake timers, so backoff, stale detection, timeouts and candle
  timing are tested at exact millisecond boundaries without real waiting.
- **End-to-end tests** run the client against a real local WebSocket server
  that mimics Coinbase, including undocumented behaviour observed on the live
  feed. They run twice: with the `ws` package and with Node's native `WebSocket`.
- **Type tests** fail the typecheck if the public types regress.
- **Live tests** (`pnpm test:live`) hit the real Coinbase feed. They are opt-in
  and never run in CI, because they depend on the network and a third party.

## Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets).

1. In your PR, run `pnpm changeset` and describe the change for users.
2. When the PR merges, the Release workflow opens (or updates) a
   **Version Packages** PR that bumps the version and updates `CHANGELOG.md`.
3. Merging that PR publishes to npm with
   [provenance](https://docs.npmjs.com/generating-provenance-statements) and
   creates a GitHub release.

One-time setup: add an npm automation token as the `NPM_TOKEN` repository
secret, and enable _Settings → Actions → General → Allow GitHub Actions to
create and approve pull requests_.

## License

[MIT](./LICENSE)
