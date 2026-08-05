import { describe, expect, it } from "vitest";
import { resolveAgentTunables } from "../../src/models/agent-resolution.ts";

const parentModel = { provider: "parent", id: "parent-model", reasoning: false } as any;
const markdownModel = {
  provider: "markdown",
  id: "markdown-model",
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
} as any;
const settingsModel = {
  provider: "settings",
  id: "settings-model",
  reasoning: false,
} as any;

function registry(): { find: (provider: string, id: string) => any } {
  const models = new Map([
    ["markdown/markdown-model", markdownModel],
    ["settings/settings-model", settingsModel],
  ]);
  return { find: (provider, id) => models.get(`${provider}/${id}`) };
}

const markdownConfig = {
  name: "Reviewer",
  model: "markdown/markdown-model",
  thinkingLevel: "high" as const,
};

describe("resolveAgentTunables", () => {
  it("applies settings above the effective Markdown definition per field", () => {
    const resolved = resolveAgentTunables({
      agentName: "reviewer",
      agentConfig: markdownConfig,
      overrides: { REVIEWER: { model: "settings/settings-model" } },
      modelRegistry: registry(),
      parentModel,
      parentThinking: "low",
    });

    expect(resolved.model).toBe(settingsModel);
    // The model comes from settings, while thinking independently comes from Markdown.
    expect(resolved.thinkingLevel).toBe("off");
  });

  it("uses a thinking override without replacing the Markdown model", () => {
    const resolved = resolveAgentTunables({
      agentName: "REVIEWER",
      agentConfig: markdownConfig,
      overrides: { reviewer: { thinking: "medium" } },
      modelRegistry: registry(),
      parentModel,
      parentThinking: "low",
    });

    expect(resolved.model).toBe(markdownModel);
    expect(resolved.thinkingLevel).toBe("high");
  });

  it("falls from an unavailable settings model through Markdown to the parent", () => {
    const resolved = resolveAgentTunables({
      agentName: "reviewer",
      agentConfig: { name: "reviewer", model: "missing/model", thinkingLevel: undefined },
      overrides: { reviewer: { model: "also-missing/model" } },
      modelRegistry: registry(),
      parentModel,
      parentThinking: "low",
    });

    expect(resolved.model).toBe(parentModel);
    expect(resolved.thinkingLevel).toBe("off");
  });

  it("preserves an already-normalized internal base when settings do not override it", () => {
    const resolved = resolveAgentTunables({
      agentName: "reviewer",
      agentConfig: markdownConfig,
      overrides: {},
      modelRegistry: registry(),
      parentModel,
      parentThinking: "low",
      baseModel: settingsModel,
      baseThinking: "minimal",
    });

    expect(resolved.model).toBe(settingsModel);
    expect(resolved.thinkingLevel).toBe("minimal");
  });
});
