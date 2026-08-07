# Trust-gate project context and skills in child sessions

A subagent runs in a new Pi session, often after asynchronous worktree
validation or queueing. Project-controlled `AGENTS.md` files and skills are
prompt/resource input and must not be read merely because a child session has a
project cwd.

## Decision

The `Agent` tool snapshots `ctx.isProjectTrusted()` synchronously during its
preflight, before the first asynchronous validation or discovery boundary.
The boolean is carried as immutable `projectTrusted` data through
`ResolvedSpawn` and `AcceptedSpawn`.

At runner setup, the snapshot creates one Pi `SettingsManager`:

- `DefaultResourceLoader` receives that manager;
- `createAgentSession` receives the same manager instance; and
- the manager is created with `{ projectTrusted }` for the effective cwd.

The custom prompt skill lookup applies the same snapshot. Context files use an
invocation-local async bounded loader rather than Pi's unbounded synchronous
helper: it reads the global AgentDir candidate first, then at most 64 accepted
ancestor directories in root-to-cwd order, with AGENTS/CLAUDE candidate order,
256 KiB per file, 512 KiB total, and pre/post-lstat regular-file identity checks.
Oversize and race results are skipped with bounded warnings. Skill metadata
for both `skills:true` and explicit arrays comes from one bounded async catalog;
per-root fingerprints reject more than 512 KiB per skill Markdown, 256 KiB per
ignore file, 32 MiB relevant bytes, 10,000 entries, or depth 64, while the
catalog caps trusted ancestor roots at 64 and the merged result at 10,000
skills. A post-worker fingerprint mismatch is fail-closed. The child
`DefaultResourceLoader` uses `noSkills:true`, so it does not repeat an
unbounded scan. Trusted children may read project/CWD context and skills;
untrusted children do not walk project/CWD context or skill roots, while
user-global context and skill roots remain available. An explicitly selected
worktree inherits the parent's snapshot; it is never trusted independently.

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
- The runner consumes only the accepted trust snapshot and fails closed if a
  malformed internal value is not explicitly trusted.
- Untrusted spawn preflight resolves against a separate project-free catalog
  containing only bundled defaults and user-global Agent Markdown. It never
  consults the mutable global registry, which may retain a prior trusted
  project/shared/worktree override.
- Project agent catalog discovery and worktree overlay policy remain governed by
  their existing trust checks; this ADR covers child context and skills only.
- The public `Agent` parameters remain fixed; trust is not model-controlled.
- If a trusted parent preflight cannot resolve a role, it performs one bounded
  `discoverNewAgents()` refresh and resolves again; the untrusted path remains
  project-free and never refreshes the trusted registry.

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
