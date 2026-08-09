# Dev
**Package manager:** bun (`bun install`, `bun add`, `bun add -d`)
**Typecheck:** `bun run typecheck` and `bun run typecheck:test`
**Tests:** `bun run test` (vitest)
**Release checks:** `bun run release:validate`, `bun run test:coverage`, `bun run pack:check`, `bun run package:smoke`, and `bun run npm:production:smoke`
**Versioning:** Let Bun regenerate `bun.lock` for version changes; never hand-edit the lockfile.
**Before committing:** run both typecheck and tests, plus the release checks for a release change.

## Branching
Before creating a feature branch, always run `git fetch origin --prune`, verify the current remote default branch, and branch from the fetched `origin/main` rather than a potentially stale local `main`.

**Windows shell safety:** Never use `> nul`, `2> nul`, `2>nul`, or `&> nul` in repository shell commands. Use PowerShell `$null`, POSIX `/dev/null`, or cmd `NUL`.
