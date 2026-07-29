/** Agent catalog tests. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAllTypes, getAgentConfig } from "../../../src/agents/agent-types.js";
import { showAgentCatalog } from "../../../src/ui/menu/menu-agent-catalog.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function selectCatalogItems(ctx: any, choices: Array<string | undefined>): any[] {
  const components: any[] = [];
  ctx.ui.custom = vi.fn(async (factory: any) => {
    components.push(factory({ terminal: { rows: 40 } }, theme, null, () => {}));
    return choices.shift();
  });
  return components;
}

describe("showAgentCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockConfig.thinkingOverrides = {};
    mockModules.mockSessionOverrides = { default: null };
    mockModules.mockSessionThinkingOverrides = {};
    (getAllTypes as any).mockReturnValue([]);
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows one SelectList catalog with Orchestration before every agent", async () => {
    (getAllTypes as any).mockReturnValue(["Explore", "Hidden"]);
    (getAgentConfig as any).mockImplementation((name: string) => ({
      description: `${name} description`,
      hidden: name === "Hidden",
      systemPrompt: "Instructions",
    }));
    const ctx = createMockCtx();
    const components = selectCatalogItems(ctx, [undefined]);

    await showAgentCatalog(ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(components[0].settingsList.items).toEqual([
      expect.objectContaining({ value: "__orchestration__", label: "Orchestration" }),
      expect.objectContaining({ value: "agent:Explore", label: "Explore", description: "Explore description" }),
      expect.objectContaining({ value: "agent:Hidden", label: "Hidden [HIDDEN]", description: "Hidden description" }),
    ]);
  });

  it("sanitizes agent names and descriptions in menu chrome while retaining the raw lookup key", async () => {
    const rawName = "Unsafe\n\u001b[31mAgent";
    (getAllTypes as any).mockReturnValue([rawName]);
    (getAgentConfig as any).mockReturnValue({
      description: "Line one\n\u001b[2JLine two",
      systemPrompt: "Instructions",
    });
    const ctx = createMockCtx();
    const components = selectCatalogItems(ctx, [undefined]);

    await showAgentCatalog(ctx);

    expect(components[0].settingsList.items[1]).toEqual(expect.objectContaining({
      value: `agent:${rawName}`,
      label: "Unsafe Agent",
      description: "Line one Line two",
    }));
  });

  it("opens the orchestration submenu and views enabled guidance built from the registry", async () => {
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({ description: "Search the codebase", systemPrompt: "Explore carefully" });
    const ctx = createMockCtx();
    const components = selectCatalogItems(ctx, ["__orchestration__", "view-guidance", undefined]);

    await showAgentCatalog(ctx);

    expect(components[1].settingsList.items).toEqual([
      expect.objectContaining({ value: "view-guidance", label: "View generated guidance" }),
    ]);
    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Orchestration is enabled and this guidance is injected into parent turns.");
    expect(message).toContain("`Explore` — Search the codebase");
  });

  it("clearly labels disabled generated guidance as not injected", async () => {
    mockModules.mockConfig.agent.orchestrationPrompt = false;
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({ description: "Search", systemPrompt: "Instructions" });
    const ctx = createMockCtx();
    const components = selectCatalogItems(ctx, ["__orchestration__", "view-guidance", undefined]);

    await showAgentCatalog(ctx);

    expect(components[0].settingsList.items[0].description).toContain("Disabled");
    expect(components[1].settingsList.items[0].description).toContain("not injected");
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("Orchestration is disabled; this generated guidance is not injected into parent turns.");
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("`Explore` — Search");
  });

  it("shows effective configuration details from the agent submenu", async () => {
    mockModules.mockConfig.agent.Explore = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockConfig.thinkingOverrides.Explore = "medium";
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({
      description: "Search the codebase",
      hidden: true,
      model: "openai/gpt-4o",
      thinkingLevel: "high",
      tools: ["read", "bash"],
      skills: ["git", "testing"],
      preloadSkills: ["testing"],
      extensions: ["tavily"],
      source: ".pi/agents/explore.md",
      systemPrompt: "Follow exploration instructions.",
    });
    const ctx = createMockCtx();
    const components = selectCatalogItems(ctx, ["agent:Explore", "view-configuration", undefined]);

    await showAgentCatalog(ctx);

    expect(components[1].settingsList.items.map((item: any) => item.value)).toEqual([
      "view-configuration", "view-instructions",
    ]);
    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Agent configuration: Explore [HIDDEN]");
    expect(message).toContain("Search the codebase");
    expect(message).toContain("Model: anthropic/claude-sonnet-4-20250514 (saved override)");
    expect(message).toContain("Thinking: medium (saved override)");
    expect(message).toContain("Tools: read, bash");
    expect(message).toContain("Skills: git, testing");
    expect(message).toContain("Preloaded skills: testing");
    expect(message).toContain("Extensions: tavily");
    expect(message).toContain("Source: .pi/agents/explore.md");
  });

  it("preserves inherited model/thinking and implicit resource defaults", async () => {
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({ description: "Search", systemPrompt: "Instructions" });
    const ctx = createMockCtx();
    selectCatalogItems(ctx, ["agent:Explore", "view-configuration", undefined]);

    await showAgentCatalog(ctx);

    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Model: inherit (parent)");
    expect(message).toContain("Thinking: inherit (parent)");
    expect(message).toContain("Tools: all");
    expect(message).toContain("Skills: all");
    expect(message).toContain("Preloaded skills: none");
    expect(message).toContain("Extensions: all");
  });

  it("shows cfg.systemPrompt as agent instructions rather than a runtime prompt", async () => {
    (getAllTypes as any).mockReturnValue(["Worker"]);
    (getAgentConfig as any).mockReturnValue({
      description: "Worker agent",
      systemPrompt: "Only perform bounded implementation work.",
    });
    const ctx = createMockCtx();
    selectCatalogItems(ctx, ["agent:Worker", "view-instructions", undefined]);

    await showAgentCatalog(ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Agent instructions: Worker\n\nOnly perform bounded implementation work.",
      "info",
    );
  });

  it("preserves model fallback, registration limits, and preload interaction", async () => {
    mockModules.mockConfig.agent.Worker = "missing/unavailable";
    (getAllTypes as any).mockReturnValue(["Worker"]);
    (getAgentConfig as any).mockReturnValue({
      description: "Worker agent",
      registeredTools: ["read"],
      preloadSkills: ["testing"],
      extensions: false,
      systemPrompt: "Instructions",
    });
    const ctx = createMockCtx();
    ctx.model = { provider: "test", id: "parent-model", reasoning: true };
    ctx.modelRegistry.find = vi.fn(() => undefined);
    selectCatalogItems(ctx, ["agent:Worker", "view-configuration", undefined]);

    await showAgentCatalog(ctx);

    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Model: test/parent-model (parent fallback; requested missing/unavailable from saved override unavailable)");
    expect(message).toContain("Tools: read");
    expect(message).toContain("Skills: none (preloads disable implicit skill metadata)");
    expect(message).toContain("Preloaded skills: testing");
    expect(message).toContain("Extensions: none");
  });

  it("preserves disabled and exclusion policies in configuration", async () => {
    (getAllTypes as any).mockReturnValue(["Restricted"]);
    (getAgentConfig as any).mockReturnValue({
      description: "Restricted agent",
      excludeTools: ["write", "edit"],
      skills: false,
      preloadSkills: false,
      excludeExtensions: ["dangerous", "legacy"],
      systemPrompt: "Instructions",
    });
    const ctx = createMockCtx();
    selectCatalogItems(ctx, ["agent:Restricted", "view-configuration", undefined]);

    await showAgentCatalog(ctx);

    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Tools: all except write, edit");
    expect(message).toContain("Skills: none");
    expect(message).toContain("Preloaded skills: none");
    expect(message).toContain("Extensions: all except dangerous, legacy");
  });
});
