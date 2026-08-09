# Repository-only release checklist

This checklist validates release metadata and prepares a repository commit. It
does not create tags, publish to npm, or create a GitHub Release. Those actions
require separate, explicit approval.

## Prepare and validate

1. Fetch and inspect the current remote state. Work from a clean local `main`
   whose `HEAD` is the intended current `origin/main`; do not prepare a release
   from an unmerged branch or with unrelated changes. Read-only checks include:

   ```bash
   git fetch origin --prune
   git status --short
   git rev-parse HEAD
   git rev-parse origin/main
   ```

2. Confirm that `package.json` has the intended semantic version and that
   `CHANGELOG.md` contains the matching dated heading exactly as
   `## [<version>] - YYYY-MM-DD`. Confirm the README install command and the
   Pi requirement `>=0.82.0 <0.83.0` (Pi `0.82.x`) match the package's
   `^0.82.0` peer ranges and release version.
3. Confirm that the exact tag `v<version>` does not exist locally or on the
   configured remote. Read-only checks include `git tag --list "v<version>"`
   and `git ls-remote --tags origin "refs/tags/v<version>"`; do not create or
   push the tag during this check.
4. Run the full local gate at the intended commit:

   ```bash
   bun install --frozen-lockfile
   bun run typecheck
   bun run typecheck:test
   bun run test
   bun run test:coverage
   bun run release:validate
   bun run pack:check
   bun run package:smoke
   bun run npm:production:smoke
   ```

   The smoke checks use the package tarball and a production-only manifest;
   they do not make paid provider calls. `release:validate` checks the package
   version and dated changelog metadata without network or registry changes.
5. Record the validated commit SHA after the gate passes. The release tag must
   eventually point to this exact commit, not merely to a branch name. Review
   the final diff and `git status --short` again before handing it off.

## After separate approvals

Only after the repository review and a separate approval for tagging may an
annotated tag named exactly `v<version>` be created. Verify that its target is
the recorded validated commit before any tag push.

Tag pushing, npm publishing, and GitHub Release creation are three separate
external actions. Each requires its own explicit approval; none is implied by
this checklist or by a passing local/CI gate. Do not publish, push, or create a
release while performing repository-only validation.
