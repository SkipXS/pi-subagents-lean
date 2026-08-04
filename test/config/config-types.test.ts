import { describe, expect, it } from "vitest";
import { CONFIG_AGENT_KEYS, normalizeAgentEntries } from "../../src/config/types.ts";

describe("agent config entry normalization", () => {
  it("accepts only the current boolean agent settings", () => {
    const input = {
      includeContextFiles: false,
      disableDefaultAgents: true,
      orchestrationPrompt: false,
      default: "provider/default",
      reviewer: "provider/model",
      ignoredString: "provider/model",
      ignoredObject: { reviewer: "high" },
      ignoredBoolean: false,
      unknown: true,
    };

    expect(normalizeAgentEntries(input)).toEqual({
      includeContextFiles: false,
      disableDefaultAgents: true,
      orchestrationPrompt: false,
    });
    expect(CONFIG_AGENT_KEYS).toEqual([
      "includeContextFiles",
      "disableDefaultAgents",
      "orchestrationPrompt",
    ]);
  });
});
