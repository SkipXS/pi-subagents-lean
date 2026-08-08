# pi-subagents-lean

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Lightweight, isolated foreground subagents for [pi](https://pi.dev).**
Delegate a self-contained task to a specialist with its own session, tools,
model, instructions, and optional working tree. Every call waits for the
complete result.

> [!NOTE]
> This is the actively developed
> [`SkipXS/pi-subagents-lean`](https://github.com/SkipXS/pi-subagents-lean)
> successor to `pi-subagents-lite`. It deliberately has two tools and no
> polling, status surface, background notification, or static activity footer.

## Install and first use

```bash
pi install git:github.com/SkipXS/pi-subagents-lean
pi install -l git:github.com/SkipXS/pi-subagents-lean # project-local
pi -e git:github.com/SkipXS/pi-subagents-lean          # try without installing
```

The parent can issue independent foreground calls in one assistant turn. Pi
submits that batch together; dependent stages remain sequential.

```text
Parent emits one batch in the same assistant turn
  ├─ reviewer ─┐
  └─ verifier ─┴─ execute concurrently under the configured root limit

Parent resumes after both settle and reconciles both complete results
```

## Public surface

Exactly two tools are registered: `Agent` and `AgentContinue`. Both always
await a complete foreground result and return the full caller response.

### `Agent`

Description:

> Delegate to a context-isolated specialized agent and wait for its result. It
> cannot see the parent conversation, parent tool results, or other agents'
> output, so its prompt must be self-contained.

| Parameter | Required | Meaning |
|---|:---:|---|
| `prompt` | yes | Self-contained task, constraints, and acceptance criteria. Maximum 256 KiB UTF-8; oversized input is rejected before queue/history allocation. |
| `agent` | yes | Canonical catalog role name. Matching is case-insensitive. |
| `description` | no | Short retained label; defaults from the first prompt line and is capped at 8 KiB UTF-8. |
| `worktree_path` | no | Optional path validated against the parent repository. A trusted selected worktree may provide an invocation-local `.pi/agents/` overlay. |

The schema is strict (`additionalProperties: false`) and contains no model,
thinking, scheduling, or execution-switch parameters. Unknown properties are
rejected. Pi's public tool wrapper throws on tool errors.

### `AgentContinue`

Description:

> Continue a finished agent's session with a new prompt and wait for its result.

| Parameter | Required | Meaning |
|---|:---:|---|
| `agent_id` | yes | Canonical retained root ID, or a unique prefix. Maximum 128 UTF-8 bytes. |
| `prompt` | yes | New self-contained follow-up instructions. Maximum 256 KiB UTF-8. |

The schema is strict and its only required properties are `agent_id` and
`prompt`. It uses constrained `json_schema` sampling with `strict: "prefer"`.
A prefix is accepted only when it resolves to one retained root record. The
record must have completed successfully, be settled, and still have its live
session. The continuation reuses that session, model, and working directory.

## Interactive rows and results

Interactive `Agent` and `AgentContinue` rows show, in order:

```text
Role | Agent ID (when known) | Model | Thinking | Run: New|Continued
Prompt:
complete prompt
```

The canonical full ID replaces a prefix after acceptance. A new row uses
`Run: New`; a continuation uses `Run: Continued`. Queued is shown only when
Pi supplies an authoritative queued lifecycle state. Interactive open rows use
Pi's ten-frame working spinner at 80 ms per frame; terminal rows use success or
error markers. HTML, print, RPC, JSON, and headless paths do not create timers.
Prompt and result text is escaped before terminal rendering, and row
invalidation is coalesced and safe when the host invalidates synchronously,
asynchronously, or not at all.

A successful result includes the canonical full ID, the complete response, and
bounded execution details. Retained record projections may be shorter than the
caller response; the exact caller promise is kept separately until the caller
has consumed it and is released by identity.

## Agent definitions, catalogs, and isolation

A role is a Markdown file with flat frontmatter and a system-prompt body. The
bundled roles are `architect`, `scout`, `implementer`, `reviewer`, and
`verifier`. User, shared, trusted project, and selected trusted-worktree
catalogs are refreshed live before parent turns. Catalog limits and UTF-8
bounds are fail-closed and deterministic.

Each accepted spawn carries immutable resolved role, settings, model, thinking,
trust, worktree, context, tools, extensions, and skills data. Queueing or later
catalog edits cannot reinterpret it. Project descriptions and instructions are
read only under Pi's trust gate; an untrusted request uses the project-free
catalog and excludes project context.

Every child session is AsyncLocalStorage-isolated. It sees only its configured
work tools and never receives either root delegation tool, so children cannot
start another child or access the parent conversation. Prompt handoffs are
explicit and self-contained.

Child sessions are kept in memory. `AgentContinue` reuses a retained in-memory
child session during the parent session. The parent Pi session retains each
`Agent`/`AgentContinue` call and its final result; the extension does not persist
internal child calls, thinking, or intermediate transcript, and creates no child
transcript files in system temp. The parent does not receive the child's full
internal conversation.

## Concurrency, batching, and FIFO queueing

`concurrency.default` accepts an integer from 1 through 64 and defaults to 4
for invalid values. It limits simultaneous root executions, including calls
submitted in one parent turn. Independent calls in the same turn therefore
start together until the limit is reached; excess accepted calls wait in one
FIFO queue. The queue admits at most 128 waiting root executions. A full queue
rejects the new call before it allocates retained history.

Dependent stages must be issued sequentially: await the earlier result, then
send the next prompt. Independent read-only stages should be issued as one
same-turn batch, allowing the configured root limit to control concurrency.

```text
Parent session
├─ Agent reviewer ── foreground root slot
├─ Agent verifier ── foreground root slot
└─ AgentContinue ── one normal root slot, FIFO when necessary
```

## Retention, cancellation, and shutdown

Up to 64 settled terminal root records are retained deterministically. Running,
queued, and unsettled records are protected. Each record keeps at most 128
completed execution summaries and a 1 MiB UTF-8 text budget for bounded prompts,
responses, and errors; each retained prompt is capped at 64 KiB. Active work
keeps its full accepted prompt only as long as execution requires it. Retained
usage, compaction data, status, prompt, response, and error projections remain
usable for continuation and diagnostics.

The parent tool AbortSignal cancels queued work before it consumes a slot and
aborts running child sessions. A cancelled tool returns an error rather than a
successful result. Session shutdown aborts active sessions, settles caller
promises, releases queue resources, and removes the session's records. Late
runner completion cannot release a newer slot or resurrect a removed record.

## Headless operation and session lifecycle

The extension uses Pi's normal tool result path and has no custom terminal UI,
manual menu, polling API, status tool, background notification, or static
activity footer. There is no need to wait for a separate event: the tool call
itself is the join point.

## Configuration

`~/.pi/agent/subagents-lean.json` supports:

| JSON path | Default | Behavior |
|---|---:|---|
| `concurrency.default` | `4` | Simultaneous root limit, integer range 1..64. |
| `agent.disableDefaultAgents` | `false` | Exclude bundled roles from refreshed catalogs. |
| `agent.orchestrationPrompt` | `true` | Add bounded parent-only routing guidance and the live catalog. |
| `agent.includeContextFiles` | `true` | Include applicable trusted context files. |
| `agents.<name>.model` | absent | Per-role provider/model override, bounded and registry-checked. |
| `agents.<name>.thinking` | absent | Per-role reasoning override with provider capability normalization. |

Configuration is read-only from the extension's perspective. Edit
`~/.pi/agent/subagents-lean.json` manually, then reload or start a new Pi
session; the extension only reads this file and never changes or recreates
it. A 1 MiB bound applies before JSON parsing. A missing primary uses defaults even
when `.bak` exists. If an existing primary is invalid or unreadable, a valid
`.bak` is used in memory and both files are left unchanged; otherwise defaults
are used so manual recovery remains possible. Each accepted `Agent` call gets
a detached, frozen settings snapshot, so later edits and reloads affect only
later accepted calls.

Model and thinking are resolved from persistent per-role settings, effective
Agent Markdown, and the parent session. Skills and extensions follow their
catalog selection and exclusion rules. Worktree validation, trust, usage
telemetry, and bounded record retention remain active.

### Skills

Agent definitions may set `skills: true` to advertise all discovered skills,
an explicit list such as `skills: ["tdd", "debug"]` to advertise selected
skills in that order, or `skills: false` to omit skill metadata. Use
`exclude_skills` to subtract names from either enabled selection. Selected
metadata resolves through a bounded asynchronous worker-backed catalog; child
startup does not perform a second skill scan.

The supported package surfaces are only the Pi manifest entry and the
bundled resources documented above. Other modules under `src/` are internal
implementation details, not supported package surfaces.

## Development

Use Bun:

```bash
bun install
bun run typecheck
bun run typecheck:test
bun run test
```

The package entry remains `./src/index.ts`; bundled Markdown agents and active
documentation are included in the published package. See `docs/coverage.md`
and `docs/releasing.md` for repository checks.
