import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AGENTS, DEFAULT_AGENT_NAMES } from "../../src/agents/default-agents.ts";
import { parseAgentFile, toAgentConfig } from "../../src/agents/agent-discovery.ts";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "../../src/config/types.ts";

const expectedNonModelKeys = [
  "default", "forceBackground", "graceTurns", "showCost", "showTools", "showTurns",
  "showInput", "showOutput", "showContext", "showTime", "widgetMaxLines",
  "widgetMaxLinesCompact", "widgetDescLengthFull", "widgetDescLengthCompact",
  "widgetCompact", "widgetShortcut", "widgetShowModelThinking", "widgetShowStartTime",
  "systemPromptMode", "includeContextFiles", "defaultThinking", "defaultMaxTurns",
  "loadSkillsImplicitly", "loadExtensionsImplicitly", "disableDefaultAgents",
  "orchestrationPrompt", "outputThinkingBufferSize", "finishedRetentionMinutes", "maxNestingDepth",
];

describe("bundled agent and config contracts", () => {
  it("keeps the non-model allowlist complete, unique, and free of agent role names", () => {
    expect(CONFIG_AGENT_NON_MODEL_KEYS).toEqual(expectedNonModelKeys);
    expect(new Set(CONFIG_AGENT_NON_MODEL_KEYS).size).toBe(CONFIG_AGENT_NON_MODEL_KEYS.length);
    for (const name of DEFAULT_AGENT_NAMES) expect(CONFIG_AGENT_NON_MODEL_KEYS).not.toContain(name);
    expect(CONFIG_AGENT_NON_MODEL_KEYS).not.toContain("defaultAgent");
  });

  it("parses every bundled Markdown file to its canonical unique name and a usable prompt", () => {
    expect([...DEFAULT_AGENTS.keys()]).toEqual([...DEFAULT_AGENT_NAMES]);
    expect(new Set(DEFAULT_AGENT_NAMES).size).toBe(DEFAULT_AGENT_NAMES.length);

    for (const name of DEFAULT_AGENT_NAMES) {
      const markdown = readFileSync(join("src", "agents", "defaults", `${name}.md`), "utf8");
      const config = toAgentConfig(parseAgentFile(markdown, "default"));
      expect(config.name).toBe(name);
      expect(config.description.trim().length).toBeGreaterThan(10);
      expect(config.systemPrompt.trim().length).toBeGreaterThan(40);
      expect(config.source).toBe("default");
      expect(DEFAULT_AGENTS.get(name)).toMatchObject({
        name,
        description: config.description,
        systemPrompt: config.systemPrompt,
        isDefault: true,
      });
    }
  });
});
