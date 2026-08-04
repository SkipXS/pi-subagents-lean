/** Non-model keys in config.agent — preserved when clearing all overrides. */
export const CONFIG_AGENT_NON_MODEL_KEYS = [
  "default",
  "forceBackground",
  "systemPromptMode",
  "includeContextFiles",
  "defaultThinking",
  "loadSkillsImplicitly",
  "loadExtensionsImplicitly",
  "disableDefaultAgents",
  "orchestrationPrompt",
  "finishedRetentionMinutes",
];

const CONFIG_AGENT_NON_MODEL_KEY_SET = new Set(CONFIG_AGENT_NON_MODEL_KEYS);

/**
 * Normalize the mixed `agent` object: known scalar settings retain their
 * values, while open-ended role/model entries accept only string or null.
 * Invalid dynamic values cannot represent a model override and are dropped.
 */
export function normalizeAgentEntries(agent: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(agent).filter(([key, value]) => (
      CONFIG_AGENT_NON_MODEL_KEY_SET.has(key) || typeof value === "string" || value === null
    )),
  );
}
