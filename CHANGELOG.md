# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **Extension-owned configuration persistence and recovery.** The config store
  and file adapter now only load and normalize the manually maintained
  `subagents-lean.json`; settings are changed manually, and existing valid
  backups remain a non-destructive fallback for invalid or unreadable primary
  files.
- **Unused synchronous local skill-loading facade.** Removed the internal parent-thread metadata/catalog path and its sync-only cache and traversal branches. Agent `skills: true`, explicit skill lists, exclusions, trust filtering, caching, coalescing, and worker-backed asynchronous discovery remain supported.

### Changed

- **Single current execution projection.** Records now retain one bounded latest execution projection with explicit `new`/`continued` kind; continuations replace that projection while reusing the exact live child session and preserving cumulative telemetry and parent Pi result persistence.
- **Pi-owned Agent row lifecycle.** `Agent` and `AgentContinue` retain informative static headers, metadata hydration, complete prompts, results, usage details, and terminal-safe text while Pi owns pending, success, and error row presentation; real queued waits remain host-pending because queue state is not sent live to the renderer.

## [0.3.0] - 2026-08-08

### Removed

- **Extension-owned child transcript logging.** Child execution remains in
  memory; internal child calls, thinking, and intermediate transcript are no
  longer persisted by the extension or written to files in system temp.
- **Breaking foreground-only surface.** Background `Agent` and `AgentContinue`
  execution and the `run_in_background` parameter are removed; both tools now
  always await their complete foreground results.
- **Removed control tools.** `StopAgent` and `AgentStatus` are no longer
  registered, executed, rendered, exported, or available in child sessions.
- **Removed delivery and activity projections.** The background delivery
  subsystem, payload/diagnostic state, completion notifications, static footer,
  activity observers, execution modes, `deliveredText`, and `resultConsumed`
  are removed from runtime records, details, and renderers.
- **Removed deprecated shell compatibility exports.** The source-path
  compatibility exports `enterSubagentSpawn`, `exitSubagentSpawn`, and
  `isInsideSubagentSpawn` are removed; AsyncLocalStorage remains the
  child-runtime isolation mechanism.

### Changed

- **Same-turn foreground parallelism.** Independent read-only `Agent` calls in
  one assistant turn are submitted concurrently under the configured FIFO root
  concurrency limit; dependent stages remain sequential.
- **Always-await results.** `Agent` and `AgentContinue` return the full caller
  response and canonical ID after settlement. `AgentContinue` still reuses
  successful retained root sessions by unique ID prefix.

## [0.2.0] - 2026-08-07

