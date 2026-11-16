import { defineConfig } from "vitest/config";

/** Opt-in tests against real exchanges: `pnpm test:live`. Never run in CI. */
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 15_000,
    // One connection at a time: be polite to the exchange.
    fileParallelism: false,
  },
});
