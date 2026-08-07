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

A `.md` agent definition with flat frontmatter and a system-prompt body. Definitions are discovered from bundled defaults, the user directory, trusted shared/project directories, and an explicitly selected trusted working tree. Skill selections expose metadata in the prompt; `skills:true` and explicit lists use one bounded async Pi worker catalog while child `DefaultResourceLoader` skill discovery is disabled. The model loads selected `SKILL.md` content on demand with `read`. Skill fingerprints fail closed at 10,000 visited entries/depth 64 per root, 512 KiB per skill Markdown, 256 KiB per ignore file, 32 MiB relevant bytes per root (including direct root `source=agents` Markdown even when filtered from publication), 64 ancestor roots, and 10,000 merged skills; stable snapshots are checked again after worker discovery. Async Pi discovery has a hard 15-second worker timeout, builds at most a 4 MiB UTF-8 metadata result incrementally, and repeats the bound before cache publication. Skill metadata prompts are capped at 1 MiB and complete child system prompts at 2 MiB; overflow is a deterministic spawn error, never partial selection.

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
persistence boundary. `concurrency.default` accepts only integers `1..64`; all
other values, including values above `64`, normalize to the default `4` at
persistence, store, manager, and scheduler boundaries.

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
background execution through the normal parent message path. The shared root
queue admits at most 128 waiting executions; a call that would exceed it is
rejected before its record/history entry is allocated.

**Nudge**

A completion message delivered to the parent after a short delay when a
background execution reaches a terminal state. Each execution independently
gets its own individual message and exactly one automatic `sendMessage` attempt.
A `sendMessage` error is retained as a diagnostic delivery failure in the
record while that bounded record is retained; the delivery service keeps at
most 64 payload-free terminal projections until parent-session shutdown. The
background result/detail handoff is UTF-8-byte bounded to a 64 KiB total message
representation, secondary details keep at most 8 KiB of text, and retained
errors at most 8 KiB; oversized values carry `[TRUNCATED]`. Payload, timer, and
parent-abort references are released immediately after accepted, failed, or
cancelled attempts; pending and armed entries remain protected. No retry is
promised.

**Agent record**

The parent-owned flat runtime record containing lifecycle state, display metadata, execution handles, accumulated usage, final result or error, and retained continuation history. Retention is bounded to 64 settled terminal records: queued, running, unsettled, and pending/armed background-delivery records are protected. Safe eviction is deterministic and disposes the session handles, so very old `AgentContinue` IDs may later resolve as `not found` and disappear from `AgentStatus`. Each record keeps at most the newest 128 completed execution summaries and at most 1 MiB of UTF-8 text across their prompts, responses, deliveries, and errors; prompts in retained summaries are capped at 64 KiB. Oldest completed entries are pruned deterministically, while active queued/running entries are protected. A full accepted prompt may exist separately on the active task up to 256 KiB and is released after settlement. Foreground callers retain the complete response locally until their promise is consumed; records keep only bounded projections, and the manager clears the promise with an identity check. Background promises clear after completion, and an older continuation can never clear a newer promise. Retained responses, results, deliveries, and errors remain UTF-8-byte bounded with `[TRUNCATED]` markers. `stats.compactionReasons` keeps at most its newest 128 entries, and every retained string field there is UTF-8-byte bounded to 8 KiB with a `[TRUNCATED]` marker.

**Output log**

An append-only, human-readable transcript under a fresh randomized temporary root for the parent/extension session. POSIX enforces private root/file modes through descriptors; Windows inherits the OS temporary directory's isolation/ACL and verifies opened file/root identities before writing, without a portable DACL guarantee. Each log is limited to 8 MiB and the root to 64 MiB across parallel writers using enqueue-time byte reservations. The first over-budget write gets one `[TRUNCATED]` marker as far as the remaining budget permits; later content writes are ignored. Every append must match the dev/ino captured after exclusive create and have `nlink === 1`; hardlink/symlink swaps are rejected before writing. Roots and absolute log paths remain on disk after lifecycle cleanup. A coalesced best-effort janitor scans only the canonical OS temporary parent and verified `pi-subagents-outputs-*` roots, follows no symlinks/junctions/reparse points, requires owner/private modes on POSIX, and uses a private live-process marker so another parent session/process cannot prune the current root. It targets at most 4 roots, 256 MiB, and 7 days, with a deterministic 50,000-entry/inspection budget across a complete pass in addition to per-root limits. A delete pass reserves the inspected entry count from that same global budget and fully validates before any unlink; growth or insufficient reservation skips the complete root. Unclear or exhausted entries are skipped and the active root is protected. The explicit `releaseOutputRoot(root)` API drains queued writes before clearing process-local accounting and identity state.

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
- Untrusted preflight resolves only bundled defaults plus user-global Agent Markdown from a project-free catalog; it never reuses a global registry that may contain trusted shared/project/worktree definitions. Each source streams its directory and fails closed above 256 relevant Markdown files or 10,000 total entries, retaining deterministic order for accepted bounded input and rejecting Agent Markdown above 512 KiB before reading.
- Foreground results return inline; each background execution receives its own **nudge**.
- Root records are scheduled by one global queue and concurrency limit. At most 128 root executions may wait globally; a full queue rejects a new queued spawn/continue before record/history allocation. `AgentContinue` reuses a retained completed root session and consumes a normal slot.
- Retention pruning runs after completion and after terminal background delivery. The BackgroundDeliveryService reports settled delivery; the coordinator/manager performs pruning without duplicating delivery state. Its terminal delivery diagnostics are bounded to 64 payload-free projections, while active pending/armed claims remain protected.
- Root preflight produces one immutable `ResolvedSpawn`; the manager alone snapshots `AcceptedSpawn` for queueing and runner setup. Catalog, settings, model, worktree, and trust resolution are not repeated downstream.
- AsyncLocalStorage isolates each subagent session while it is created and while extensions are bound. No subagent receives an `Agent` custom tool or any root control tool.
