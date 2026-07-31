/** Agent catalog: inspect discovered agent definitions and orchestration guidance. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import { getEffectiveMaxChildAgents, type AgentConfig } from "../../agents/types.js";
import type { SettingSource } from "../../models/model-precedence.js";
import { requireAvailableModel } from "../../models/model-availability.js";
import { normalizeThinkingLevel } from "../../models/thinking.js";
import { buildOrchestrationPrompt } from "../../prompt/orchestration.js";
import { getStore } from "../../shell.js";
import { findModelInRegistry } from "../../utils.js";
import { buildSelectListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

const SOURCE_LABELS: Record<SettingSource, string> = {
  spawn: "spawn",
  "session-agent": "session override",
  "config-agent": "saved override",
  "agent-md": "agent MD",
  "session-global": "session global",
  "config-global": "global default",
  parent: "parent",
};

/** Keep untrusted frontmatter values from emitting terminal controls in menu chrome. */
function sanitizeDisplayText(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPolicy(value: true | string[] | false, excluded?: string[]): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none";
  if (value === false) return "none";
  return excluded?.length ? `all except ${excluded.join(", ")}` : "all";
}

function formatDelegationPolicy(cfg: AgentConfig, maxNestingDepth: number): string {
  const allowedRoles = cfg.delegateTo?.map(sanitizeDisplayText).filter(Boolean) ?? [];
  if (allowedRoles.length === 0) return "Delegation: none";

  return [
    `Delegation: ${allowedRoles.join(", ")}`,
    `  Children: ${getEffectiveMaxChildAgents(cfg)} total · 1 at a time`,
    `  Depth: ${maxNestingDepth}`,
  ].join("\n");
}

function formatTools(
  cfg: AgentConfig,
  extensions: true | string[] | false,
): string {
  if (Array.isArray(cfg.tools) || cfg.tools === false) return formatPolicy(cfg.tools);

  const excluded = cfg.excludeTools?.length ? ` except ${cfg.excludeTools.join(", ")}` : "";
  if (cfg.registeredTools?.length) {
    const extensionTools = extensions === true || (Array.isArray(extensions) && extensions.length > 0)
      ? " + loaded extension tools"
      : "";
    return `${cfg.registeredTools.join(", ")}${extensionTools}${excluded}`;
  }
  return `all${excluded}`;
}

/** Render the same effective settings previously shown by the catalog notification. */
async function formatAgentConfiguration(
  ctx: ExtensionCommandContext,
  name: string,
  cfg: AgentConfig,
): Promise<string> {
  const store = getStore();
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const registry = ctx.modelRegistry as typeof ctx.modelRegistry & { find?: unknown };
  const model = typeof store.modelSettingForMode === "function"
    ? store.modelSettingForMode(name, parentModelId, cfg)
    : { ...store.modelSettingFor(name, parentModelId, cfg), ecoConfigured: false };
  const thinking = typeof store.thinkingSettingForMode === "function"
    ? store.thinkingSettingForMode(name, ctx.thinkingLevel, cfg)
    : { ...store.thinkingSettingFor(name, ctx.thinkingLevel, cfg), ecoConfigured: false };
  const hasRegistry = typeof registry.find === "function";
  let effectiveModel = hasRegistry
    ? findModelInRegistry(model.value, registry as Parameters<typeof findModelInRegistry>[1], ctx.model)
    : ctx.model;
  let ecoBlocker: string | undefined;
  if (store.mode === "eco" && model.ecoConfigured && hasRegistry) {
    try {
      effectiveModel = await requireAvailableModel(model.value, ctx.modelRegistry, "Eco model");
    } catch (error) {
      effectiveModel = undefined;
      ecoBlocker = error instanceof Error ? error.message : String(error);
    }
  }
  const effectiveModelId = effectiveModel ? `${effectiveModel.provider}/${effectiveModel.id}` : undefined;
  const modelUnavailable = !model.ecoConfigured && hasRegistry && !!model.value && !!effectiveModelId && effectiveModelId !== model.value;
  const modelDisplay = ecoBlocker
    ? `${model.value} (${SOURCE_LABELS[model.source]}; BLOCKED — ${ecoBlocker})`
    : modelUnavailable
      ? `${effectiveModelId} (parent fallback; requested ${model.value} from ${SOURCE_LABELS[model.source]} unavailable)`
      : `${model.value || effectiveModelId || "inherit"} (${SOURCE_LABELS[model.source]})`;
  const effectiveThinking = ecoBlocker ? undefined : normalizeThinkingLevel(effectiveModel, thinking.value);
  const thinkingNote = thinking.value !== undefined && effectiveThinking !== thinking.value
    ? `; requested ${thinking.value}${ecoBlocker ? " cannot run while the Eco model is blocked" : " unsupported by model"}`
    : "";
  const hasPreloads = Array.isArray(cfg.preloadSkills);
  const skills = hasPreloads && !Array.isArray(cfg.skills)
    ? false
    : cfg.skills ?? store.agent.loadSkillsImplicitly;
  const skillsNote = hasPreloads && !Array.isArray(cfg.skills)
    ? " (preloads disable implicit skill metadata)"
    : "";
  const extensions = cfg.extensions ?? store.agent.loadExtensionsImplicitly;
  const hidden = cfg.hidden === true ? " [HIDDEN]" : "";
  const displayName = sanitizeDisplayText(name) || "(unnamed agent)";
  const lines: string[] = [
    `Agent configuration: ${displayName}${hidden}`,
    `Mode: ${store.mode === "eco" ? "🍃 Eco" : "Default"} (${store.modeSource})`,
    "",
    sanitizeDisplayText(cfg.description),
  ];

  lines.push(`Model: ${modelDisplay}`);
  lines.push(`Thinking: ${effectiveThinking ?? (ecoBlocker ? "unavailable" : "inherit")} (${SOURCE_LABELS[thinking.source]}${thinkingNote})`);
  if (ecoBlocker) lines.push(`Spawn availability: blocked — ${ecoBlocker}`);
  lines.push(`Tools: ${formatTools(cfg, extensions)}`);
  lines.push(`Skills: ${formatPolicy(skills)}${skillsNote}`);
  lines.push(`Preloaded skills: ${formatPolicy(cfg.preloadSkills ?? false)}`);
  lines.push(`Extensions: ${formatPolicy(extensions, Array.isArray(cfg.extensions) ? undefined : cfg.excludeExtensions)}`);
  lines.push(formatDelegationPolicy(cfg, store.agent.maxNestingDepth));
  if (cfg.source) lines.push(`Source: ${cfg.source}`);
  return lines.join("\n");
}

