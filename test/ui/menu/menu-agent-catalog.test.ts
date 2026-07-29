/** Agent catalog tests. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAllTypes, getAgentConfig } from "../../../src/agents/agent-types.js";
import { showAgentCatalog } from "../../../src/ui/menu/menu-agent-catalog.js";

describe("showAgentCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAllTypes as any).mockReturnValue([]);
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("reports when no agent types are available", async () => {
    const ctx = createMockCtx();
    await showAgentCatalog(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No agent types available", "info");
  });

  it("lists configured agent metadata", async () => {
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({
      description: "Search the codebase",
      hidden: true,
      model: "openai/gpt-4o",
      registeredTools: ["read", "bash"],
      source: ".pi/agents/explore.md",
    });
    const ctx = createMockCtx();
    await showAgentCatalog(ctx);
    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Agent catalog:");
    expect(message).toContain("Explore [HIDDEN]");
    expect(message).toContain("Search the codebase");
    expect(message).toContain("Model: openai/gpt-4o");
    expect(message).toContain("Tools: read, bash");
    expect(message).toContain("Source: .pi/agents/explore.md");
  });

  it("shows the built-in-tools fallback", async () => {
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({ description: "Search" });
    const ctx = createMockCtx();
    await showAgentCatalog(ctx);
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("Tools: all built-in tools");
  });
});
