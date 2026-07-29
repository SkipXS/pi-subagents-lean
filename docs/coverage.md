# Test and coverage policy

## Local checks

Run the same checks required by CI before opening a pull request:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:test
bun run test
bun run test:coverage
bun run npm:production:smoke
bun run package:smoke
```

Coverage uses Vitest's V8 provider over `src/**/*.ts`. The report is written to
`coverage/` in text, JSON summary, and LCOV formats. CI uploads that directory as
the `coverage` artifact.

## Minimum coverage

The global thresholds in `vitest.config.ts` are:

| Metric | Minimum |
|---|---:|
| Statements | 79% |
| Branches | 69% |
| Functions | 75% |
| Lines | 80% |

Coverage runs once on Ubuntu with one worker. A single worker makes aggregation
reproducible for this suite because many tests intentionally isolate and mock the
same extension modules. The gates use the reproducible Ubuntu baseline; V8's
module/mocking instrumentation reports different aggregate values on Windows.
Linux also executes filesystem permission and symlink cases that may be skipped
on Windows.

Treat the thresholds as a regression floor, not a target for low-value tests.
Prefer lifecycle, concurrency, cleanup, configuration, and Pi contract paths.
Raise thresholds after a reproducible CI run improves the baseline. Do not lower
them without documenting the platform or instrumentation reason in the change.

## Compatibility and package checks

CI tests three supported environments:

- Ubuntu with the lockfile Pi versions;
- Windows with the lockfile Pi versions;
- Ubuntu with the minimum supported Pi version, `0.82.0`.

`bun run npm:production:smoke` installs the production dependency graph from a
fresh copy of `package.json` with npm. It catches npm peer-resolution failures
before install scripts run in Pi's production Git-source installation. `bun run package:smoke` packs
the published file set, installs the resulting tarball in an isolated project,
and loads the installed extension through Pi's public extension loader. It
performs no model or network request beyond package installation.

## Required checks for `main`

Repository branch protection requires these checks before merge:

- `Checks (Ubuntu, Pi locked)`
- `Checks (Windows, Pi locked)`
- `Checks (Ubuntu, Pi minimum)`
- `Coverage`
- `Package smoke`
