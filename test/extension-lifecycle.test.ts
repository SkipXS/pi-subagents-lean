import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const state = vi.hoisted(() => ({
  manager: null as any,
  coordinator: null as any,
  managers: [] as any[],
  coordinators: [] as any[],
  managerConfigs: [] as any[],
  order: [] as string[],
  store: {
    agent: { disableDefaultAgents: false, orchestrationPrompt: true },
    concurrency: { default: 4 },
    reload: vi.fn(),
  },
  discover: vi.fn(),
  scanDirs: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/tmp/pi-agent" }));
vi.mock("../src/agents/agent-types.js", () => ({
  discoverNewAgents: state.discover,
  getAvailableAgents: () => [],
  setAgentScanDirs: state.scanDirs,
}));
vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class {
    dispose = vi.fn();
    setConcurrency = vi.fn((config: unknown) => {
      state.order.push("setConcurrency");
      state.managerConfigs.push(structuredClone(config));
    });
    constructor(concurrency: unknown) {
      state.order.push("construct");
      state.managerConfigs.push(structuredClone(concurrency));
      state.managers.push(this);
    }
    listAgents() { return []; }
  },
}));
vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class {
    constructor() { state.coordinators.push(this); }
  },
}));
vi.mock("../src/prompt/orchestration.js", () => ({ getOrchestrationPromptUpdate: () => undefined }));
vi.mock("../src/shell.js", () => ({
  getManager: () => state.manager,
  getCoordinator: () => state.coordinator,
  getStore: () => state.store,
  setSessionCtx: vi.fn(),
  setManager: (value: unknown) => { state.manager = value; },
  setCoordinator: (value: unknown) => { state.coordinator = value; },
}));

import { setupEventListeners } from "../src/events.js";
import { AgentRenderMetadataBridge } from "../src/agents/agent-render-bridge.js";
import { AGENT_RENDER_DETAILS_KEY, renderAgentCall } from "../src/agents/agent-renderer.js";

function context(): ExtensionContext {
  return { cwd: "/tmp/project", hasUI: false, isProjectTrusted: () => true } as unknown as ExtensionContext;
}

function normalizedConcurrency(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 64 ? raw : 4;
}

function listenersFor(bridge = new AgentRenderMetadataBridge()) {
  const listeners = new Map<string, (...args: any[]) => any>();
  setupEventListeners({ on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)) } as any, bridge);
  return { listeners, bridge };
}