### Added
- **Persistent per-agent model/thinking settings.** `agents.<name>.model` and `agents.<name>.thinking` in `~/.pi/agent/subagents-lean.json` apply to bundled and discovered agents with case-insensitive names. Each field resolves as settings > effective Agent Markdown > parent session, using registry fallback and model-capability thinking normalization.
- **Agent control-call renderer.** Interactive `Agent` rows retain their canonical role/model/thinking/prompt display; `AgentContinue` and `StopAgent` now show the canonical full ID, role, resolved `provider/model-id`, normalized thinking, and (for `AgentContinue`) the complete prompt.
- **AgentContinue tool.** Continue a finished agent's session with a new prompt: the execution reuses the retained session, model, working directory, and output log, and consumes a normal global concurrency slot without incrementing the accepted-agent count. Foreground calls await their execution; `run_in_background` acknowledges immediately and delivers exactly one per-execution completion notification. Each execution is retained in the record as its own summary (`executions`) with per-execution usage/cost/compaction deltas, while lifetime totals stay cumulative.
- **Flat root-agent execution.** `Agent`, `AgentContinue`, `StopAgent`, and `AgentStatus` now operate only on root records. Subagent sessions remain ALS-isolated but receive no `Agent` custom proxy or root control tool.
- **Bounded resource retention.** At most 64 settled terminal records and the newest 128 completed execution summaries per record are retained; active/pending work is protected, and safe eviction disposes sessions. Very old `AgentContinue` IDs can consequently become `not found`.
- **Hard root queue quota.** The global FIFO admits at most 128 queued root executions. A spawn or continuation that would wait beyond the bound is rejected deterministically before record/history allocation with a stable error; accepted, running, abort, and shutdown behavior is unchanged.
- **Hard UTF-8 agent-string bounds.** `Agent` and `AgentContinue` prompts are rejected above 256 KiB before queue/history allocation, and an `AgentConfig.systemPrompt` above 512 KiB is rejected during preflight. Retained result/delivery text is capped at 64 KiB, retained errors and descriptions at 8 KiB, with a complete `[TRUNCATED]` marker; foreground callers receive the full response through a caller-local promise while records retain only projections, and that promise is cleared by identity after consumption.
- **Bounded trusted discovery and configuration.** Untrusted preflight resolves only a fresh/cached bundled-default plus user-global catalog, never a project-contaminated global registry. Each source streams its directory and fails closed above 256 relevant Markdown files or 10,000 total entries, retaining deterministic order for accepted bounded input and rejecting files above 512 KiB before reading; identifiers, model keys, and frontmatter selections remain bounded by UTF-8 bytes. `subagents-lean.json` rejects files above 1 MiB before JSON parsing and retains at most 256 bounded agent overrides.
- **Bounded execution-summary history.** Retained execution prompts are capped at 64 KiB and all retained summary text shares a 1 MiB per-record budget; oldest completed summaries are pruned deterministically while queued/running entries remain protected. The full accepted prompt may remain only on the active task up to 256 KiB and is released after settlement.
- **Bounded background-delivery diagnostics.** Terminal delivery keeps at most 64 payload-free projections. Accepted, failed, and cancelled attempts immediately release completion payloads, timers, and parent-abort references while `record.delivery` diagnostics, exactly-once delivery, and pending-entry protection remain intact. Background result/detail text is capped at a 64 KiB UTF-8-byte message budget, secondary details at 8 KiB, and retained delivery errors at 8 KiB with `[TRUNCATED]` markers.
- **Bounded compaction metadata.** Each record retains only the newest 128 `stats.compactionReasons` entries; every retained string field is capped at 8 KiB by UTF-8 bytes with a `[TRUNCATED]` marker while numeric and structural metadata remains unchanged.
- **Hardened skill discovery hotpath.** Each resource fingerprint is capped at 10,000 visited entries/depth 64 per root, 512 KiB per skill Markdown, 256 KiB per ignore file, and 32 MiB relevant bytes; direct root Markdown under `source=agents` is charged to the file/aggregate byte budgets even though it is filtered from publication. Trusted ancestor roots are capped at 64 and merged catalogs at 10,000 skills. `skills:true` and explicit lists use bounded async metadata workers, the child loader uses `noSkills:true`, and post-worker fingerprint races fail closed. Async Pi skill requests have a hard 15-second timeout and idempotent worker/listener/timer cleanup. Worker results are built incrementally and limited to 10,000 skills and a 4 MiB UTF-8 metadata payload; the main thread repeats the payload validation before cache publication. Skill metadata prompts are capped at 1 MiB and complete child system prompts at 2 MiB; overflow fails deterministically without partial selection. Warm cache hits start no worker or timer.

