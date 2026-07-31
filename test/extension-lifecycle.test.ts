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
  coordinatorDisposeError: undefined as unknown,
  coordinatorDisposePending: undefined as Promise<void> | undefined,
  registerAgents: vi.fn(),
  scanAndMerge: vi.fn(async () => new Map()),
  store: {
    mode: "default" as "default" | "eco",
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
    uiCtx: any;
    dispose = vi.fn(() => {
      this.uiCtx?.setWidget?.("agents", undefined);
      this.uiCtx?.setStatus?.("agents", undefined);
    });
    setUICtx = vi.fn((uiCtx) => {
      this.uiCtx = uiCtx;
      uiCtx.setWidget?.("agents", this);
      uiCtx.setStatus?.("agents", "active");
    });
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
    dispose = vi.fn(async () => {
      if (state.coordinatorDisposeError) throw state.coordinatorDisposeError;
      await state.coordinatorDisposePending;
    });
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

function createContext(
  activeRecords: any[] = [],
  sharedUI?: { widgets: Map<string, unknown>; statuses: Map<string, unknown> },
) {
  const unregister = vi.fn();
  const onTerminalInput = vi.fn(() => unregister);
  const notify = vi.fn();
  const widgets = sharedUI?.widgets ?? new Map<string, unknown>();
  const statuses = sharedUI?.statuses ?? new Map<string, unknown>();
  const setWidget = vi.fn((key: string, value: unknown) => {
    if (value === undefined) widgets.delete(key);
    else widgets.set(key, value);
  });
  const setStatus = vi.fn((key: string, value: unknown) => {
    if (value === undefined) statuses.delete(key);
    else statuses.set(key, value);
  });
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { onTerminalInput, notify, setWidget, setStatus, theme: { fg: (_color: string, text: string) => text } },
  } as unknown as ExtensionContext;
  return { ctx, unregister, onTerminalInput, notify, widgets, statuses, activeRecords };
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
    state.coordinatorDisposeError = undefined;
    state.coordinatorDisposePending = undefined;
    state.store.mode = "default";
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

  it("sets the Eco footer on start and clears it on shutdown", async () => {
    state.store.mode = "eco";
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const session = createContext();

    await listeners.get("session_start")!({}, session.ctx);
    expect(session.statuses.get("subagents-eco")).toBe("🍃 Eco");

    await listeners.get("session_shutdown")!({}, session.ctx);
    expect(session.statuses.has("subagents-eco")).toBe(false);
  });

  it("clears an Eco footer when startup fails after publishing it", async () => {
    state.store.mode = "eco";
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const session = createContext();
    const failure = new Error("terminal unavailable");
    session.onTerminalInput.mockImplementationOnce(() => { throw failure; });

    await expect(listeners.get("session_start")!({}, session.ctx)).rejects.toBe(failure);

    expect(session.statuses.has("subagents-eco")).toBe(false);
    expect(state.manager).toBeNull();
    expect(state.widget).toBeNull();
    expect(state.coordinator).toBeNull();
  });

  it("waits for shutdown disposal before reactivating a new session", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    await listeners.get("session_start")!({}, first.ctx);
    const firstManager = state.manager;

    let releaseDisposal!: () => void;
    state.coordinatorDisposePending = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const shutdown = listeners.get("session_shutdown")!({}, first.ctx);
    await vi.waitFor(() => expect(state.coordinators[0].dispose).toHaveBeenCalledOnce());

    const retry = createContext();
    const restart = listeners.get("session_start")!({}, retry.ctx);
    expect(state.sessionCtx).toBe(first.ctx);
    expect(state.manager).toBe(firstManager);

    releaseDisposal();
    await shutdown;
    await restart;
    expect(state.sessionCtx).toBe(retry.ctx);
    expect(state.manager).not.toBe(firstManager);
    expect(retry.onTerminalInput).toHaveBeenCalledOnce();

    await listeners.get("session_shutdown")!({}, retry.ctx);
  });

  it("keeps a new runtime intact when an older overlapping shutdown finishes late", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const sharedUI = { widgets: new Map<string, unknown>(), statuses: new Map<string, unknown>() };
    const first = createContext([], sharedUI);
    await listeners.get("session_start")!({}, first.ctx);
    await listeners.get("tool_execution_start")!({}, first.ctx);
    const firstManager = state.manager;
    expect(sharedUI.widgets.get("agents")).toBe(state.widget);

    let releaseFirstDisposal!: () => void;
    state.coordinatorDisposePending = new Promise<void>((resolve) => { releaseFirstDisposal = resolve; });
    const firstShutdown = listeners.get("session_shutdown")!({}, first.ctx);
    await vi.waitFor(() => expect(state.coordinators[0].dispose).toHaveBeenCalledOnce());

    // The second generation cleans global services while the first remains
    // blocked disposing its coordinator.
    await listeners.get("session_shutdown")!({}, first.ctx);

    const retry = createContext([], sharedUI);
    await listeners.get("session_start")!({}, retry.ctx);
    await listeners.get("tool_execution_start")!({}, retry.ctx);
    const retryManager = state.manager;
    const retryWidget = state.widget;
    const retryCoordinator = state.coordinator;
    expect(retryManager).not.toBe(firstManager);
    expect(sharedUI.widgets.get("agents")).toBe(retryWidget);
    expect(sharedUI.statuses.get("agents")).toBe("active");
    expect(state.sessionCtx).toBe(retry.ctx);

    releaseFirstDisposal();
    await firstShutdown;

    expect(firstManager.dispose).toHaveBeenCalledOnce();
    expect(state.store.dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBe(retryManager);
    expect(state.widget).toBe(retryWidget);
    expect(state.coordinator).toBe(retryCoordinator);
    expect(sharedUI.widgets.get("agents")).toBe(retryWidget);
    expect(sharedUI.statuses.get("agents")).toBe("active");
    expect(state.sessionCtx).toBe(retry.ctx);

    await listeners.get("session_shutdown")!({}, retry.ctx);
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

  it("cleans a setDeps startup failure and can start again", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    const failure = new Error("manager dependency failed");
    state.store.setDeps.mockImplementationOnce(() => { throw failure; });

    await expect(listeners.get("session_start")!({}, first.ctx)).rejects.toBe(failure);

    expect(state.managers).toHaveLength(1);
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.coordinators).toHaveLength(0);
    expect(state.widgets).toHaveLength(0);
    expect(state.store.dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.widget).toBeNull();
    expect(state.coordinator).toBeNull();
    expect(state.sessionCtx).toBeNull();

    const retry = createContext();
    await expect(listeners.get("session_start")!({}, retry.ctx)).resolves.toBeUndefined();
    expect(state.manager).not.toBeNull();
    expect(retry.onTerminalInput).toHaveBeenCalledOnce();
    await listeners.get("session_shutdown")!({}, retry.ctx);
  });

  it("does not leak a completed scan after shutdown and permits a fresh session", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    let completeScan!: (catalog: Map<string, unknown>) => void;
    const pendingScan = new Promise<Map<string, unknown>>((resolve) => { completeScan = resolve; });
    state.scanAndMerge.mockImplementationOnce(() => pendingScan);

    const startup = listeners.get("session_start")!({}, first.ctx);
    expect(state.scanAndMerge).toHaveBeenCalledOnce();
    expect(state.manager).not.toBeNull();
    expect(state.coordinator).not.toBeNull();

    await listeners.get("session_shutdown")!({}, first.ctx);
    expect(state.coordinators[0].dispose).toHaveBeenCalledOnce();
    expect(state.widgets[0].dispose).toHaveBeenCalledOnce();
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.widget).toBeNull();
    expect(state.coordinator).toBeNull();
    expect(state.sessionCtx).toBeNull();

    // Start a new session before the stale scan completes. It must own the
    // shared agent catalog and terminal listener after reactivation.
    const retry = createContext();
    await expect(listeners.get("session_start")!({}, retry.ctx)).resolves.toBeUndefined();
    expect(state.registerAgents).toHaveBeenCalledOnce();
    expect(retry.onTerminalInput).toHaveBeenCalledOnce();

    completeScan(new Map());
    await expect(startup).resolves.toBeUndefined();
    expect(state.registerAgents).toHaveBeenCalledOnce();
    expect(first.onTerminalInput).not.toHaveBeenCalled();
    expect(first.unregister).not.toHaveBeenCalled();
    expect(state.sessionCtx).toBe(retry.ctx);
    expect(state.manager).not.toBeNull();
    expect(state.widget).not.toBeNull();
    expect(state.coordinator).not.toBeNull();

    await listeners.get("session_shutdown")!({}, retry.ctx);
    expect(retry.unregister).toHaveBeenCalledOnce();
  });

  it("cleans services when scanning fails and supports a retry", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    const failure = new Error("agent scan failed");
    state.scanAndMerge.mockRejectedValueOnce(failure);

    await expect(listeners.get("session_start")!({}, first.ctx)).rejects.toBe(failure);

    expect(first.onTerminalInput).not.toHaveBeenCalled();
    expect(state.coordinators[0].dispose).toHaveBeenCalledOnce();
    expect(state.widgets[0].dispose).toHaveBeenCalledOnce();
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.store.dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.widget).toBeNull();
    expect(state.coordinator).toBeNull();
    expect(state.sessionCtx).toBeNull();

    const retry = createContext();
    await expect(listeners.get("session_start")!({}, retry.ctx)).resolves.toBeUndefined();
    expect(retry.onTerminalInput).toHaveBeenCalledOnce();
    await listeners.get("session_shutdown")!({}, retry.ctx);
  });

  it("preserves a startup error while continuing cleanup after a disposal error", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    const startupFailure = new Error("agent scan failed");
    const disposalFailure = new Error("coordinator disposal failed");
    state.scanAndMerge.mockRejectedValueOnce(startupFailure);
    state.coordinatorDisposeError = disposalFailure;

    await expect(listeners.get("session_start")!({}, first.ctx)).rejects.toBe(startupFailure);

    expect(state.widgets[0].dispose).toHaveBeenCalledOnce();
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.widget).toBeNull();
    expect(state.coordinator).toBeNull();
    expect(state.sessionCtx).toBeNull();
  });

  it("unregisters terminal input when post-registration startup work fails", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    const failure = new Error("tool expansion sync failed");
    state.store.notifyToolsExpanded.mockImplementationOnce(() => { throw failure; });

    await expect(listeners.get("session_start")!({}, first.ctx)).rejects.toBe(failure);

    expect(first.onTerminalInput).toHaveBeenCalledOnce();
    expect(first.unregister).toHaveBeenCalledOnce();
    expect(state.coordinators[0].dispose).toHaveBeenCalledOnce();
    expect(state.widgets[0].dispose).toHaveBeenCalledOnce();
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.widget).toBeNull();
    expect(state.coordinator).toBeNull();
    expect(state.sessionCtx).toBeNull();

    const retry = createContext();
    await expect(listeners.get("session_start")!({}, retry.ctx)).resolves.toBeUndefined();
    expect(retry.onTerminalInput).toHaveBeenCalledOnce();
    await listeners.get("session_shutdown")!({}, retry.ctx);
  });
});
