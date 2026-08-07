/** Persisted configuration accepted by the extension. */
import type { ThinkingLevel } from "../types.js";
import { parseThinkingLevel } from "../utils.js";
import { MAX_AGENT_MODEL_BYTES, MAX_AGENT_NAME_BYTES, utf8ByteLength } from "../agents/agent-string-limits.js";

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
    /** Global maximum number of agents that may run at once (1..64). */
    default: number;
  };
}

/** The durable/runtime fallback for an invalid concurrency setting. */
export const DEFAULT_CONCURRENCY_DEFAULT = 4;
/** The inclusive runtime/persistence range for a configured concurrency limit. */
export const MAX_CONCURRENCY_DEFAULT = 64;
/** Maximum bytes read before parsing subagents-lean.json as JSON. */
export const MAX_SUBAGENTS_CONFIG_BYTES = 1024 * 1024;
/** Maximum raw entries retained from the persisted per-agent override map. */
export const MAX_AGENT_SETTINGS_OVERRIDE_ENTRIES = 256;
/** Descriptive aliases for consumers and boundary tests. */
export const SUBAGENTS_CONFIG_MAX_BYTES = MAX_SUBAGENTS_CONFIG_BYTES;
export const MAX_AGENT_OVERRIDE_ENTRIES = MAX_AGENT_SETTINGS_OVERRIDE_ENTRIES;

/**
 * Accept only the scalar shape that the scheduler can safely count.
 * Runtime callers may still provide untyped values at persistence or host
 * integration boundaries, so this check intentionally does not rely on the
 * TypeScript `number` annotation.
 */
export function normalizeConcurrencyDefault(raw: unknown): number {
  return typeof raw === "number"
    && Number.isFinite(raw)
    && Number.isInteger(raw)
    && raw >= 1
    && raw <= MAX_CONCURRENCY_DEFAULT
    ? raw
    : DEFAULT_CONCURRENCY_DEFAULT;
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
 * Agent names are lowercased just like discovery matching. The first 256 raw
 * object entries are considered in deterministic JSON/insertion order; later
 * entries are rejected before they can enlarge the runtime snapshot. Invalid
 * or unknown fields are dropped independently, and strings are checked by
 * UTF-8 bytes rather than JavaScript code units.
 */
export function normalizeAgentSettingsOverrides(raw: unknown): AgentSettingsOverrides {
  if (!isRecord(raw)) return {};

  const normalized: AgentSettingsOverrides = {};
  let rawEntryCount = 0;
  for (const rawName in raw) {
    if (!Object.hasOwn(raw, rawName)) continue;
    if (rawEntryCount++ >= MAX_AGENT_SETTINGS_OVERRIDE_ENTRIES) break;
    if (utf8ByteLength(rawName) > MAX_AGENT_NAME_BYTES) continue;
    const name = rawName.toLowerCase();
    if (name.length === 0 || utf8ByteLength(name) > MAX_AGENT_NAME_BYTES) continue;
    const rawOverride = raw[rawName];
    if (!isRecord(rawOverride)) {
      // An invalid later duplicate is still the last complete entry within the
      // bounded input prefix.
      if (Object.hasOwn(normalized, name)) delete normalized[name];
      continue;
    }

    const override: AgentSettingsOverride = {};
    if (
      typeof rawOverride.model === "string"
      && rawOverride.model.length > 0
      && utf8ByteLength(rawOverride.model) <= MAX_AGENT_MODEL_BYTES
    ) {
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
