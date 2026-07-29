/** Agent catalog: inspect discovered agent definitions. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import type { AgentConfig } from "../../agents/types.js";
import type { SettingSource } from "../../models/model-precedence.js";
import { normalizeThinkingLevel } from "../../models/thinking.js";
import { getStore } from "../../shell.js";
import { findModelInRegistry } from "../../utils.js";

const SOURCE_LABELS: Record<SettingSource, string> = {
  spawn: "spawn",
  "session-agent": "session override",
  "config-agent": "saved override",
  "agent-md": "agent MD",
  "session-global": "session global",
  "config-global": "global default",
  parent: "parent",
};

function formatPolicy(value: true | string[] | false, excluded?: string[]): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none";
  if (value === false) return "none";
  return excluded?.length ? `all except ${excluded.join(", ")}` : "all";
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

export async function showAgentCatalog(ctx: ExtensionCommandContext): Promise<void> {
  const types = getAllTypes();
  if (types.length === 0) {
    ctx.ui.notify("No agent types available", "info");
    return;
  }

  const store = getStore();
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const registry = ctx.modelRegistry as typeof ctx.modelRegistry & { find?: unknown };
  const lines: string[] = ["Agent catalog:\n"];
  for (const name of types) {
    const cfg = getAgentConfig(name);
    if (!cfg) continue;

    const model = store.modelSettingFor(name, parentModelId, cfg);
    const thinking = store.thinkingSettingFor(name, ctx.thinkingLevel, cfg);
    const hasRegistry = typeof registry.find === "function";
    const effectiveModel = hasRegistry
      ? findModelInRegistry(model.value, registry as Parameters<typeof findModelInRegistry>[1], ctx.model)
      : ctx.model;
    const effectiveModelId = effectiveModel ? `${effectiveModel.provider}/${effectiveModel.id}` : undefined;
    const modelUnavailable = hasRegistry && !!model.value && !!effectiveModelId && effectiveModelId !== model.value;
    const modelDisplay = modelUnavailable
      ? `${effectiveModelId} (parent fallback; requested ${model.value} from ${SOURCE_LABELS[model.source]} unavailable)`
      : `${model.value || effectiveModelId || "inherit"} (${SOURCE_LABELS[model.source]})`;
    const effectiveThinking = normalizeThinkingLevel(effectiveModel, thinking.value);
    const thinkingNote = thinking.value !== undefined && effectiveThinking !== thinking.value
      ? `; requested ${thinking.value} unsupported by model`
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

    lines.push(`  ${name}${hidden}`);
    lines.push(`    ${cfg.description}`);
    lines.push(`  Model: ${modelDisplay}`);
    lines.push(`  Thinking: ${effectiveThinking ?? "inherit"} (${SOURCE_LABELS[thinking.source]}${thinkingNote})`);
    lines.push(`  Tools: ${formatTools(cfg, extensions)}`);
    lines.push(`  Skills: ${formatPolicy(skills)}${skillsNote}`);
    lines.push(`  Preloaded skills: ${formatPolicy(cfg.preloadSkills ?? false)}`);
    lines.push(`  Extensions: ${formatPolicy(extensions, Array.isArray(cfg.extensions) ? undefined : cfg.excludeExtensions)}`);
    if (cfg.source) lines.push(`  Source: ${cfg.source}`);
    lines.push("");
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
