# Changesets

Every pull request that changes the published `tickforge` package should
include a changeset. Run `pnpm changeset`, pick the bump type (patch, minor or
major), and describe the change for users. The release workflow turns pending
changesets into a version bump and `CHANGELOG.md` entry, then publishes to npm.
