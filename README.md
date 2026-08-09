# pi-subagents-lean

[![CI and coverage](https://github.com/SkipXS/pi-subagents-lean/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SkipXS/pi-subagents-lean/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Lightweight, isolated foreground delegation for [Pi](https://pi.dev). Give a specialist a bounded task, let it work in its own Pi session, and receive its complete result in the current turn. The parent remains responsible for planning, decisions, integration, and the final answer.

This is the first public npm package release, `0.4.0`; the publicly visible `v0.1`–`v0.3` Git tags were internal checkpoints. The extension deliberately exposes exactly two tools: `Agent` and `AgentContinue`.

## Requirements and installation

Use Pi `>=0.82.0 <0.83.0` (Pi `0.82.x`). Install the pinned first release with Pi's package manager:

```bash
pi install npm:pi-subagents-lean@0.4.0
```

For a project-local installation, use `pi install -l` with the same pinned package. To try it without installing, pass `npm:pi-subagents-lean@0.4.0` to Pi's extension option. There is no background Agent execution or long-lived Agent daemon; short-lived Skills discovery Workers may still run. Pi owns the parent session, tool calls, and result presentation.

## Why use it?

Use a specialist when a task benefits from a focused role, a different model, a separate working directory, or an independent review. Each child has its own conversation, selected tools, model, thinking level, skills, extensions, and optional worktree. It cannot silently inherit the parent transcript or another child's answer, so handoffs are explicit and unrelated context stays out of the child prompt.

Every call is foreground and returns a complete result. There is no polling, background notification, `StopAgent`, `AgentStatus`, delivery subsystem, or persistent child-transcript logger.

## First use: start, inspect, continue

A new call returns a complete response and result details containing a canonical agent ID. Keep that ID when a successful child needs a decision or focused follow-up:

```text
Parent
  │
  ├─ Agent({ agent: "scout", prompt: "..." })
  │       └─ complete result + canonical agent ID
  │
  ├─ reconcile the result in the parent
  │
  └─ AgentContinue({ agent_id: "same canonical ID", prompt: "...new instruction..." })
          └─ complete continued result from the same retained session
```

A continuation is valid only for a successfully completed, settled retained root session. It reuses that session, its model, and its working directory. Send the new instruction, evidence, or changed constraint; do not repeat context already retained. The prompt can include new parent or sibling findings the child has not seen.

A child may ask for a missing decision, clarification, evidence, or sibling finding when it cannot reasonably obtain it from its prompt, session, repository, or tools. The parent gathers the answer through `AgentContinue` on the **same** canonical ID; parent and sibling context is not automatic:

```text
Parent: Agent({ agent: "scout", prompt: "Investigate the occasional scheduler stall." })
Child: "After shutdown, should cancellation be reported as success or cancellation?"
Parent: AgentContinue({ agent_id: "same canonical ID",
                        prompt: "Use the existing late-completion contract: shutdown settles caller promises, removes retained records, and a late child completion cannot resurrect one; classify the cancellation accordingly." })
```

### A good conceptual handoff

This is guidance for a useful prompt, not a public schema: **Goal**; **State / evidence / decisions**; **Scope / files / symbols**; **Constraints / non-goals**; **Acceptance criteria**; **Expected result**.

## Public tools

Both tools are strict objects: unknown properties are rejected. Neither accepts model, thinking, scheduling, background, or execution-switch fields.

### `Agent`

Starts a new isolated root child and waits for its complete foreground result.

| Parameter | Required | Meaning |
|---|:---:|---|
| `prompt` | yes | Prompt text; at most 256 KiB of UTF-8 text. |
| `agent` | yes | Catalog role name; matching is case-insensitive. |
| `description` | no | Short retained label; omitted values derive from the first prompt line. |
| `worktree_path` | no | Path in the parent's Git repository, validated before the child starts. |

### `AgentContinue`

Resumes a finished retained root session and waits for its complete result.

| Parameter | Required | Meaning |
|---|:---:|---|
| `agent_id` | yes | Canonical retained root ID or a unique prefix; at most 128 UTF-8 bytes. |
| `prompt` | yes | New instructions, evidence, or constraints; at most 256 KiB of UTF-8 text. |

A prefix must resolve to exactly one retained root. Tool failures are thrown through Pi's normal public tool path.

## Bundled roles

The bundled Markdown definitions are the catalog's default roles; their role files are authoritative for tools and writing permissions:

| Role | Purpose | Writes |
|---|---|---|
| `architect` | Cross-component design, interfaces, trade-offs, compatibility | None; read-only |
| `scout` | Repository discovery and focused investigation | None; read-only |
| `implementer` | Bounded implementation, test, configuration, or documentation change | Only explicitly delegated files/scope |
| `reviewer` | Independent correctness, regression, security, and contract review | None; read-only |
| `verifier` | Reproduction, validation, and reporting of a bounded check | None; read-only |

### Custom Agents and precedence

Custom roles are Markdown files. The parent refreshes these catalog locations before each turn:

| Priority | Location | Scope |
|---:|---|---|
| 1 (highest) | `<selected effective cwd>/.pi/agents/*.md` | Invocation-local overlay when a trusted `worktree_path` is supplied |
| 2 | `<project cwd>/.pi/agents/*.md` | Current trusted project |
| 3 | `<project cwd>/.agents/agents/*.md` | Current trusted shared workspace |
| 4 | `~/.pi/agent/agents/*.md` | User-global |
| 5 | bundled roles | Built-in fallback |

Project, shared-workspace, and selected-worktree definitions are excluded when the project is untrusted. Names match case-insensitively. Overrides merge **per field**: a higher-priority definition replaces only fields it explicitly sets, while omitted fields fall through to the next lower layer.

For example, save this as `~/.pi/agent/agents/api-reviewer.md` for a global role, or as `.pi/agents/api-reviewer.md` in a trusted project:

```markdown
---
name: api-reviewer
description: Read-only API compatibility and regression review.
tools: [read, grep, bash]
extensions: false
skills: false
model: provider/model-id
thinking: high
---

Review only the delegated API change. Compare public contracts, compatibility,
tests, and migration impact. Report evidence-backed findings; do not edit files.
```

`name` and `description` identify the role in the parent catalog; the body is its system prompt. `tools`, `extensions`, `skills`, `model`, and `thinking` are optional. The new or edited definition is considered on the next parent-turn catalog refresh.

Model and thinking resolve independently for each accepted `Agent` call:

| Priority | Model source | Thinking source |
|---:|---|---|
| 1 (highest) | `agents.<name>.model` in `~/.pi/agent/subagents-lean.json` | `agents.<name>.thinking` in that config |
| 2 | `model` in the effective Agent Markdown | `thinking` in the effective Agent Markdown |
| 3 | Parent Pi session model | Parent Pi session thinking level |

To **inherit both** from the parent, omit `model` and `thinking` from both the Markdown and the per-agent config. To set them in the Agent definition, keep lines such as `model: provider/model-id` and `thinking: high` in the Markdown. To override either field without editing the Agent file, use the read-only extension config:

```json
{
  "agents": {
    "api-reviewer": {
      "model": "provider/model-id",
      "thinking": "high"
    }
  }
}
```

The two fields do not have to come from the same layer: for example, a config `model` can combine with Markdown `thinking`. Agent names in config match case-insensitively. If a configured model is unavailable, resolution falls through to the Markdown model and then the parent model; an unavailable Markdown model falls through to the parent. After the final model is selected, the requested or inherited thinking level is normalized to levels that model supports. The resolved values are frozen when the call is accepted, and the Agent row/result metadata shows the effective model and thinking.

Parent orchestration policy is always active: before each parent turn, its handler refreshes a live, trust-scoped catalog. It injects the extension-owned **parent-only** block only when that visible catalog is non-empty; an empty catalog removes the old owned block. The block is not copied into children. The parent owns decomposition, sequencing, reconciliation, integration, validation, and the final answer.

### Orchestration and prompt layout

The parent block is generated from fixed guidance plus the sorted live Agent catalog; it is not a verbatim copy of every Agent file:

```text
parent system prompt
└─ subagents-lean orchestration block
   ├─ when to delegate versus work directly
   ├─ independent parallel work versus dependent sequential work
   ├─ self-contained handoff structure
   ├─ AgentContinue and parent↔child clarification guidance
   ├─ parent ownership of reconciliation and final validation
   └─ visible Agent names + descriptions from the current catalog
```

A new child receives a separate prompt assembled in cache-friendly order:

```text
child system prompt
├─ shared child identity + clarification/AgentContinue guidance
├─ environment (effective cwd, Git state, platform)
├─ applicable bounded AGENTS.md / CLAUDE.md context
├─ active Agent name
├─ <agent_instructions> from the effective Agent Markdown body
└─ selected Skill metadata

child user turn
└─ the explicit Agent.prompt handoff
```

Selected tools and Extensions are registered on the child session; they are not pasted into the Agent Markdown body. The role body changes only the `<agent_instructions>` section.

The ordering deliberately keeps the generic child identity and guidance stable across roles. For children with the same environment and applicable context, those sections also remain before the role-specific divergence. The parent catalog is sorted deterministically and its owned block is replaced at the end of the parent prompt, while the two public tool schemas stay fixed. These choices preserve the longest practical reusable prompt prefix, but an actual provider cache hit is never guaranteed: it depends on the selected model/provider and whether the preceding content is identical. When reported, `cacheRead`, `cacheWrite`, and `latestCacheHitRate` show the observed provider/Pi prompt-cache telemetry; they are unrelated to retained-session continuity.

## Scheduling and parallel work

Independent `Agent` calls submitted in the same assistant turn can run together. One FIFO root scheduler applies `concurrency.default` to new calls and continuations. The default is `4`; valid values are integers `1..64`; invalid values fall back to `4`. Accepted calls beyond the active limit wait in one FIFO queue, which holds at most `128` waiting root executions; a full queue rejects a new call. `AgentContinue` uses normal root capacity, and children cannot recursively fan out because root tools are unavailable in child sessions.

Independent work:

```text
same parent turn
  Agent(scout)     ─┐
  Agent(architect) ─┼─ FIFO scheduler ── complete results ── parent reconciles
  Agent(verifier)  ─┘
```

Dependent work:

```text
Agent(architect) ── await ── parent decision ── Agent(implementer) ── await ── review
```

Scheduler-stall clarification: with `concurrency.default: 1`, submitting `scout` and `architect` together starts `scout` and queues `architect`. If `scout` finishes by asking for clarification, a continuation submitted next also waits behind the accepted `architect` call. For dependent work, await `scout`, answer it with `AgentContinue`, then submit `architect`; a same-turn dependent call cannot bypass FIFO.

A realistic workflow is: submit `scout` and `architect` together; reconcile their complete results; give an `implementer` a self-contained handoff; then submit `reviewer` and `verifier` together after implementation. If the implementer needs a decision or review finding, continue that same session with `AgentContinue` and explicitly include new evidence and changed acceptance criteria. Never run overlapping writers concurrently.

## Isolation, context, trust, and worktrees

A child is an AsyncLocalStorage-isolated Pi session. It does not receive the parent transcript, parent tool history, sibling output, or parent-only orchestration. Preflight/acceptance freezes the resolved role, trust, effective cwd and worktree selection, resolved model/thinking, prompt/caller contract, and resource-selection policy. After a scheduler slot is acquired, runner setup materializes bounded context, selected Skills/Extensions, and the effective tool mapping under that frozen policy and trust.

Every new `Agent` loads supported context files through the bounded trust-aware loader. It checks the global AgentDir candidate first, then the bounded filesystem ancestors of the effective cwd in root-to-cwd order for trusted calls. In each directory it tries `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` in priority order and selects the first acceptable candidate; an unsafe, oversized, changing, or otherwise rejected candidate falls through to the next name. File, total, and ancestor limits apply, and rejected files are never silently trusted.

An untrusted invocation receives the global candidate only and does not inspect project ancestors or project-controlled catalogs/skills. A trusted invocation may use project/shared resources. `AgentContinue` does not reload context files; it keeps the retained child session and existing conversation. Pi may compact that conversation semantically, so continuation promises neither infinite context nor verbatim retention of every old turn.

`worktree_path` must resolve inside the parent's repository (primary checkout, linked worktree, or subdirectory). In a trusted invocation, the selected effective cwd may contribute an invocation-local `<selected effective cwd>/.pi/agents/` overlay; for a selected subdirectory, this is not necessarily the worktree root. Other worktrees are not crawled automatically, and selection does not grant trust independently. This is a repository/discovery boundary, not an OS sandbox: normal child Pi tools still determine what can be read or written.

The live role catalog combines bundled defaults with user-global definitions and, only under project trust, shared/project definitions. A selected trusted effective-cwd overlay is resolved for that invocation and never becomes a session-global catalog entry.

## Configuration

The extension reads the manually maintained `~/.pi/agent/subagents-lean.json` file:

```json
{
  "agent": { "disableDefaultAgents": false },
  "concurrency": { "default": 4 },
  "agents": { "reviewer": { "model": "provider/model-id", "thinking": "high" } }
}
```

- `agent.disableDefaultAgents` defaults to `false`; true omits bundled roles from refreshed catalogs.
- `concurrency.default` controls simultaneous root executions and accepts only `1..64`; invalid values use `4`.
- `agents.<name>.model` and `.thinking` are per-role overrides. For each field, persisted settings win over effective Agent Markdown, which wins over the parent session. An unavailable model falls through to the lower-precedence model, and the selected model normalizes unsupported thinking.

Configuration is read-only to the extension and reloads for a new Pi session. Each accepted spawn freezes its resolved role, trust, effective cwd/worktree selection, model/thinking, prompt/caller contract, and resource-selection policy, so later edits affect later calls only. After a scheduler slot is acquired, runner setup materializes bounded context, Skills, Extensions, and tool mapping under that frozen policy/trust. Model and thinking are not public `Agent` parameters.

### Skills and Extensions

Agent Markdown controls selection: `skills: false` omits metadata, `skills: true` advertises the bounded discovered catalog, and an explicit list advertises those names in order. `exclude_skills` subtracts after selection. Metadata is discovered asynchronously and bounded; a child does not perform a second unbounded skill scan.

`extensions: false` loads none, `true` loads discovered extensions, and an explicit list selects extension/package names. `exclude_extensions` subtracts from that selection. Extension tools can then be selected by role tool policy; root `Agent` and `AgentContinue` are always excluded from children. Missing resources do not broaden access.

## Results, usage, compaction, and retention

Pi owns pending, success, and error presentation. The extension supplies static row metadata, complete prompts/responses, canonical ID, role, model, thinking, `Run: New`/`Run: Continued`, and useful details. Interactive rows may display provider/Pi usage fields `input`, `output`, `cacheRead`, `cacheWrite`, `latestCacheHitRate`, `cost`, context utilization, and compaction counts; headless paths use the normal Pi result path.

`cacheRead`/`cacheWrite` in continuation details may be current-execution deltas; `latestCacheHitRate` is cumulative and derived as cumulative `cacheRead` / (cumulative prompt-accounting `input` + `cacheRead` + `cacheWrite`). These are provider/Pi prompt-cache telemetry, not session continuity: a continuation is never a cache hit. Bounded process-local catalog, skill, and resource caches are internal discovery optimizations, not child history.

Pi compaction keeps a usable semantic summary when a child context is reduced. The retained session is the conversation source; the record's current/latest execution projection is only the latest bounded result/diagnostic view. A continuation replaces that projection while cumulative usage and compaction telemetry remain. It does not create child transcript history in the extension.

At most 64 settled terminal root records remain in memory. Running, queued, and unsettled records are protected; deterministic eviction can make an old continuation ID unavailable. Pi retains parent tool calls and final results, while child internal calls, thinking, and intermediate transcript are not persisted. Shutdown disposes retained child sessions.

Parent cancellation removes queued work before it consumes a slot and aborts running child work. Session shutdown settles caller promises, disposes child sessions, releases scheduler resources, and removes retained records; a late child completion cannot resurrect one.

The foreground caller receives the complete response even when the retained
diagnostic projection is bounded. Queued calls remain host-pending until Pi
receives their normal result; the extension does not simulate live queue
status. A canonical full ID is published after acceptance and remains the
handle for later continuation until retention or shutdown removes it. That
handle is the stable bridge between a complete result and an explicit
follow-up.

## Limitations

- Provider credentials, model availability, pricing, and actual cache behavior belong to Pi and the selected provider.
- Children do not automatically see parent or sibling information; include evidence in the initial prompt or a later `AgentContinue`.
- There is no background Agent execution or separate delivery/status surface; short-lived Skills discovery Workers may still run.
- Worktree validation is not a security sandbox; the parent must review delegated writes and final results.
- Retention is bounded and in-memory; an evicted or shut-down child cannot be continued.

## Origin and license

This project is a fork and renamed successor of [`AlexParamonov/pi-subagents-lite`](https://github.com/AlexParamonov/pi-subagents-lite), which was originally derived from [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents). It is distributed under the MIT License; the upstream and current copyright notices are preserved in [LICENSE](LICENSE).

## Development

```bash
bun install
bun run typecheck
bun run typecheck:test
bun run test
```

CI enforces minimum coverage of 79% statements, 74% branches, 75% functions, and 81% lines, plus stricter per-file gates for critical modules. The package entry is `./src/index.ts`; the five bundled Markdown role files are part of the package. Repository coverage, package, and release checks are documented in [the coverage policy](https://github.com/SkipXS/pi-subagents-lean/blob/v0.4.0/docs/coverage.md) and [the release checklist](https://github.com/SkipXS/pi-subagents-lean/blob/v0.4.0/docs/releasing.md).
