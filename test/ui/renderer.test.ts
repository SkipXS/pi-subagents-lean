/**
 * worktree-renderer.test.ts — Tests for worktree path display in the details pane.
 *
 * Verifies:
 *   - renderSubagentResult includes worktree: path in the result card
 *   - buildFallbackResultLine (via renderSubagentResult without turnCount) includes worktree: path
 *
 * Note: renderer.ts no longer imports shell.ts — showCost is passed as a parameter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock setup — capture Text content for assertions                  */
/* ------------------------------------------------------------------ */

const textInstances: any[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    children: any[] = [];
    addChild(c: any) { this.children.push(c); }
    clear() { this.children = []; }
  },
  Spacer: class {},
  Text: class {
    text: string;
    constructor(text: string, _x?: number, _y?: number) {
      this.text = text;
      textInstances.push(this);
    }
  },
  Box: class {
    children: any[] = [];
    addChild(c: any) { this.children.push(c); }
  },
}));

vi.mock("../../src/ui/format.js", () => ({
  buildStatsCells: vi.fn(() => ({ tools: "5⚙︎", turns: "3⟳", duration: "1m 0s" })),
  formatStatsRow: vi.fn(() => "5⚙︎  3⟳ · 1m 0s"),
  formatThinkingTag: vi.fn((value: unknown) => value === "high" ? "high" : undefined),
  getAgentStatusDisplay: vi.fn((status: string) => {
    const displays: Record<string, { icon: string; color: string }> = {
      completed: { icon: "✓", color: "success" },
      turn_limited: { icon: "✓", color: "warning" },
      stopped: { icon: "■", color: "dim" },
      error: { icon: "✗", color: "error" },
      aborted: { icon: "✗", color: "error" },
    };
    return displays[status] ?? displays.completed;
  }),
  getDisplayName: vi.fn((type: string) => type.charAt(0).toUpperCase() + type.slice(1)),
}));

// Import after mocks are set up
import { buildStatsCells, getAgentStatusDisplay } from "../../src/ui/format.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "../../src/ui/renderer.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const noopTheme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

