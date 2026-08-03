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
bun run pack:check
```

Coverage uses Vitest's V8 provider over `src/**/*.ts`. Reports are written to
`coverage/` as text, JSON summary, and LCOV; CI uploads the directory.

## Minimum coverage

Global thresholds in `vitest.config.ts` are 79% statements, 74% branches, 75%
functions, and 81% lines. Critical failure/race boundaries additionally have
conservative per-file floors:

| Module | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| `src/registration.ts` | 80% | 70% | 95% | 80% |
| `src/agents/agent-manager.ts` | 85% | 80% | 80% | 88% |
| `src/config/config-io.ts` | 68% | 80% | 73% | 70% |
| `src/prompt/skill-loader.ts` | 72% | 80% | 70% | 72% |
| `src/spawn/spawn-coordinator.ts` | 74% | 70% | 80% | 74% |

The manager function floor remains at the project gate for the active root-only
implementation; all other floors remain below the reproducible Ubuntu baseline rather than rounded up
to arbitrary targets. Coverage runs with one worker because tests intentionally
isolate and mock shared extension modules. Linux is the gate platform because
V8 module/mocking instrumentation differs on Windows and some filesystem cases
are platform-specific. Raise floors after stable CI evidence; do not trade
behavioral assertions for coverage padding.

## Compatibility and package checks

CI runs locked Pi checks on Ubuntu and Windows and minimum-supported Pi checks
on Ubuntu. Package smokes run on both Ubuntu and Windows. Each CI job has a
finite job timeout, and subprocess-based integration/package checks also have
explicit process timeouts.

`bun run npm:production:smoke` installs a production-only manifest with npm.
`bun run package:smoke` packs and installs the tarball, verifies its manifest,
documentation, and bundled Markdown agents, then loads it through Pi's public
extension loader. Neither smoke makes a model/provider request.

Skill integration tests use Pi's real loaders with temporary git/ignore trees.
Directory junctions are used on Windows where possible; privileged Windows file
symlinks and UNC paths are intentionally not claimed. The suite also does not pretend to validate paid provider calls or power-loss
durability; headless extension lifecycle and package loading are covered.

## Required checks for `main`

- `Checks (Ubuntu, Pi locked)`
- `Checks (Windows, Pi locked)`
- `Checks (Ubuntu, Pi minimum)`
- `Coverage`
- `Package smoke`
- `Package smoke (Windows)`
