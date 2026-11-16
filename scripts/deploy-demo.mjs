/**
 * Deploys the demo to Cloudflare Pages (https://tickforge.pages.dev) from
 * exactly what is on origin/main, so the live demo always matches a commit.
 *
 * Usage (from the repo root): pnpm deploy:demo
 *
 * Needs a one-time `npx wrangler@4.156.1 login` with the Cloudflare account
 * that owns the `tickforge` Pages project. Wrangler keeps that OAuth login on
 * this machine; no Cloudflare secret is stored in the repository or on GitHub.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WRANGLER = "wrangler@4.156.1"; // pinned; bump deliberately
const PROJECT = "tickforge";
const root = fileURLToPath(new URL("..", import.meta.url));

const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const run = (cmd, args, env = process.env) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

// 1. Deploy only what is committed and pushed to main.
if (out("git", ["status", "--porcelain"])) fail("Uncommitted changes. Commit and push first.");
if (out("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") fail("Not on main.");
run("git", ["fetch", "--quiet", "origin", "main"]);
const commit = out("git", ["rev-parse", "HEAD"]);
if (commit !== out("git", ["rev-parse", "origin/main"])) {
  fail("Local main differs from origin/main. Pull or push first.");
}
const subject = out("git", ["log", "-1", "--format=%s"]);
console.log(`Deploying demo at ${commit.slice(0, 7)}: ${subject}`);

// 2. Test and build. The commit is stamped into the page footer and /version.json.
run("pnpm", ["--filter", "@tickforge/demo", "test"]);
run("pnpm", ["--filter", "@tickforge/demo", "build"], {
  ...process.env,
  BASE_PATH: "/",
  VITE_DEMO_COMMIT: commit,
});
writeFileSync(
  `${root}/apps/demo/dist/version.json`,
  `${JSON.stringify({ commit, subject, builtAt: new Date().toISOString() }, null, 2)}\n`,
);

// 3. Upload.
run("npx", [
  "--yes",
  WRANGLER,
  "pages",
  "deploy",
  "apps/demo/dist",
  "--project-name",
  PROJECT,
  "--branch",
  "main",
  "--commit-hash",
  commit,
  "--commit-message",
  subject,
]);
console.log(`✓ Live at https://${PROJECT}.pages.dev (check /version.json for the commit)`);
