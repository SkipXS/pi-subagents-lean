# Worktree path parameter naming

The `Agent` tool exposes `worktree_path` rather than a generic `cwd` parameter. The name communicates that the target must belong to a working tree of the parent's Git repository.

The value may be absolute or relative to the parent cwd. Runtime validation resolves the canonical path and requires the target and parent to share the same `git-common-dir`. The target may be the primary checkout, a linked worktree, or a subdirectory of either.

## Why

A generic `cwd` would imply that agents can run in any directory. That is intentionally not supported: keeping execution within the parent's repository provides a clear trust and discovery boundary.

In the schema-first design described by ADR 0001, parameter names carry most of the tool's semantics. `worktree_path` communicates the restriction before the model has to discover it through a validation error.

The same parameter also identifies when an invocation-local agent overlay may apply. In a trusted project, an explicitly selected target can contribute its `.pi/agents/` definitions for that spawn. Other working trees are never crawled automatically, and an untrusted project cannot supply this overlay.

## Trade-off

The name commonly suggests only a secondary linked worktree, while validation also accepts the primary checkout and subdirectories. This is deliberate: the security boundary is repository identity, not whether `git worktree list` labels the checkout as primary or linked.

If a future feature needs arbitrary-directory execution, it should use a separate parameter with an explicit trust model rather than weakening `worktree_path` validation.

## Considered options

- **`cwd`** — rejected because it implies unrestricted directory selection.
- **`path_to_worktree`** — rejected because it adds length without additional meaning.
- **`worktree_cwd`** — rejected because it mixes a repository concept with session-state terminology.