function buildOrchestrationGuidance(): string | undefined {
  return buildOrchestrationPrompt(
    getAllTypes().flatMap((name) => {
      const cfg = getAgentConfig(name);
      return cfg ? [{ name, description: cfg.description, hidden: cfg.hidden }] : [];
    }),
  );
}

async function selectItem(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
    const list = new SelectList(items, 12, buildSelectListTheme(theme));
    list.onSelect = (item) => done(item.value);
    return new SettingsListWrapper(list, { title, theme, onCancel: () => done(undefined) });
  });
}

function showOrchestrationGuidance(ctx: ExtensionCommandContext): void {
  // Rebuild at selection time so the displayed guidance reflects the live registry.
  const guidance = buildOrchestrationGuidance();
  ctx.ui.notify(
    `${getStore().agent.orchestrationPrompt ? "Orchestration is enabled and this guidance is injected into parent turns." : "Orchestration is disabled; this generated guidance is not injected into parent turns."}\n\n${guidance ?? "No generated orchestration guidance is available because no visible agents can be advertised."}`,
    "info",
  );
}

async function showAgentDetails(
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  const cfg = getAgentConfig(name);
  const displayName = sanitizeDisplayText(name) || "(unnamed agent)";
  if (!cfg) {
    ctx.ui.notify(`Agent configuration for ${displayName} is no longer available`, "info");
    return;
  }

  ctx.ui.notify(
    `${await formatAgentConfiguration(ctx, name, cfg)}\n\nAgent instructions: ${displayName}\n\n${cfg.systemPrompt || "(No agent instructions configured.)"}`,
    "info",
  );
}

/** Show an interactive catalog, returning to it after each selection. */
export async function showAgentCatalog(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const types = getAllTypes();
    const items: SelectItem[] = [
      {
        value: "__orchestration__",
        label: "Orchestration",
        description: getStore().agent.orchestrationPrompt
          ? "Enabled — dynamic parent-agent guidance."
          : "Disabled — dynamic parent-agent guidance is not injected.",
      },
      ...types.map((name) => {
        const cfg = getAgentConfig(name);
        const displayName = sanitizeDisplayText(name) || "(unnamed agent)";
        return {
          value: `agent:${name}`,
          label: `${displayName}${cfg?.hidden === true ? " [HIDDEN]" : ""}`,
          description: cfg ? sanitizeDisplayText(cfg.description) : "Configuration unavailable",
        };
      }),
    ];
    const choice = await selectItem(ctx, "Agent Catalog", items);
    if (choice === undefined) return;

    if (choice === "__orchestration__") {
      showOrchestrationGuidance(ctx);
    } else if (choice.startsWith("agent:")) {
      await showAgentDetails(ctx, choice.slice("agent:".length));
    }
  }
}
