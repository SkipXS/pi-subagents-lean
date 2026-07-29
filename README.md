# pi-subagents-lean

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Sub-agents for [pi](https://pi.dev) — schema-first, minimal-fluff.**

Spawn specialized agents with isolated sessions, controlled tool access, and per-type models with low baseline token overhead.

> [!NOTE]
> This repository is the actively developed [`SkipXS/pi-subagents-lean`](https://github.com/SkipXS/pi-subagents-lean) fork and renamed successor of [`AlexParamonov/pi-subagents-lite`](https://github.com/AlexParamonov/pi-subagents-lite), which originated as a focused fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents). It deliberately keeps a smaller scope: immediate foreground/background execution, without scheduling or join modes. Subagents cannot spawn further subagents.

## Minimal-Fluff, Schema-First Design

Every tool the LLM sees adds recurring schema tokens. This extension therefore keeps its three tool registrations deliberately bare: stable names and parameters, no tool descriptions, no parameter descriptions, and no extra prompt snippets or tool-specific guidelines.

| Verbose registration | Lean registration |
|---|---|
| `description: "Spawn a sub-agent"` | _(removed)_ |
| `promptSnippet` with usage examples | _(none)_ |
| `promptGuidelines` with rules | _(none)_ |
| Parameters with `.description()` | Bare `Type.String()` |

Names like `Agent`, `StopAgent`, `AgentStatus`, `run_in_background`, and `worktree_path` carry most of the interface. Clear success and error results provide the remaining runtime guidance.

It is intentionally **minimal fluff**, not zero context: by default, parent turns receive one small, bounded orchestration block with delegation rules and the visible agent catalog. This makes the required explicit `agent` selection practical without inflating every tool schema. Set `agent.orchestrationPrompt` to `false` to remove that block. Agent Markdown instructions and applicable context files are loaded only into spawned sessions according to their configuration.

**Result:** foreground and background agents, custom agent types, global concurrency, cost tracking, steering, model overrides, and status visibility with a lean parent-session footprint.

## Features

- **Three lean tool schemas** — `Agent` (spawn), `StopAgent` (stop), `AgentStatus` (list)
- **Foreground & background** — block, or fire-and-forget with auto-delivered results
- **Custom agent types** — `.md` files with flat YAML-style frontmatter (tools, model, thinking, turn/token limits)
- **Manual spawn** — from `/agents`, no LLM round-trip; full control over model, thinking, turns, tokens, background
- **Model & thinking resolution** — shared 6-level precedence chain; set once, forget
- **Concurrency** — global agent slot limit with automatic queuing
- **Steering** — inject mid-execution guidance into running agents
- **Cost & usage tracking** — input/output/cache tokens and dollar cost per agent (toggle in stats)
- **Live widget** — persistent status bar with running/completed agents, full and compact modes
- **Conversation viewer** — fullscreen transcript with live streaming, markdown rendering, and keyboard navigation
- **Worktrees** — run agents in a git worktree via `worktree_path`
- **Output logs** — stored under the system temporary directory, ISO-timestamped with configurable thinking buffer (OFF, 80, 200, 500, 1000 chars). Flush rounds to sentence boundaries.
- **Constrained control tools** — `StopAgent` and `AgentStatus` prefer provider-side strict JSON-schema validation, with graceful fallback on unsupported providers

## Install

Install this fork directly from GitHub:

```bash
pi install git:github.com/SkipXS/pi-subagents-lean
pi install -l git:github.com/SkipXS/pi-subagents-lean   # project-local
pi -e git:github.com/SkipXS/pi-subagents-lean           # try without installing
```

## Quick Start

The LLM calls `Agent` like any other tool. Foreground agents return inline with stats; background agents acknowledge immediately and auto-deliver on completion. On parent turns, the extension also adds a compact orchestration section generated from visible agent frontmatter, so agent definitions alone are enough for basic delegation. Set `agent.orchestrationPrompt` to `false` to disable it.

Agents appear in the live widget:

```
◈ Agents
  ⠙ 09:42 Implementer  Write model precedence unit tests  6⚙︎  3⟳ · ↑6.8k ↓1.3k 6.0%/128k (auto) · 12s
  │ output log: <temporary-directory>/pi-agent-outputs/bb3382a9-1f7e-474.log
  └ The file already exists but is ~175 lines. The user wants a …
  ◇ 09:41 Reviewer     Review agent-runner.ts
  ✓ 09:40 Scout        Explore codebase architecture  13⚙︎  4⟳ · ↑16k ↓2.9k 15.0%/128k (auto) · 12s
```

Background agents deliver a result notification when done:

```
 Subagent Result

 ✓ Scout (model-name) · 13⚙︎  5⟳ · ↑25.9k ↓4.9k 15.0%/128k · 21s
   Explore codebase architecture
   output log: <temporary-directory>/pi-agent-outputs/4f6b0f08-7a9a-419.log
```

Foreground results land inline:

```
 ▸ Scout
 ✓ Scout · 31⚙︎  6⟳ · ↑48.1k ↓9.2k 28.0%/128k · 39s
   Explore project directory structure
```

Stop a running agent from `/agents`:

```
○ Agents
  ■ 09:42 Reviewer  Code review of agent-runner.ts  12⚙︎  10⟳ · ↑32.8k ↓6.2k 8% · 52s stopped
    output log: <temporary-directory>/pi-agent-outputs/23689696-3cd3-400.log
```

## Tools

### `Agent`

Spawn a sub-agent.

| Parameter | Required | Description |
|---|---|---|
| `prompt` | ✅ | The task for the sub-agent |
| `description` | | Brief description for the caller (optional — derived from `prompt` if omitted) |
| `agent` | ✅ | Explicit type name — one of bundled `architect`, `scout`, `implementer`, `reviewer`, `verifier`, or a custom type. The parent orchestration catalog lists visible types when enabled. `hidden: true` suppresses automatic advertisement and spawn selection but remains callable by name. |
| `run_in_background` | | Fire-and-forget; result delivered automatically when done |
| `worktree_path` | | Absolute path, or a path relative to the parent cwd, inside a working tree of the parent repository. The path is validated through Git's common directory and shown as a UI label. In a trusted project, the selected working tree can also supply a spawn-local `.pi/agents/` overlay; untrusted projects never load that overlay. Other working trees are not crawled automatically. |

The fixed bare schema requires `agent`. Model, thinking, turn, and token settings are intentionally not exposed to the orchestrator; configure them through `/agents`, Agent Markdown, or persistent settings. See [Custom Agent Types](#custom-agent-types).

### `StopAgent`

Stop a running agent by ID.

| Parameter | Required | Description |
|---|---|---|
| `agent_id` | ✅ | The agent ID returned by `Agent` at spawn |

IDs come from the `Agent` result, the `StopAgent` error (lists all running IDs), or `/agents` → **Running agents**. Display format is `id (type)` (e.g. `a1b2c3 (scout)`).

### `AgentStatus`

List all agents with short ID, type, and status. Output: `short_id (type) status, ...` (e.g. `a1b2c3d4 (implementer) running, d4e5f6a7 (scout) completed`).

The result nudges the LLM to wait for automatic notifications instead of polling — preventing wasteful repeated calls while still letting it discover agents when needed.

## Custom Agent Types

Drop a `.md` file into `.pi/agents/` (project), `.agents/agents/` (shared workspace), or `~/.pi/agent/agents/` (global). Flat frontmatter configures the agent; the body is its system prompt. The supported frontmatter subset is simple `key: value` pairs plus inline comma-separated lists (`[read, bash]`) or `- item` lists—not nested YAML, multiline scalars, or other advanced YAML features. The `name` field, or the filename without `.md`, becomes the agent type. Project and shared-workspace files are read only after project trust.

Bundled defaults ship as inspectable Markdown definitions and are enabled by default:

| Type | Purpose | Default policy |
|---|---|---|
| `architect` | Cross-component design and technical trade-offs | Read-only tools; no extensions or skills |
| `scout` | Repository discovery, tracing, and failure investigation | Read-only tools; no extensions or skills |
| `implementer` | Bounded code, test, configuration, or documentation changes | Read/write tools; no extensions or skills |
| `reviewer` | Independent correctness, regression, and security review | Read-only tools; no extensions or skills |
| `verifier` | Reproduction, checks, tests, and failure analysis | Read-only tools; no extensions or skills |

Here, “read-only tools” means `read`, `grep`, and `bash`; shell commands still depend on the agent instructions and project policy.

The parent refreshes global and trusted current-project files before every turn, so added, changed, hidden, and removed files are reflected without restart. A trusted worktree's `.pi/agents/` is resolved as an invocation-local overlay and never mutates the parent registry. Give visible agents concise descriptions; those descriptions are parent prompt text. The automatic parent catalog advertises only exact agent names of at most 64 UTF-8 bytes without control characters, backticks, or orchestration markers; omitted names remain callable by their exact name. **Precedence:** worktree overlay (for that invocation) > project (`.pi/agents/`) > shared (`.agents/agents/`) > user (`~/.pi/agent/agents/`) > bundled defaults. `disableDefaultAgents` applies on the next parent turn and to on-demand discovery. On name clash, higher precedence wins.

```markdown
---
name: security-review
display_name: Security Review
description: Review code for security issues
tools: [read, bash, grep]
extensions: false
skills: false
model: zai/glm-5.2
thinking: high
max_turns: 80
---

You are a security review specialist. Analyze code for vulnerabilities,
focusing on injection flaws, auth bypasses, and insecure defaults.
```

A minimal agent — just `name` and `description` — gets all currently active tools plus implicitly loaded extensions and skills (subject to the global implicit-loading settings). Pi initially activates `read`, `bash`, `edit`, and `write`; `grep` and `find` are available built-ins but must be selected explicitly through `tools`. Set restrictions only when you want them.

### Frontmatter reference

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | filename | Agent type name (the `agent` tool parameter). Same-name definitions merge according to discovery precedence. |
| `display_name` | string | `name` | Label in the widget, `/agents` menu, and conversation viewer. |
| `description` | string | `""` | One-sentence description in the `/agents` list and tool rendering. |
| `tools` | `string[]` | all active | **Tool whitelist** — which tool schemas the LLM sees. Accepts built-in names and extension tool references (see below). Mutually exclusive with `exclude_tools`. Omit it to expose all currently active tools. |
| `exclude_tools` | `string[]` | none | **Tool blacklist** — all tools except these are visible. Supports `ext/*` syntax. Mutually exclusive with `tools` (when `tools` is `string[]`). |
| `extensions` | `true` \| `string[]` \| `false` | `true` | **Extension loader** — which extensions load (hooks + commands fire). Does NOT control tool visibility. Mutually exclusive with `exclude_extensions`. |
| `exclude_extensions` | `string[]` | none | **Extension blacklist** — all extensions except these load. Mutually exclusive with `extensions` (when `extensions` is `string[]`). |
| `skills` | `true` \| `string[]` \| `false` | `true` | **Skill whitelist** — which skills are available (metadata in system prompt). |
| `preload_skills` | `string[]` \| `false` | `false` | **Full skill injection** — dump complete SKILL.md content into the system prompt instead of metadata-only. |
| `model` | string | inherit parent | Default model as `"provider/model-id"`. See [Model Resolution](#model-resolution). |
| `thinking` | string | inherit parent | One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `max_turns` | number | unlimited | Soft turn limit. The agent receives a wrap-up steer at the limit and is hard-aborted after the configured grace turns (`graceTurns: 0` aborts on the next turn). |
| `max_tokens` | number | unlimited | Max output tokens per LLM response. Injected into provider request payloads. |
| `hidden` | `true` \| `false` | `false` | `true` removes the type from the parent orchestration catalog and spawn picker. It remains inspectable in catalog/settings views and callable by exact name. |

### Tool control (`tools` / `exclude_tools`)

Use a whitelist (`tools`) when an agent needs few tools, or a blacklist (`exclude_tools`) when it needs most. You can use **either**, not both; if both are set, the whitelist wins.

Built-in tool names: `read`, `bash`, `edit`, `write`, `grep`, `find`.

| Value | Meaning |
|---|---|
| omitted | All currently active tools visible |
| `[]` | No tools visible |
| `[read, bash]` | Only listed built-in tools |
| `[web_search]` | Extension tool by name |
| `[tavily/*]` | All tools from an extension |
| `[tavily/web_search]` | Specific tool from an extension |

```yaml
# Read-only via whitelist
tools: [read, bash, grep]
extensions: false

# Same result via blacklist (easier to maintain as the toolset grows)
exclude_tools: [edit, write]
```

> `exclude_tools: [tavily/*]` hides tavily's tools but the extension still loads (hooks fire). Use `exclude_extensions: [tavily]` to prevent loading entirely.

### Extensions & skills

**What they are:**
- **Tools** are callable functions — `read`, `bash`, `edit`, `write`, `grep`, `find` (built-in), or `web_search` / `tavily/*` (from extensions). The `tools` whitelist controls which tool schemas the LLM sees.
- **Skills** are reusable instruction files (`SKILL.md`) that teach an agent how to do a task — e.g. `debug`, `tdd`. By default the agent sees only skill metadata (name, description, path) in its system prompt and reads the full content on-demand via `read`.
- **Extensions** are pi plugins (e.g. `tavily`, `pi-tokf`) that register tools and hooks. Loading one makes its hooks fire and its tools *available* — but those tools still need to pass the `tools` whitelist to be visible.

`extensions` controls which extensions **load** (hooks + tool registration), not tool visibility. `skills` and `preload_skills` control skill availability. Extension lists contain extension/package names; tool lists additionally support bare tool names and `extension/*` or `extension/tool` references.

| `extensions` value | Meaning |
|---|---|
| `true` / omitted | Load all extensions |
| `false` | Load none |
| `[tavily, pi-tokf]` | Load only listed extensions |

| Skill field | Value | Effect |
|---|---|---|
| `skills` | `true` / `[debug, tdd]` / `false` | All / listed / no skills (metadata-only in system prompt) |
| `preload_skills` | `[debug]` / `false` | Dump full SKILL.md content / none (default) |

**Implicit loading.** `loadSkillsImplicitly` and `loadExtensionsImplicitly` are config globals that decide what an agent gets when its frontmatter **omits** `skills` / `extensions`. They default ON, so an agent that says nothing about either gets everything. Turn them OFF (in config, or `/agents` → Settings → System prompt, context, skills & extensions) to default every new agent to nothing — isolated sessions and minimal token cost, with agents opting in explicitly via `skills: [debug]` / `extensions: [tavily]`. A concrete frontmatter value always overrides the global.

**Token cost ranking** (highest → lowest): `preload_skills` ≫ `tools`/`exclude_tools` (each tool schema every turn) > `extensions` (hooks fire every turn) > `skills` (metadata-only, agent reads full content on-demand) > `skills: false` (zero). Prefer metadata skills over preloading; whitelist tools aggressively for narrow agents.

## Model Resolution

Model and thinking use the same precedence (highest first):

1. **Manual spawn override** — model or thinking selected through `/agents` for this spawn
2. **Session-agent override** — `/agents` → Settings → Agent settings, lasts the session
3. **Persistent agent override** — `~/.pi/agent/subagents-lean.json`
4. **Agent Markdown** — frontmatter in the selected agent definition
5. **Global default** — session global first, then persistent global
6. **Parent value** — inherit from the calling agent

Set a default in config or frontmatter, or use `/agents` for a one-off manual spawn override.

## System Prompt Mode

Control how the subagent system prompt is built via `systemPromptMode` (default: `replace`):

- **`replace`** — minimal generic prompt plus the agent's own `<agent_instructions>`. Lowest token cost, most isolated.
- **`inherit`** — parent's system prompt (scaffolding stripped to avoid duplication) plus `<agent_instructions>`. Best when agents need parent context and guidelines.
- **`custom`** — content of `~/.pi/agent/subagents-lean-prompt.md` plus `<agent_instructions>`. Full control.

When `includeContextFiles` is `true` (default), AGENTS.md files from the project root and `~/.pi/agent/` load as `<project_context>` before agent-specific instructions — shared static context improves KV cache prefix hit rates. Toggle off to cut token cost.

## Commands

### `/agents`

Management menu with four sections:

- **Running agents** — status and description; per-agent actions (view conversation, result, error; steer; stop) and bulk stop
- **Spawn agent** — manually spawn without the LLM. Pick a type, enter a prompt, then set model/background or open Advanced options for worktree, type, thinking, limits, grace turns, and description.
- **Agent catalog** — inspect discovered agent definitions, effective model/thinking sources, and tool/skill/extension policies
- **Settings**
  - **Agent settings** — agent availability plus effective model and thinking with global/per-agent session and saved overrides
  - **Execution** — global concurrency, force background, default max turns, and grace turns
  - **Widget** — all appearance, sizing, behavior, and individual usage-stat controls in one menu
  - **System prompt, context, skills & extensions** — prompt construction, custom prompt-file creation, parent orchestration, context, and implicit resource loading

## Interface

### Live widget

Persistent bar above the editor showing running, queued, and completed agents in one newest-first list, updating live. `widgetShowModelThinking` controls one shared model-and-thinking column; when OFF, both values and their column are removed to free space. When `widgetShowStartTime` is ON (the default), every row shows its local creation/start time (`HH:MM`) directly after its status symbol; for queued agents this is the time it entered the queue. Running agents show a spinner, current tool activity, turn count, Pi-compatible token/cache/cost usage, context window utilization, and elapsed time. Completed agents retain their final context and subscription snapshot. Under overflow, running and queued rows take precedence over completed rows, then the visible rows are put back into newest-first order. Full rows show the output-log location. On systems with `tail`, that path can be followed with `tail -f`; use an equivalent log-following command elsewhere.

**Full mode** (header + output-log location + activity):
```
  ⠙ 09:42 Scout  description  3⚙︎  5≤30⟳ · ↑10k ↓1.8k R85k W3.0k CH89.2% $0.024 45.0%/128k (auto) · 1h 2m 3s
  │ output log: <temporary-directory>/pi-agent-outputs/...
  └ thinking…
```

**Compact mode** (single line, description truncated, activity inline):
```
  ⠙ 09:42 Scout  description trunc…  3⚙︎  5≤30⟳ · ↑10k ↓1.8k R85k W3.0k CH89.2% $0.024 45.0%/128k (auto) · 1h 2m 3s  thinking…
```

Turn format uses `≤` and `⟳` (`5≤30⟳` = 5 of 30 turns). Turn count is colored by usage: normal < 80%, warning 80–99%, error at 100%. The max is hidden when well below the limit. The contiguous usage group follows Pi: `↑input ↓output Rcache-read Wcache-write CHhit-rate $cost context/window (auto)`. Input visibility also controls cache fields; output, context, and cost remain independently configurable.

Compact mode is active when **Force compact** is ON, or **ctrl+o shortcut** is ON and the user has collapsed tool expansion. Force compact always wins.

### Keyboard navigation and conversation viewer

With an empty editor, press `↓` to enter widget navigation. Use `↑`/`↓` to select an agent, `Enter` to open its conversation, and `Esc` to leave navigation. Any other key returns focus to the editor.

The conversation viewer streams thinking and response text live as deltas arrive and renders tool calls in pi's style. For tool results over 500 characters, it shows up to the first five newline-delimited source lines; when additional source lines are omitted, an overflow note reports their count. Long individual lines wrap to the viewport. Its scroll keys follow the configured `tui.select.*` keybindings; `k`/`j` and `Shift+↑`/`Shift+↓` remain available as aliases.

**Viewer controls:** `↑`/`↓` or `k`/`j` scroll · `PgUp`/`PgDn` or `Shift+↑`/`Shift+↓` page · `g`/`G` or `Home`/`End` jump · `Enter` compose steering while running · `s` twice stop/abort · `q`/`Esc` close.

**Stats line:** `15⟳ · ↑12k ↓8.0k R85k W3.0k CH89.2% $0.024 47.0%/128k (auto) · 47s`. Tools and turns form one counter group with two spaces between them; Pi footer metrics remain contiguous, with ` · ` separating the counter, Pi, and duration groups. The configured stats-visibility toggles also apply here, including **Cost display**. Foreground and background result cards use the same Pi-compatible usage group; `showCost` also controls their cost field, while the other visibility toggles are scoped to the widget and conversation viewer.

## Configuration

`~/.pi/agent/subagents-lean.json` — managed via `/agents`, or edit directly. Per-agent model overrides are dynamic keys in `agent`; per-agent thinking overrides live in `thinkingOverrides`.

### Execution and prompt settings

| Field | Default | Description |
|---|---:|---|
| `default` | `null` | Global fallback model as `provider/model-id`; `null` inherits the parent. |
| `defaultThinking` | parent | Global fallback thinking level. |
| `defaultMaxTurns` | unlimited | Soft turn limit used when an agent definition does not set `max_turns`. |
| `forceBackground` | `false` | Run every spawn in the background. |
| `graceTurns` | `6` | Additional turns after the soft limit before hard abort. |
| `disableDefaultAgents` | `false` | Exclude bundled types on the next parent turn and during discovery. |
| `systemPromptMode` | `replace` | `replace`, `inherit`, or `custom`; custom content comes from `~/.pi/agent/subagents-lean-prompt.md`. |
| `includeContextFiles` | `true` | Include applicable project and user `AGENTS.md` files in subagent context. |
| `orchestrationPrompt` | `true` | Add bounded parent-only delegation guidance and the visible agent catalog. |
| `loadSkillsImplicitly` | `true` | Load all skills when agent frontmatter omits `skills`. |
| `loadExtensionsImplicitly` | `true` | Load all extensions when agent frontmatter omits `extensions`. |
| `concurrency.default` | `4` | Global running-agent limit; excess spawns queue. |

**Migration from 1.5.x:** Agent selection is now explicit. Calls that omitted `agent` or used `general-purpose` must choose one of `architect`, `scout`, `implementer`, `reviewer`, or `verifier`. The former built-in `Explore` model key is migrated to `scout` unless that key is already configured, including an explicit `null` inheritance value.

```json
{
  "agent": {
    "default": "zai/glm-5.2",
    "defaultThinking": "medium",
    "defaultMaxTurns": 40,
    "forceBackground": true,
    "graceTurns": 6,
    "showCost": true,
    "showTools": false,
    "showTurns": true,
    "showInput": true,
    "showOutput": true,
    "showContext": true,
    "showTime": true,
    "widgetMaxLines": 12,
    "widgetMaxLinesCompact": 6,
    "widgetDescLengthFull": 50,
    "widgetDescLengthCompact": 30,
    "widgetCompact": true,
    "widgetShortcut": false,
    "widgetShowModelThinking": true,
    "widgetShowStartTime": true,
    "outputThinkingBufferSize": 0,
    "finishedRetentionMinutes": 10,
    "systemPromptMode": "inherit",
    "includeContextFiles": true,
    "orchestrationPrompt": true,
    "loadSkillsImplicitly": false,
    "loadExtensionsImplicitly": false,
    "disableDefaultAgents": false,
    "scout": "xiaomi/mimo-v2.5",
    "implementer": "xiaomi/mimo-v2-pro",
    "reviewer": "zai/glm-5.2"
  },
  "thinkingOverrides": {
    "scout": "medium",
    "implementer": "high",
    "reviewer": "high"
  },
  "concurrency": {
    "default": 4
  }
}
```

### Parent orchestration

`orchestrationPrompt` defaults to `true`. It appends a parent-only, cache-stable catalog of visible global/trusted-current-project agents; subagents never inherit it. Visible descriptions should be concise. Only exact representable names of at most 64 UTF-8 bytes are advertised; descriptions are capped at 160 UTF-8 bytes, the catalog at 24 agents/2,263 UTF-8 bytes, and the full generated block at 4,096 UTF-8 bytes; a deterministic `… +N omitted` marker reports overflow. Toggle it in `/agents` → **Settings** → **System prompt, context, skills & extensions**, or set `"orchestrationPrompt": false` under `agent` in config. Opt-out intentionally provides no automatic catalog.

### Widget settings

| Field | Default | Description |
|---|---|---|
| `widgetMaxLines` | `12` | Max total lines in full mode, including the heading. |
| `widgetMaxLinesCompact` | half of `widgetMaxLines` | Max total lines in compact mode, including the heading. |
| `widgetDescLengthFull` | `50` | Max description length in full mode. |
| `widgetDescLengthCompact` | `30` | Max description length in compact mode. |
| `widgetCompact` | `false` | Force compact mode regardless of ctrl+o state. |
| `widgetShortcut` | `false` | When ON, ctrl+o (tool expansion toggle) syncs with widget compact mode. When OFF, compact is manual via `widgetCompact`. |
| `widgetShowModelThinking` | `true` | Show one model-and-thinking column in every agent row. OFF removes the values and frees its space. |
| `widgetShowStartTime` | `true` | Show each row's local `HH:MM` creation/start time. Queued rows show their queue-entry time. |
| `outputThinkingBufferSize` | `0` | Live thinking-log buffer threshold in chars. `0` writes thinking at turn end; positive values flush during streaming near sentence boundaries. |
| `finishedRetentionMinutes` | `10` | Minutes to retain finished agents in the widget. |

The `↓ to navigate` heading hint is always shown while the widget is visible.

### Stats visibility

These toggles apply to the live widget and conversation viewer. Model and thinking metadata are separate from usage stats: `widgetShowModelThinking` controls them in widget rows, while the conversation viewer and result cards show invocation metadata when available.

| Field | Default | Description |
|---|---|---|
| `showTools` | `true` | Tool count (⚙︎). |
| `showTurns` | `true` | Turn count (⟳). |
| `showInput` | `true` | Input tokens (↑). |
| `showOutput` | `true` | Output tokens (↓). |
| `showContext` | `true` | Context-fill percent (%). |
| `showCost` | `false` | Dollar cost ($). |
| `showTime` | `true` | Elapsed time in the widget and conversation viewer. |

Result cards always include elapsed time; among these visibility settings, only `showCost` also applies to result cards.

> **Reload safety:** if a session reload (`/reload`, extension reload) kills running agents, the UI reports the count lost. Output logs and completed results are preserved on disk.

## Output Logs

`<system temporary directory>/pi-agent-outputs/<agentId>.log` — append-only and human-readable. On systems with `tail`, it can be followed with `tail -f`; use an equivalent command elsewhere. Log entries are ISO-8601 timestamped; embedded newlines in a prompt can continue on an unprefixed line:

```
2026-05-27T12:00:00.000Z [USER] Find all authentication files
2026-05-27T12:00:02.000Z [TOOL] read("src/auth/index.ts")
2026-05-27T12:00:02.000Z [TOOL_RESULT] read: 234 chars
2026-05-27T12:00:15.000Z [ASSISTANT] I found the authentication module...
2026-05-27T12:00:45.000Z [DONE] 5 turns, 12 tool uses, 12.3k tokens, $0.024
```

## Requirements

- Node.js >= 18
- Bun >= 1.0
- pi >= 0.82.0

## Development

Use Bun for development and run source typechecking, test typechecking, and the
Vitest suite before submitting changes:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:test
bun run test
```

See [docs/coverage.md](docs/coverage.md) for coverage thresholds, compatibility
checks, package smoke testing, and the required CI checks for `main`. Maintainers
should follow the [release checklist](docs/releasing.md) before creating a tag.

## Origin and license

This fork preserves the project's MIT license and Alexander Paramonov's copyright notice. See [LICENSE](LICENSE). The implementation was originally derived from [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents); thanks to both upstream projects and their contributors.
