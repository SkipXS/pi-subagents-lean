import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const state = vi.hoisted(() => ({
  manager: null as any,
  coordinator: null as any,
  sessionCtx: null as any,
  managers: [] as any[],
  coordinators: [] as any[],
  coordinatorDisposeError: undefined as unknown,
  coordinatorDisposePending: undefined as Promise<void> | undefined,
  registerAgents: vi.fn(),
  scanAndMerge: vi.fn(async () => new Map()),
  store: {
    agent: {
      disableDefaultAgents: false,
      orchestrationPrompt: true,
      outputThinkingBufferSize: 0,
    },
    concurrency: { default: 4 },
    reload: vi.fn(),
    setDeps: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/pi-agent",
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
    setOnRecordEvicted = vi.fn();
    constructor() { state.managers.push(this); }
    listAgents() { return this.records; }
  },
}));

vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class {
    dispose = vi.fn(async () => {
      if (state.coordinatorDisposeError) throw state.coordinatorDisposeError;
      await state.coordinatorDisposePending;
    });
    onAgentComplete = vi.fn();
    onRecordEvicted = vi.fn();
    constructor() { state.coordinators.push(this); }
  },
}));

vi.mock("../src/agents/tool-execution.js", () => ({ toolCallListener: vi.fn() }));
vi.mock("../src/prompt/orchestration.js", () => ({ getOrchestrationPromptUpdate: () => undefined }));

vi.mock("../src/shell.js", () => ({
  getManager: () => state.manager,
  getCoordinator: () => state.coordinator,
  getStore: () => state.store,
  setSessionCtx: (ctx: unknown) => { state.sessionCtx = ctx; },
  setManager: (value: unknown) => { state.manager = value; },
  setCoordinator: (value: unknown) => { state.coordinator = value; },
}));

import { setupEventListeners } from "../src/events.js";
import { AgentRenderMetadataBridge } from "../src/agents/agent-render-bridge.js";
import { AGENT_RENDER_DETAILS_KEY } from "../src/agents/agent-renderer.js";

