# ADR 0004: Composition root over scattered shared state

## Decision

Keep long-lived extension state in the process-local `shell` composition root.
The shell owns the read-only `ConfigStore` and the current session's
`AgentManager` and `SpawnCoordinator`; domain state remains owned by those
collaborators. Pi's fixed-signature lifecycle and tool callbacks reach current
collaborators through shell getters rather than captured stale bindings.

`session_start` reloads configuration, creates or updates the manager, and
mounts the coordinator. `session_shutdown` clears the coordinator, disposes
the manager and its records/resources, and clears the session context. A
startup/shutdown epoch prevents an asynchronous scan from publishing into a
newer session. Repeated starts update the existing manager's concurrency rather
than creating a second execution service.

AsyncLocalStorage marks an isolated child runtime. Root-only getters reject
child access, and child extension initialization remains inert, so a child does
not create another shell or gain the parent's manager, coordinator, or session
context.

## Why

Pi invokes callbacks with signatures it controls, so closure capture is the
reliable composition boundary for the current extension instance. A shell
keeps lifecycle replacement explicit and prevents a handler from retaining an
old manager or configuration snapshot. It also keeps configuration,
execution records, and foreground promise coordination with the component that
owns each concern.

This is process-local state for the normal one-extension-per-Pi-process model.
A future multi-instance host would need an instance-scoped composition root.
