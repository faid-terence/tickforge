/**
 * Measures what an app pays for importing tickforge: each entry below is
 * bundled, minified and tree-shaken the way an app bundler would, then gzipped.
 *
 * Usage: pnpm build && pnpm size
 */
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

const entries = {
  "MarketClient (everything)": `import { MarketClient } from "@tickforge/sdk"; console.log(MarketClient);`,
  "TickforgeError only": `import { TickforgeError } from "@tickforge/sdk"; console.log(TickforgeError);`,
  "CandleAggregator only": `import { CandleAggregator } from "@tickforge/sdk"; console.log(CandleAggregator);`,
};

const rows = [];
for (const [name, contents] of Object.entries(entries)) {
  const result = await build({
    stdin: { contents, resolveDir: `${root}/packages/sdk`, loader: "js" },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    write: false,
    alias: { "@tickforge/sdk": `${root}/packages/sdk/dist/index.js` },
    logLevel: "silent",
  });
  const code = result.outputFiles[0].contents;
  rows.push({
    import: name,
    "min (bytes)": code.length,
    "min+gzip (bytes)": gzipSync(code).length,
  });
}
console.table(rows);
