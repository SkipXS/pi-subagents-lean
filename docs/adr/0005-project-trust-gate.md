# Trust-gate project context and skills in child sessions

A subagent runs in a new Pi session, often after asynchronous worktree
validation or queueing. Project-controlled `AGENTS.md` files and skills are
prompt/resource input and must not be read merely because a child session has a
project cwd.

## Decision

The `Agent` tool snapshots `ctx.isProjectTrusted()` synchronously during its
preflight, before the first asynchronous validation or discovery boundary.
The boolean is carried as immutable `projectTrusted` data through
`ResolvedSpawn` and `AcceptedSpawn`. Contracts from older/direct callers that
lack the field are treated as `false`.

At runner setup, the snapshot creates one Pi `SettingsManager`:

- `DefaultResourceLoader` receives that manager;
- `createAgentSession` receives the same manager instance; and
- the manager is created with `{ projectTrusted }` for the effective cwd.

The custom prompt skill lookup applies the same snapshot. Trusted children keep
the existing project/CWD context and skill behavior. Untrusted children do not
walk project/CWD context or skill roots, while user-global context and skill
roots remain available. An explicitly selected worktree inherits the parent's
snapshot; it is never trusted independently.

This gate is internal. The public tool schema is unchanged, and the decision
does not alter spawn retention, queueing, or the existing preflight and spawn
consolidation boundaries.

## Why

Trust can change while a tool call is validating a worktree or waiting for a
concurrency slot. Reading the live trust state at runner start would make the
same accepted request behave differently depending on timing. Carrying the
snapshot in the existing accepted-spawn contract makes the authorization input
explicit, immutable, and available after those boundaries.

Using Pi's manager for both loader and session avoids a split trust state: the
loader's project resource discovery and the session's settings see the same
policy. Keeping global roots separate in the untrusted custom skill/context
path preserves user configuration without opening the selected project.

## Consequences

- Trust is decided by the parent at tool preflight, not by the worktree or child
  session.
- Existing trusted behavior remains unchanged.
- Legacy/direct runner and spawn paths fail closed for missing trust metadata.
- Project agent catalog discovery and worktree overlay policy remain governed by
  their existing trust checks; this ADR covers child context and skills only.
- The public `Agent` parameters remain fixed; trust is not model-controlled.

## Considered options

- **Read trust again in the runner** — rejected because queueing and async
  validation would create a time-of-check/time-of-use race.
- **Let the worktree decide its own trust** — rejected because selecting a path
  must not grant it authority over the parent session.
- **Create separate managers for the loader and session** — rejected because
  project settings/resources could then be resolved under different trust
  states.
- **Remove all skills/context when untrusted** — rejected because global user
  resources are not project-controlled and remain useful to the child.
