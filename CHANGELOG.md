# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Agent control-call renderer.** Interactive `Agent` rows retain their canonical role/model/thinking/prompt display; `AgentContinue` and `StopAgent` now show the canonical full ID, role, resolved `provider/model-id`, normalized thinking, and (for `AgentContinue`) the complete prompt.
- **AgentContinue tool.** Continue a finished agent's session with a new prompt: the execution reuses the retained session, model, working directory, and output log, and consumes a normal global concurrency slot without incrementing the accepted-agent count. Foreground calls await their execution; `run_in_background` acknowledges immediately and delivers exactly one per-execution completion notification. Each execution is retained in the record as its own summary (`executions`) with per-execution usage/cost/compaction deltas, while lifetime totals stay cumulative.
- **Flat root-agent execution.** `Agent`, `AgentContinue`, `StopAgent`, and `AgentStatus` now operate only on root records. Subagent sessions remain ALS-isolated but receive no `Agent` custom proxy or root control tool.

### Changed
- **Finished-agent retention default raised to 60 minutes** (config fallback, manager default, and docs); the `finishedRetentionMinutes` setting remains configurable from 1 minute up.
- **Deprecated shell compatibility.** `enterSubagentSpawn`, `exitSubagentSpawn`, and `isInsideSubagentSpawn` are again exported for source-path consumers. They only preserve inert extension registration; AsyncLocalStorage remains authoritative for child isolation and root shell guards.
- **Legacy configuration compatibility.** Removed UI and delegation fields are tolerated while loading and are omitted from new configuration writes.
- **Phase 5 cleanup.** Removed the obsolete active-session viewer cadence and stale ConfigStore/type APIs. Background completion delivery now uses a short per-execution delay and one automatic `sendMessage` attempt; failures remain diagnostic until eviction without a retry path. Documentation, stale fixtures, tests, and internal exports now describe the flat tool-first model.

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