describe("headless extension lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.manager = null;
    state.coordinator = null;
    state.managers.length = 0;
    state.coordinators.length = 0;
    state.managerConfigs.length = 0;
    state.order.length = 0;
    state.store.concurrency = { default: 4 };
    state.store.reload.mockReset().mockImplementation(() => { state.order.push("reload"); });
    state.discover.mockReset().mockResolvedValue(0);
    state.scanDirs.mockReset();
    vi.useRealTimers();
  });

  it("registers only host lifecycle and renderer bridge hooks", () => {
    const { listeners } = listenersFor();
    expect([...listeners.keys()]).toEqual([
      "tool_execution_start", "tool_execution_update", "tool_result", "message_end",
      "before_agent_start", "session_start", "session_shutdown",
    ]);
  });

  it("bridges resolved Agent metadata through tool_result and message_end", () => {
    const { listeners, bridge } = listenersFor();
    const metadata = { role: "reviewer", model: "provider/model", thinking: "high", prompt: "inspect", kind: "new" as const };
    listeners.get("tool_execution_start")!({ toolCallId: "call", toolName: "Agent" });
    listeners.get("tool_execution_update")!({
      toolCallId: "call", toolName: "Agent", partialResult: { details: { [AGENT_RENDER_DETAILS_KEY]: metadata } },
    });
    const patched = listeners.get("tool_result")!({ toolName: "Agent", toolCallId: "call", details: {} });
    expect(patched.details[AGENT_RENDER_DETAILS_KEY]).toEqual(metadata);
    listeners.get("message_end")!({ message: { role: "toolResult", toolCallId: "call", toolName: "Agent", details: patched.details } });
    expect(bridge.pendingCount()).toBe(0);
  });

  it("reloads before constructing a new manager and passes reloaded concurrency", async () => {
    state.store.reload.mockImplementationOnce(() => {
      state.order.push("reload");
      state.store.concurrency = { default: normalizedConcurrency(9) };
    });
    const { listeners } = listenersFor();

    await listeners.get("session_start")!({}, context());

    expect(state.order).toEqual(["reload", "construct"]);
    expect(state.managerConfigs).toEqual([{ default: 9 }]);
    await listeners.get("session_shutdown")!({}, context());
  });

  it("reloads and updates an existing manager without reconstructing it", async () => {
    state.store.reload
      .mockImplementationOnce(() => {
        state.order.push("reload");
        state.store.concurrency = { default: normalizedConcurrency(2) };
      })
      .mockImplementationOnce(() => {
        state.order.push("reload");
        state.store.concurrency = { default: normalizedConcurrency(999) };
      });
    const { listeners } = listenersFor();

    await listeners.get("session_start")!({}, context());
    const manager = state.manager;
    await listeners.get("session_start")!({}, context());

    expect(state.managers).toHaveLength(1);
    expect(manager.setConcurrency).toHaveBeenCalledOnce();
    expect(manager.setConcurrency).toHaveBeenCalledWith({ default: 4 });
    expect(state.managerConfigs).toEqual([{ default: 2 }, { default: 4 }]);
    expect(state.order).toEqual(["reload", "construct", "reload", "setConcurrency"]);
    await listeners.get("session_shutdown")!({}, context());
  });

  it("keeps renderer rows timer-free across session reload and shutdown", async () => {
    vi.useFakeTimers();
    const { listeners } = listenersFor();
    await listeners.get("session_start")!({}, context());

    const rowContext: any = {
      args: { agent: "scout", prompt: "reload me" },
      state: {},
      lastComponent: undefined,
      invalidate: vi.fn(),
    };
    const row = renderAgentCall(rowContext.args, {}, rowContext);
    expect(row.render(200)[0]).toContain("Role: scout");
    expect(vi.getTimerCount()).toBe(0);

    await listeners.get("session_start")!({}, context());
    await listeners.get("session_shutdown")!({}, context());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish stale startup state after shutdown and restart", async () => {
    let releaseScan!: () => void;
    state.discover
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseScan = resolve; }))
      .mockResolvedValue(0);
    const { listeners } = listenersFor();
    const firstStartup = listeners.get("session_start")!({}, context());
    await vi.waitFor(() => expect(state.discover).toHaveBeenCalledOnce());

    await listeners.get("session_shutdown")!({}, context());
    const restart = listeners.get("session_start")!({}, context());
    await restart;
    const restartedManager = state.manager;
    const restartedCoordinator = state.coordinator;

    releaseScan();
    await firstStartup;
    expect(state.manager).toBe(restartedManager);
    expect(state.coordinator).toBe(restartedCoordinator);
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.managers[1].dispose).not.toHaveBeenCalled();

    await listeners.get("session_shutdown")!({}, context());
  });

  it("serializes overlapping shutdown epochs without letting the older one own cleanup", async () => {
    const { listeners } = listenersFor();
    await listeners.get("session_start")!({}, context());
    const firstManager = state.manager;
    let releaseDispose!: () => void;
    firstManager.dispose.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseDispose = resolve; }));

    const firstShutdown = listeners.get("session_shutdown")!({}, context());
    await vi.waitFor(() => expect(firstManager.dispose).toHaveBeenCalledOnce());
    const secondShutdown = listeners.get("session_shutdown")!({}, context());
    const restart = listeners.get("session_start")!({}, context());
    expect(state.manager).toBe(firstManager);

    releaseDispose();
    await firstShutdown;
    await secondShutdown;
    await restart;

    expect(firstManager.dispose).toHaveBeenCalledOnce();
    expect(state.manager).not.toBe(firstManager);
    await listeners.get("session_shutdown")!({}, context());
  });

  it("creates root services on session start and disposes the manager on shutdown", async () => {
    const { listeners } = listenersFor();
    await listeners.get("session_start")!({}, context());
    expect(state.managers).toHaveLength(1);
    expect(state.coordinators).toHaveLength(1);
    expect(state.store.reload).toHaveBeenCalledOnce();

    await listeners.get("session_shutdown")!({}, context());
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.coordinators[0]).not.toHaveProperty("dispose");
  });

});
