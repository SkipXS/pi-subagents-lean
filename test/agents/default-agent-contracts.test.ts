import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AGENTS, DEFAULT_AGENT_NAMES } from "../../src/agents/default-agents.ts";
import { parseAgentFile, toAgentConfig } from "../../src/agents/agent-discovery.js";
import { CONFIG_AGENT_KEYS } from "../../src/config/types.ts";

const expectedAgentKeys = ["disableDefaultAgents"];

describe("bundled agent and config contracts", () => {
  it("keeps the persisted agent allowlist current", () => {
    expect(CONFIG_AGENT_KEYS).toEqual(expectedAgentKeys);
    expect(CONFIG_AGENT_KEYS).not.toContain("default");
  });

  it("keeps the implementer bounded, non-delegating, and handoff-ready", () => {
    const prompt = DEFAULT_AGENTS.get("implementer")!.systemPrompt;
    expect(prompt).toContain("sole writer for this delegated stage");
    expect(prompt).toContain(
      "Report unrelated, environmental, or pre-existing failures without expanding scope.",
    );
    expect(prompt).toContain("Return a concise completion report");
    expect(prompt).toContain("Do not claim checks you did not run");
    expect(prompt).toContain("focused tests");
    expect(prompt).not.toContain("nested");
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
