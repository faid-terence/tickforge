# Releasing tickforge

Releases are published from GitHub Actions with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC).
No npm token exists anywhere: npm trusts the `release.yml` workflow in
`faid-terence/tickforge`, running in the `npm` environment, and nothing else.
Every release gets a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
automatically, linking it to the exact commit and workflow run that built it.

## Day to day

1. In your PR, run `pnpm changeset` and describe the change for users.
2. When the PR merges, the Release workflow opens (or updates) a
   **Version Packages** PR that bumps the version and updates `CHANGELOG.md`.
3. Merging that PR builds, verifies, packs and publishes the package, then
   pushes a git tag and creates a GitHub release.

## One-time setup

npm can only attach a trusted publisher to a package that already exists
([`npm trust` prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust)),
so the very first version is published by hand. It is published as `0.0.0`, a
bootstrap placeholder; the first real release, `0.1.0`, comes from CI.

### 1. GitHub

1. The repository must be **public** (npm only generates provenance for public repositories).
2. **Settings → Actions → General → Workflow permissions:** tick
   **Allow GitHub Actions to create and approve pull requests**, then **Save**.
   The Version Packages PR is opened by the workflow.
3. **Settings → Environments → New environment:** name it `npm` (exactly).
   Under **Deployment branches and tags**, choose **Selected branches and tags**
   and add the rule `main`. Optionally add yourself as a **Required reviewer**
   to approve each publish by hand.
4. No secrets are needed. If an `NPM_TOKEN` secret exists, delete it.

### 2. Bootstrap publish (once, from your machine)

1. On npmjs.com, make sure **two-factor authentication** is enabled on your
   account (**Account → Two-Factor Authentication**).
2. Check the name is still free: `npm view tickforge` should fail with `E404`.
3. Publish the placeholder (you will be asked for a 2FA code):

   ```sh
   npm login
   cd packages/sdk
   pnpm build
   npm publish --access public   # publishes tickforge@0.0.0
   ```

### 3. npmjs.com: trust the workflow

Do this **no more than 2 days before** merging the first Version Packages PR:
a new trusted publisher that has not published within 2 days expires.

1. Open **npmjs.com/package/tickforge → Settings → Trusted Publisher** and choose **GitHub Actions**.
2. Fill in exactly:

   | Field                | Value          |
   | -------------------- | -------------- |
   | Organization or user | `faid-terence` |
   | Repository           | `tickforge`    |
   | Workflow filename    | `release.yml`  |
   | Environment name     | `npm`          |

   Allow the **`npm publish`** action, then save.

   Equivalent CLI (needs npm 11.15+, hence `npx npm@latest`):

   ```sh
   npx npm@latest trust github tickforge --repo faid-terence/tickforge \
     --file release.yml --env npm --allow-publish
   ```

3. On the same Settings page, under **Publishing access**, choose
   **Require two-factor authentication and disallow tokens**, then
   **Update Package Settings**. Trusted publishing keeps working; tokens no longer can.
4. Under your avatar → **Access Tokens**, revoke any token you no longer need.

### 4. First real release

1. Push `main` (it contains the pending `initial-release` changeset). The
   Release workflow opens **Version Packages** (`0.0.0 → 0.1.0`).
2. Merge it. Watch the **Release** run: `select-mode → pack → publish`.
3. Verify:
   - npmjs.com/package/tickforge shows `0.1.0` with a **Provenance** badge.
   - `npm view tickforge dist-tags` shows `latest: 0.1.0`.
4. Retire the placeholder:

   ```sh
   npm deprecate tickforge@0.0.0 "Bootstrap placeholder, use tickforge@>=0.1.0"
   ```

## Troubleshooting

- **`E404` / `ENEEDAUTH` on publish:** the trusted publisher fields do not
  match exactly (owner, repo, `release.yml`, environment `npm`), or
  `repository.url` in `packages/sdk/package.json` does not point at
  `github.com/faid-terence/tickforge`.
- **The Version Packages PR shows no CI checks:** GitHub does not start
  workflows for events created with the built-in `GITHUB_TOKEN`. The Release
  workflow re-runs lint, typecheck, tests and package checks before publishing,
  so nothing unverified is published. If branch protection requires checks,
  close and reopen the PR to trigger CI.
