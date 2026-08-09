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
before_agent_start (before every parent turn)
  -> refresh configured discovery sources
  -> trust-scoped live agent catalog
  -> non-empty visible catalog: inject extension-owned parent-only block
  -> empty visible catalog: remove the old owned block
```

The orchestration handler and policy run before every parent turn. The
extension-owned parent-only block advertises visible role names and descriptions
only when the visible trust-scoped catalog is non-empty; an empty catalog
removes the prior owned block. It is not copied into child prompts.

A new `Agent` follows this boundary:

```text
role / trust / effective cwd/worktree / model/thinking / prompt/caller contract /
resource-selection policy preflight
  -> immutable ResolvedSpawn
  -> manager creates immutable AcceptedSpawn
  -> FIFO root scheduler
  -> runner setup after slot acquisition under frozen policy/trust
  -> bounded context + Skills + Extensions + tool mapping
  -> isolated child AgentSession
  -> complete foreground result
```

Preflight/acceptance freezes the resolved role, project trust, effective cwd and
worktree selection, resolved model/thinking, prompt/caller contract, and
resource-selection policy. After a scheduler slot is acquired, runner setup uses
that frozen policy/trust to materialize bounded context, Skills, Extensions, and
the effective tool mapping. The accepted contract is not reinterpreted while
queued.
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
  candidate is first, followed by bounded filesystem ancestors of the effective
  cwd in root-to-cwd order for trusted calls. Within each directory, candidates
  are tried in that priority and the first acceptable one is selected; unsafe,
  oversized, changing, or otherwise rejected candidates fall through to later
  names. Untrusted calls do not inspect project ancestors.
- **Retained child conversation** is the live in-memory Pi `AgentSession`.
  `AgentContinue` reuses it and does not reload context files or create a new
  session. Pi may compact older conversation semantically.
- **Provider/Pi cache telemetry** is usage data such as `cacheRead` and
  `cacheWrite`; in continuation details they may be current-execution deltas.
  `latestCacheHitRate` is cumulative and derived as cumulative `cacheRead` /
  (cumulative prompt-accounting `input` + `cacheRead` + `cacheWrite`). This is
  prompt-cache telemetry, not session continuity, and never means that
  continuation is a cache hit.
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

## Prompt assembly and cache boundaries

The parent and child prompts are separate. `before_agent_start` strips the
previous extension-owned orchestration block and appends a newly generated one
only when a visible catalog exists. Its rules are fixed, while the bounded
catalog is sorted by canonical Agent name. Updating the tail instead of the
fixed public tool schemas avoids unnecessary parent-prefix churn; a catalog
change still changes that tail.

`buildAgentPrompt()` assembles a new child system prompt in this order:

```text
1. generic Pi child identity
2. shared isolation, clarification, and AgentContinue guidance
3. environment: effective cwd, repository/branch, platform
4. bounded applicable context files
5. <active_agent name="..."/>
6. <agent_instructions>effective Agent Markdown body</agent_instructions>
7. selected <available_skills> metadata
```

The explicit `Agent.prompt` is then sent as the child user turn. Selected tools
and Extensions are session resources and registry policy, not text copied into
`<agent_instructions>`.

The stable identity/guidance prefix is identical across roles. Environment and
context precede role-specific identity/instructions, so calls sharing those
inputs can retain a longer common prefix. Role identity, instructions, and
Skills intentionally diverge later. This layout is an optimization for
provider prompt-prefix reuse, not a cache guarantee. Provider/Pi usage events
are the only authority for `cacheRead`/`cacheWrite`; the extension derives the
cumulative hit rate from that telemetry. Skill/catalog caches are separate
resource-discovery caches, and `AgentContinue` reuses a live session rather
than reconstructing one from any cache.

## Resource and lifecycle ownership

Bundled defaults plus user definitions form the parent catalog; trusted shared,
project, and explicitly selected trusted invocation `<selected effective cwd>/.pi/agents/`
resources are overlays. A selected effective-cwd overlay is invocation-local and
never mutates the parent catalog. `agent.disableDefaultAgents` controls bundled-role
discovery.

Role Markdown controls tools, extensions, skills, exclusions, model, thinking,
and the role system prompt. Persistent per-agent model/thinking settings are
resolved above effective Markdown and the parent session, then frozen in the
accepted contract. Runner setup applies the Skills policy through the bounded
asynchronous catalog and filters Extensions/tool mapping under the frozen trust
snapshot. Root delegation tools are always excluded from children.

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
