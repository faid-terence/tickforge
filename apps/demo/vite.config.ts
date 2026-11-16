import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const sdkSource = fileURLToPath(new URL("../../packages/sdk/src/index.ts", import.meta.url));

export default defineConfig({
  // Cloudflare Pages serves the demo from "/". Set BASE_PATH to host it under
  // a sub-path instead (e.g. BASE_PATH=/tickforge/ for a GitHub Pages project site).
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  resolve: {
    // Use the SDK's source, not its build output: edits to the SDK hot-reload
    // in the demo, and there is no "build the SDK first" step to forget.
    alias: { "@tickforge/sdk": sdkSource },
  },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
