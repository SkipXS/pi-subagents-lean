# pi-subagents-lean

A lightweight pi extension that lets the parent model spawn autonomous subagents for focused tasks. This repository is the renamed `SkipXS/pi-subagents-lean` successor to `AlexParamonov/pi-subagents-lite`, itself derived from `tintinweb/pi-subagents`. Its scope intentionally excludes scheduling and join modes and uses a flat root-agent model.

## Language

### Core concepts

**Subagent**

An autonomous agent with an isolated session, spawned from the parent conversation through the `Agent` tool. A subagent cannot access the extension's root control tools and cannot start another agent.

**Parent**

The pi session that owns the extension, delegates work, and receives foreground
results or one completion nudge per background execution.

**Agent type**

A named configuration defining a subagent's instructions, tools, extensions, skills, model, and thinking level. Agent types may be bundled or loaded from Agent Markdown.

**Agent Markdown**

A `.md` agent definition with flat frontmatter and a system-prompt body. Definitions are discovered from bundled defaults, the user directory, trusted shared/project directories, and an explicitly selected trusted working tree. Skill selections expose metadata in the prompt; the model loads selected `SKILL.md` content on demand with `read`.

**Orchestration prompt**

A compact, bounded, parent-only system-prompt block generated from visible agent definitions before each parent turn. It provides routing guidance and the current agent catalog without changing the fixed tool schema.

**Schema-first tool**

A tool registered with a fixed, minimal parameter schema and concise static
description. It has no prompt snippets, parameter descriptions, or
runtime-generated enum. `Agent`, `AgentContinue`, `StopAgent`, and
`AgentStatus` follow this design.

### Configuration

The JSON configuration accepts `includeContextFiles`,
`disableDefaultAgents`, `orchestrationPrompt`, `concurrency.default`, and the
optional top-level `agents` map. Unknown or invalid fields are discarded at the
persistence boundary.

**Agent model and thinking**

The effective merged Agent Markdown definition supplies `model` and `thinking`,
while `agents.<name>` settings override either field independently. Names are
case-insensitive and cover bundled, discovered, and trusted worktree agents;
case variants in one JSON object are normalized to lowercase and the last entry
wins. Missing fields use the parent session. Model registry validation and
provider-specific thinking normalization remain active; queue/rendering may
carry resolved values internally.

### Working trees

**Working tree path**

The canonical absolute directory used as a subagent's working directory after resolving the `worktree_path` argument. Relative input is resolved against the parent cwd. The directory must belong to a working tree that shares the parent's Git common directory; it may be the primary checkout, a linked worktree, or a subdirectory of either.

**Working tree overlay**

An invocation-local `.pi/agents/` layer loaded only from an explicitly selected working tree in a trusted project. It has higher precedence than the parent catalog and never mutates the parent registry.

**Working tree label**

A compact label derived from the selected working-tree root and optional relative subdirectory.

### Runtime

**Foreground subagent**

A spawn that blocks its `Agent` tool call until the subagent finishes and then returns the result inline.

**Background subagent**

A spawn that acknowledges immediately, occupies or waits for a global concurrency
slot, and schedules exactly one automatic completion nudge for that
background execution through the normal parent message path.

**Nudge**

A completion message delivered to the parent after a short delay when a
background execution reaches a terminal state. Each execution independently
gets its own individual message and exactly one automatic `sendMessage` attempt.
A `sendMessage` error is retained as a diagnostic delivery failure until the
parent session shuts down; no retry is promised.

**Agent record**

The parent-owned flat runtime record containing lifecycle state, display metadata, execution handles, accumulated usage, final result or error, and retained continuation history.

**Output log**

An append-only, human-readable transcript under the system temporary directory. On systems with `tail`, it can be followed with `tail -f`; use an equivalent command elsewhere.

### Interface

The extension exposes only four public tools:

- `Agent` starts one root agent in the foreground or background. Its public
  schema does not expose model, thinking, or token spawn overrides.
- `AgentContinue` resumes one retained, successfully completed root session.
  A background continuation owns a separate automatic nudge claim.
- `StopAgent` stops one running or queued root agent.
- `AgentStatus` lists retained root records and their delivery state.

There is no custom terminal UI; host-standard output, status, and the
append-only output log are the diagnostic surfaces.

## Relationships

- The **parent** starts independent root **subagents** from named **agent types** using persistent per-agent settings above the effective Agent Markdown model and thinking values, or its own values when those fields are absent.
- **Agent Markdown** supplies custom or overriding agent-type configuration; the persistent `agents.<name>` map supplies optional model/thinking overrides.
- The **orchestration prompt** advertises visible agent types only to the parent.
- A subagent may run at a validated **working tree path** and use its trusted **working tree overlay**.
- Foreground results return inline; each background execution receives its own **nudge**.
- Root records are scheduled by one global queue and concurrency limit. `AgentContinue` reuses a retained completed root session and consumes a normal slot.
- AsyncLocalStorage isolates each subagent session while it is created and while extensions are bound. No subagent receives an `Agent` custom tool or any root control tool.
