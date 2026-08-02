/**
 * events-navigation.test.ts — Tests for the real navigation key handler from events.ts.
 *
 * Drives createNavInputHandler with stubbed shell singletons (getManager, getWidget)
 * and a minimal ctx. Every assertion exercises the actual handler code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNavInputHandler, scanAndRegisterAgents, setupEventListeners } from "../src/events.js";
import { buildOrchestrationPrompt } from "../src/prompt/orchestration.js";

const { mockGetAgentDir, mockSetAgentScanDirs, mockScanAndMerge, mockGetAvailableAgents } = vi.hoisted(() => ({
  mockGetAgentDir: vi.fn(() => "C:\\Users\\Pi User\\.pi\\agent"),
  mockSetAgentScanDirs: vi.fn(),
  mockScanAndMerge: vi.fn(async () => new Map()),
  mockGetAvailableAgents: vi.fn(() => [{ name: "reviewer", description: "Reviews changes" }]),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: mockGetAgentDir,
}));

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

const mockMatchesKey = vi.fn<(...args: any[]) => unknown>();
const mockIsKeyRelease = vi.fn<(...args: any[]) => boolean>(() => false);

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: (...args: any[]) => mockMatchesKey(...args),
  isKeyRelease: (...args: any[]) => mockIsKeyRelease(...args),
  truncateToWidth: (text: string, width: number) => text,
  Editor: class Editor {},
  Container: class Container {},
  Markdown: class Markdown {},
  Spacer: class Spacer {},
  Text: class Text {},
  getKeybindings: () => [],
  visibleWidth: (text: string) => text.length,
}));

vi.mock("../src/agents/agent-types.js", () => ({
  getConfig: (type: string) => ({
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    tools: [],
    maxTurns: undefined,
    thinkingLevel: undefined,
  }),
  registerAgents: vi.fn(),
  getAvailableAgents: mockGetAvailableAgents,
  getAvailableTypes: vi.fn(() => []),
  setAgentScanDirs: mockSetAgentScanDirs,
  scanAndMerge: mockScanAndMerge,
}));

vi.mock("../src/agents/default-agents.js", () => ({
  DEFAULT_AGENTS: new Map(),
}));

vi.mock("../src/agents/agent-discovery.js", () => ({
  scanAgentFilesInDir: vi.fn(async () => new Map()),
  mergeAgents: vi.fn((...maps: Map<any, any>[][]) => {
    const merged = new Map();
    for (const m of maps) for (const [k, v] of m) merged.set(k, v);
    return merged;
  }),
}));

vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class AgentManager {
    listAgents() { return []; }
    getAgent() { return undefined; }
    setConcurrency() {}
    getTotalAgentCost() { return 0; }
    getTotalAgentCount() { return 0; }
    setOnComplete(cb: any) { (this as any).onComplete = cb; }
    dispose() { return Promise.resolve(); }
  },
}));

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class AgentWidget {
    setUICtx = vi.fn();
    onTurnStart = vi.fn();
    setShowCost = vi.fn();
    setForceCompact = vi.fn();
    setWidgetShortcut = vi.fn();
    setShowModelThinking = vi.fn();
    setShowStartTime = vi.fn();
    setMaxLines = vi.fn();
    setMaxLinesCompact = vi.fn();
    setDescLengthFull = vi.fn();
    setDescLengthCompact = vi.fn();
    setStatsVisibility = vi.fn();
    update = vi.fn();
  },
}));

vi.mock("../src/ui/result-viewer.js", () => ({
  ResultViewer: class ResultViewer {},
}));

vi.mock("../src/ui/conversation-viewer.js", () => ({
  ConversationViewer: class ConversationViewer {
    constructor(...args: any[]) {
      (globalThis as any).__conversationViewerArgs = args;
    }
  },
  VIEWER_OVERLAY_OPTIONS: {},
}));

vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class SpawnCoordinator {
    onAgentComplete = vi.fn();
    liveView = vi.fn();
  },
}));

vi.mock("../src/agents/tool-execution.js", () => ({
  toolCallListener: vi.fn(),
}));

vi.mock("../src/registration.js", () => ({
  registerAgentTool: vi.fn(),
}));

vi.mock("../src/prompt/context.js", () => ({
  buildSnapshotMarkdown: vi.fn(() => ""),
}));

vi.mock("../src/ui/format.js", () => ({
  formatMs: vi.fn(() => "0s"),
  buildStatsParts: vi.fn(() => []),
  getDisplayName: vi.fn((type: string) => type),
  truncateDesc: vi.fn((desc: string) => desc),
}));

const mockManager: any = {
  listAgents: vi.fn(() => []),
  getTotalAgentCost: vi.fn(() => 0),
  getTotalAgentCount: vi.fn(() => 0),
  dispose: vi.fn(),
  abort: vi.fn(),
  steer: vi.fn(),
};

const mockCoordinator: any = { dispose: vi.fn() };

const mockWidget: any = {
  isViewerOpen: vi.fn(() => false),
  isEditorFocused: vi.fn(() => true),
  isNavActive: vi.fn(() => false),
  navActivate: vi.fn(),
  navUp: vi.fn(),
  navDown: vi.fn(),
  navSelect: vi.fn(() => null),
  navDeactivate: vi.fn(),
  setViewerOpen: vi.fn(),
  highlightedIndex: vi.fn(() => 0),
  update: vi.fn(),
  setUICtx: vi.fn(),
  onTurnStart: vi.fn(),
  notifyToolsExpansionChanged: vi.fn(),
  dispose: vi.fn(),
};

let currentManager: any = mockManager;
let currentWidget: any = mockWidget;
let currentCoordinator: any = mockCoordinator;

const mockStore: any = {
  agent: { disableDefaultAgents: false, orchestrationPrompt: true },
  notifyToolsExpanded: vi.fn(),
  reload: vi.fn(),
  dispose: vi.fn(),
  setDeps: vi.fn(),
};

vi.mock("../src/shell.js", () => ({
  getManager: () => currentManager,
  getWidget: () => currentWidget,
  getStore: () => mockStore,
  getCoordinator: () => currentCoordinator,
  getPiInstance: () => ({}),
  getSessionCtx: () => ({}),
  setSessionCtx: vi.fn(),
  setManager: (manager: any) => { currentManager = manager; },
  setWidget: (widget: any) => { currentWidget = widget; },
  setCoordinator: (coordinator: any) => { currentCoordinator = coordinator; },
}));

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("navigation key handler (createNavInputHandler)", () => {
  let ctx: ExtensionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWidget.isViewerOpen.mockReturnValue(false);
    mockWidget.isEditorFocused.mockReturnValue(true);
    mockWidget.isNavActive.mockReturnValue(false);
    mockWidget.highlightedIndex.mockReturnValue(0);
    mockWidget.navSelect.mockReturnValue(null);
    mockManager.listAgents.mockReturnValue([]);
    mockMatchesKey.mockReturnValue(false);
    mockIsKeyRelease.mockReturnValue(false);
    mockGetAgentDir.mockReturnValue("C:\\Users\\Pi User\\.pi\\agent");
    currentManager = mockManager;
    currentWidget = mockWidget;
    currentCoordinator = mockCoordinator;
    mockStore.agent.orchestrationPrompt = true;
    ctx = {
      ui: {
        getEditorText: vi.fn(() => ""),
        notify: vi.fn(),
      },
      isProjectTrusted: vi.fn(() => true),
    } as unknown as ExtensionContext;
  });

  it("uses Pi's agent directory for global agents when HOME is unset", async () => {
    vi.stubEnv("HOME", "");
    const agentDir = "C:\\Users\\Pi User\\.pi\\agent";

    try {
      await scanAndRegisterAgents({
        cwd: "C:\\work\\project",
        isProjectTrusted: () => true,
      } as ExtensionContext);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mockGetAgentDir).toHaveBeenCalledOnce();
    expect(mockSetAgentScanDirs)
      .toHaveBeenCalledWith(join(agentDir, "agents"), join("C:\\work\\project", ".pi", "agents"), join("C:\\work\\project", ".agents", "agents"));
  });

  it("does not discover project-controlled agents before project trust", async () => {
    await scanAndRegisterAgents({
      cwd: "C:\\work\\untrusted",
      isProjectTrusted: () => false,
    } as ExtensionContext);

    expect(mockSetAgentScanDirs).toHaveBeenCalledWith(
      join("C:\\Users\\Pi User\\.pi\\agent", "agents"),
      "",
      "",
    );
  });

  describe("parent orchestration hook", () => {
    it("refreshes trusted registry before each turn with stable prompt output", async () => {
      const on = vi.fn();
      setupEventListeners({ on } as any);
      const handler = on.mock.calls.find(([event]) => event === "before_agent_start")?.[1]!;
      const trusted = { cwd: "C:\\work\\project", isProjectTrusted: () => true } as ExtensionContext;

      const first = await handler({ systemPrompt: "Base" }, trusted);
      const second = await handler({ systemPrompt: "Base" }, trusted);

      expect(mockScanAndMerge).toHaveBeenCalledTimes(2);
      expect(first).toEqual(second);
      expect(first.systemPrompt).toContain("`reviewer` — Reviews changes");
    });

    it("refreshes but does not inject when orchestration is disabled", async () => {
      const on = vi.fn();
      setupEventListeners({ on } as any);
      const handler = on.mock.calls.find(([event]) => event === "before_agent_start")?.[1]!;
      mockStore.agent.orchestrationPrompt = false;

      const result = await handler({ systemPrompt: "Base" }, { cwd: "C:\\work\\project", isProjectTrusted: () => true } as ExtensionContext);

      expect(mockScanAndMerge).toHaveBeenCalled();
      expect(result).toBeUndefined();
      mockStore.agent.orchestrationPrompt = true;
    });

    it("returns an empty prompt when disabling a standalone owned block", async () => {
      const on = vi.fn();
      setupEventListeners({ on } as any);
      const handler = on.mock.calls.find(([event]) => event === "before_agent_start")?.[1]!;
      mockStore.agent.orchestrationPrompt = false;
      const owned = buildOrchestrationPrompt([{ name: "reviewer", description: "Reviews changes" }])!;

      const result = await handler({ systemPrompt: owned }, { cwd: "C:\\work\\project", isProjectTrusted: () => true } as ExtensionContext);

      expect(result).toEqual({ systemPrompt: "" });
      mockStore.agent.orchestrationPrompt = true;
    });

    it("returns an empty prompt when no visible catalog remains", async () => {
      const on = vi.fn();
      setupEventListeners({ on } as any);
      const handler = on.mock.calls.find(([event]) => event === "before_agent_start")?.[1]!;
      mockGetAvailableAgents.mockReturnValueOnce([]);
      const owned = buildOrchestrationPrompt([{ name: "reviewer", description: "Reviews changes" }])!;

      const result = await handler({ systemPrompt: owned }, { cwd: "C:\\work\\project", isProjectTrusted: () => true } as ExtensionContext);

      expect(result).toEqual({ systemPrompt: "" });
    });

    it("never exposes untrusted project agents in the parent prompt", async () => {
      const on = vi.fn();
      setupEventListeners({ on } as any);
      const handler = on.mock.calls.find(([event]) => event === "before_agent_start")?.[1]!;
      mockGetAvailableAgents.mockReturnValueOnce([]);

      const result = await handler({ systemPrompt: "Base" }, { cwd: "C:\\work\\untrusted", isProjectTrusted: () => false } as ExtensionContext);

      expect(mockSetAgentScanDirs).toHaveBeenCalledWith(expect.any(String), "", "");
      expect(result).toBeUndefined();
    });
  });

  describe("key release ignored", () => {
    it("returns undefined for key release events", () => {
      mockIsKeyRelease.mockReturnValue(true);
      const handler = createNavInputHandler(ctx);
      const result = handler("some_key");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });
  });

  describe("viewer open guard", () => {
    it("returns undefined when viewer is open", () => {
      mockWidget.isViewerOpen.mockReturnValue(true);
      mockMatchesKey.mockReturnValue(true);
      const handler = createNavInputHandler(ctx);
      const result = handler("down");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });
  });

  describe("editor focus check", () => {
    it("deactivates nav and returns undefined when editor not focused", () => {
      mockWidget.isEditorFocused.mockReturnValue(false);
      mockWidget.isNavActive.mockReturnValue(true);
      const handler = createNavInputHandler(ctx);
      const result = handler("down");
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });

    it("does nothing when editor not focused and nav inactive", () => {
      mockWidget.isEditorFocused.mockReturnValue(false);
      mockWidget.isNavActive.mockReturnValue(false);
      const handler = createNavInputHandler(ctx);
      const result = handler("down");
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).not.toHaveBeenCalled();
    });
  });

  describe("activation", () => {
    it("activates on down + empty editor + agents exist", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockManager.listAgents.mockReturnValue([{ id: "a1" }]);
      (ctx.ui.getEditorText as any).mockReturnValue("");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navActivate).toHaveBeenCalled();
    });

    it("does not activate when editor has text", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockManager.listAgents.mockReturnValue([{ id: "a1" }]);
      (ctx.ui.getEditorText as any).mockReturnValue("hello");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });

    it("does not activate when no agents", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockManager.listAgents.mockReturnValue([]);
      (ctx.ui.getEditorText as any).mockReturnValue("");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });

    it("does not activate on non-down key", () => {
      mockMatchesKey.mockReturnValue(false);
      mockManager.listAgents.mockReturnValue([{ id: "a1" }]);
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });
  });

  describe("navigation when active", () => {
    beforeEach(() => {
      mockWidget.isNavActive.mockReturnValue(true);
    });

    it("handles down arrow", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navDown).toHaveBeenCalled();
    });

    it("handles up arrow", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "up");
      mockWidget.highlightedIndex.mockReturnValue(2);
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navUp).toHaveBeenCalled();
    });

    it("wraps on up at index 0", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "up");
      mockWidget.highlightedIndex.mockReturnValue(0);
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navUp).toHaveBeenCalled();
      expect(mockWidget.navDeactivate).not.toHaveBeenCalled();
    });

    it("handles escape", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "escape");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });

    it("handles enter and calls navSelect", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "enter");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navSelect).toHaveBeenCalled();
    });

    it("opens and closes the conversation viewer for a selected session", async () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "enter");
      const record = { id: "agent-1", execution: { session: {} } };
      mockWidget.navSelect.mockReturnValue(record);
      (ctx.ui as any).custom = vi.fn(async (render: any) => {
        render({}, {}, {}, () => {});
      });

      createNavInputHandler(ctx)("enter");
      await vi.waitFor(() => expect(mockWidget.setViewerOpen).toHaveBeenCalledWith(false));

      expect((ctx.ui as any).custom).toHaveBeenCalledWith(expect.any(Function), {
        overlay: true,
        overlayOptions: {},
      });
      const viewerArgs = (globalThis as any).__conversationViewerArgs;
      viewerArgs[5]();
      viewerArgs[7]("steer this agent");
      expect(mockManager.abort).toHaveBeenCalledWith("agent-1", "user");
      expect(mockManager.steer).toHaveBeenCalledWith("agent-1", "steer this agent");
    });

    it("does not open a viewer for an incomplete selected record", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "enter");
      mockWidget.navSelect.mockReturnValue({ id: "agent-1" });

      const result = createNavInputHandler(ctx)("enter");

      expect(result).toEqual({ consume: true });
      expect((ctx.ui as any).custom).toBeUndefined();
      expect(mockWidget.setViewerOpen).not.toHaveBeenCalled();
    });

    it("reports viewer creation failures without consuming the next input", async () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "enter");
      mockWidget.navSelect.mockReturnValue({ id: "agent-1", execution: { session: {} } });
      (ctx.ui as any).custom = vi.fn().mockRejectedValue(new Error("overlay failed"));

      createNavInputHandler(ctx)("enter");

      await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Failed to open agent viewer: Error: overlay failed", "error",
      ));
    });

    it("deactivates on non-navigation key", () => {
      mockMatchesKey.mockReturnValue(false);
      const handler = createNavInputHandler(ctx);
      const result = handler("a");
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Event listener lifecycle and Ctrl-O                               */
/* ------------------------------------------------------------------ */

