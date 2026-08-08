# pi-subagents-lean

A lightweight Pi extension for isolated, foreground-only root delegation. The
parent has exactly two tools, `Agent` and `AgentContinue`; both await complete
results. Child sessions keep their own context, catalog, tools, model, thinking,
skills, extensions, and optional trusted worktree.

## Core concepts

**Agent**

Starts one context-isolated root session. Its prompt cannot rely on parent
conversation, parent tool results, or peer output. The prompt must carry all
relevant state, constraints, scope, and acceptance criteria.

**AgentContinue**

Resumes one successfully completed and settled retained root session. It accepts
an exact canonical ID or a unique prefix, validates the ID and prompt before
lookup/history allocation, publishes canonical metadata, and awaits the new
turn. It reuses the retained in-memory session, model, and working directory.

**ResolvedSpawn / AcceptedSpawn**

`ResolvedSpawn` is the immutable preflight snapshot containing the selected
role definition, runtime settings, model/thinking resolution, trust decision,
worktree selection, prompt, and caller signal. The manager snapshots it once as
`AcceptedSpawn`; queued work never consults mutable catalogs or settings again.

**Configuration**

`~/.pi/agent/subagents-lean.json` is a manually maintained, read-only input.
The ConfigStore loads and normalizes a detached snapshot; it has no manager
lifecycle coupling or file ownership dependency. `session_start` reloads the store before
creating a manager or applying its normalized concurrency to an existing one.
Accepted runtime settings are detached and frozen, so a later reload cannot
reinterpret an already accepted spawn.

**Child isolation**

AsyncLocalStorage marks every child setup and turn. Root shell access and both
root tools are unavailable inside a child. Tool policy applies exactly the
selected work tools and always excludes `Agent` and `AgentContinue`.

**Agent record**

The parent-owned flat record retains lifecycle state, display metadata, session
handles, cumulative usage/context telemetry, and bounded execution history. Each
history entry retains `kind`, `status`, timestamps, prompt, response projection,
usage, compaction count, and terminal error. There
is no execution delivery projection or execution-mode metadata.

At most 64 settled terminal records are retained. Queued, running, and
unsettled records are protected. Safe eviction is deterministic and disposes
session resources, so an old continuation ID may later become unavailable. A
record keeps at most 128 completed execution summaries and a 1 MiB UTF-8 text
budget; retained prompts are capped at 64 KiB and responses/errors retain their
existing UTF-8 bounds. The full caller response travels through the exact
foreground promise and is released by identity after consumption.

**Foreground coordinator**

`SpawnCoordinator` is a stateless root facade with a narrow manager port. It
rejects child calls, accepts a spawn or continuation, publishes accepted
metadata before awaiting, captures the exact caller promise, awaits it, and
releases that same promise identity in `finally`. It owns no delivery map,
observer, timer, host API, or disposal lifecycle.

**Root scheduling**

The manager and execution service own one FIFO scheduler. `concurrency.default`
accepts integer values 1..64 and defaults invalid values to 4. At most 128
accepted root executions may wait. Calls issued independently in one assistant
turn are submitted concurrently until the configured limit; dependent stages
remain sequential.

**Cancellation and shutdown**

The parent AbortSignal removes queued work without consuming a slot and aborts
running child sessions. Shutdown aborts active controllers, settles caller
promises, releases queue resources, and removes records. Late completion cannot
release a slot or mutate a removed record.

**Renderer**

Interactive rows are limited to `Agent` and `AgentContinue`. Headers show role,
canonical ID when known, resolved model, thinking, prompt, and `Run: New` or
`Run: Continued`. Queued is shown only from an authoritative lifecycle result.
Pi's working spinner is interactive-only; print, HTML, RPC, JSON, and headless
calls use no process-live renderer timer. Terminal text is escaped and
invalidation is guarded against stale, synchronous, asynchronous, and detached
hosts.

## Catalog, trust, and handoffs

Bundled defaults, user definitions, trusted shared/project definitions, and an
explicit trusted-worktree `.pi/agents/` overlay are discovered with bounded
streaming scans and live refresh before parent turns. Catalog entries and
frontmatter descriptions remain bounded; malformed or oversized inputs fail
closed. An immutable trust snapshot controls project catalogs, context files,
skills, and worktree overlays for the whole accepted execution.

Agent prompts are explicit handoffs. The parent owns planning, decomposition,
sequencing, reconciliation, integration, validation, and the final answer.
Independent read-only stages should be submitted as one foreground batch when
useful; dependent stages must wait for their prerequisite result.

## Public contract

- `Agent`: required `prompt` and `agent`; optional `description` and
  `worktree_path`; strict additional-property rejection.
- `AgentContinue`: required `agent_id` and `prompt`; strict constrained sampling
  preference and root-only unique-prefix reuse.
- Both tools throw through Pi's public wrapper when their internal result is an
  error and always return the complete foreground result on success.
- No polling, status/control tool, deferred result message, custom result
  message renderer, static activity footer, or execution-mode projection is
  part of the active surface.

The manually maintained configuration, model/thinking resolution,
skills/extensions, worktrees, usage telemetry, and bounded retention contracts
remain active. See
`README.md`, `docs/coverage.md`, and the ADRs for operational and test detail.
