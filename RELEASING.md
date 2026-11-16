# Releasing @tickforge/sdk

The SDK is published to npm as **`@tickforge/sdk`** (the unscoped name
`tickforge` is blocked by npm as "too similar" to a reserved package,
`tick-forge`).

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

Before every push, run `pnpm check:all`: it runs exactly what CI runs.

## One-time setup

npm can only attach a trusted publisher to a package that already exists
([`npm trust` prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust)),
so the very first version is published by hand. It is published as `0.0.0`, a
bootstrap placeholder; the first real release, `0.1.0`, comes from CI.

### 1. GitHub

These can be done with the `gh` CLI (as below) or in the repository settings.

1. The repository must be **public** (npm only generates provenance for public repositories).
2. Allow the workflow to open the Version Packages PR
   (_Settings → Actions → General → Allow GitHub Actions to create and approve pull requests_):

   ```sh
   gh api -X PUT repos/faid-terence/tickforge/actions/permissions/workflow \
     -F default_workflow_permissions=read -F can_approve_pull_request_reviews=true
   ```

3. Create the `npm` environment, deployable only from `main`
   (_Settings → Environments → New environment_):

   ```sh
   echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
     gh api -X PUT repos/faid-terence/tickforge/environments/npm --input -
   gh api -X POST repos/faid-terence/tickforge/environments/npm/deployment-branch-policies \
     -f name=main -f type=branch
   ```

   Optionally add yourself as a **Required reviewer** to approve each publish by hand.

4. No secrets are needed. If an `NPM_TOKEN` secret exists, delete it.

### 2. npm account and organization

1. **Enable two-factor authentication** on your npm account (_avatar → Account →
   Two-Factor Authentication_, mode "Authorization and writes"). npm refuses to
   publish from an account without it (`E403 … Two-factor authentication … is required`).
2. **Create the `tickforge` organization** (_avatar → Add Organization_, free
   plan for public packages). It owns the `@tickforge` scope.
3. Note: the npm username (`faidterence`) and the GitHub owner
   (`faid-terence`) differ. That is fine; the trusted publisher below uses the
   **GitHub** owner.

### 3. Bootstrap publish (once, from your machine)

Run each command on its own line. (zsh does not treat `#` as a comment when
commands are pasted, so don't paste comments.)

```sh
npm login --auth-type=web
npm whoami
```

`npm whoami` must print your username. If it fails with `E401`, the token saved
in `~/.npmrc` is stale: run `npm login` again. A stale token makes
`npm publish` fail with a misleading `E404`.

```sh
cd packages/sdk
npm publish --dry-run
npm publish --access public
```

The dry run should show `@tickforge/sdk@0.0.0`, 9 files, tag `latest`, public
access. The real publish rebuilds `dist/` first (`prepublishOnly`) and asks
for 2FA.

A brand-new package takes a few minutes to appear. While npm processes it,
the registry may list only a `0.0.0-stage` placeholder (it stays in the
version list afterwards), and the tarball can return 404 from the CDN.
`npm view` may also show cached data; query the registry directly to check:

```sh
curl -s "https://registry.npmjs.org/@tickforge%2Fsdk" | grep -o '"dist-tags":{[^}]*}'
```

### 4. npmjs.com: trust the workflow

Do this **no more than 2 days before** merging the first Version Packages PR:
a new trusted publisher that has not published within 2 days expires.

1. Open **npmjs.com/package/@tickforge/sdk → Settings → Trusted Publisher** and choose **GitHub Actions**.
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
   npx npm@latest trust github @tickforge/sdk --repo faid-terence/tickforge --file release.yml --env npm --allow-publish
   ```

3. On the same Settings page, under **Publishing access**, choose
   **Require two-factor authentication and disallow tokens**, then
   **Update Package Settings**. Trusted publishing keeps working; tokens no longer can.
4. Under your avatar → **Access Tokens**, revoke any token you no longer need.

### 5. First real release

1. The Release workflow has opened **Version Packages** (`0.0.0 → 0.1.0`).
   Check the version bump and the changelog.
2. Merge it. Watch the **Release** run: `select-mode → pack → publish`.
3. Verify:
   - npmjs.com/package/@tickforge/sdk shows `0.1.0` with a **Provenance** badge.
   - `npm view @tickforge/sdk dist-tags` shows `latest: 0.1.0`.
   - `npm audit signatures` in a project that installs it reports a verified
     registry signature and a verified attestation.
4. Retire the placeholders (asks for 2FA):

   ```sh
   npm deprecate @tickforge/sdk@0.0.0 "Bootstrap placeholder, use @tickforge/sdk@>=0.1.0"
   npm deprecate @tickforge/sdk@0.0.0-stage "Registry placeholder, use @tickforge/sdk@>=0.1.0"
   ```

## Troubleshooting

- **`E404` on `npm publish`** of a new package: usually not a missing package
  but missing authentication. Check `npm whoami`.
- **`E403 … too similar to existing package`:** npm compares names with
  punctuation removed. Use a scope.
- **`E404` / `ENEEDAUTH` in the publish job:** the trusted publisher fields do
  not match exactly (owner, repo, `release.yml`, environment `npm`), or
  `repository.url` in `packages/sdk/package.json` does not point at
  `github.com/faid-terence/tickforge`.
- **The Version Packages PR shows no CI checks:** GitHub does not start
  workflows for events created with the built-in `GITHUB_TOKEN`. The Release
  workflow re-runs lint, typecheck, tests and package checks before publishing,
  so nothing unverified is published. Close and reopen the PR to trigger CI.
