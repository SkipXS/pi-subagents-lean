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
| `agent` | yes | Role to resolve from the current catalog. Canonical names resolve case-insensitively; use the name shown by the catalog when practical. |
| `description` | no | Short caller-facing label. If omitted, the first prompt line (up to 80 characters) is used. |
| `run_in_background` | no | Return immediately; this execution receives exactly one automatic completion nudge after a short delay. |
| `worktree_path` | no | Root-only absolute path or parent-CWD-relative path inside a worktree of the parent repository. It is validated with Git. A trusted selected worktree may add a spawn-local `.pi/agents/` overlay. |

The public tool deliberately has no model or thinking parameters. Configure
these values in the selected Agent Markdown definition or with the persistent
`agents.<name>` settings below; settings win independently per field, and an
absent field falls back to the Markdown definition and then the parent session.
Every `Agent` call is a root launch owned by the parent session.

In Pi's interactive tool rows, `Agent`, `AgentContinue`, and `StopAgent` use
one header order: role, agent ID, resolved `provider/model-id`, normalized
thinking, mode, and run. A new `Agent` row initially omits its ID and is
hydrated with the canonical full ID after spawn acceptance; control rows use
the resolved full ID when available. `Agent` and `AgentContinue` then show the
complete prompt.

While an interactive foreground `Agent` or `AgentContinue` tool call is open,
its row starts Pi's default working spinner (`⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`) at
80 ms per frame. Completed rows use `✓` on success and `✗` on error or abort;
a background acknowledgement may use a static `●` and never keeps an animation
running. No queue glyph is shown unless an authoritative queue state is
available. These markers are renderer-only and do not change tool results,
RPC/JSON, or print output.

### `AgentContinue`

`AgentContinue({ agent_id, prompt, run_in_background })` continues a
finished agent on its existing session, reusing its model, working directory,
and output log. `run_in_background` is a mandatory boolean (strict-mode tool
schemas cannot declare optional parameters): pass `true` to acknowledge
immediately and receive exactly one automatic completion nudge for this
execution, or `false` to await the new execution's result. Delivery claims are
per execution, so each background continuation gets its own nudge. Only
retained root agents that completed successfully can be continued; running,
queued, unsettled, stopped, aborted, or failed agents are rejected. A short `agent_id`
prefix is accepted only when it matches
exactly one retained agent; ambiguous prefixes are rejected. Each execution is
retained as its own entry (`id`, `mode`, `status`, `usage`, `compactionCount`) in
the record's `executions` history and usage, cost, and compaction totals stay
cumulative across executions.

### `StopAgent`

`StopAgent({ agent_id })` stops one running or queued agent. A successful
foreground `Agent` or `AgentContinue` result includes its canonical full agent
ID. Background `Agent` and `AgentContinue` acknowledgements also supply the
full ID. Use `AgentStatus` to identify other agents; it displays entries as
`[short_id] (type) status`. The interactive `StopAgent` row resolves a full ID
from a unique prefix when the retained record is available.

### `AgentStatus`

Lists retained agents as `[short_id] (type) status`, with an optional
`delivery:<state>` field. Delivery state is diagnostic: a `sendMessage` error
remains visible until the parent session shuts down, with no retry promise. Use the tool for
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
description: Review a change for security flaws
tools: [read, grep, bash]
extensions: false
skills: false
model: zai/glm-5.2
thinking: high
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

For each `Agent` call, project trust is snapshotted during synchronous tool
preflight before worktree validation or catalog discovery can await. That
immutable snapshot governs the child session even if the parent trust state
changes while the call is queued. An untrusted child cannot load project/CWD
`AGENTS.md` context or project skills; global user resources remain available.
An explicitly selected worktree inherits the parent snapshot and is never
trusted independently.

**Live catalog versus accepted snapshot.** At session start and before every
parent turn, the extension rescans the user and trusted current-project
locations. Added, changed, hidden, and removed roles therefore affect the next
parent orchestration catalog without a restart. If a requested root role is unknown,
it also performs on-demand discovery. A trusted `worktree_path` instead resolves
a fresh private overlay for that invocation.

Once a root spawn is accepted—whether it starts now or waits in the global
queue—it keeps an immutable copy of its effective definition. Later file edits
do not change that run or its queued work.

