# ADR 0005: Immutable project-trust snapshot

## Decision

Capture `ctx.isProjectTrusted() === true` synchronously during `Agent`
preflight, before worktree validation, discovery, or any other asynchronous
boundary. Carry that boolean through `ResolvedSpawn` and `AcceptedSpawn` and
use the same snapshot for child settings/resource loading and prompt
construction. A selected worktree inherits the parent's decision; selecting a
path does not grant it trust.

Trusted spawns may use project-controlled agent definitions, shared/project
context, project skill roots, and an explicitly selected worktree's
invocation-local `.pi/agents/` overlay. Untrusted spawns resolve from bundled
defaults and user-global definitions/resources only. They do not inspect
project/shared/worktree-controlled catalogs, context files, or skill roots.
User-global resources remain available because they are not controlled by the
selected project.

The child loader and `createAgentSession` receive the same trust-aware settings
manager. The public tool schema does not expose trust and the decision does not
change retention or scheduling.

## Why

Trust can change while a worktree is being validated or while accepted work is
waiting for a root slot. Reading live trust again at runner start would make
identical calls depend on timing and could authorize project input after an
untrusted preflight. An immutable snapshot makes the authorization decision
explicit and consistent across discovery, context, skills, and session setup.

Detailed file, byte, ancestor, race, catalog, and skill limits are owned by the
source modules and focused tests rather than this ADR.