### Changed
- **Authoritative root-spawn contract.** `ResolvedSpawn` is forwarded unchanged to the manager, which alone snapshots `AcceptedSpawn` for queued runner execution; repository-internal scalar and manual-nudge compatibility paths were removed without changing the four public tool schemas.
- **Bounded concurrency configuration.** `concurrency.default` now accepts only integers from `1` through `64` at persistence/store, manager, and scheduler boundaries; all other values, including values above `64`, fall back to `4` without changing valid FIFO limits.
- **Root-control isolation.** Child tool policy now excludes `Agent`, `AgentContinue`, `StopAgent`, and `AgentStatus` unconditionally, regardless of the host's active tool list.
- **Private output-log roots.** Each parent/extension session now uses a securely-created private temporary root. POSIX enforces `0700` directories and `0600` files through descriptors with no-follow/exclusive opens where supported; Windows inherits the OS-temp isolation/ACL and performs post-open file/root identity checks without claiming a portable DACL. Roots remain persistent so absolute log paths stay usable, while a coalesced asynchronous janitor scans only the canonical temp parent and verified prefixed roots, never follows links/reparse points, and uses a private live-process marker so parent sessions/processes protect their current roots. It targets at most 4 roots, 256 MiB, and 7 days, with a deterministic 50,000-entry/inspection budget across each global pass; the second traversal reserves the same snapshot count, fully validates before any unlink, and skips a root on growth or insufficient global budget. Active and uncertain/exhausted entries are protected/skipped.
- **Bounded output logs.** Each log is limited to 8 MiB and each fresh private parent-session root to 64 MiB with byte-correct enqueue-time reservations across parallel writers. One `[TRUNCATED]` marker is emitted within the remaining budget, then content writes stop. Appends must match the dev/ino identity captured after exclusive create and have `nlink === 1`, so hardlink/symlink swaps fail closed before writing. Execution-service disposal explicitly releases root/file accounting and identity state only after queued writes drain, without deleting logs; hosts may use the same `releaseOutputRoot(root)` API explicitly.
- **Internal decoupling and stabilization.** Agent detail formatting is separated from tool execution, with matching composition-root documentation and focused configuration/lifecycle race coverage.
- **Unified selection-minus-exclusion semantics.** `exclude_tools` and `exclude_extensions` are now applied after their corresponding `tools`/`extensions` base selection, including explicit lists and `true`; excluded extensions are not bound. `exclude_skills` removes names from the selected skill metadata, including skills discovered by extensions.
- **Finished-agent records are retained within the bounded parent-session phase.** The former time-based expiry is replaced by deterministic oldest-safe eviction at the 64-record limit; `session_shutdown` still disposes all remaining records, sessions, queue entries, and resources.
- **Confirmed agent simplification.** Roles use only canonical `name`/filename resolution; missing skills/extensions resolve to `false`; prompts always replace; model and thinking use only per-agent persisted settings, effective Agent Markdown, or the parent session. Global model fallbacks, session overrides, and automatic model/thinking injection remain absent; config persists current runtime settings, per-agent overrides, and concurrency.
- **Deprecated shell compatibility.** `enterSubagentSpawn`, `exitSubagentSpawn`, and `isInsideSubagentSpawn` are again exported for source-path consumers. They only preserve inert extension registration; AsyncLocalStorage remains authoritative for child isolation and root shell guards.
- **Phase 5 cleanup.** Removed the obsolete active-session viewer cadence and stale ConfigStore/type APIs. Background completion delivery now uses a short per-execution delay and one automatic `sendMessage` attempt; failures remain diagnostic until parent-session shutdown without a retry path. Documentation, stale fixtures, tests, and internal exports now describe the flat tool-first model.

### Fixed
- **`AgentContinue` schema now satisfies strict-mode providers.** Codex rejects tool schemas whose `required` array omits any property, so `run_in_background` is now a mandatory boolean (`Type.Boolean()` instead of `Type.Optional`) — the executor still treats `false`/missing as foreground, so behavior is unchanged.

## [0.1.0] - 2026-07-29

### Changed
- **Project renamed to `pi-subagents-lean`.** Package metadata, GitHub links, diagnostics, persisted filenames, custom prompt filenames, and orchestration markers now use the Lean identity.
- **Bundled agent catalog now uses inspectable Markdown.** `architect`, `scout`, `implementer`, `reviewer`, and `verifier` replace the embedded `general-purpose`/`Explore` pair; agent selection is explicit and silent general-purpose fallbacks are removed.
- **Scout now combines discovery and focused investigation.** It replaces `explorer` and can begin with repository-wide searches before tracing the relevant path depth-first.
- **Model and thinking resolution is unified and model-aware.** Precedence is spawn > session agent override > saved agent override > Agent Markdown > global fallback > parent. Agent Settings shows effective sources, filters per-agent Thinking choices by model capability, and reports Pi-adjusted values for incompatible existing settings.
- **Finished agents no longer vanish mid-navigation.** Widget eviction unified with manager retention — one configurable clock instead of two conflicting ones.

