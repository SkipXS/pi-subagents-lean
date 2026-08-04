/** Persisted configuration accepted by the extension. */
export interface SubagentsConfig {
  agent: {
    includeContextFiles?: boolean;
    disableDefaultAgents?: boolean;
    orchestrationPrompt?: boolean;
  };
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