describe("event listener lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockManager.listAgents.mockReturnValue([]);
    mockWidget.isViewerOpen.mockReturnValue(false);
    mockWidget.isEditorFocused.mockReturnValue(true);
    mockWidget.isNavActive.mockReturnValue(false);
    mockMatchesKey.mockReturnValue(false);
    mockIsKeyRelease.mockReturnValue(false);
    currentManager = mockManager;
    currentWidget = mockWidget;
    currentCoordinator = mockCoordinator;
  });

  it("binds UI context and starts the widget turn on tool execution", async () => {
    const on = vi.fn();
    setupEventListeners({ on } as any);
    const handler = on.mock.calls.find(([event]) => event === "tool_execution_start")?.[1]!;
    const ctx = { ui: { id: "ui" } } as any;

    await handler({}, ctx);

    expect(mockWidget.setUICtx).toHaveBeenCalledWith(ctx.ui);
    expect(mockWidget.onTurnStart).toHaveBeenCalledOnce();
  });

  it("lazily creates the manager and widget on the first tool execution", async () => {
    currentManager = null;
    currentWidget = null;
    const on = vi.fn();
    setupEventListeners({ on } as any);
    const handler = on.mock.calls.find(([event]) => event === "tool_execution_start")?.[1]!;
    const ctx = { ui: { id: "ui" } } as any;

    await handler({}, ctx);

    expect(currentManager).toBeTruthy();
    expect(currentWidget).toBeTruthy();
    expect(mockStore.setDeps).toHaveBeenCalledTimes(2);
    expect(currentWidget.setUICtx).toHaveBeenCalledWith(ctx.ui);
    expect(currentWidget.onTurnStart).toHaveBeenCalledOnce();
    currentManager.onComplete({ id: "agent-1" });
    // The completion handler forwards the optional per-execution summary.
    expect(currentCoordinator.onAgentComplete).toHaveBeenCalledWith({ id: "agent-1" }, undefined);
    expect(currentWidget.update).toHaveBeenCalledOnce();
  });

  it("syncs Ctrl-O expansion state after Pi's terminal handler runs", () => {
    vi.useFakeTimers();
    try {
      const ctx = {
        ui: {
          getEditorText: vi.fn(() => ""),
          getToolsExpanded: vi.fn(() => true),
          notify: vi.fn(),
        },
      } as unknown as ExtensionContext;

      createNavInputHandler(ctx)("\u000f");
      expect(mockStore.notifyToolsExpanded).not.toHaveBeenCalled();
      vi.runAllTimers();

      expect(mockWidget.notifyToolsExpansionChanged).toHaveBeenCalledWith(true);
      expect(mockStore.notifyToolsExpanded).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers terminal input at session start and disposes active session resources on shutdown", async () => {
    const on = vi.fn();
    setupEventListeners({ on } as any);
    const start = on.mock.calls.find(([event]) => event === "session_start")?.[1]!;
    const shutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]!;
    const unregister = vi.fn();
    const ctx = {
      cwd: "C:\\work\\project",
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        onTerminalInput: vi.fn(() => unregister),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;
    mockManager.listAgents.mockReturnValue([
      { lifecycle: { status: "running" } },
      { lifecycle: { status: "queued" } },
      { lifecycle: { status: "completed" } },
    ]);

    await start({}, ctx);
    await shutdown({}, ctx);

    expect((ctx.ui as any).onTerminalInput).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect((ctx.ui as any).notify).toHaveBeenCalledWith("2 agent(s) killed by reload", "warning");
    expect(mockCoordinator.dispose).toHaveBeenCalledOnce();
    expect(mockStore.dispose).toHaveBeenCalledOnce();
    expect(mockWidget.dispose).toHaveBeenCalledOnce();
    expect(mockManager.dispose).toHaveBeenCalledOnce();
  });
});
