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
- [/agents menu](#agents-menu)
- [Tools and execution](#tools-and-execution)
- [Agent definitions](#agent-definitions)
  - [Dynamic catalog, discovery, and trust](#dynamic-catalog-discovery-and-trust)
  - [Frontmatter reference](#frontmatter-reference)
  - [Parent orchestration guidance](#parent-orchestration-guidance)
  - [Nested delegation and concurrency](#nested-delegation-and-concurrency)
- [Models, prompts, extensions, and skills](#models-prompts-extensions-and-skills)
- [Widget and conversation viewer](#widget-and-conversation-viewer)
- [Configuration reference](#configuration-reference)
- [Logs, requirements, and development](#logs-requirements-and-development)

## Install and first use

Install this fork directly from GitHub:

```bash
pi install git:github.com/SkipXS/pi-subagents-lean
pi install -l git:github.com/SkipXS/pi-subagents-lean # project-local
pi -e git:github.com/SkipXS/pi-subagents-lean          # try without installing
```

Ask pi to delegate, or use `/agents` to start an agent yourself. A foreground
agent returns its result in the current turn. A background agent acknowledges
immediately and sends one completion notification later.

```text
Parent session
  │ Agent({ agent: "scout", prompt: "Find the authentication entry points" })
  ├─ foreground ── waits ──► result and usage in this turn
  └─ background ── continues ─► automatic result notification when finished
```

Use background work only for independent work. Do not poll `AgentStatus`, sleep,
or repeat the task while waiting for a background result; resume dependent work
when its notification arrives.

## `/agents` menu

`/agents` is the manual control surface. It never requires an LLM tool call. The
interactive menu is TUI-only; RPC, JSON, and print mode return a short notice
instead of opening custom terminal UI.

```text
/agents
├─ Mode: Default / 🍃 Eco (session-only or permanent; source shown)
├─ Running agents
│  ├─ view live conversation, final result, or error
│  ├─ steer a running agent or stop one
│  └─ stop all running/queued agents
├─ Spawn agent
│  ├─ choose a visible type and enter a prompt
│  └─ set model/background; Advanced also sets worktree, thinking,
│     turn/token limits, grace turns, type, and description
├─ Agent catalog
│  └─ inspect discovered definitions and effective model, thinking,
│     tools, skills, and extensions policy
└─ Settings
   ├─ Agent settings — availability plus Default/Eco session/saved model and thinking overrides
   ├─ Execution — concurrency, forced background, limits, and nesting depth
   ├─ Widget — layout, retention/log buffering, and usage columns
   └─ System prompt, context, skills & extensions — prompt mode, parent
      orchestration, context files, and implicit loading defaults
```

Hidden roles remain inspectable in the catalog but are not offered by the spawn
picker. See [resolution and hidden roles](#dynamic-catalog-discovery-and-trust).

## Tools and execution

The extension registers four intentionally bare schemas. Their stable names
and fields keep recurring parent-session schema tokens low; the generated parent
orchestration guidance supplies the changing catalog and operating advice.

### `Agent`

| Parameter | Required | Meaning |
|---|:---:|---|
| `prompt` | yes | Task and relevant constraints for the child. |
| `agent` | yes | Role to resolve from the current catalog. Names and `display_name` values resolve case-insensitively; use the canonical name shown by the catalog when practical. |
| `description` | no | Short caller-facing label. If omitted, the first prompt line (up to 80 characters) is used. |
| `run_in_background` | no | Return immediately and deliver a result notification later. Ignored in favor of `forceBackground: true`; unsupported for nested children. |
| `worktree_path` | no | Root-only absolute path or parent-CWD-relative path inside a worktree of the parent repository. It is validated with Git and shown as a widget label. A trusted selected worktree may add a spawn-local `.pi/agents/` overlay. |

The tool deliberately has no model, thinking, turn, or token parameters.
Configure those through an agent definition, persistent settings, or the manual
spawn flow. `worktree_path` is rejected for nested children.

### `AgentContinue`

`AgentContinue({ agent_id, prompt, run_in_background })` continues a
finished agent on its existing session, reusing its model, working directory,
output log, and stored `max_turns`/`grace_turns` limits. `run_in_background`
is a mandatory boolean (strict-mode tool schemas cannot declare optional
parameters): pass `true` to acknowledge immediately with a completion
notification, or `false` to await the new execution's result. Only retained depth-1
agents that completed successfully can be continued; running, queued,
unsettled, stopped, aborted, turn-limited, or failed agents are rejected, as
are nested children. A short `agent_id` prefix is accepted only when it matches
exactly one retained agent; ambiguous prefixes are rejected. Each execution is
retained as its own entry (`id`, `mode`, `status`, `usage`, `turnCount`) in the
record's `executions` history and the accumulated usage, cost, tool, turn, and
compaction totals stay cumulative across executions.

### `StopAgent`

`StopAgent({ agent_id })` stops one running or queued agent. A background
`Agent` acknowledgement supplies its full ID; foreground `Agent` results do not
necessarily supply one. Use the **Running agents** menu or `AgentStatus` to
identify other agents; they display IDs as `short_id (type)`.

### `AgentStatus`

Lists retained agents as `short_id (type) status`, with applicable
`parent:<short_id>`, `depth:<n>`, `waiting:<short_id>`, and `delivery:<state>`
fields. It is useful for discovery or recovery, not for waiting: background
completion is delivered automatically. Nested child sessions do not receive
`StopAgent` or `AgentStatus`.

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
eco_model: openai/gpt-4o-mini
eco_thinking: low
max_turns: 80
delegate_to: [scout, reviewer]
max_child_agents: 2
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
parent catalog and menu without a restart. If a requested root role is unknown,
it also performs on-demand discovery. A trusted `worktree_path` instead resolves
a fresh private overlay for that invocation.

Once a root spawn is accepted—whether it starts now or waits in the global
queue—it keeps an immutable copy of its effective definition and full catalog.
Later file edits do not change that run, its queued work, or the roles a nested
child may use. This avoids a live refresh changing authorization mid-run.

**Resolution and visibility.** `Agent` resolves a canonical role by name or
`display_name`, case-insensitively. `hidden: true` omits a role from the parent
orchestration catalog and manual spawn picker, but does not remove it from the
registry: it is still inspectable and callable with its name or display name.
A delegating child can receive a hidden role only when its parent's
`delegate_to` explicitly resolves to that role. Names that cannot be represented
safely in generated prompt guidance are also omitted from that guidance, but
remain resolvable through the catalog/tool path.

Bundled roles are enabled unless `disableDefaultAgents` is set:

| Role | Purpose | Built-in delegation policy |
|---|---|---|
| `architect` | Read-only design, interfaces, migrations, and trade-offs | May foreground-delegate to `scout`; 2 total direct children. |
| `scout` | Read-only discovery, tracing, and root-cause investigation | Leaf. |
| `implementer` | Bounded code, test, configuration, or documentation work | May foreground-delegate to `scout`, `verifier`, or `reviewer`; 4 total direct children. |
| `reviewer` | Independent correctness, regression, and security review | Leaf. |
| `verifier` | Reproduction, checks, tests, and failure analysis | Leaf. |

Bundled read-only roles expose `read`, `grep`, and `bash`. Shell access still
follows that role's instructions and project policy.

### Frontmatter reference

The following is the complete supported frontmatter. Defaults marked “global
policy” are controlled by the configuration settings documented below.

#### Identity and prompt

| Field | Accepted value | Default | Behavior |
|---|---|---|---|
| `name` | string | filename | Canonical role name. Same-name definitions merge by [catalog precedence](#dynamic-catalog-discovery-and-trust). |
| `display_name` | string | `name` | Label in `/agents`, widget, and viewer; also an alias for role resolution. |
| `description` | string | empty | Catalog and tool-rendering summary. Keep it concise: visible descriptions are included in generated parent guidance. |
| Markdown body | text | empty | System instructions for this role. An absent/empty higher-precedence body does not erase a lower-precedence body. |
| `hidden` | `true` or `false` | `false` | Hide from automatic parent advertising and manual spawn selection while retaining catalog inspection and explicit resolution. |

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
| `model` | `provider/model-id` | resolved precedence | Role-level model candidate. Session/persistent overrides and manual spawn selection can take precedence; the parent model is the final fallback. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | resolved precedence | Role-level reasoning candidate; invalid values are ignored. Provider capability normalization may adjust the selected level. |
| `eco_model` | `provider/model-id` | resolved Default model | Optional Eco-only model candidate. A configured but missing/unauthenticated model fails the spawn instead of falling back. |
| `eco_thinking` | thinking level | resolved Default thinking | Optional Eco-only reasoning candidate, normalized against the final Eco model independently of `eco_model`. |
| `max_turns` | number | unlimited for `Agent` tool/nested calls; `defaultMaxTurns` fallback for manual `/agents` spawns | Soft limit. At the limit the agent is steered to wrap up; it is hard-aborted after `graceTurns` more turns (`0` aborts on the next turn). |
| `max_tokens` | number | unlimited | Maximum output tokens per model response, passed through as the provider's completion-token limit. |

#### Delegation

| Field | Accepted value | Default | Behavior |
|---|---|---|---|
| `delegate_to` | list of role names/aliases | none | Opts this role into nested delegation and lists the only child roles it may resolve from its accepted catalog. |
| `max_child_agents` | number | 1 when `delegate_to` is nonempty; otherwise 0 | Total direct foreground children allowed over the parent run. Values are floored; negative or non-finite values become 0. Only one can be active at a time. |

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

spawn accepted ──────────────────────────► capture a stable catalog snapshot
child session ───────────────────────────► never inherits parent guidance
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

### Nested delegation and concurrency

Nested delegation is opt-in and bounded. The root session creates depth-1
agents. With the default and hard maximum `maxNestingDepth: 2`, an eligible
depth-1 agent may create depth-2 children; no depth-3 child can exist.

```text
Root session (not counted as an agent slot)
└─ depth 1: Implementer [one global slot]
   ├─ direct child budget: 4 total; one active at a time
   └─ depth 2: Scout [foreground; borrows Implementer's slot]
      └─ no depth 3

Independent root agents
├─ Scout       [one global slot]
└─ Reviewer    [one global slot]
```

A child receives the same `Agent` schema but a reduced, sanitized catalog of
only its permitted roles (including an explicitly permitted hidden role). It
must run in the foreground, inherits the parent CWD/worktree, cannot choose a
worktree, and has neither `StopAgent` nor `AgentStatus`. Before every nested
spawn, the manager rechecks the accepted parent snapshot, permissions, child
budget, active-child state, and depth. Cancelling a parent cascades to all its
descendants.

`concurrency.default` limits simultaneous **root** agents across foreground and
background launches; excess root launches queue. A nested foreground child
borrows its root ancestor's existing slot during the parent handoff, so it does
not consume another global slot. Thus nested work does not exceed global
concurrency, but it can temporarily occupy the parent’s one slot while the
parent waits.

## Models, prompts, extensions, and skills

### Model and thinking resolution

Model and thinking use the same highest-to-lowest precedence:

1. Manual `/agents` spawn override
2. Session per-role override
3. Persisted per-role override in `subagents-lean.json`
4. Agent Markdown `model` or `thinking`
5. Session global default, then persisted global default
6. Calling parent value

A missing frontmatter model or thinking value therefore does not necessarily
inherit the parent: any higher global or per-role setting can win.

Eco mode is selected only in the TUI `/agents` menu. Its footer indicator is
`🍃 Eco`; Default mode adds no footer text. Each Eco field resolves independently as explicit
wizard value > Eco session role override > saved Eco role override > Agent
Markdown `eco_*` > the fully resolved Default-mode field. A wizard field left
unchanged uses the active mode. Mode and resolved settings are captured when a
root spawn is accepted, so queued/running work is unaffected by later toggles;
nested agents inherit that root snapshot.

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

## Widget and conversation viewer

The persistent widget appears above the editor and shows queued, running, and
retained finished agents. It is a live text UI, not a documented screenshot.

```text
◈ Agents  ↓ to navigate
  ⠙ 09:42 Implementer  Add validation  3⚙︎  5⟳ · ↑10k ↓1.8k 45.0%/128k · 12s
    │ output log: <temporary-directory>/pi-agent-outputs/…
    └ editing src/config.ts
  ⠙ 09:43 ↳ Scout      Trace setting use  1⚙︎  2⟳ · ↑2.0k ↓400 · 4s
```

Roots are displayed newest-first. A visible nested child is placed immediately
below its parent and marked with `↳` before its role, so hierarchy takes priority
over purely chronological flattening. In full mode, continuation lines align
under nested rows; in compact mode each row is one line. If space is limited,
running and queued records are selected before finished records, then the
visible hierarchy is ordered for display.

With an empty editor, press `↓` to navigate the widget, `↑`/`↓` to choose a
record, `Enter` to open its conversation, and `Esc` to leave. Other keys return
focus to the editor. The viewer streams thinking and response deltas, renders
Markdown and tool calls, and truncates a tool result over 500 characters to its
first five source lines (with an omitted-line note). Viewer keys follow
`tui.select.*`; `k`/`j` and `Shift+↑`/`Shift+↓` remain aliases.

**Viewer controls:** `↑`/`↓` or `k`/`j` scroll · `PgUp`/`PgDn` or
`Shift+↑`/`Shift+↓` page · `g`/`G` or `Home`/`End` jump · `Enter` steer while
running · `s` twice stop/abort · `q`/`Esc` close.

### Customize the widget

```text
Widget settings
├─ Layout: full/compact line limits, description lengths,
│          force compact, ctrl+o sync, model+thinking, start time
├─ Behavior: finished retention and thinking-log buffer
└─ Usage columns: tools, turns, input, output, context, cost, time
```

- **Full vs compact:** `widgetCompact` forces compact mode. Otherwise,
  `widgetShortcut: true` makes `ctrl+o` track Pi's tool-expansion state; forced
  compact wins.
- **Line limits:** `widgetMaxLines` and `widgetMaxLinesCompact` are total
  rendered-line caps **including the heading**, with a minimum of 2. An omitted
  compact limit defaults to half the full limit. Full rows can use continuation
  lines, so the cap may show fewer agent records; compact rows use one line each.
- **Columns:** `widgetShowModelThinking` controls one shared model-and-thinking
  column in widget rows. `widgetShowStartTime` controls local `HH:MM` after the
  status icon (queue-entry time while queued). Turning a column off frees width.
- **Stats:** the toggles below control widget and viewer usage values. Result
  cards always show elapsed time; only `showCost` also controls cost on result
  cards. Cache fields follow `showInput`.
- **Retention and logs:** finished records stay for `finishedRetentionMinutes`.
  `outputThinkingBufferSize` chooses when streamed thinking is flushed to the
  output log: `0` writes it at turn end; any positive character threshold
  flushes during streaming near sentence boundaries. The `/agents` menu offers
  80/200/500/1000 as presets.

A full row can show tool count, turns, Pi-compatible input/output/cache/cost
usage, context use, and elapsed time. `widgetShowModelThinking` is separate
from those usage toggles. The heading's `↓ to navigate` hint appears whenever
the widget is visible.

## Configuration reference

`~/.pi/agent/subagents-lean.json` is managed by `/agents`; direct edits are also
supported. Per-role model overrides are dynamic keys inside `agent`, and
per-role thinking overrides live in `thinkingOverrides`. Eco mode/settings use
`mode`, `ecoModelOverrides`, and `ecoThinkingOverrides`.

### Execution, catalog, model, and prompt settings

| JSON path | Default | Behavior |
|---|---:|---|
| `agent.default` | `null` | Persisted global model fallback (`provider/model-id`); `null` lets lower precedence continue to the parent. |
| `agent.<role>` | absent | Persisted model override for that role. A string wins at its precedence level; `null` does not select a model. |
| `agent.defaultThinking` | absent | Persisted global thinking fallback. |
| `thinkingOverrides.<role>` | absent | Persisted thinking override for that role. |
| `mode` | absent (`default`) | Default mode for new sessions; `eco` activates Eco resolution immediately. |
| `ecoModelOverrides.<role>` | absent | Persisted Eco model override for that role. |
| `ecoThinkingOverrides.<role>` | absent | Persisted Eco thinking override for that role. |
| `agent.defaultMaxTurns` | unlimited | Soft turn-limit fallback for manual `/agents` spawns when the selected definition has no `max_turns`. It does not apply to `Agent` tool spawns or nested `Agent` calls, which are unlimited unless their definition sets `max_turns`. |
| `agent.graceTurns` | `6` | Extra turns after a soft limit before hard abort. |
| `agent.forceBackground` | `false` | Make every root spawn background, even when its call requests foreground. Nested children stay foreground. |
| `concurrency.default` | `4` | Global simultaneous-root-agent limit; excess root spawns queue. |
| `agent.maxNestingDepth` | `2` | `1` permits root children only; `2` permits their children. Values normalize to 1 or 2; 2 is the runtime maximum. |
| `agent.disableDefaultAgents` | `false` | Exclude bundled roles from the next parent refresh and on-demand discovery. |
| `agent.orchestrationPrompt` | `true` | Add the generated parent-only routing guidance and visible catalog, or remove the extension's existing block when false. |
| `agent.systemPromptMode` | `replace` | `replace`, `inherit`, or `custom`; custom reads `~/.pi/agent/subagents-lean-prompt.md`. |
| `agent.includeContextFiles` | `true` | Include applicable project and user `AGENTS.md` context. |
| `agent.loadSkillsImplicitly` | `true` | Default for a definition that omits `skills`. |
| `agent.loadExtensionsImplicitly` | `true` | Default for a definition that omits `extensions`. |

### Widget and usage settings

| JSON path | Default | Behavior |
|---|---:|---|
| `agent.widgetMaxLines` | `12` | Full-widget total-line cap, including heading; minimum 2. |
| `agent.widgetMaxLinesCompact` | half of full limit | Compact-widget total-line cap, including heading; minimum 2. |
| `agent.widgetDescLengthFull` | `50` | Full-mode description character limit. |
| `agent.widgetDescLengthCompact` | `30` | Compact-mode description character limit. |
| `agent.widgetCompact` | `false` | Force compact mode. |
| `agent.widgetShortcut` | `false` | Let `ctrl+o` tool expansion control compact mode when forced compact is off. |
| `agent.widgetShowModelThinking` | `true` | Show model and thinking in one widget column. |
| `agent.widgetShowStartTime` | `true` | Show local `HH:MM` start/queue time per widget row. |
| `agent.finishedRetentionMinutes` | `60` | Retain completed records in the widget for this many minutes. |
| `agent.outputThinkingBufferSize` | `0` | Thinking-log buffer in characters: `0` writes at turn end; any positive value flushes during streaming near sentence boundaries. `/agents` offers 80/200/500/1000 presets. |
| `agent.showTools` | `true` | Show tool count (⚙︎) in widget and viewer. |
| `agent.showTurns` | `true` | Show turn count (⟳) in widget and viewer. |
| `agent.showInput` | `true` | Show input tokens (↑) and cache fields in widget and viewer. |
| `agent.showOutput` | `true` | Show output tokens (↓) in widget and viewer. |
| `agent.showContext` | `true` | Show context-fill percentage in widget and viewer. |
| `agent.showCost` | `false` | Show dollar cost in widget, viewer, and result cards. |
| `agent.showTime` | `true` | Show elapsed time in widget and viewer. |

Example configuration:

```json
{
  "agent": {
    "default": "zai/glm-5.2",
    "defaultThinking": "medium",
    "defaultMaxTurns": 40,
    "forceBackground": false,
    "graceTurns": 6,
    "maxNestingDepth": 2,
    "orchestrationPrompt": true,
    "includeContextFiles": true,
    "loadSkillsImplicitly": false,
    "loadExtensionsImplicitly": false,
    "widgetMaxLines": 12,
    "widgetMaxLinesCompact": 6,
    "widgetCompact": false,
    "widgetShowModelThinking": true,
    "widgetShowStartTime": true,
    "showCost": true,
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
> The UI reports how many were lost; output logs and completed results already
> written to disk remain available.

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
are deprecated inert-extension-registration markers: migrate child setup to the
manager-created AsyncLocalStorage runtime. The legacy pair cannot provide async
isolation, root shell controls, or override an active child runtime's guards.

This fork preserves the project's MIT license and Alexander Paramonov's
copyright notice. See [LICENSE](LICENSE).
