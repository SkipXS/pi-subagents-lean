# One authoritative root-spawn contract

## Decision

`Agent` preflight produces one immutable `ResolvedSpawn` value containing the
resolved role definition, runtime settings, model/thinking values, worktree,
trust snapshot, and delivery mode. `SpawnCoordinator` forwards that value
without resolving anything again. `AgentManager` is the only acceptance
boundary: it creates the detached `AcceptedSpawn` snapshot, retains it in the
queue, and passes it to the runner.

The runner has no registry/configuration fallback and requires the accepted
contract. Background delivery is driven only by the manager completion callback
and the synchronous `reconcileBackgroundClaim` race guard; delivery remains
per-execution and exactly once. `AgentContinue` keeps its separate retained
session-turn path and does not use the initial assistant-history fallback.

The four public tool schemas and documented extension behavior are unchanged.
This is an internal ownership boundary, not a new public spawn API.

## Consequences

- Mutable catalogs, settings, and model registries cannot reinterpret queued
  work.
- Worktree revalidation and the immutable trust decision remain fail-closed at
  runner setup.
- Legacy scalar manager/coordinator inputs and manual nudge/status adapters are
  removed rather than maintained as parallel contracts.
