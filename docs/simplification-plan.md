# Foreground-only simplification

## Status

This is the active product decision for the deliberate breaking simplification.
The extension is a flat, root-only, two-tool foreground system.

## Contract

Exactly two tools are registered:

- `Agent` starts a context-isolated specialized session and waits for its
  complete result.
- `AgentContinue` resumes a successfully completed retained root session and
  waits for its complete result.

Both schemas are strict with `additionalProperties: false`. `Agent` has
required `prompt` and `agent`, plus optional `description` and `worktree_path`.
`AgentContinue` has required `agent_id` and `prompt`, with constrained
`json_schema` sampling using `strict: "prefer"`. The public wrapper throws for
internal errors. No legacy execution switch, status/control tool, deferred
message, custom result type, or footer is part of the active contract.

## Same-turn orchestration

The parent may issue several independent foreground `Agent` calls in the same
assistant turn. Pi submits that batch concurrently and the configured root
concurrency limit controls how many run at once. Dependent stages remain
sequential: await a prerequisite, reconcile it, then issue the next call.
Excess accepted calls wait FIFO, with a maximum of 128 queued root executions.

```text
Parent emits one batch
  ├─ reviewer ─┐
  └─ verifier ─┴─ concurrent under the configured limit

Parent resumes after both settle
```

## Preserved architecture

- Child sessions remain AsyncLocalStorage-isolated and cannot access either root
  delegation tool.
- Preflight resolves catalogs, trust, worktrees, model/thinking, context,
  tools, extensions, and skills into immutable `ResolvedSpawn` data. The manager
  creates the immutable `AcceptedSpawn` snapshot before queueing.
- `SpawnCoordinator` is a stateless foreground facade. It guards the root,
  publishes accepted metadata before awaiting, captures the exact caller
  promise, awaits it, and releases by identity in `finally`.
- `AgentManager` and `AgentExecutionService` retain FIFO scheduling, configured
  concurrency, queue quota, parent-signal cancellation, shutdown cleanup,
  telemetry, and deterministic record retention. Running, queued, and
  unsettled records are protected; settled records are bounded to 64.
- `AgentContinue` reuses only a successful settled retained root session. Exact
  IDs and unique prefixes are supported; ambiguous, missing, active, failed, or
  unavailable records are rejected.
- Retained history keeps bounded prompt/response/error projections, usage,
  compaction, kind, and status. The full caller response remains on the
  foreground promise, separate from bounded record text.
- Interactive rows retain escaped text, coalesced invalidation, and the Pi
  working spinner. Noninteractive and headless paths never create renderer
  timers.
- Catalog live refresh, project trust, model/thinking resolution, worktrees,
  skills, extensions, and useful timing diagnostics remain covered.

## Removed implementation

The complete deferred delivery subsystem and its payload/diagnostic types are
removed. Delivery state, claims, retries, timers, host message sending, and
completion notifications are not represented in records or details. Static
activity-footer and activity-observer code is removed because it has no active
consumer. Execution summaries no longer duplicate caller text or carry mode
labels. Root status/control execution is removed; parent cancellation and
shutdown remain service-owned lifecycle paths.

## Validation expectations

Focused tests cover exact schemas, unknown-property rejection, child exclusion,
foreground promise identity and terminal races, concurrent calls, FIFO excess,
parent cancellation, shutdown settlement, continuation validity and retention,
full caller responses, deterministic history bounds, renderer New/Continued
headers, queued authority, escaping, spinner timing, invalidation safety, live
catalog/trust, worktree behavior, and package/Pi loading. Active documentation
and smoke contracts describe only the two foreground tools; released changelog
history remains archival.