### Added
- **Bundled `architect` agent** for read-only cross-component design and technical trade-off analysis.
- **Per-agent thinking overrides** for the current session or persisted config, alongside existing model overrides.
- **`finishedRetentionMinutes` setting** (Widget Settings, default 10, min 1). Controls how long finished agents stay visible.
- **Navigation highlight clamps** when roster shrinks from agent eviction.
- **Cross-platform and minimum-Pi CI coverage** with strict source/test typechecking, risk-based coverage gates, and an installed-tarball Pi loader smoke test.

### Fixed
- **Git-source installations now complete with npm.** Vitest's dev dependency is pinned to the matching coverage-provider version, avoiding npm Arborist peer-resolution failures during Pi's production install.
- **Shutdown now aborts active agent controllers** even when session setup has not completed.
- **Already-aborted parent signals propagate immediately** when a subagent run begins.
- **Session shutdown and terminal-input cleanup are failure-safe**, and temporary config files are removed after failed atomic writes.

The `1.x` entries below document the inherited `pi-subagents-lite` history. `pi-subagents-lean` starts a new release line at `0.1.0`.

## [1.5.1] - 2026-07-26

### Fixed

- **Extension tools no longer missing from subagent sessions.** `createAgentSession({ tools })` is a registry allowlist gate in pi; a builtins-only list silently filtered out every extension tool before registration. Fix: expand `tavily/*` and bare extension tool names in the whitelist *before* session creation so they enter the gate. `resolveSessionAllowedTools` (new, in `agent-types.ts`) owns this policy; in whitelist mode the gate derives from the expansion alone (no raw wildcards, no unlisted builtins leak). `tools: undefined` agents register all loaded extension tools consistent with pi's own `includeAllExtensionTools` semantics.
- **Whitelist no longer leaks unlisted builtins into the registry gate.** A secondary bug where `registeredTools` was used as an unconditional base alongside the whitelist. Under strict semantics, builtins not named in `tools:` do not enter the allowlist, and raw wildcard literals like `"tavily/*"` never reach pi as bogus tool names.

## [1.5.0] - 2026-07-24

### Added
- **Shared workspace agent discovery.** Agents from `.agents/agents/*.md` are now discovered alongside `.pi/agents/`. Precedence: default < user < shared < project.
- **ConversationViewer replaces ResultViewer.** Full conversation transcript with live streaming, thinking blocks, tool args (4000 char limit), success/error icons, compaction summaries, and event-driven updates (no polling). Navigation: arrow keys, vim j/k, g/G, Home/End, f fullscreen, r refresh. Steering via Enter when agent running.
- **Constrained tool sampling with strict json_schema.** Provider-side schema validation reduces malformed tool calls. Graceful fallback on unsupported providers.

### Changed
- **Agent status icons replaced with ◈/◇.** Broader terminal-font coverage than ●/○.
- **Peer dependencies updated to pi 0.82.** `@earendil-works/pi-*` peers now resolve to ^0.82.0.

### Fixed
- **Widget timer survives steer re-registration.** `clearWidget` no longer kills the timer when steer re-registers the tool.
- **ConversationViewer scroll boundary.** Scroll max computed from actual content, not stale cache.
- **Streaming deduplication.** No duplicate text when full message event catches up to streamed deltas.
- **`bun.lock` peerDep carets restored.** Lock file peer dependencies use carets for flexible resolution.

## [1.4.9] - 2026-07-17

### Added
- **`thinking: max` level support.** Import `ThinkingLevel` from `@earendil-works/pi-ai` so the `max` thinking level is available alongside `none`, `low`, `medium`, `high`, and `xhigh`.

