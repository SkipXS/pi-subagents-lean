# pi-subagents-lean

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Lightweight, isolated subagents for [pi](https://pi.dev).** Give a task to a
specialist with its own session, tools, model, and instructions, while keeping
the parent tool interface small.

> [!NOTE]
> This is the actively developed [`SkipXS/pi-subagents-lean`](https://github.com/SkipXS/pi-subagents-lean)
> fork and renamed successor of [`AlexParamonov/pi-subagents-lite`](https://github.com/AlexParamonov/pi-subagents-lite),
> originally derived from [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).
> It deliberately provides immediate foreground and background execution—not
> scheduling or join modes.

## Table of contents

- [Install and first use](#install-and-first-use)
- [Tools and execution](#tools-and-execution)
- [Agent definitions](#agent-definitions)
  - [Dynamic catalog, discovery, and trust](#dynamic-catalog-discovery-and-trust)
  - [Frontmatter reference](#frontmatter-reference)
  - [Parent orchestration guidance](#parent-orchestration-guidance)
  - [Root concurrency and queue](#root-concurrency-and-queue)
- [Models, prompts, extensions, and skills](#models-prompts-extensions-and-skills)
- [Headless operation and logs](#headless-operation-and-logs)
- [Configuration reference](#configuration-reference)
- [Logs, requirements, and development](#logs-requirements-and-development)

## Install and first use

Install this fork directly from GitHub:

```bash
pi install git:github.com/SkipXS/pi-subagents-lean
pi install -l git:github.com/SkipXS/pi-subagents-lean # project-local
pi -e git:github.com/SkipXS/pi-subagents-lean          # try without installing
```

Ask pi to delegate through the `Agent` tool. A foreground agent returns its
result in the current turn. A background execution acknowledges immediately and
gets one per-execution automatic completion nudge after a short delay (exactly one
automatic delivery attempt). A background
`AgentContinue` execution gets its own nudge and never reuses the original
execution's delivery claim.

```text
Parent session
  │ Agent({ agent: "scout", prompt: "Find the authentication entry points" })
  ├─ foreground ── waits ──► result and usage in this turn
  └─ background ── continues ─► one automatic result nudge when finished
```

Use background work only for independent work. Do not poll `AgentStatus`, sleep,
or repeat the task while waiting for a background result; resume dependent work
when its notification arrives.

## Tools and execution

The extension registers four fixed, minimal schemas with concise static tool
descriptions. Their stable names and fields keep recurring parent-session schema
tokens low; the generated parent orchestration guidance supplies the changing
catalog and operating advice.

### `Agent`

| Parameter | Required | Meaning |
|---|:---:|---|
| `prompt` | yes | Task and relevant constraints for the root agent. |
| `agent` | yes | Role to resolve from the current catalog. Names and `display_name` values resolve case-insensitively; use the canonical name shown by the catalog when practical. |
| `description` | no | Short caller-facing label. If omitted, the first prompt line (up to 80 characters) is used. |
| `run_in_background` | no | Return immediately; this execution receives exactly one automatic completion nudge after a short delay. `forceBackground: true` can make all root launches background. |
| `worktree_path` | no | Root-only absolute path or parent-CWD-relative path inside a worktree of the parent repository. It is validated with Git. A trusted selected worktree may add a spawn-local `.pi/agents/` overlay. |

The public tool deliberately has no model, thinking, turn, or token
parameters. Configure model and thinking through an agent definition or
persistent/session settings; those values are applied internally and are not
caller-controlled spawn overrides. Turn and token limits come from the agent
definition. Every `Agent` call is a root launch owned by the parent session.

In Pi's interactive tool rows, `Agent` displays the canonical role, resolved
`provider/model-id`, normalized thinking level, and the complete prompt. The
row is hydrated after asynchronous resolution. `AgentContinue` and `StopAgent`
use the same details renderer: their first line shows the canonical full agent
ID, role, resolved model, and normalized thinking; `AgentContinue` then shows
its complete prompt.

### `AgentContinue`

`AgentContinue({ agent_id, prompt, run_in_background })` continues a
finished agent on its existing session, reusing its model, working directory,
output log, and stored `max_turns`/`grace_turns` limits. `run_in_background`
is a mandatory boolean (strict-mode tool schemas cannot declare optional
parameters): pass `true` to acknowledge immediately and receive exactly one
automatic completion nudge for this execution, or `false` to await the new
execution's result. Delivery claims are per execution, so each background
continuation gets its own nudge. Only retained root
agents that completed successfully can be continued; running, queued, unsettled,
stopped, aborted, turn-limited, or failed agents are rejected. A short `agent_id`
prefix is accepted only when it matches
exactly one retained agent; ambiguous prefixes are rejected. Each execution is
retained as its own entry (`id`, `mode`, `status`, `usage`, `turnCount`) in the
record's `executions` history and the accumulated usage, cost, tool, turn, and
compaction totals stay cumulative across executions.

### `StopAgent`

`StopAgent({ agent_id })` stops one running or queued agent. A background
`Agent` acknowledgement supplies its full ID; foreground `Agent` results do not
necessarily supply one. Use `AgentStatus` to identify other agents; it
displays IDs as `short_id (type)`. The interactive `StopAgent` row resolves a
full ID from a unique prefix when the retained record is available.

### `AgentStatus`

Lists retained agents as `short_id (type) status`, with an optional
`delivery:<state>` field. Delivery state is diagnostic: a `sendMessage` error
remains visible until record eviction, with no retry promise. Use the tool for
discovery, not for waiting; background completion is delivered automatically.

## Agent definitions

An agent definition is a Markdown file: flat frontmatter configures a role and
the body becomes that role's instructions.

```text
--- frontmatter ---
role-specific system prompt body
```

The parser supports only flat `key: value` pairs. Lists may be bracketed
comma-separated values (`[read, bash]`), bare comma-separated values
(`read, bash`), or YAML-style `- item` lines. It does **not** support nested
YAML or multiline scalars. `name`, or the filename without `.md`, is the role
name.

```markdown
---
name: security-review
display_name: Security Review
description: Review a change for security flaws
tools: [read, grep, bash]
extensions: false
skills: false
model: zai/glm-5.2
thinking: high
max_turns: 80
---

Review only the delegated change. Focus on injection, authorization, and
insecure defaults. Report evidence and actionable findings.
```

### Dynamic catalog, discovery, and trust

The active catalog is not fixed at installation. It is assembled per field from
these sources (highest precedence first):

```text
One root spawn with worktree_path
  trusted <worktree>/.pi/agents/       invocation-only overlay
                  │
Normal parent catalog (and base of that overlay)
  <project>/.pi/agents/                trusted projects only
  <project>/.agents/agents/            trusted projects only
  ~/.pi/agent/agents/                  always eligible
  bundled defaults                     lowest; removable by disableDefaultAgents
```

A higher source overrides only the fields it supplies; absent fields continue
from lower sources. On a same-name collision, this per-field merge produces the
effective definition. Project-controlled descriptions are prompt input, so Pi
trust is required before either project directory is read. An untrusted project
uses only user definitions and enabled bundled defaults. Other worktrees are
never crawled automatically.

**Live catalog versus accepted snapshot.** At session start and before every
parent turn, the extension rescans the user and trusted current-project
locations. Added, changed, hidden, and removed roles therefore affect the next
parent orchestration catalog without a restart. If a requested root role is unknown,
it also performs on-demand discovery. A trusted `worktree_path` instead resolves
a fresh private overlay for that invocation.

Once a root spawn is accepted—whether it starts now or waits in the global
queue—it keeps an immutable copy of its effective definition. Later file edits
do not change that run or its queued work.

**Resolution and visibility.** `Agent` resolves a canonical role by name or
`display_name`, case-insensitively. `hidden: true` omits a role from the parent
orchestration catalog, but does not remove it from the registry: it is still
inspectable and callable with its name or display name.
Names that cannot be represented safely in generated prompt guidance are
omitted from that guidance, but remain resolvable through the explicit tool path.

Bundled roles are enabled unless `disableDefaultAgents` is set:

| Role | Purpose |
|---|---|
| `architect` | Read-only design, interfaces, migrations, and trade-offs |
| `scout` | Read-only discovery, tracing, and root-cause investigation |
| `implementer` | Bounded code, test, configuration, or documentation work |
| `reviewer` | Independent correctness, regression, and security review |
| `verifier` | Reproduction, checks, tests, and failure analysis |

Bundled read-only roles expose `read`, `grep`, and `bash`. Shell access still
follows that role's instructions and project policy.

### Frontmatter reference

The following is the complete supported frontmatter. Defaults marked “global
policy” are controlled by the configuration settings documented below.

#### Identity and prompt

| Field | Accepted value | Default | Behavior |
|---|---|---|---|
| `name` | string | filename | Canonical role name. Same-name definitions merge by [catalog precedence](#dynamic-catalog-discovery-and-trust). |
| `display_name` | string | `name` | Human-readable catalog label and alias for role resolution. |
| `description` | string | empty | Catalog and tool-result summary. Keep it concise: visible descriptions are included in generated parent guidance. |
| Markdown body | text | empty | System instructions for this role. An absent/empty higher-precedence body does not erase a lower-precedence body. |
| `hidden` | `true` or `false` | `false` | Hide from automatic parent advertising while retaining catalog inspection and explicit resolution. |

#### Tools, extensions, and skills

| Field | Accepted value | Default | Behavior |
|---|---|---|---|
| `tools` | list of tool references | all active tools | Whitelist visible tool schemas and session registration. `[]` exposes no work tools. Built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`. Use a bare extension tool, `extension/tool`, or `extension/*`. |
| `exclude_tools` | list | none | Blacklist visible tool schemas. Use the same extension reference syntax. Do not combine it with `tools`; a list-valued `tools` whitelist wins. |
| `extensions` | `true`/`all`, `false`/`none`, or list | global policy | Select extensions to load. Loading controls hooks and tool registration, **not** whether the LLM can see a tool schema. |
| `exclude_extensions` | list | none | Load every extension except these. Do not combine it with a list-valued `extensions`; the explicit list wins. |
| `skills` | `true`/`all`, `false`/`none`, or list | global policy | Select available skills. The prompt normally includes only each skill's metadata. |
| `preload_skills` | list, `false`, or `none` | no preload | Put complete `SKILL.md` content for listed skills in the system prompt. A preload list suppresses implicit/all skill metadata; use an explicit `skills` list to retain metadata for selected skills. This has the highest prompt cost. |

Omitting `extensions` or `skills` does not unconditionally mean “all”: it uses
`loadExtensionsImplicitly` or `loadSkillsImplicitly`, both of which default to
`true`. A concrete frontmatter value always overrides the global policy.

A minimal definition therefore inherits all active tools and the current
implicit extensions/skills policy. Pi initially activates `read`, `bash`,
`edit`, and `write`; `grep` and `find` are built-ins that must be explicitly
selected to be active. `tools` affects what the model sees, whereas `extensions`
affects what loads:

```yaml
# Read-only tools; no extension hooks or skills.
tools: [read, grep, bash]
extensions: false
skills: false

# Keep most tools but hide one extension's tools; its hooks still load.
exclude_tools: [tavily/*]
# Use exclude_extensions: [tavily] instead to prevent that extension loading.
```

#### Model, reasoning, and limits

| Field | Accepted value | Default | Behavior |
|---|---|---|---|
| `model` | `provider/model-id` | resolved precedence | Role-level model candidate. Session and persistent overrides can take precedence; the parent model is the final fallback. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | resolved precedence | Role-level reasoning candidate; invalid values are ignored. Provider capability normalization may adjust the selected level. |
| `max_turns` | number | unlimited | Soft limit. At the limit the agent is instructed to wrap up; it is hard-aborted after `graceTurns` more turns (`0` aborts on the next turn). |
| `max_tokens` | number | unlimited | Maximum output tokens per model response, passed through as the provider's completion-token limit. |

### Parent orchestration guidance

With `orchestrationPrompt: true` (the default), each parent turn receives a
newly generated, parent-only block. It is an explanation of how to route work,
sequence dependencies, avoid duplicate work, use background work safely, and
remain responsible for the final answer. It then lists the currently visible
roles and concise descriptions.

```text
before each parent turn
  refresh trusted live catalog
          │
          ├─ orchestrationPrompt: false ──► remove this extension's old block
          └─ true ───────────────────────► replace it with bounded guidance
                                             + visible role catalog

spawn accepted ──────────────────────────► capture the stable role definition
agent session ───────────────────────────► receives isolated prompt and tools
```

The exact wording is generated implementation detail, so it is intentionally
not pasted here. Its behavior is stable: it advertises only visible names that
are safe to represent exactly (at most 64 UTF-8 bytes, without controls,
backticks, or its reserved markers); descriptions are normalized and capped.
The catalog is deterministic and bounded to 24 agents and 4,096 UTF-8 bytes for
the whole generated block; its available byte budget is derived after framing
and routing guidance. Omitted entries are reported with an
`… +N omitted` marker. Disable it when you want no automatic catalog or routing
guidance.

### Root concurrency and queue

Every `Agent` call creates one root record. `concurrency.default` limits the
number of simultaneous foreground and background root executions; excess work
waits in one FIFO queue. Queue admission is atomic, and a queued worktree run
keeps the accepted role definition and validated path until it starts.

```text
Parent session
├─ Agent A ── foreground or background ──► one root slot
├─ Agent B ── foreground or background ──► one root slot
└─ AgentContinue ───────────────────────► one root slot
```

Agent sessions are isolated with AsyncLocalStorage. They receive only their
configured work tools; the root control tools and any custom `Agent` proxy are
never registered in a subagent session.

## Models, prompts, extensions, and skills

### Model and thinking resolution

Model and thinking use the same highest-to-lowest precedence:

1. Extension-internal spawn value (not a public tool parameter)
2. Session per-role override
3. Persisted per-role override in `subagents-lean.json`
4. Agent Markdown `model` or `thinking`
5. Session global default, then persisted global default
6. Calling parent value

The public `Agent` schema does not expose model or thinking spawn overrides.
The first level describes only the internal settings plumbing used while the
extension prepares a tool call. A missing frontmatter model or thinking value
therefore does not necessarily inherit the parent: any higher global or
per-role setting can win.

### System prompt and context

`systemPromptMode` controls the prompt base; the agent Markdown body is always
added as `<agent_instructions>`.

| Mode | Base prompt |
|---|---|
| `replace` (default) | Minimal generic prompt plus this role's instructions. Lowest token cost and strongest isolation. |
| `inherit` | Parent system prompt with duplicated Pi scaffolding and extension-owned orchestration blocks stripped, plus this role's instructions. |
| `custom` | `~/.pi/agent/subagents-lean-prompt.md` plus this role's instructions. |

When `includeContextFiles` is `true` (default), applicable project-root and
user `AGENTS.md` files are included as `<project_context>` before the role
instructions. Set it to `false` to reduce static prompt context.

For narrow agents, prefer metadata-only skills over `preload_skills`, restrict
tools when appropriate, and disable unneeded extensions. Full skill preloads
usually cost the most prompt space; tool schemas recur every turn; extension
hooks run every turn; ordinary skill metadata is comparatively small.

## Headless operation and logs

The extension has no custom terminal UI, `/agents` command, widget, conversation
viewer, or manual steering surface. Use the four tools from the parent session:
`Agent` starts work, `AgentContinue` resumes a retained completed root agent,
`StopAgent` cancels running or queued work, and `AgentStatus` reports retained
records. Each background execution delivers one automatic nudge through Pi's
normal message path, including every background continuation.

Finished records are retained for `finishedRetentionMinutes`, and thinking
output can be streamed to the append-only output log with
`outputThinkingBufferSize`. These settings are useful for headless diagnostics
and do not require a custom UI.

## Configuration reference

`~/.pi/agent/subagents-lean.json` is edited directly or by another host-side
configuration writer. Per-role model overrides are dynamic keys inside `agent`,
and per-role thinking overrides live in `thinkingOverrides`.

### Execution, catalog, model, and prompt settings

| JSON path | Default | Behavior |
|---|---:|---|
| `agent.default` | `null` | Persisted global model fallback (`provider/model-id`); `null` lets lower precedence continue to the parent. |
| `agent.<role>` | absent | Persisted model override for that role. A string wins at its precedence level; `null` does not select a model. |
| `agent.defaultThinking` | absent | Persisted global thinking fallback. |
| `thinkingOverrides.<role>` | absent | Persisted thinking override for that role. |
| `agent.graceTurns` | `6` | Extra turns after a soft limit before hard abort. |
| `agent.forceBackground` | `false` | Make every root spawn background, even when its call requests foreground. |
| `concurrency.default` | `4` | Global simultaneous-root-agent limit; excess root spawns queue. |
| `agent.disableDefaultAgents` | `false` | Exclude bundled roles from the next parent refresh and on-demand discovery. |
| `agent.orchestrationPrompt` | `true` | Add the generated parent-only routing guidance and visible catalog, or remove the extension's existing block when false. |
| `agent.systemPromptMode` | `replace` | `replace`, `inherit`, or `custom`; custom reads `~/.pi/agent/subagents-lean-prompt.md`. |
| `agent.includeContextFiles` | `true` | Include applicable project and user `AGENTS.md` context. |
| `agent.loadSkillsImplicitly` | `true` | Default for a definition that omits `skills`. |
| `agent.loadExtensionsImplicitly` | `true` | Default for a definition that omits `extensions`. |

### Runtime and compatibility settings

| JSON path | Default | Behavior |
|---|---:|---|
| `agent.finishedRetentionMinutes` | `60` | Retain completed records for `AgentStatus` and `AgentContinue`. |
| `agent.outputThinkingBufferSize` | `0` | Thinking-log buffer in characters: `0` writes at turn end; positive values flush during streaming near sentence boundaries. |

Older UI-only keys such as `widgetMaxLines`, `widgetCompact`, `showCost`, and
`showTools` are accepted and ignored when loading existing files. Deprecated
nested-delegation fields (`delegate_to`, `max_child_agents`, and
`maxNestingDepth`) are also accepted for migration compatibility, but have no
effect and are removed from newly written configuration. The former
`agent.defaultMaxTurns` field is ignored and dropped during config
normalization; it never supplies a root turn-limit fallback. Legacy `mode`,
`ecoModelOverrides`, and `ecoThinkingOverrides` keys are also tolerated and
removed from normalized writes. Use `max_turns` in Agent Markdown for a role
limit. `finishedRetentionMinutes` and `outputThinkingBufferSize` remain
functional because they govern retention and output logs, not presentation.
Example configuration:

```json
{
  "agent": {
    "default": "zai/glm-5.2",
    "defaultThinking": "medium",
    "forceBackground": false,
    "graceTurns": 6,
    "orchestrationPrompt": true,
    "includeContextFiles": true,
    "loadSkillsImplicitly": false,
    "loadExtensionsImplicitly": false,
    "scout": "xiaomi/mimo-v2.5"
  },
  "thinkingOverrides": {
    "scout": "medium"
  },
  "concurrency": {
    "default": 4
  }
}
```

**Migration from 1.5.x:** Role selection is explicit. Calls that omitted
`agent` or used `general-purpose` must choose a role. The old built-in `Explore`
model key migrates to `scout` unless `scout` is already configured, including an
explicit `null` inheritance value.

> **Reload safety:** A session or extension reload can terminate running agents.
> Output logs and completed results already written to disk remain available.

## Logs, requirements, and development

### Output logs

Each agent has an append-only, human-readable log at:

```text
<system temporary directory>/pi-agent-outputs/<agentId>.log
```

Entries are ISO-8601 timestamped. On systems with `tail`, follow a log with
`tail -f`; use an equivalent command elsewhere. A prompt containing embedded
newlines can continue on an unprefixed log line.

```text
2026-05-27T12:00:00.000Z [USER] Find all authentication files
2026-05-27T12:00:02.000Z [TOOL] read("src/auth/index.ts")
2026-05-27T12:00:15.000Z [ASSISTANT] I found the authentication module...
2026-05-27T12:00:45.000Z [DONE] 5 turns, 12 tool uses, 12.3k tokens, $0.024
```

### Requirements

- Node.js >= 18
- Bun >= 1.0
- pi >= 0.82.0

### Development

Use Bun for development:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:test
bun run test
```

See [docs/coverage.md](docs/coverage.md) for coverage thresholds, compatibility
checks, package smoke testing, and required CI checks for `main`. Maintainers
should follow the [release checklist](docs/releasing.md) before creating a tag.

### Compatibility, origin, and license

Published `src/shell` paths still export `enterSubagentSpawn`,
`exitSubagentSpawn`, and `isInsideSubagentSpawn` for older integrations. They
are deprecated inert-extension-registration markers. AsyncLocalStorage is the
runtime authority for isolated agent sessions; the legacy pair cannot provide
async isolation, root shell controls, or override an active session's guards.

This fork preserves the project's MIT license and Alexander Paramonov's
copyright notice. See [LICENSE](LICENSE).
