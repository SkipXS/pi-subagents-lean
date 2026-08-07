/**
 * Agent discovery facade — catalog merging and per-field precedence.
 *
 * Filesystem scanning and Markdown frontmatter parsing live in dedicated
 * modules. This facade preserves the established discovery exports while
 * keeping merge/catalog behavior in one place.
 */

import type { AgentConfig } from "./types.js";
import type { AgentConfigFromMd } from "./agent-frontmatter.js";
import {
  isAgentModelWithinLimit,
  isAgentNameWithinLimit,
  isUtf8WithinLimit,
  MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES,
  MAX_AGENT_FRONTMATTER_ITEM_BYTES,
  MAX_AGENT_SYSTEM_PROMPT_BYTES,
  retainAgentDescription,
} from "./agent-string-limits.js";

export { parseAgentFile, parseExtensions } from "./agent-frontmatter.js";
export type { AgentConfigFromMd } from "./agent-frontmatter.js";
export { MAX_AGENT_FILES_PER_SOURCE, scanAgentFilesInDir } from "./agent-directory-scan.js";

/* ------------------------------------------------------------------ */
/*  mergeAgents                                                        */
/* ------------------------------------------------------------------ */

/**
 * Merge default agents with user, shared, and project overrides.
 *
 * Per-field merge precedence (highest to lowest):
 *   1. project agents (.pi/agents/)
 *   2. shared agents (.agents/agents/)
 *   3. user agents (~/.pi/agent/agents/)
 *   4. default agents
 *
 * For each field, if a higher-precedence layer sets the field (not undefined),
 * it wins. Otherwise, the lower layer's value is preserved.
 *
 * @param defaults - Map of default agent configs
 * @param userAgents - User-defined agent configs
 * @param sharedAgents - Shared workspace agent configs (.agents/agents/)
 * @param projectAgents - Project-specific agent configs (.pi/agents/)
 * @returns Merged Map<string, AgentConfig> keyed by agent name
 */
export function mergeAgents(
  defaults: Map<string, AgentConfig>,
  userAgents: AgentConfigFromMd[],
  sharedAgents: AgentConfigFromMd[],
  projectAgents: AgentConfigFromMd[],
): Map<string, AgentConfig> {
  const result = new Map<string, AgentConfig>();

  // Start with detached defaults. Discovery results are retained in the
  // registry, so never let a caller mutate the source map through an array
  // field on the merged config.
  for (const [name, config] of defaults) {
    result.set(name, snapshotAgentConfig(config));
  }

  // Apply overrides in precedence order: user, then shared, then project.
  // Names identify roles case-insensitively, while the first layer that creates
  // a role supplies its canonical map key.
  mergeAgentOverrides(result, userAgents);
  mergeAgentOverrides(result, sharedAgents);
  mergeAgentOverrides(result, projectAgents);

  // A missing selection is deliberately closed after all field-wise layers
  // have been merged. This preserves inherited explicit values while making a
  // new/minimal definition deterministic without global implicit settings.
  for (const [name, config] of result) {
    result.set(name, snapshotAgentConfig({
      ...config,
      skills: config.skills ?? false,
      extensions: config.extensions ?? false,
    }));
  }

  return result;
}

/** Apply a list of agent configs onto the result map. */
function mergeAgentOverrides(
  result: Map<string, AgentConfig>,
  agents: AgentConfigFromMd[],
): void {
  for (const md of agents) {
    if (!isAgentNameWithinLimit(md.name) || md.name.length === 0) continue;
    const existingKey = [...result.keys()].find((key) => key.toLowerCase() === md.name!.toLowerCase());
    if (existingKey !== undefined) {
      const existing = result.get(existingKey)!;
      result.set(existingKey, snapshotAgentConfig({ ...existing, ...fromMd(md) }));
    } else {
      result.set(md.name, snapshotAgentConfig({ ...BASE_DEFAULTS, ...fromMd(md) }));
    }
  }
}

/** Keep direct merge callers subject to the same bounded discovery shape. */
function boundedAgentList(value: readonly string[] | undefined): string[] | undefined {
  if (!value || value.length > MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES) return undefined;
  return value.every((entry) =>
    typeof entry === "string"
    && entry.length > 0
    && isUtf8WithinLimit(entry, MAX_AGENT_FRONTMATTER_ITEM_BYTES),
  ) ? [...value] : undefined;
}

function boundedAgentSelection(
  value: boolean | string[] | undefined,
): boolean | string[] | undefined {
  return Array.isArray(value) ? boundedAgentList(value) : value;
}

/**
 * Translate AgentConfigFromMd fields to a Partial<AgentConfig> containing only
 * fields explicitly set in frontmatter or as a prompt body.
 *
 * An absent prompt body remains undefined so it falls through to a lower-
 * precedence prompt when merging into an existing AgentConfig.
 */
function fromMd(md: AgentConfigFromMd): Partial<AgentConfig> {
  const name = isAgentNameWithinLimit(md.name) ? md.name : undefined;
  const model = isAgentModelWithinLimit(md.model) ? md.model : undefined;
  const systemPrompt = isUtf8WithinLimit(md.systemPrompt, MAX_AGENT_SYSTEM_PROMPT_BYTES)
    ? md.systemPrompt
    : undefined;
  const obj: Record<string, unknown> = {
    name,
    description: md.description,
    // A tools list seeds the registry and controls visible schemas. Boolean
    // values only control schema selection; the runner supplies its normal
    // built-in registry base for true/undefined.
    registeredTools: md.tools === undefined || typeof md.tools === "boolean"
      ? undefined
      : boundedAgentList(md.tools),
    tools: boundedAgentSelection(md.tools),
    excludeTools: boundedAgentList(md.exclude_tools),
    extensions: boundedAgentSelection(md.extensions),
    excludeExtensions: boundedAgentList(md.exclude_extensions),
    skills: boundedAgentSelection(md.skills),
    excludeSkills: boundedAgentList(md.exclude_skills),
    model,
    thinkingLevel: md.thinking,
    hidden: md.hidden,
    systemPrompt,
    source: md.source === "user" ? "global" : md.source,
  };
  return compactDefined(obj) as Partial<AgentConfig>;
}

/** Return a detached AgentConfig snapshot for catalog and registry boundaries. */
export function snapshotAgentConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    description: retainAgentDescription(config.description),
    registeredTools: config.registeredTools && [...config.registeredTools],
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    excludeTools: config.excludeTools && [...config.excludeTools],
    extensions: Array.isArray(config.extensions) ? [...config.extensions] : config.extensions,
    excludeExtensions: config.excludeExtensions && [...config.excludeExtensions],
    skills: Array.isArray(config.skills) ? [...config.skills] : config.skills,
    excludeSkills: config.excludeSkills && [...config.excludeSkills],
  };
}

function compactDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) => value !== undefined),
  ) as Partial<T>;
}

/** Defaults used when creating an AgentConfig from a Markdown definition. */
const BASE_DEFAULTS: AgentConfig = {
  name: "unknown",
  description: "",
  // Missing selections resolve to false after the field-wise merge.
  extensions: false,
  skills: false,
  systemPrompt: "",
};

/** Convert a parsed Markdown agent into a complete standalone config. */
export function toAgentConfig(md: AgentConfigFromMd): AgentConfig {
  return snapshotAgentConfig({ ...BASE_DEFAULTS, ...fromMd(md) } as AgentConfig);
}
