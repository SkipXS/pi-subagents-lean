# One authoritative root-spawn contract

## Decision

`Agent` preflight produces one immutable `ResolvedSpawn` value containing the
resolved role definition, runtime settings, model/thinking values, trust
snapshot, worktree, prompt, and caller signal. `SpawnCoordinator` forwards that
value without resolving anything again. `AgentManager` is the only acceptance
boundary: it creates the detached `AcceptedSpawn` snapshot, retains it in the
queue, and passes it to the runner.

The coordinator is a stateless foreground facade. It guards root-only access,
publishes accepted metadata before awaiting, captures the exact caller promise,
awaits the complete response, and releases that same promise by identity in
`finally`. `AgentContinue` has a separate retained-session path but follows the
same await/release boundary.

## Consequences

- Mutable catalogs, settings, and model registries cannot reinterpret queued
  work.
- Worktree revalidation and the immutable trust decision remain fail-closed at
  runner setup.
- Full caller responses are not replaced by bounded record projections.
- Running and queued work use one FIFO scheduler and one configured root limit.
- Parent cancellation and session shutdown remain service-owned cleanup paths.
- Delivery maps, host message hooks, observer subscriptions, and execution-mode
  projections are unnecessary and removed.
- Legacy scalar manager/coordinator inputs and manual control adapters are not
  maintained as parallel contracts.
