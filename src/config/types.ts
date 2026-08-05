/** Persisted configuration accepted by the extension. */
import type { ThinkingLevel } from "../types.js";
import { parseThinkingLevel } from "../utils.js";

export interface AgentSettingsOverride {
  /** Registry key in `provider/model-id` form. */
  model?: string;
  /** Requested reasoning level; the selected model may normalize it further. */
  thinking?: ThinkingLevel;
}

export type AgentSettingsOverrides = Record<string, AgentSettingsOverride>;

export interface SubagentsConfig {
  agent: {
    includeContextFiles?: boolean;
    disableDefaultAgents?: boolean;
    orchestrationPrompt?: boolean;
  };
  /** Persisted per-agent model/thinking overrides, keyed case-insensitively. */
  agents?: AgentSettingsOverrides;
  concurrency: {
    /** Global maximum number of agents that may run at once. */
    default: number;
  };
}

/** Agent settings that are valid in subagents-lean.json. */
export const CONFIG_AGENT_KEYS = [
  "includeContextFiles",
  "disableDefaultAgents",
  "orchestrationPrompt",
] as const;

const CONFIG_AGENT_KEY_SET = new Set<string>(CONFIG_AGENT_KEYS);

/**
 * Retain only current, typed agent settings at the persistence boundary.
 * Role/model-shaped keys are intentionally not accepted as configuration.
 */
export function normalizeAgentEntries(agent: Record<string, unknown>): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(agent).filter(([key, value]) =>
      CONFIG_AGENT_KEY_SET.has(key) && typeof value === "boolean",
    ),
  ) as Record<string, boolean>;
}

/**
 * Normalize persisted per-agent overrides.
 *
 * Agent names are lowercased just like discovery matching. JSON object order is
 * deterministic, so when case variants occur the last entry wins. Invalid or
 * unknown fields are dropped independently; an entry with no valid fields is
 * omitted rather than reaching runtime resolution.
 */
export function normalizeAgentSettingsOverrides(raw: unknown): AgentSettingsOverrides {
  if (!isRecord(raw)) return {};

  const normalized: AgentSettingsOverrides = {};
  for (const [rawName, rawOverride] of Object.entries(raw)) {
    const name = rawName.toLowerCase();
    if (name.length === 0) continue;
    if (!isRecord(rawOverride)) {
      // An invalid later duplicate is still the last complete entry.
      if (Object.hasOwn(normalized, name)) delete normalized[name];
      continue;
    }

    const override: AgentSettingsOverride = {};
    if (typeof rawOverride.model === "string" && rawOverride.model.length > 0) {
      override.model = rawOverride.model;
    }
    const thinking = parseThinkingLevel(rawOverride.thinking);
    if (thinking !== undefined) override.thinking = thinking;

    // A later case-insensitive duplicate replaces the complete prior entry.
    // This makes `{ "Scout": {...}, "scout": {...} }` deterministic without
    // inventing field-wise merge semantics for duplicate JSON names.
    if (Object.keys(override).length > 0) {
      Object.defineProperty(normalized, name, {
        configurable: true,
        enumerable: true,
        value: override,
        writable: true,
      });
    } else if (Object.hasOwn(normalized, name)) delete normalized[name];
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