/** Default showCost value for tests. */
const SHOW_COST = false;

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("renderer", () => {
  beforeEach(() => {
    textInstances.length = 0;
    vi.clearAllMocks();
  });

  it("shows thinking level directly after the model in a normal tool call", () => {
    renderAgentToolCall({ agent: "builder", _modelOverride: "sonnet", thinking: "high" }, noopTheme);

    expect(textInstances.at(-1)?.text).toBe("▸ Builder (sonnet · high)");
  });

  it("shows concrete thinking without a model override in a tool call", () => {
    renderAgentToolCall({ agent: "agent", thinking: "high" }, noopTheme);

    expect(textInstances.at(-1)?.text).toBe("▸ Agent (high)");
  });

  it("keeps the normal tool call unchanged without a concrete thinking level", () => {
    renderAgentToolCall({ agent: "builder", _modelOverride: "sonnet", thinking: "inherit" }, noopTheme);

    expect(textInstances.at(-1)?.text).toBe("▸ Builder (sonnet)");
  });

  it("shows thinking level directly after the model in an agent result card", () => {
    renderAgentToolResult({
      content: [{ type: "text", text: "Agent output" }],
      details: { type: "builder", description: "Build something", modelName: "sonnet", thinkingLevel: "high", turnCount: 5 },
    }, { expanded: false }, noopTheme, SHOW_COST);

    expect(textInstances.map((t) => t.text).join("\n")).toContain("Builder (sonnet · high)");
  });

  it("shows concrete thinking without inventing a model in a foreground result card", () => {
    renderAgentToolResult({
      content: [{ type: "text", text: "Agent output" }],
      details: { type: "builder", description: "Build something", thinkingLevel: "high", turnCount: 5 },
    }, { expanded: false }, noopTheme, SHOW_COST);

    const text = textInstances.map((t) => t.text).join("\n");
    expect(text).toContain("Builder (high)");
    expect(text).not.toContain("undefined");
  });

  it("renders error, minimal, background, and expanded Agent result states", () => {
    renderAgentToolResult({
      content: [{ type: "text", text: "failed" }],
      isError: true,
      details: { type: "builder", description: "Build", turnCount: 1 },
    }, { expanded: false }, noopTheme, SHOW_COST);
    expect(textInstances.at(-1)?.text).toContain("✗ Builder");

    renderAgentToolResult({ content: [{ type: "text", text: "completed" }] }, { expanded: false }, noopTheme, SHOW_COST);
    expect(textInstances.at(-1)?.text).toBe("✓ completed");

    renderAgentToolResult({
      content: [{ type: "text", text: "Agent running in background" }],
      details: { description: "Queued build" },
    }, { expanded: false }, noopTheme, SHOW_COST);
    expect(textInstances.at(-1)?.text).toBe("  Queued build");

    renderAgentToolResult({
      content: [{ type: "text", text: "first line\nsecond line" }],
      details: { type: "builder", description: "Build", turnCount: 1 },
    }, { expanded: true }, noopTheme, SHOW_COST);
    expect(textInstances.at(-1)?.text).toContain("  first line\n  second line");
  });

  it("forwards cost fields to stats only when showCost is enabled", () => {
    const result = {
      content: [{ type: "text", text: "done" }],
      details: { type: "builder", description: "Build", turnCount: 1, cost: 0.42, usingSubscription: true },
    };

    renderAgentToolResult(result, { expanded: false }, noopTheme, true);
    expect(buildStatsCells).toHaveBeenLastCalledWith(
      expect.objectContaining({ cost: 0.42, usingSubscription: true }),
      noopTheme,
    );

    renderAgentToolResult(result, { expanded: false }, noopTheme, false);
    expect(buildStatsCells).toHaveBeenLastCalledWith(
      expect.objectContaining({ cost: undefined, usingSubscription: undefined }),
      noopTheme,
    );
  });

  it("shows worktree path in details pane for a completed agent with stats", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        turnCount: 5,
        worktreePath: "/wt/feature",
        status: "completed",
      },
    };

    renderSubagentResult(message, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("worktree: /wt/feature");
  });

  it("shows thinking level directly after the model in a subagent result card", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        modelName: "sonnet",
        thinkingLevel: "high",
        turnCount: 5,
        status: "completed",
      },
    };

    renderSubagentResult(message, { expanded: false }, noopTheme, SHOW_COST);

    expect(textInstances.map((t) => t.text).join("\n")).toContain("Builder (sonnet · high)");
  });

  it("shows concrete thinking without inventing a model in a background result card", () => {
    renderSubagentResult({
      content: "Agent output",
      details: { type: "builder", description: "Build something", thinkingLevel: "high", turnCount: 5, status: "completed" },
    }, { expanded: false }, noopTheme, SHOW_COST);

    const text = textInstances.map((t) => t.text).join("\n");
    expect(text).toContain("Builder (high)");
    expect(text).not.toContain("undefined");
  });

  it.each([
    ["stopped", "■", "dim"],
    ["turn_limited", "✓", "warning"],
  ])("uses the shared %s status icon and theme color", (status, icon, color) => {
    const theme = {
      ...noopTheme,
      fg: vi.fn((themeColor: string, value: string) => `[${themeColor}]${value}`),
    };

    renderSubagentResult({
      content: "Agent output",
      details: { type: "builder", description: "Build something", turnCount: 5, status },
    }, { expanded: false }, theme, SHOW_COST);

    expect(textInstances.map((t) => t.text).join("\n")).toContain(`[${color}]${icon}`);
    expect(theme.fg).toHaveBeenCalledWith(color, icon);
  });

  it("renders output file paths in detailed and fallback result cards", () => {
    renderSubagentResult({
      content: "Agent output",
      details: { type: "builder", description: "Build", turnCount: 1, outputFile: "/tmp/build.log" },
    }, { expanded: false }, noopTheme, SHOW_COST);
    expect(textInstances.map((t) => t.text).join("\n")).toContain("tail -f /tmp/build.log");

    textInstances.length = 0;
    renderSubagentResult({
      content: "Agent output",
      details: { type: "builder", description: "Build", outputFile: "/tmp/fallback.log" },
    }, { expanded: false }, noopTheme, SHOW_COST);
    expect(textInstances.map((t) => t.text).join("\n")).toContain("tail -f /tmp/fallback.log");
  });

  it("uses fallback status and type labels when result stats are unavailable", () => {
    renderSubagentResult({
      content: "Agent output",
      details: { type: "builder", description: "Build", status: "stopped" },
    }, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("■ Builder");
    expect(getAgentStatusDisplay).toHaveBeenCalledWith("stopped");
  });

  it("does not render worktree line when worktreePath is absent", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        turnCount: 5,
        status: "completed",
      },
    };

    renderSubagentResult(message, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).not.toContain("worktree:");
  });
});