**Resolution and visibility.** `Agent` resolves a canonical role by `name`,
case-insensitively. `hidden: true` omits a role from the parent orchestration
catalog, but does not remove it from the registry: it remains inspectable and
callable by its canonical name.
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

The following is the complete supported frontmatter.

#### Identity and prompt

| Field | Accepted value | Default | Behavior |
|---|---|---|---|
| `name` | string | filename | Canonical role name. Same-name definitions merge by [catalog precedence](#dynamic-catalog-discovery-and-trust). |
| `description` | string | empty | Catalog and tool-result summary. Keep it concise: visible descriptions are included in generated parent guidance. |
| Markdown body | text | empty | System instructions for this role. An absent/empty higher-precedence body does not erase a lower-precedence body. |
| `hidden` | `true` or `false` | `false` | Hide from automatic parent advertising while retaining catalog inspection and explicit resolution. |

#### Tools, extensions, and skills

| Field | Accepted value | Default | Behavior |
|---|---|---|---|
| `tools` | `true`/`all`, `false`/`none`, or list | all active tools | Select visible tool schemas and session registration. `[]` exposes no work tools. Built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`. Use a bare extension tool, `extension/tool`, or `extension/*`. |
| `exclude_tools` | list | none | Subtract these from the selected tools, including when `tools` is `true` or a list. Uses the same extension reference syntax. |
| `extensions` | `true`/`all`, `false`/`none`, or list | `false` | Select extensions to load. Loading controls hooks and tool registration, **not** whether the LLM can see a tool schema. |
| `exclude_extensions` | list | none | Subtract these from the selected extensions. Excluded extensions are not bound, so their hooks and tools do not contribute. |
| `skills` | `true`/`all`, `false`/`none`, or list | `false` | Select available skill metadata. The model can load selected skill contents on demand with `read`. |
| `exclude_skills` | list | none | Subtract these from the selected skill metadata, including skills discovered by extensions. |

`exclude_extensions` is a binding policy, not an import sandbox. Pi's discovery
may already import every extension in the base selection and execute its
factory before this filter is applied. The excluded extension is then omitted
from `bindExtensions()`, so its hooks and tools do not bind or contribute, but
import-time and factory side effects may already have happened. Do not treat
`exclude_extensions` as protection against those side effects; use Pi's project
trust and extension-loading controls when that boundary matters.

Missing `extensions` and `skills` resolve to `false` after the per-field
catalog merge. Explicit `true`, `false`, and list values remain available. A
minimal definition therefore loads no extensions or skills. Skills are exposed
as metadata only; the model loads selected `SKILL.md` contents on demand with
`read`.

Pi initially activates `read`, `bash`, `edit`, and `write`; `grep` and `find`
are built-ins that must be explicitly selected to be active. `tools` affects
what the model sees, whereas `extensions` affects what loads:

```yaml
# Read-only tools; no extension hooks or skills.
tools: [read, grep, bash]
exclude_tools: [bash]
extensions: false
skills: false
```

```yaml
# Select extension tools, then subtract one tool from the selection.
tools: [read, bash, tavily/*]
exclude_tools: [bash]
# Use exclude_extensions: [tavily] to prevent that extension's hooks/tools loading.
```

#### Model and reasoning

| Field | Accepted value | Default | Behavior |
|---|---|---|---|
| `model` | `provider/model-id` | parent session | Markdown role-level model. A persistent `agents.<name>.model` value takes precedence; invalid or unavailable registry entries fall through. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | parent session | Markdown role-level reasoning level. A persistent `agents.<name>.thinking` value takes precedence; invalid values are ignored and provider capability normalization may adjust the selected level. |

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

The effective merged Agent Markdown definition supplies `model` and `thinking`,
with optional persistent `agents.<name>` values taking precedence independently
per field. If a field is absent in both places, the calling parent session's
value is used. Agent names are matched case-insensitively, including bundled,
user, shared, project, and worktree-discovered definitions. Model keys use Pi's
existing registry lookup and fallback chain; malformed or unavailable settings
fall through to the effective Markdown model and then the parent model.
Thinking values use the existing provider-capability normalization. Queueing and
rendering may carry the already-resolved values internally, while
`AgentContinue` reuses the original session rather than resolving a new model or
thinking level.

### System prompt and context

Every subagent uses replacement mode: a minimal generic header, environment
information, the role's Markdown body in `<agent_instructions>`, and optional
skills/context sections. No parent system prompt is read.

When `includeContextFiles` is `true` (default), a trusted child includes
applicable project-root and user `AGENTS.md` files as `<project_context>` before
the role instructions. An untrusted child includes only the user-global
context file and never reads project/CWD context files. Set it to `false` to
reduce static prompt context.

For narrow agents, select only the needed skill metadata, restrict tools when
appropriate, and disable unneeded extensions. Project skills are available only
when the parent project is trusted; global user skills remain available in an
untrusted child. The model can use `read` to load a selected `SKILL.md` only
when its description matches the task; ordinary skill metadata is comparatively
small.

## Headless operation and logs

The extension has no custom terminal UI, `/agents` command, widget, conversation
viewer, or manual steering surface. Use the four tools from the parent session:
`Agent` starts work, `AgentContinue` resumes a retained completed root agent,
`StopAgent` cancels running or queued work, and `AgentStatus` reports retained
records. Each background execution delivers one automatic nudge through Pi's
normal message path, including every background continuation.

Finished records remain available to `AgentStatus` and `AgentContinue` until the
parent session shuts down. Thinking output is written to the append-only output
log at turn end. These diagnostics do not require a custom UI.

## Configuration reference

`~/.pi/agent/subagents-lean.json` is edited directly or by another host-side
configuration writer. Only current runtime settings and the top-level `agents`
map are accepted and persisted. Unknown or invalid fields in `agent` and in an
agent override are discarded; they are never treated as model selections.

### Execution, catalog, and prompt settings

| JSON path | Default | Behavior |
|---|---:|---|
| `concurrency.default` | `4` | Global simultaneous-root-agent limit; excess root spawns queue. |
| `agent.disableDefaultAgents` | `false` | Exclude bundled roles from the next parent refresh and on-demand discovery. |
| `agent.orchestrationPrompt` | `true` | Add the generated parent-only routing guidance and visible catalog, or remove the extension's existing block when false. |
| `agent.includeContextFiles` | `true` | Include applicable trusted-project and user-global `AGENTS.md` context. |
| `agents.<name>.model` | absent | Persistent `provider/model-id` override. Registry-invalid or unavailable values fall through to the effective Markdown model and then the parent. |
| `agents.<name>.thinking` | absent | Persistent `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` override. Provider capability normalization may adjust it. |

`agents.<name>` matches the effective agent name case-insensitively and applies
to bundled and discovered agents, including trusted worktree overlays. The
precedence for each field is `agents.<name>` > effective Agent Markdown
(including discovery merge) > parent session; model and thinking therefore fall
back independently. Names are normalized to lowercase at load time. If a JSON
object contains case variants such as `Scout` and `scout`, the last entry in
property/input order wins as a complete override object.

Missing `skills` and `extensions` frontmatter fields resolve to `false` after
catalog merging.

Example configuration:

```json
{
  "agent": {
    "orchestrationPrompt": true,
    "includeContextFiles": true,
    "disableDefaultAgents": false
  },
  "agents": {
    "implementer": {
      "model": "anthropic/claude-sonnet-4-6",
      "thinking": "high"
    }
  },
  "concurrency": {
    "default": 4
  }
}
```

> **Reload safety:** A session or extension reload can terminate running agents.
> Output logs and completed results already written to disk remain available.

## Logs, requirements, and development

### Output logs

Each agent has an append-only, human-readable log at:

```text
<system temporary directory>/pi-agent-outputs/<agentId>.log
```

Entries are ISO-8601 timestamped. Writes are asynchronous and best effort, so
agent lifecycle operations do not wait for a slow disk; an I/O failure does not
fail the agent execution. On systems with `tail`, follow a log with `tail -f`;
use an equivalent command elsewhere. A prompt containing embedded newlines can
continue on an unprefixed log line.

```text
2026-05-27T12:00:00.000Z [USER] Find all authentication files
2026-05-27T12:00:02.000Z [TOOL] read("src/auth/index.ts")
2026-05-27T12:00:15.000Z [ASSISTANT] I found the authentication module...
2026-05-27T12:00:45.000Z [DONE] 12.3k tokens, $0.024
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
