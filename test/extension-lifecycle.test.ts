import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const state = vi.hoisted(() => ({
  manager: null as any,
  coordinator: null as any,
  managers: [] as any[],
  coordinators: [] as any[],
  store: {
    agent: { disableDefaultAgents: false, orchestrationPrompt: true },
    concurrency: { default: 4 },
    reload: vi.fn(),
    setDeps: vi.fn(),
    dispose: vi.fn(),
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
    constructor() { state.managers.push(this); }
    listAgents() { return []; }
    setConcurrency = vi.fn();
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
import { AGENT_RENDER_DETAILS_KEY, renderAgentCall, stopAgentRendererTimers } from "../src/agents/agent-renderer.js";

function context(): ExtensionContext {
  return { cwd: "/tmp/project", hasUI: false, isProjectTrusted: () => true } as unknown as ExtensionContext;
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
    state.store.dispose.mockReset();
    state.store.reload.mockReset();
    state.store.setDeps.mockReset();
    state.discover.mockReset().mockResolvedValue(0);
    state.scanDirs.mockReset();
    stopAgentRendererTimers();
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

  it("clears interactive row timers when a session reloads", async () => {
    vi.useFakeTimers();
    const { listeners } = listenersFor();
    await listeners.get("session_start")!({}, context());

    const rowContext: any = {
      args: { agent: "scout", prompt: "reload me" },
      state: {},
      lastComponent: undefined,
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
    };
    rowContext.invalidate = vi.fn(() => renderAgentCall(rowContext.args, {}, rowContext));
    const unopened = renderAgentCall(rowContext.args, {}, rowContext);
    rowContext.lastComponent = unopened;
    rowContext.executionStarted = true;
    renderAgentCall(rowContext.args, {}, rowContext);
    expect(vi.getTimerCount()).toBe(1);

    await listeners.get("session_start")!({}, context());
    expect(vi.getTimerCount()).toBe(0);
    await listeners.get("session_shutdown")!({}, context());
    vi.useRealTimers();
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
    state.store.dispose.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseDispose = resolve; }));

    const firstShutdown = listeners.get("session_shutdown")!({}, context());
    await vi.waitFor(() => expect(state.store.dispose).toHaveBeenCalledOnce());
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
    expect(state.store.dispose).toHaveBeenCalledOnce();
    expect(state.managers[0].dispose).toHaveBeenCalledOnce();
    expect(state.coordinators[0]).not.toHaveProperty("dispose");
  });

  it("stops interactive row timers during session shutdown", async () => {
    vi.useFakeTimers();
    const { listeners } = listenersFor();
    const rowContext: any = {
      args: { agent: "scout", prompt: "inspect" },
      state: {},
      lastComponent: undefined,
      executionStarted: false,
      isPartial: true,
      invalidate: vi.fn(),
    };
    rowContext.invalidate = vi.fn(() => renderAgentCall(rowContext.args, {}, rowContext));
    const first = renderAgentCall(rowContext.args, {}, rowContext);
    rowContext.lastComponent = first;
    rowContext.executionStarted = true;
    renderAgentCall(rowContext.args, {}, rowContext);
    expect(vi.getTimerCount()).toBe(1);
    await listeners.get("session_shutdown")!({}, context());
    expect(vi.getTimerCount()).toBe(0);
  });
});
