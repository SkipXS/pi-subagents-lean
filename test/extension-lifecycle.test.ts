import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const state = vi.hoisted(() => ({
  manager: null as any,
  widget: null as any,
  coordinator: null as any,
  sessionCtx: null as any,
  managers: [] as any[],
  widgets: [] as any[],
  coordinators: [] as any[],
  registerAgents: vi.fn(),
  scanAndMerge: vi.fn(async () => new Map()),
  store: {
    agent: { disableDefaultAgents: false, orchestrationPrompt: true, outputThinkingBufferSize: 0 },
    concurrency: { default: 4 },
    reload: vi.fn(),
    setDeps: vi.fn(),
    notifyToolsExpanded: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/pi-agent",
}));

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: () => false,
  isKeyRelease: () => false,
}));

vi.mock("../src/agents/agent-types.js", () => ({
  registerAgents: state.registerAgents,
  getAvailableAgents: () => [],
  setAgentScanDirs: vi.fn(),
  scanAndMerge: state.scanAndMerge,
}));

vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class {
    records: any[] = [];
    dispose = vi.fn(async () => undefined);
    setOnComplete = vi.fn();
    constructor() { state.managers.push(this); }
    listAgents() { return this.records; }
  },
}));

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {
    dispose = vi.fn();
    setUICtx = vi.fn();
    onTurnStart = vi.fn();
    update = vi.fn();
    constructor() { state.widgets.push(this); }
  },
}));

vi.mock("../src/ui/conversation-viewer.js", () => ({
  ConversationViewer: class {},
  VIEWER_OVERLAY_OPTIONS: {},
}));

vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class {
    dispose = vi.fn();
    onAgentComplete = vi.fn();
    constructor() { state.coordinators.push(this); }
  },
}));

vi.mock("../src/agents/tool-execution.js", () => ({ toolCallListener: vi.fn() }));
vi.mock("../src/prompt/orchestration.js", () => ({ getOrchestrationPromptUpdate: () => undefined }));

vi.mock("../src/shell.js", () => ({
  getPiInstance: () => ({}),
  getManager: () => state.manager,
  getWidget: () => state.widget,
  getCoordinator: () => state.coordinator,
  getStore: () => state.store,
  setSessionCtx: (ctx: unknown) => { state.sessionCtx = ctx; },
  setManager: (value: unknown) => { state.manager = value; },
  setWidget: (value: unknown) => { state.widget = value; },
  setCoordinator: (value: unknown) => { state.coordinator = value; },
}));

import { setupEventListeners } from "../src/events.js";

function createContext(activeRecords: any[] = []) {
  const unregister = vi.fn();
  const onTerminalInput = vi.fn(() => unregister);
  const notify = vi.fn();
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { onTerminalInput, notify },
  } as unknown as ExtensionContext;
  return { ctx, unregister, onTerminalInput, notify, activeRecords };
}

describe("extension session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.manager = null;
    state.widget = null;
    state.coordinator = null;
    state.sessionCtx = null;
    state.managers.length = 0;
    state.widgets.length = 0;
    state.coordinators.length = 0;
  });

  it("creates runtime services on start and disposes them on shutdown", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const { ctx, unregister, onTerminalInput } = createContext();

    await listeners.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    expect(state.sessionCtx).toBe(ctx);
    expect(state.store.reload).toHaveBeenCalledOnce();
    expect(state.managers).toHaveLength(1);
    expect(state.widgets).toHaveLength(1);
    expect(state.coordinators).toHaveLength(1);
    expect(state.store.setDeps).toHaveBeenCalledTimes(2);
    expect(state.registerAgents).toHaveBeenCalledOnce();
    expect(onTerminalInput).toHaveBeenCalledOnce();

    const manager = state.manager;
    const widget = state.widget;
    const coordinator = state.coordinator;
    await listeners.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);

    expect(unregister).toHaveBeenCalledOnce();
    expect(coordinator.dispose).toHaveBeenCalledOnce();
    expect(state.store.dispose).toHaveBeenCalledOnce();
    expect(widget.dispose).toHaveBeenCalledOnce();
    expect(manager.dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.widget).toBeNull();
    expect(state.coordinator).toBeNull();
  });

  it("re-registers terminal input after a shutdown and warns about killed agents", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();

    await listeners.get("session_start")!({}, first.ctx);
    state.manager.records = [
      { lifecycle: { status: "running" } },
      { lifecycle: { status: "queued" } },
      { lifecycle: { status: "completed" } },
    ];
    await listeners.get("session_shutdown")!({}, first.ctx);

    expect(first.notify).toHaveBeenCalledWith("2 agent(s) killed by reload", "warning");
    expect(first.unregister).toHaveBeenCalledOnce();

    const second = createContext();
    await listeners.get("session_start")!({}, second.ctx);
    expect(second.onTerminalInput).toHaveBeenCalledOnce();
    await listeners.get("session_shutdown")!({}, second.ctx);
    expect(second.unregister).toHaveBeenCalledOnce();
  });
});
