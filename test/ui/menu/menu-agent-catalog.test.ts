/** Agent catalog tests. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAllTypes, getAgentConfig } from "../../../src/agents/agent-types.js";
import { showAgentCatalog } from "../../../src/ui/menu/menu-agent-catalog.js";

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

  it("reports when no agent types are available", async () => {
    const ctx = createMockCtx();
    await showAgentCatalog(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No agent types available", "info");
  });

  it("lists effective settings and configured resource policies", async () => {
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
    });
    const ctx = createMockCtx();
    await showAgentCatalog(ctx);
    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Agent catalog:");
    expect(message).toContain("Explore [HIDDEN]");
    expect(message).toContain("Search the codebase");
    expect(message).toContain("Model: anthropic/claude-sonnet-4-20250514 (saved override)");
    expect(message).toContain("Thinking: medium (saved override)");
    expect(message).toContain("Tools: read, bash");
    expect(message).toContain("Skills: git, testing");
    expect(message).toContain("Preloaded skills: testing");
    expect(message).toContain("Extensions: tavily");
    expect(message).toContain("Source: .pi/agents/explore.md");
  });

  it("shows inherited model/thinking and implicit resource defaults", async () => {
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({ description: "Search" });
    const ctx = createMockCtx();
    await showAgentCatalog(ctx);
    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Model: inherit (parent)");
    expect(message).toContain("Thinking: inherit (parent)");
    expect(message).toContain("Tools: all");
    expect(message).toContain("Skills: all");
    expect(message).toContain("Preloaded skills: none");
    expect(message).toContain("Extensions: all");
  });

  it("shows model fallback, registration limits, and preload interaction", async () => {
    mockModules.mockConfig.agent.Worker = "missing/unavailable";
    (getAllTypes as any).mockReturnValue(["Worker"]);
    (getAgentConfig as any).mockReturnValue({
      description: "Worker agent",
      registeredTools: ["read"],
      preloadSkills: ["testing"],
      extensions: false,
    });
    const ctx = createMockCtx();
    ctx.model = { provider: "test", id: "parent-model", reasoning: true };
    ctx.modelRegistry.find = vi.fn(() => undefined);
    await showAgentCatalog(ctx);
    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Model: test/parent-model (parent fallback; requested missing/unavailable from saved override unavailable)");
    expect(message).toContain("Tools: read");
    expect(message).toContain("Skills: none (preloads disable implicit skill metadata)");
    expect(message).toContain("Preloaded skills: testing");
    expect(message).toContain("Extensions: none");
  });

  it("shows disabled and exclusion policies", async () => {
    (getAllTypes as any).mockReturnValue(["Restricted"]);
    (getAgentConfig as any).mockReturnValue({
      description: "Restricted agent",
      excludeTools: ["write", "edit"],
      skills: false,
      preloadSkills: false,
      excludeExtensions: ["dangerous", "legacy"],
    });
    const ctx = createMockCtx();
    await showAgentCatalog(ctx);
    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Tools: all except write, edit");
    expect(message).toContain("Skills: none");
    expect(message).toContain("Preloaded skills: none");
    expect(message).toContain("Extensions: all except dangerous, legacy");
  });
});
