# Composition root over module-level shared state

Shared runtime state is held by the process-local module singleton `shell` in
`src/shell.ts`. PI's fixed-signature callbacks read that shell through getters,
rather than keeping separate mutable `let`/`Map` bindings in each handler.
Model and thinking are resolved from the persistent per-agent settings and
Agent Markdown, with the parent session as fallback; the ConfigStore owns the
loaded snapshot but exposes no session or global model override.

The shell's `ConfigStore` is constructed when the module is loaded and lives for
the extension lifetime. `session_start` reloads its config and creates the
session-scoped `AgentManager` and `SpawnCoordinator`, mounting them on the
shell. `session_shutdown` disposes and clears the coordinator and manager; the
store remains and only drops its manager dependency. The session context is
set at start and cleared at shutdown, while the PI instance is set during
extension initialization. Owned domain state stays in the module that owns the
concern: config in ConfigStore and background delivery in SpawnCoordinator.

Getters always read the shell's current fields. The manager and coordinator
getters return `null` in a child AsyncLocalStorage context, while root-only
getters reject child access. AsyncLocalStorage therefore marks the child
runtime boundary; it does not create another shell or another ConfigStore.

## Why

Three problems forced this. First, the PI runtime invokes tool `execute`
callbacks and lifecycle handlers (`session_start`, `session_shutdown`) as plain
closures with signatures it dictates; they cannot take extra parameters, so
dependencies must be reachable from inside them somehow. A shell captured by
closure is the cleanest way and reaches every callback.

Second, the old state module warned that the PI runtime does not propagate ESM
live-binding reassignments. A shell with fields removes that stale-reference
footgun entirely; the closure always reads the current field.

Third, the module-level globals forced every test of a tool execute handler to
mock 15+ modules, because the handlers' real dependencies (config, manager,
pi, session context) were invisible in their signatures. Capture-by-closure
makes those dependencies real parameters of the handler (captured, not
positional), so a test substitutes one shell (or one service) instead of mocking
the world.

The shell is a composition root, not a god object: it is small, survives across
sessions, and holds only the long-lived ConfigStore plus current session
collaborators. Domain state remains owned by ConfigStore, AgentManager, and
SpawnCoordinator.

## Trade-off

Callbacks read the shell through getters captured at registration time, but the
fields have explicit lifecycle boundaries. Before the first `session_start`,
and after `session_shutdown`, the manager and coordinator are unavailable; the
ConfigStore still exists. At `session_start` the store is reloaded and the
session services are mounted. At shutdown the coordinator is claimed and
disposed, the store's manager dependency is dropped, the manager is disposed
and cleared, and the session context is cleared. Startup/shutdown epochs prevent
an asynchronous startup scan from publishing state after its session ended.

The contract for handlers that need session services is therefore "run during or
after a current session and before its shutdown cleanup completes". New event
handlers must preserve that boundary and must use the getters rather than
caching session collaborators. The shell remains a process-local singleton for
the lifetime of the extension; that is acceptable for one extension instance
per pi process, but would need to become per-instance in a multi-instance host.

## Considered Options

- **Keep `state.ts` as a module-level singleton namespace.** Rejected: leaves
  the stale-`let` footgun for `__config`, keeps the 15-mock test pattern, and
  the "read directly, write via setter" contract stays an unenforced convention.
- **Per-handler dependency injection via a request-scoped context.** Rejected:
  PI's callback signatures don't accept extra parameters, so there is nowhere to
  inject per-call. Closure capture is the only injection mechanism available.
