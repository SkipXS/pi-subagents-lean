# Test and coverage policy

The local release gate should match CI. Run these commands from a clean
checkout:

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

Coverage uses Vitest's V8 provider over `src/**/*.ts`. Reports are written to
`coverage/` as text, JSON summary, and LCOV. The instrumented coverage run
excludes `test/pi-contract-smoke.test.ts`: Pi's public loader uses Jiti to load
a second, uninstrumented copy of the extension module graph, which produces
incorrect V8 function counts when merged into coverage. The ordinary `bun run
test` run still executes that contract test, and `bun run package:smoke`
independently loads the installed tarball through Pi. Both checks are required;
coverage is not a replacement for either loader smoke.

## Minimum coverage

Global thresholds in `vitest.config.ts` are 79% statements, 74% branches, 75%
functions, and 81% lines. Critical per-file floors are:

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

Coverage runs with two workers. Raise floors only after stable cross-platform
evidence; do not trade behavioral assertions for coverage padding.

## Compatibility and CI

Supported Pi is `>=0.82.0 <0.83.0` (Pi `0.82.x`), matching the package's
`^0.82.0` peer ranges. CI runs locked dependencies on Ubuntu and Windows and the minimum
supported version on Ubuntu:

- `Checks (Ubuntu, Pi locked)`
- `Checks (Windows, Pi locked)`
- `Checks (Ubuntu, Pi minimum)`
- `Coverage`
- `Package smoke`
- `Package smoke (Windows)`

The package smoke packs and installs the allowlisted package, checks its
manifest and bundled role Markdown, then loads the tarball through Pi's public
extension loader. The npm production smoke installs a manifest without
development dependencies. Neither smoke makes a model/provider request.
`release:validate` checks the package version and dated changelog heading
without changing tags, the registry, GitHub, or any external state. See
[`docs/releasing.md`](releasing.md) for the repo-only release checklist.