function createContext(): ExtensionContext {
  return {
    cwd: "/tmp/project",
    hasUI: false,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

describe("headless extension session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.manager = null;
    state.coordinator = null;
    state.sessionCtx = null;
    state.managers.length = 0;
    state.coordinators.length = 0;
    state.coordinatorDisposeError = undefined;
    state.coordinatorDisposePending = undefined;
    state.store.dispose.mockReset();
    state.scanAndMerge.mockReset().mockResolvedValue(new Map());
  });

  it("registers root lifecycle hooks without terminal input listeners", () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);

    expect([...listeners.keys()]).toEqual([
      "tool_execution_start", "tool_execution_update", "tool_result", "message_end",
      "tool_call", "before_agent_start", "session_start", "session_shutdown",
    ]);
    expect(listeners.has("tool_execution_start")).toBe(true);
  });

  it("bridges resolved Agent metadata through update, tool_result, and message_end", () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    const bridge = new AgentRenderMetadataBridge();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any, bridge);
    const metadata = { role: "reviewer", model: "openai/gpt-4o", thinking: "high", prompt: "inspect" };

    listeners.get("tool_execution_start")!({ toolCallId: "bridge-id", toolName: "Agent", args: {} });
    listeners.get("tool_execution_update")!({
      toolCallId: "bridge-id",
      toolName: "Agent",
      args: {},
      partialResult: { content: [], details: { [AGENT_RENDER_DETAILS_KEY]: metadata } },
    });
    const hookResult = listeners.get("tool_result")!({
      toolName: "Agent",
      toolCallId: "bridge-id",
      details: {},
      content: [{ type: "text", text: "failed" }],
      isError: true,
    });
    expect(hookResult.details[AGENT_RENDER_DETAILS_KEY]).toEqual(metadata);
    expect(listeners.get("message_end")!({
      message: { role: "toolResult", toolCallId: "bridge-id", toolName: "Agent", details: hookResult.details },
    })).toBeUndefined();
    expect(bridge.pendingCount()).toBe(0);
    bridge.clear();
  });

  it("creates and disposes root services on session start/shutdown", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const ctx = createContext();

    await listeners.get("session_start")!({}, ctx);
    expect(state.sessionCtx).toBe(ctx);
    expect(state.store.reload).toHaveBeenCalledOnce();
    expect(state.managers).toHaveLength(1);
    expect(state.coordinators).toHaveLength(1);
    expect(state.store.setDeps).toHaveBeenCalledWith({ manager: state.manager });
    expect(state.registerAgents).toHaveBeenCalledOnce();

    const manager = state.manager;
    const coordinator = state.coordinator;
    await listeners.get("session_shutdown")!({}, ctx);

    expect(coordinator.dispose).toHaveBeenCalledOnce();
    expect(state.store.dispose).toHaveBeenCalledOnce();
    expect(manager.dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.coordinator).toBeNull();
    expect(state.sessionCtx).toBeNull();
  });

  it("waits for a delayed coordinator dispose before restarting", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    await listeners.get("session_start")!({}, first);
    const firstManager = state.manager;

    let releaseDispose!: () => void;
    state.coordinatorDisposePending = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const shutdown = listeners.get("session_shutdown")!({}, first);
    await vi.waitFor(() => expect(state.coordinators[0].dispose).toHaveBeenCalledOnce());

    const retry = createContext();
    const restart = listeners.get("session_start")!({}, retry);
    expect(state.sessionCtx).toBe(first);
    expect(state.manager).toBe(firstManager);

    releaseDispose();
    await shutdown;
    await restart;

    expect(state.sessionCtx).toBe(retry);
    expect(state.manager).not.toBe(firstManager);
    await listeners.get("session_shutdown")!({}, retry);
  });

  it("keeps a restarted runtime intact when an older shutdown finishes late", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    await listeners.get("session_start")!({}, first);
    const firstManager = state.manager;

    let releaseFirstDispose!: () => void;
    state.coordinatorDisposePending = new Promise<void>((resolve) => { releaseFirstDispose = resolve; });
    const firstShutdown = listeners.get("session_shutdown")!({}, first);
    await vi.waitFor(() => expect(state.coordinators[0].dispose).toHaveBeenCalledOnce());

    // A second generation can clean global services while the first coordinator
    // remains blocked. The following start must own the shared runtime.
    await listeners.get("session_shutdown")!({}, first);
    const retry = createContext();
    await listeners.get("session_start")!({}, retry);
    const retryManager = state.manager;
    const retryCoordinator = state.coordinator;

    expect(retryManager).not.toBe(firstManager);
    expect(state.sessionCtx).toBe(retry);

    releaseFirstDispose();
    await firstShutdown;

    expect(state.manager).toBe(retryManager);
    expect(state.coordinator).toBe(retryCoordinator);
    expect(state.sessionCtx).toBe(retry);
    await listeners.get("session_shutdown")!({}, retry);
  });

  it("attempts every runtime disposer and remains restartable after disposal errors", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const first = createContext();
    await listeners.get("session_start")!({}, first);

    const coordinatorFailure = new Error("coordinator dispose failed");
    const storeFailure = new Error("store dispose failed");
    const managerFailure = new Error("manager dispose failed");
    state.coordinatorDisposeError = coordinatorFailure;
    state.store.dispose.mockImplementationOnce(() => { throw storeFailure; });
    state.manager.dispose.mockImplementationOnce(async () => { throw managerFailure; });

    await expect(listeners.get("session_shutdown")!({}, first)).rejects.toBe(coordinatorFailure);

    expect(state.coordinators[0].dispose).toHaveBeenCalledOnce();
    expect(state.store.dispose).toHaveBeenCalledOnce();
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.coordinator).toBeNull();
    expect(state.sessionCtx).toBeNull();

    state.coordinatorDisposeError = undefined;
    const retry = createContext();
    await expect(listeners.get("session_start")!({}, retry)).resolves.toBeUndefined();
    expect(state.manager).not.toBeNull();
    await listeners.get("session_shutdown")!({}, retry);
  });

  it("does not publish a pending catalog scan after shutdown", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    let resolveScan!: (catalog: Map<string, unknown>) => void;
    state.scanAndMerge.mockImplementationOnce(() => new Promise((resolve) => { resolveScan = resolve; }));
    const first = createContext();

    const startup = listeners.get("session_start")!({}, first);
    await vi.waitFor(() => expect(state.scanAndMerge).toHaveBeenCalledOnce());
    await listeners.get("session_shutdown")!({}, first);

    const retry = createContext();
    await listeners.get("session_start")!({}, retry);
    resolveScan(new Map([["stale", {}]]));
    await expect(startup).resolves.toBeUndefined();

    expect(state.registerAgents).toHaveBeenCalledTimes(1);
    expect(state.sessionCtx).toBe(retry);
    await listeners.get("session_shutdown")!({}, retry);
  });

  it("cleans partially initialized services when catalog loading fails", async () => {
    const listeners = new Map<string, (...args: any[]) => any>();
    setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any);
    const failure = new Error("agent scan failed");
    state.scanAndMerge.mockRejectedValueOnce(failure);

    await expect(listeners.get("session_start")!({}, createContext())).rejects.toBe(failure);
    expect(state.coordinators[0].dispose).toHaveBeenCalledOnce();
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.manager).toBeNull();
    expect(state.coordinator).toBeNull();
    expect(state.sessionCtx).toBeNull();
  });
});
