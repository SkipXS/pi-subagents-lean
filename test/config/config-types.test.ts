import { describe, expect, it } from "vitest";
import {
  CONFIG_AGENT_KEYS,
  normalizeAgentEntries,
  normalizeAgentSettingsOverrides,
} from "../../src/config/types.ts";

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

describe("per-agent model/thinking override normalization", () => {
  it("normalizes names case-insensitively and lets the last case variant win", () => {
    expect(normalizeAgentSettingsOverrides({
      Scout: { model: "provider/first", thinking: "high", ignored: true },
      scout: { thinking: "low", ignored: "still ignored" },
      Reviewer: { model: "provider/reviewer", thinking: "invalid", extra: "ignored" },
      invalid: { model: 42, thinking: "ultra" },
      notAnObject: "provider/model",
    })).toEqual({
      scout: { thinking: "low" },
      reviewer: { model: "provider/reviewer" },
    });
  });
});
