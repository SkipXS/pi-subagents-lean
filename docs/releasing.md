# Release checklist

This checklist prepares a version tag; it does not publish a package or create a
GitHub release. Publishing and releasing require separate, explicit approval.

## Before tagging

1. Start from the merged, current `origin/main`; do not tag an unmerged feature
   branch.
2. Confirm that `package.json` contains the intended semantic version and that
   `CHANGELOG.md` has a dated heading in the exact form
   `## [<version>] - YYYY-MM-DD`.
3. Confirm the public install instructions and requirements in `README.md`.
   The release must support Pi `>= 0.82.0`.
4. Run the complete local release gate:

   ```bash
   bun install --frozen-lockfile
   bun run typecheck
   bun run typecheck:test
   bun run test
   bun run test:coverage
   bun run package:smoke
   bun run release:validate
   ```

   `package:smoke` packs the allowlisted files, installs the tarball in an
   isolated project, and loads the installed extension through Pi's public
   extension loader. `release:validate` checks the version tag and changelog
   metadata without making network or registry changes.
5. Open and merge a pull request. Wait for every required `main` check to pass.

## Tag validation

After explicit approval, create and push an annotated tag named exactly
`v<version>` from the validated `main` commit. CI runs the normal cross-platform,
minimum-Pi, coverage, and installed-tarball checks for `v*` tags. Its
**Release metadata** job also rejects a tag that does not exactly match
`package.json` or lacks the dated changelog entry.

Do not publish a package, create a GitHub release, or push a tag as part of this
checklist without the required approval.
