# pi-subagents-lean

A lightweight pi extension that lets the parent model spawn autonomous subagents for focused tasks. This repository is the renamed `SkipXS/pi-subagents-lean` successor to `AlexParamonov/pi-subagents-lite`, itself derived from `tintinweb/pi-subagents`. Its scope intentionally excludes scheduling and join modes; bounded, foreground-only nested delegation is supported for explicitly configured roles.

## Language

### Core concepts

**Subagent**

An autonomous agent with an isolated session, spawned from the parent conversation through the `Agent` tool or manually through `/agents`.

**Parent**

The pi session that owns the extension, delegates work, and receives foreground results or background completion notifications.

**Agent type**

A named configuration defining a subagent's instructions, display name, tools, extensions, skills, model, thinking level, and execution limits. Agent types may be bundled or loaded from Agent Markdown.

**Agent Markdown**

A `.md` agent definition with YAML frontmatter and a system-prompt body. Definitions are discovered from bundled defaults, the user directory, trusted shared/project directories, and an explicitly selected trusted working tree.

**Orchestration prompt**

A compact, bounded, parent-only system-prompt block generated from visible agent definitions before each parent turn. It provides delegation guidance and the current agent catalog without changing the fixed tool schema.

**Schema-first tool**

A tool registered with a fixed, minimal schema and no descriptions, prompt snippets, parameter descriptions, or runtime-generated enum. `Agent`, `StopAgent`, and `AgentStatus` follow this design.

### Configuration

**Model override**

A model selection for a single manual spawn, the current session, persisted per-agent settings, or a global fallback. Resolution order is spawn > session agent override > persisted agent override > Agent Markdown > global fallback > parent.

**Thinking override**

A thinking-level selection resolved through the same precedence chain as the model and normalized to the selected model's supported levels.

**Eco mode**

A session-only or persisted operating mode controlled from the TUI-only `/agents` menu (RPC, JSON, and print mode do not open its custom UI). Eco model and thinking fields resolve independently after explicit wizard values and fall back to the fully resolved Default-mode fields. Root acceptance snapshots the mode/settings for queued work and all descendants; a configured unavailable or unauthenticated Eco model fails closed.

**Soft turn limit**

The turn count at which a subagent receives a steer instructing it to wrap up and return a final answer.

**Grace turns**

Additional turns allowed after the soft turn limit before the session is hard-aborted. The default is 6.

### Working trees

**Working tree path**

The canonical absolute directory used as a subagent's working directory after resolving the `worktree_path` argument. Relative input is resolved against the parent cwd. The directory must belong to a working tree that shares the parent's Git common directory; it may be the primary checkout, a linked worktree, or a subdirectory of either.

**Working tree overlay**

An invocation-local `.pi/agents/` layer loaded only from an explicitly selected working tree in a trusted project. It has higher precedence than the parent catalog and never mutates the parent registry.

**Working tree label**

A compact UI label derived from the selected working-tree root and optional relative subdirectory.

### Runtime

**Foreground subagent**

A spawn that blocks its `Agent` tool call until the subagent finishes and then returns the result inline.

**Background subagent**

A spawn that acknowledges immediately, occupies or waits for a global concurrency slot, and delivers its result automatically when complete.

**Nudge**

A completion message delivered to the parent after a background subagent reaches a terminal state. Closely timed nudges are batched.

**Agent record**

The parent-owned runtime record containing lifecycle state, display metadata, execution handles, accumulated usage, final result or error, and hierarchy metadata (parent, depth, direct children, and any child currently awaited).

**Activity tracker**

Transient per-agent display state for active tools and streaming response text. Durable usage totals live on the agent record.

**Output log**

An append-only, human-readable transcript under the system temporary directory. On systems with `tail`, it can be followed with `tail -f`; use an equivalent command elsewhere.

### Interface

**Live widget**

The persistent status area above the editor showing queued, running, and retained completed subagents, including configured usage statistics and activity.

**Widget navigation**

Keyboard navigation entered with `Down` while the editor is empty. `Up`/`Down` selects an agent, `Enter` opens its conversation, and `Esc` returns to the editor.

**Conversation viewer**

The live transcript overlay for a subagent session. It supports scrolling, steering a running subagent, and a two-step stop action.

## Relationships

- The **parent** spawns a **subagent** from one **agent type** using the accepted Default/Eco mode snapshot.
- **Agent Markdown** supplies custom or overriding agent-type configuration.
- The **orchestration prompt** advertises visible agent types only to the parent.
- A subagent may run at a validated **working tree path** and use its trusted **working tree overlay**.
- Foreground results return inline; background results arrive through a **nudge**.
- The **agent record** owns lifecycle, hierarchy, and usage data displayed by the **live widget** and **conversation viewer**.
- An explicitly configured **subagent** may foreground-delegate to its permitted child roles within the configured depth: root children are depth 1 and only their children may be depth 2. It inherits its CWD/worktree, may have only one active child, and receives no child `StopAgent` or `AgentStatus` tools. The manager centrally enforces the captured catalog, permission, depth, budget, and active-child checks.
- The **soft turn limit** triggers wrap-up guidance; **grace turns** bound the remaining execution.
