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

The instrumented coverage run excludes `test/pi-contract-smoke.test.ts`. Pi's
public loader uses Jiti to load a second, uninstrumented copy of the extension
module graph; merging that graph into V8 coverage produces incorrect function
counts even when the corresponding lines execute. `bun run test` still runs
this contract test, and `bun run package:smoke` independently loads the
installed tarball through Pi. Both checks are mandatory and must not be
replaced by the coverage run.

## Minimum coverage

Global thresholds in `vitest.config.ts` are 79% statements, 74% branches, 75%
functions, and 81% lines. Critical failure/race boundaries additionally have
conservative per-file floors:

| Module | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| `src/registration.ts` | 80% | 70% | 95% | 80% |
| `src/agents/agent-manager.ts` | 85% | 80% | 80% | 87% |
| `src/agents/tool-execution.ts` | 70% | 75% | 45% | 70% |
| `src/agents/agent-tool-results.ts` | 90% | 84% | 78% | 90% |
| `src/agents/agent-control-execution.ts` | 58% | 48% | 60% | 60% |
| `src/agents/agent-tool-policy.ts` | 90% | 90% | 80% | 90% |
| `src/agents/agent-frontmatter.ts` | 75% | 74% | 85% | 78% |
| `src/agents/agent-directory-scan.ts` | 82% | 70% | 80% | 82% |
| `src/agents/agent-discovery.ts` | 83% | 84% | 85% | 90% |
| `src/config/config-io.ts` | 68% | 68% | 73% | 70% |
| `src/prompt/skill-loader.ts` | 85% | 78% | 90% | 85% |
| `src/prompt/skill-cache.ts` | 70% | 70% | 68% | 70% |
| `src/prompt/skill-catalog.ts` | 60% | 40% | 64% | 62% |
| `src/prompt/skill-fingerprint-walk.ts` | 70% | 70% | 80% | 74% |
| `src/prompt/skill-limits.ts` | 78% | 70% | 65% | 80% |
| `src/prompt/skill-loader-worker.ts` | 85% | 70% | 90% | 90% |
| `src/spawn/spawn-coordinator.ts` | 74% | 70% | 80% | 74% |

The manager function floor remains at the project gate for the active root-only
implementation. The skill-module floors account for the measured Windows
instrumentation baseline while retaining the global project gates; they should
be raised only after stable cross-platform evidence rather than padded with
synthetic tests. Coverage runs with two workers; skill tests intentionally
isolate and mock shared extension modules while capping nested Worker usage.
Linux is the gate platform because
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
Trust/discovery tests cover trusted-to-untrusted catalog contamination,
trusted add-after-parent-turn refresh, ASCII/multibyte UTF-8 boundaries,
streaming iterator cleanup at Agent/skill entry limits, oversized Agent
Markdown rejected before readFile, deterministic bounded ordering, per-file
512 KiB/256 KiB ignore/32 MiB relevant-byte skill limits (including direct
root `source=agents` Markdown that is later filtered), 64 ancestor roots,
10,000-skill aggregate limits, post-worker fingerprint races, pathological
skill trees with 10,000-entry/depth-64 fingerprint budgets, worker timeout
cleanup, incrementally bounded 4 MiB UTF-8 worker metadata results with main
thread cache revalidation, and the project-free catalog. Prompt tests cover
1 MiB skill metadata and 2 MiB complete child system-prompt failures with
multibyte input and no partial selection. The runner covers `skills:true` and
explicit lists through the async metadata worker and `noSkills:true` in the
child loader while preserving arrays/false, exclusion, precedence, and trust
semantics. Context tests cover root-to-cwd ordering, 256/512 KiB
file/total limits, deep ancestor bounds, lstat identity races, and trust.
Config tests cover the 1 MiB pre-parse rejection, bounded override count, and
multibyte name/model strings. Record tests cover the 64 KiB prompt/response
projections, full multi-MiB foreground response return, identity-safe promise
release, shutdown cleanup, and deterministic 1 MiB summary-text pruning.
Foreground execution lifecycle tests cover parent-signal binding and cleanup,
exceptional runner setup, shutdown settlement, retained sessions, FIFO slot
release, and late completion. The suite does not pretend to validate paid
provider calls; headless extension lifecycle and package loading are covered.

## Required checks for `main`

- `Checks (Ubuntu, Pi locked)`
- `Checks (Windows, Pi locked)`
- `Checks (Ubuntu, Pi minimum)`
- `Coverage`
- `Package smoke`
- `Package smoke (Windows)`
