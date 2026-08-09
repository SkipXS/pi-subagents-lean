# Current architecture map

`pi-subagents-lean` is a Pi extension with two fixed foreground tools:
`Agent` creates a root child session and `AgentContinue` resumes a successful
retained root session. Pi owns the tool lifecycle and parent result history.

## Composition root and turn flow

At extension initialization, fixed `Agent` and `AgentContinue` schemas are
registered. Root lifecycle state is composed through the process-local shell;
`AsyncLocalStorage` marks for child runtimes keep root tools and shell access out of children.

Before every parent turn:

```text
before_agent_start
  -> refresh configured discovery sources
  -> trust-scoped live agent catalog
  -> extension-owned parent-only orchestration prompt
```

The orchestration block advertises visible role names and descriptions and
explains delegation and handoff rules. It is regenerated from the live catalog
for the parent and is not copied into child prompts.

A new `Agent` follows this boundary:

```text
role / trust / cwd / model / context / tools / skills / extensions preflight
  -> immutable ResolvedSpawn
  -> manager creates immutable AcceptedSpawn
  -> FIFO root scheduler
  -> isolated child AgentSession
  -> complete foreground result
```

Preflight validates the repository-bound worktree, resolves the role against a
trust-appropriate catalog, captures project trust, loads tunables, and selects
resources. The accepted contract is not reinterpreted while queued.
`AgentContinue` resolves one exact or unique-prefix retained root, requires a
successful settled record with a live session, and sends its new prompt to that
same `AgentSession` through normal FIFO capacity.

## Context ownership

These inputs are intentionally separate:

- **Parent orchestration context** is the live catalog and delegation guidance
  added only to the parent system prompt.
- **Explicit handoff** is the caller's `Agent` or `AgentContinue` prompt. It
  carries the goal, evidence, decisions, scope, constraints, and acceptance
  criteria; parent and sibling history is not injected.
- **Automatically loaded context files** are bounded `AGENTS.md`, `AGENTS.MD`,
  `CLAUDE.md`, and `CLAUDE.MD` candidates for a new child. The global AgentDir
  candidate is first, followed by trusted project ancestors in root-to-cwd
  order. Within each directory, candidates are tried in that priority and the
  first acceptable one is selected; unsafe, oversized, changing, or otherwise
  rejected candidates fall through to later names. Untrusted calls do not
  inspect project ancestors.
- **Retained child conversation** is the live in-memory Pi `AgentSession`.
  `AgentContinue` reuses it and does not reload context files or create a new
  session. Pi may compact older conversation semantically.
- **Provider/Pi cache telemetry** is usage data such as `cacheRead`,
  `cacheWrite`, and the derived cache rate. It describes prompt-cache
  accounting, not session continuity and never means that continuation is a
  cache hit.
- **Internal caches** are bounded process-local discovery caches for agent
  catalogs, skills, extension/package lookup, and resource fingerprints. They
  are optimizations, not child history or user-visible session storage.
- **Current execution projection** is the record's one bounded latest-turn
  diagnostic/result view. A continuation replaces it; cumulative usage and
  compaction telemetry remain, but prior projections are not an execution
  transcript.

Context loading uses an invocation-local bounded loader so trust survives
asynchronous setup. The child resource loader uses the already-built prompt
and does not perform a second context or skill scan. Source tests cover
candidate order, trust exclusion, byte/ancestor bounds, and file identity
races.

## Resource and lifecycle ownership

Bundled defaults plus user definitions form the parent catalog; trusted shared,
project, and explicitly selected trusted-worktree `.pi/agents/` resources are
overlays. A selected worktree overlay is invocation-local and never mutates the
parent catalog. `agent.disableDefaultAgents` controls bundled-role discovery.

Role Markdown controls tools, extensions, skills, exclusions, model, thinking,
and the role system prompt. Persistent per-agent model/thinking settings are
resolved above effective Markdown and the parent session, then frozen in the
accepted contract. Skills use the bounded asynchronous catalog; extensions are
filtered by positive selection followed by exclusions. Root delegation tools
are always excluded from children.

`AgentManager` owns records, retention, continuation lookup, and total counts.
`AgentExecutionService` owns runner tasks, parent cancellation, shutdown, and
scheduler slots. `ExecutionTelemetry` owns cumulative usage/context/compaction
bookkeeping and per-execution deltas. `AgentRecordStore` owns lifecycle and the
current projection. `SpawnCoordinator` is the stateless foreground facade: it
accepts work, publishes metadata, awaits the complete caller result, and
releases the exact caller promise by identity.

Interactive renderers expose static role/ID/model/thinking/prompt metadata,
complete results, and useful usage details. Pi owns pending/success/error
presentation; real queue waits remain host-pending. Renderer state is hydrated
and invalidated defensively, while print, HTML, RPC, JSON, and headless paths
remain timer-free.

## Source and decision records

- Tool registration and strict schemas: `src/registration.ts`, `src/index.ts`,
  `test/index.test.ts`, and ADR 0001.
- Parent orchestration and refresh: `src/events.ts`, `src/prompt/orchestration.ts`, and `test/prompt/orchestration.test.ts`.
- Preflight and immutable contracts: `src/spawn/spawn-preflight.ts`,
  `src/spawn/spawn-contract.ts`, and ADR 0006.
- Trust and resource boundaries: `src/agents/context-file-loader.ts`, `src/agents/agent-types.ts`, skill catalog sources, and ADR 0005.
- Composition root: `src/shell.ts`, `src/events.ts`, and ADR 0004.
- Scheduling, retention, continuation, and telemetry: manager, execution-service, record-store, and focused manager/service tests.
- Worktree naming and repository identity: `src/spawn/worktree-validator.ts`
  and ADR 0003.

Source and focused tests are authoritative for detailed limits and provider/host integration behavior; this map records current boundaries, not an exhaustive implementation inventory.
