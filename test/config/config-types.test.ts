import { describe, expect, it } from "vitest";
import { normalizeAgentEntries } from "../../src/config/types.ts";

describe("agent config entry normalization", () => {
  it("preserves scalar settings and string/null role models only", () => {
    const input = {
      default: "provider/default",
      forceBackground: true,
      systemPromptMode: "inherit",
      includeContextFiles: false,
      defaultThinking: "high",
      loadSkillsImplicitly: false,
      loadExtensionsImplicitly: false,
      disableDefaultAgents: true,
      orchestrationPrompt: false,
      finishedRetentionMinutes: 15,
      roleModel: "provider/model",
      roleWithoutModel: null,
      numericMetadata: 42,
      booleanMetadata: true,
      arrayMetadata: ["not", "a", "model"],
      objectMetadata: { not: "a model" },
    };

    expect(normalizeAgentEntries(input)).toEqual({
      default: "provider/default",
      forceBackground: true,
      systemPromptMode: "inherit",
      includeContextFiles: false,
      defaultThinking: "high",
      loadSkillsImplicitly: false,
      loadExtensionsImplicitly: false,
      disableDefaultAgents: true,
      orchestrationPrompt: false,
      finishedRetentionMinutes: 15,
      roleModel: "provider/model",
      roleWithoutModel: null,
    });
    expect(input).toHaveProperty("numericMetadata", 42);
    expect(input).toHaveProperty("booleanMetadata", true);
  });
});
