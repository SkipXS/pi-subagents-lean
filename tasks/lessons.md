# Lessons Learned

## General

### Worktrees
- Clean up after merge: commit/discard untracked files first. Verify path exists before spawning reviewers.
- Slice from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.
- Always verify worktree branch exists and is checked out before spawning builder.

### Testing
- Always `bun run test` after merging to main; clean merge ≠ passing tests.
- Acceptance tests match planned interface (plan.md), not guessed implementation.
- Test public interfaces and behavior, not implementation details or hardcoded data.
- User manual testing result ("all works") → record and proceed, don't insist on automated loop.
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh.
- Tests must exercise public behavior, not captured mock references.
- Export testable functions early to avoid mock ceremony.
- Existing tests that mock away the real path mask the bug. Assert constructor args, not just downstream behavior.

### Delegation
- Delegate immediately without pre-reading files — agent explores itself.
- For simple tasks, propose 2-3 name/design alternatives upfront.
- Wave-level arch review catches incomplete feature branches.
- Parallel sub-agents writing design docs: mandate distinct output paths per agent.
- Parallel slice execution (2+ slices) consistently saves time.

### Verification
- When merge agent reports success, verify the actual merge commit exists.
- Don't assume — verify. Code review catches silent production bugs.
- Host callbacks can reject stale session context objects. Keep foreground lifecycle cleanup defensive and do not retain host context beyond the active call.
- A trailing `?? N` fallback on optional config fields looks dead but is forced by `T | undefined` static type. Run typecheck before removing "redundant" fallbacks.
- Never use `general-purpose` when workflow specifies a specialized agent type. Check workflow docs for exact `agent` values before spawning.

### Config & Refactoring
- When adding config overrides respecting "explicit vs default", make source fields optional from the start. Type system enforces precedence, not runtime equality checks.
- When adding new visibility/config alongside existing similar config, trace ALL existing mutation paths for the old config.
- Check if any WIP branches might land before merge — gives builder context for conflict resolution.
- Only extract mock factories with ≥1 consumer in the current slice. Speculative extraction is waste.
- Diff old paths before merging to ensure all side effects are preserved.
- Module-level singletons still require vi.mock(). Accept module singleton as sufficient if composition root goal is otherwise achieved.

### Foreground agent API
- `Agent` and `AgentContinue` are foreground-only and await their complete caller response. The extension has no deferred result delivery or host message-send path; renderer metadata is carried on the normal tool result.

### Subagent Session Lifecycle
- Subagents are built with `createAgentSession`, which runs its own `DefaultResourceLoader.reload()` and `session.bindExtensions()`. That re-executes every extension factory and re-fires `session_start`/`session_shutdown` in the child context, not just the parent's.
- Parent-owned shell state is protected by the registered `AsyncLocalStorage` child-runtime marker. `src/index.ts` stays inert in that context, and root shell/control guards continue to reject child access.
- `runAgent` enters the child context with `runWithSubagentRuntime(createSubagentRuntimeContext(), ...)`; no mutable nesting-depth compatibility flag is required. `AgentSession.dispose()` does not emit `session_shutdown`, so child cleanup cannot dispose parent state.

### Extension Tools
- Registry/allowlist gates reject before you can patch the result. When tools/resources are silently missing, find the gate first (search where the set is built and filtered), and seed it at construction — pushing names in after construction cannot resurrect filtered-out entries. `setActiveToolsByName` silently ignoring unknown names is the tell that the registry, not activation, is the bug.
- Seeding `createAgentSession({ tools })` with concrete extension tool names (expanding `tavily/*` before session creation). Pi's `tools` option is a registry allowlist gate, not just an initial-active list.
- Whitelist must gate builtins too. Seeding gate with `registeredTools` as unconditional base leaks unlisted builtins and raw wildcard literals as bogus tool names. Gate must derive from whitelist expansion alone in whitelist mode.
- Confirmed against pi source: `agent-session.ts:_refreshToolRegistry` (~2454-2545) and `sdk.ts` (~245-251). `options.tools` becomes both `allowedToolNames` and `initialActiveToolNames`.

### Caching
- Breaking `extensionPackageName` into a memoizing wrapper plus pure resolver clarifies concerns. `.has()` presence checks solve negative caching bugs cleanly; use them for nullable caches instead of value-guard patterns.

### Issue Design
- Prototype code blocks in issue.md (state machine, boundary cases) give the implementer a clear contract.
- Call out overflow behavior as a hard gate in the AC.
- Prefer public API for cross-package access — private fields break silently on upstream changes.
- Specify test location and approach in the issue or builder prompt. "Test frontmatter parsing of max" not "cover max in tests".
- Single meaningful behavior test beats multiple implementation tests on a one-liner.

### Buffer & Error Patterns
- Buffer-then-flush pattern is the simplest fix for ordering/corruption issues. When deferring side effects, always consider error paths. try/finally guarantees flush.
- When nudges stop working, restart harness rather than debugging live state.

### Package Management
- When bumping versions, always run the package manager to regenerate lockfiles. Never hand-edit bun.lock.
- Keep `@ts-expect-error` comments focused — one error per directive.