### Fixed
- **Removed deprecated `modelRegistry` from `createAgentSession`.** Compatible with pi 0.80+ which replaced `modelRegistry` with `modelRuntime`.

## [1.4.8] - 2026-07-11

### Fixed
- **Cleanup timer preserves unconsumed agent records.** Background cleanup no longer evicts records before the LLM has read their results.

## [1.4.7] - 2026-07-08

### Added
- **Delta input token tracking for vLLM models.** Shows input token delta in the widget for models without cache stats. Opt-in, off by default.

### Fixed
- **User vs agent stops distinguished in status notes.** `StopAgent` tracks stop initiator, surfacing different notes in result output.

## [1.4.6] - 2026-07-01

### Added
- **`deltaInputTokens` widget setting.** Toggle input token delta display for models without cache reporting.

## [1.4.5] - 2026-06-25

### Added
- **Thinking buffer flush rounded to sentence boundaries.** Log file thinking content flushes at natural sentence breaks.

### Fixed
- **Nudge delivery fixed with fresh pi instance.** `SpawnCoordinator` stores the pi instance for nudge delivery, preventing stale context crashes.
- **Fallback to UI notification when nudge delivery fails.** Completion notifications surface even if `sendMessage` fails.

## [1.4.3] - 2026-06-24

### Fixed
- **Nudge messages use correct `deliverAs` mode.** Prevents delivery failures when parent session state has changed.
- **Stale context error suppressed on background agent nudge.** No spurious errors when nudging agents whose parent context was replaced.

## [1.4.2] - 2026-06-24

### Added
- **Thinking buffer ring selector in widget settings.** Configure how many lines of thinking content appear in the widget tail.
- **Agent display format flipped to `id (type)`.** Resolves `StopAgent` ambiguity when multiple agents of the same type are running.
- **Thinking blocks streamed to output file in real-time.** Thinking content written as it arrives, with deduplication when `thinking_end` fires.

### Fixed
- **Stale pi context crash in SpawnCoordinator nudge emission.** Uses current pi instance instead of captured reference.
- **Worktree validation warnings flushed via `ctx.ui.notify`.** Errors surface to the user instead of silently failing.
- **KV cache ordering improved.** `active_agent` tag moved after shared prefix; `AGENTS.md` placed before `agent_instructions`.

## [1.4.1] - 2026-06-19

### Added
- **Search in type, provider, model, and worktree selection menus.** Incremental text search across all spawn wizard and settings menus.
- **Live descriptions in SettingsList menus.** Contextual descriptions replace the Back button.

### Fixed
- **Notify calls buffered during setup.** Prevents session tree corruption when extensions call `notify()` before initialization.
- **Inline YAML array syntax parsed correctly.** `[a, b, c]` bracket notation strips brackets in frontmatter parsing.
- **System prompt menu rebuilds when switching modes.** Custom/inherit/replace changes update the submenu immediately.
- **Pi scaffolding stripped from parent prompt in all modes.** Inherit mode no longer duplicates pi's system prompt wrappers.

## [1.4.0] - 2026-06-19

### Added
- **`disableDefaultAgents` setting.** Hide built-in agents so only custom `.pi/agents/*.md` agents are advertised.
- **KV cache optimization.** System prompt reordered for maximum cache reuse across agents.

### Changed
- **Menus unified to pi-style SettingsList/SelectList.** All menus use pi's native components with consistent navigation and submenus.

### Fixed
- **Disabled agents no longer advertised in tool description.** `enabled: false` agents filtered from the LLM's type list.
- **Agent tool type list built after settings load.** Description reflects persisted settings.

## [1.3.0] and earlier

AgentStatus tool, `worktree_path` parameter, manual spawn menu, cost display, compact mode sync, selective extension loading, skill whitelisting, and the foundational subagent spawning system with foreground/background modes, concurrency limits, and the `/agents` menu.
