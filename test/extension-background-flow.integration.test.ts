import { describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  clampThinkingLevel: (_model: unknown, level: unknown) => level,
  getSupportedThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/offline/pi-agent",
  createAgentSession: boundary.createAgentSession,
  DefaultResourceLoader: class {
    constructor(readonly options: any) {}
    reload = vi.fn(async () => undefined);
    getExtensions = vi.fn(() => ({ extensions: [], errors: [], runtime: {} }));
  },
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { create: vi.fn(() => ({})) },
  loadProjectContextFiles: vi.fn(() => []),
  DynamicBorder: class {},
}));

import extension from "../src/index.js";
import { AGENT_RENDER_DETAILS_KEY } from "../src/agents/agent-renderer.js";
import { runAgent } from "../src/agents/agent-runner.js";
import {
  createSubagentRuntimeContext,
  getCoordinator,
  getManager,
  getPiInstance,
  getSessionCtx,
  getStore,
  getSubagentRuntimeContext,
  runWithSubagentRuntime,
  setCoordinator,
  setManager,
} from "../src/shell.js";

interface OfflineSession {
  prompt: ReturnType<typeof vi.fn>;
  promptStarted: Promise<void>;
  setActiveToolsByName: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  finish: (text: string) => void;
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createOfflineSession(): OfflineSession & Record<string, unknown> {
  const listeners: Array<(event: any) => void> = [];
  const promptStarted = createDeferred();
  let finishPrompt!: () => void;
  const prompt = vi.fn(() => {
    promptStarted.resolve();
    return new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
  });
  const emit = (event: any) => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = {
    agent: {},
    messages: [] as any[],
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => undefined),
    getActiveToolNames: vi.fn(() => ["read", "grep", "Agent", "StopAgent", "AgentStatus"]),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    prompt,
    promptStarted: promptStarted.promise,
    steer: vi.fn(async () => undefined),
    abort: vi.fn(),
    dispose: vi.fn(),
    finish: (text: string) => {
      emit({ type: "message_start" });
      emit({ type: "tool_execution_start", toolName: "read" });
      emit({ type: "tool_execution_end", toolName: "read" });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text }] });
      emit({ type: "turn_end" });
      finishPrompt();
    },
  };
  return session;
}

function createOfflinePi() {
  const tools: any[] = [];
  const listeners: Array<{ event: string; handler: (...args: any[]) => any }> = [];
  return {
    tools,
    listeners,
    api: {
      registerTool: vi.fn((tool: any) => tools.push(tool)),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.push({ event, handler })),
      exec: vi.fn(async () => ({ code: 1, stdout: "" })),
      sendMessage: vi.fn(),
    },
  };
}

function listener(api: ReturnType<typeof createOfflinePi>, event: string) {
  const handler = api.listeners.find((entry) => entry.event === event)?.handler;
  if (!handler) throw new Error(`Missing ${event} listener`);
  return handler;
}

describe("offline extension headless lifecycle", () => {
  it("runs registered background agents through completion delivery and shutdown", async () => {
    const api = createOfflinePi();
    const sessions: OfflineSession[] = [];
    boundary.createAgentSession.mockImplementation(async () => {
      const session = createOfflineSession();
      sessions.push(session);
      return { session };
    });
    let parentIdle = true;
    const ctx = {
      cwd: "/offline/project",
      hasUI: false,
      isIdle: () => parentIdle,
      isProjectTrusted: () => false,
      model: { provider: "offline", id: "test-model" },
      modelRegistry: {
        find: vi.fn(() => ({ provider: "offline", id: "test-model" })),
        getAvailable: vi.fn(() => []),
      },
      getSystemPrompt: () => "parent prompt",
      ui: { notify: vi.fn() },
    };

    extension(api.api as any);
    expect(api.tools.map((tool) => tool.name)).toEqual(["Agent", "AgentContinue", "StopAgent", "AgentStatus"]);

    const agentTool = api.tools.find((tool) => tool.name === "Agent")!;
    const stopAgentTool = api.tools.find((tool) => tool.name === "StopAgent")!;
    const agentStatusTool = api.tools.find((tool) => tool.name === "AgentStatus")!;
    const beforeStart = await Promise.allSettled([
      agentTool.execute("before-agent", { agent: "Scout", prompt: "must not start" }, undefined, undefined, ctx),
      stopAgentTool.execute("before-stop", { agent_id: "missing" }, undefined, undefined, ctx),
      agentStatusTool.execute("before-status", {}, undefined, undefined, ctx),
    ]);
    expect(beforeStart.every((result) => result.status === "rejected")).toBe(true);
    expect(sessions).toHaveLength(0);
    expect(api.api.sendMessage).not.toHaveBeenCalled();

    await listener(api, "session_start")({}, ctx);
    expect(getManager()).not.toBeNull();
    expect(getCoordinator()).not.toBeNull();

    const manager = getManager()!;
    const coordinator = getCoordinator()!;
    setCoordinator(null);
    const managerOnly = await Promise.allSettled([
      agentTool.execute("manager-only-agent", { agent: "Scout", prompt: "must not start" }, undefined, undefined, ctx),
      stopAgentTool.execute("manager-only-stop", { agent_id: "missing" }, undefined, undefined, ctx),
      agentStatusTool.execute("manager-only-status", {}, undefined, undefined, ctx),
    ]);
    expect(managerOnly.every((result) => result.status === "rejected")).toBe(true);

    setCoordinator(coordinator);
    setManager(null);
    const coordinatorOnly = await Promise.allSettled([
      agentTool.execute("coordinator-only-agent", { agent: "Scout", prompt: "must not start" }, undefined, undefined, ctx),
      stopAgentTool.execute("coordinator-only-stop", { agent_id: "missing" }, undefined, undefined, ctx),
      agentStatusTool.execute("coordinator-only-status", {}, undefined, undefined, ctx),
    ]);
    expect(coordinatorOnly.every((result) => result.status === "rejected")).toBe(true);
    expect(sessions).toHaveLength(0);
    expect(api.api.sendMessage).not.toHaveBeenCalled();
    setManager(manager);

    expect(agentTool).toBeDefined();
    const backgroundOnUpdate = vi.fn();

    const firstSpawn = await agentTool.execute("call-1", {
      agent: "Scout",
      prompt: "Find the relevant files",
      run_in_background: true,
    }, undefined, backgroundOnUpdate, ctx);
    expect(firstSpawn.isError).toBeUndefined();
    expect(firstSpawn.content[0].text).toBe(
      `Agent ID: ${firstSpawn.details.agentId}\n\n[Agent running] A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.`,
    );
    expect(firstSpawn.content[0].text).not.toContain("Response:");
    expect(backgroundOnUpdate).toHaveBeenCalled();
    expect(backgroundOnUpdate.mock.calls.every(([update]) =>
      update?.details?.[AGENT_RENDER_DETAILS_KEY]?.agentId === undefined,
    )).toBe(true);
    expect(api.api.sendMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    await vi.waitFor(() => expect(sessions[0].prompt).toHaveBeenCalledWith("Find the relevant files"));

    const runningStatus = await agentStatusTool.execute("status-running", {}, undefined, undefined, ctx);
    expect(runningStatus.content[0].text).toContain(" running");

    sessions[0].finish("First result");
    await vi.waitFor(() => expect(api.api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "subagent-result",
        content: expect.stringContaining("\n\nResponse:\nFirst result"),
        display: true,
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    const firstNotification = api.api.sendMessage.mock.calls.at(-1)![0];
    expect(firstNotification.content).toMatch(
      new RegExp(`^\\[${firstNotification.details.agentId.slice(0, 8)}\\]`),
    );
    const firstNotificationRecord = getManager()!.listAgents().find(
      (record) => (record.execution.session as unknown) === sessions[0],
    )!;
    expect(firstNotification.details.agentId).toBe(firstNotificationRecord.id);
    const completedStatus = await agentStatusTool.execute("status-completed", {}, undefined, undefined, ctx);
    expect(completedStatus.content[0].text).toContain(" completed");

    parentIdle = false;
    await agentTool.execute("call-2", {
      agent: "Scout",
      prompt: "Find the busy-session result",
      run_in_background: true,
    }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    await vi.waitFor(() => expect(sessions[1].prompt).toHaveBeenCalledWith("Find the busy-session result"));

    sessions[1].finish("Second result");
    await vi.waitFor(() => expect(api.api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "subagent-result",
        content: expect.stringContaining("\n\nResponse:\nSecond result"),
        display: true,
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    // AgentContinue: continue the finished first agent in the background. It
    // reuses its retained session, acknowledges immediately, and delivers
    // exactly one automatic completion for the new execution.
    const agentContinueTool = api.tools.find((tool) => tool.name === "AgentContinue")!;
    const firstRecord = getManager()!.listAgents().find((r) => (r.execution.session as unknown) === sessions[0])!;
    const continueAck = await agentContinueTool.execute("continue-1", {
      agent_id: firstRecord.id,
      prompt: "Wrap up the findings",
      run_in_background: true,
    }, undefined, undefined, ctx);
    expect(continueAck.isError).toBeUndefined();
    expect(continueAck.content[0].text).toBe(
      `Agent ID: ${firstRecord.id}\n\n[AgentContinue] A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.`,
    );
    // Immediate acknowledgement: no new session or completion message is created.
    expect(sessions).toHaveLength(2);
    expect(api.api.sendMessage).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(sessions[0].prompt).toHaveBeenCalledWith("Wrap up the findings"));

    sessions[0].finish("Continued result");
    await vi.waitFor(() => expect(api.api.sendMessage).toHaveBeenCalledTimes(3));
    expect(api.api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "subagent-result",
        content: expect.stringContaining("\n\nResponse:\nContinued result"),
        display: true,
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    // A foreground continuation on the same record awaits its execution delta.
    const fgContinue = agentContinueTool.execute("continue-2", {
      agent_id: firstRecord.id,
      prompt: "Synthesize the outcome",
    }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(sessions[0].prompt).toHaveBeenCalledWith("Synthesize the outcome"));
    let fgSettled = false;
    fgContinue.then(() => { fgSettled = true; });
    await Promise.resolve();
    expect(fgSettled).toBe(false); // foreground awaits the execution
    sessions[0].finish("FG result");
    const fgResult = await fgContinue;
    expect(fgResult.isError).toBeUndefined();
    expect(fgResult.content[0].text).toBe(`Agent ID: ${firstRecord.id}\n\nResponse:\nFG result`);
    // Foreground completions never produce a notification.
    expect(api.api.sendMessage).toHaveBeenCalledTimes(3);

    await listener(api, "session_shutdown")({}, ctx);
    expect(sessions.every((session) => session.dispose.mock.calls.length === 1)).toBe(true);
    expect(getManager()).toBeNull();
    expect(getCoordinator()).toBeNull();

    const sendMessageCalls = api.api.sendMessage.mock.calls.length;
    const sessionCount = sessions.length;
    const afterShutdown = await Promise.allSettled([
      agentTool.execute("after-agent", { agent: "Scout", prompt: "must not start" }, undefined, undefined, ctx),
      stopAgentTool.execute("after-stop", { agent_id: "missing" }, undefined, undefined, ctx),
      agentStatusTool.execute("after-status", {}, undefined, undefined, ctx),
    ]);
    expect(afterShutdown.every((result) => result.status === "rejected")).toBe(true);
    expect(sessions).toHaveLength(sessionCount);
    expect(api.api.sendMessage).toHaveBeenCalledTimes(sendMessageCalls);
  });

  it("keeps an initial foreground run headless until its final result", async () => {
    const api = createOfflinePi();
    const sessions: OfflineSession[] = [];
    boundary.createAgentSession.mockImplementation(async () => {
      const session = createOfflineSession();
      sessions.push(session);
      return { session };
    });
    const ctx = {
      cwd: "/offline/project",
      hasUI: false,
      isIdle: () => true,
      isProjectTrusted: () => false,
      model: { provider: "offline", id: "test-model" },
      modelRegistry: {
        find: vi.fn(() => ({ provider: "offline", id: "test-model" })),
        getAvailable: vi.fn(() => []),
      },
      getSystemPrompt: () => "parent prompt",
      ui: { notify: vi.fn() },
    };

    extension(api.api as any);
    const agentTool = api.tools.find((tool) => tool.name === "Agent")!;
    const agentStatusTool = api.tools.find((tool) => tool.name === "AgentStatus")!;
    let started = false;
    try {
      await listener(api, "session_start")({}, ctx);
      started = true;

      const foregroundOnUpdate = vi.fn();
      const foreground = agentTool.execute("foreground", {
        agent: "Scout",
        prompt: "Return the foreground result",
      }, undefined, foregroundOnUpdate, ctx);
      await vi.waitFor(() => expect(sessions).toHaveLength(1));
      await sessions[0].promptStarted;
      const acceptedRecord = getManager()!.listAgents().find(
        (record) => (record.execution.session as unknown) === sessions[0],
      )!;

      // The foreground execution is still blocked in its delayed prompt. The
      // accepted record ID must already have reached the row renderer.
      expect(foregroundOnUpdate).toHaveBeenCalledWith({
        content: [],
        details: {
          [AGENT_RENDER_DETAILS_KEY]: expect.objectContaining({
            agentId: acceptedRecord.id,
            mode: "foreground",
            kind: "new",
          }),
        },
      });

      let settled = false;
      foreground.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(api.api.sendMessage).not.toHaveBeenCalled();

      const running = await agentStatusTool.execute("status-running", {}, undefined, undefined, ctx);
      expect(running.content[0].text).toContain(" running");

      sessions[0].finish("Foreground result");
      const result = await foreground;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(`Agent ID: ${result.details.agentId}\n\nResponse:\nForeground result`);
      expect(api.api.sendMessage).not.toHaveBeenCalled();

      const completed = await agentStatusTool.execute("status-completed", {}, undefined, undefined, ctx);
      expect(completed.content[0].text).toContain(" completed");
    } finally {
      if (started) await listener(api, "session_shutdown")({}, ctx);
    }
  });

  it("stops running and queued root agents through the headless tools", async () => {
    const api = createOfflinePi();
    const sessions: OfflineSession[] = [];
    boundary.createAgentSession.mockImplementation(async () => {
      const session = createOfflineSession();
      sessions.push(session);
      return { session };
    });
    const ctx = {
      cwd: "/offline/project",
      hasUI: false,
      isIdle: () => true,
      isProjectTrusted: () => false,
      model: { provider: "offline", id: "test-model" },
      modelRegistry: {
        find: vi.fn(() => ({ provider: "offline", id: "test-model" })),
        getAvailable: vi.fn(() => []),
      },
      getSystemPrompt: () => "parent prompt",
      ui: { notify: vi.fn() },
    };

    extension(api.api as any);
    const agentTool = api.tools.find((tool) => tool.name === "Agent")!;
    const stopAgentTool = api.tools.find((tool) => tool.name === "StopAgent")!;
    const agentStatusTool = api.tools.find((tool) => tool.name === "AgentStatus")!;
    let started = false;
    try {
      await listener(api, "session_start")({}, ctx);
      started = true;
      const manager = getManager()!;
      manager.setConcurrency({ default: 1 });

      await agentTool.execute("running", {
        agent: "Scout",
        prompt: "Keep the running agent active",
        run_in_background: true,
      }, undefined, undefined, ctx);
      await sessions[0].promptStarted;
      const runningRecord = manager.listAgents().find((record) => (record.execution.session as unknown) === sessions[0])!;

      await agentTool.execute("queued", {
        agent: "Scout",
        prompt: "Wait in the root queue",
        run_in_background: true,
      }, undefined, undefined, ctx);
      const queuedRecord = manager.listAgents().find((record) => record.lifecycle.status === "queued")!;

      const activeStatuses = await agentStatusTool.execute("status-active", {}, undefined, undefined, ctx);
      expect(activeStatuses.content[0].text).toContain(" running");
      expect(activeStatuses.content[0].text).toContain(" queued");

      const queuedStop = await stopAgentTool.execute("stop-queued", {
        agent_id: queuedRecord.id,
      }, undefined, undefined, ctx);
      expect(queuedStop.isError).toBeUndefined();
      expect(queuedStop.content[0].text).toContain("Stopped agent");
      expect(queuedRecord.lifecycle.status).toBe("stopped");

      sessions[0].abort.mockImplementation(() => sessions[0].finish("stopped result"));
      const runningStop = await stopAgentTool.execute("stop-running", {
        agent_id: runningRecord.id,
      }, undefined, undefined, ctx);
      expect(runningStop.isError).toBeUndefined();
      expect(runningStop.content[0].text).toContain("Stopped agent");
      expect(runningRecord.lifecycle.status).toBe("stopped");
      expect(sessions[0].abort).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(runningRecord.lifecycle.settled).toBe(true));

      const stoppedStatuses = await agentStatusTool.execute("status-stopped", {}, undefined, undefined, ctx);
      expect(stoppedStatuses.content[0].text).toContain(" stopped");
    } finally {
      if (started) await listener(api, "session_shutdown")({}, ctx);
    }
  });

  it("shuts down active and queued root work without result delivery", async () => {
    const api = createOfflinePi();
    const sessions: OfflineSession[] = [];
    boundary.createAgentSession.mockImplementation(async () => {
      const session = createOfflineSession();
      sessions.push(session);
      return { session };
    });
    const ctx = {
      cwd: "/offline/project",
      hasUI: false,
      isIdle: () => true,
      isProjectTrusted: () => false,
      model: { provider: "offline", id: "test-model" },
      modelRegistry: {
        find: vi.fn(() => ({ provider: "offline", id: "test-model" })),
        getAvailable: vi.fn(() => []),
      },
      getSystemPrompt: () => "parent prompt",
      ui: { notify: vi.fn() },
    };

    extension(api.api as any);
    const agentTool = api.tools.find((tool) => tool.name === "Agent")!;
    const agentStatusTool = api.tools.find((tool) => tool.name === "AgentStatus")!;
    let started = false;
    try {
      await listener(api, "session_start")({}, ctx);
      started = true;
      const manager = getManager()!;
      manager.setConcurrency({ default: 1 });

      await agentTool.execute("shutdown-running", {
        agent: "Scout",
        prompt: "Remain active until shutdown",
        run_in_background: true,
      }, undefined, undefined, ctx);
      await sessions[0].promptStarted;
      const activeRecord = manager.listAgents().find((record) => (record.execution.session as unknown) === sessions[0])!;

      await agentTool.execute("shutdown-queued", {
        agent: "Scout",
        prompt: "Remain queued until shutdown",
        run_in_background: true,
      }, undefined, undefined, ctx);
      const queuedRecord = manager.listAgents().find((record) => record.lifecycle.status === "queued")!;
      const statuses = await agentStatusTool.execute("status-before-shutdown", {}, undefined, undefined, ctx);
      expect(statuses.content[0].text).toContain(" running");
      expect(statuses.content[0].text).toContain(" queued");

      sessions[0].abort.mockImplementation(() => sessions[0].finish("shutdown result"));
      await listener(api, "session_shutdown")({}, ctx);
      started = false;

      expect(sessions[0].abort).toHaveBeenCalledOnce();
      expect(sessions[0].dispose).toHaveBeenCalledOnce();
      expect(queuedRecord.execution.session).toBeUndefined();
      expect(activeRecord.execution.session).toBeUndefined();
      expect(manager.listAgents()).toHaveLength(0);
      expect(getManager()).toBeNull();
      expect(getCoordinator()).toBeNull();
      expect(api.api.sendMessage).not.toHaveBeenCalled();
    } finally {
      if (started) await listener(api, "session_shutdown")({}, ctx);
    }
  });

  it("rejects direct nested execution even when a caller supplies detached settings", async () => {
    const settings = getStore().createSubagentRuntimeSettings();
    await expect(runWithSubagentRuntime(
      createSubagentRuntimeContext(),
      () => runAgent({} as any, "implementer", "nested", { pi: {} as any, runtimeSettings: settings }),
    )).rejects.toThrow("Nested agent execution is unavailable from a child runtime");
  });

  it("isolates a direct executor-less run before extension loading", async () => {
    const api = createOfflinePi();
    const childApi = createOfflinePi();
    const session = createOfflineSession();
    let observedRuntime: ReturnType<typeof getSubagentRuntimeContext>;
    let sessionOptions: any;
    boundary.createAgentSession.mockImplementation(async (options: any) => {
      sessionOptions = options;
      observedRuntime = getSubagentRuntimeContext();
      // Simulate Pi binding this extension while the direct child session is
      // initialized. Its entry point must be inert in the child ALS context.
      extension(childApi.api as any);
      return { session };
    });
    const ctx = {
      cwd: "/offline/project",
      hasUI: false,
      isIdle: () => true,
      isProjectTrusted: () => false,
      model: { provider: "offline", id: "test-model" },
      modelRegistry: {
        find: vi.fn(() => ({ provider: "offline", id: "test-model" })),
        getAvailable: vi.fn(() => []),
      },
      getSystemPrompt: () => "parent prompt",
      ui: { notify: vi.fn() },
    };

    extension(api.api as any);
    let started = false;
    try {
      await listener(api, "session_start")({}, ctx);
      started = true;
      const rootTools = [...api.tools];
      const rootListeners = [...api.listeners];
      const rootManager = getManager();
      const rootCoordinator = getCoordinator();

      // This legacy/direct call has neither an accepted parent ID nor a
      // nested executor, but its resource/session extension setup is isolated.
      const run = runAgent(ctx as any, "implementer", "Inspect directly", { pi: api.api as any });
      await session.promptStarted;

      expect(observedRuntime).toMatchObject({ isChildRuntime: true });
      expect(observedRuntime).not.toHaveProperty("executeNestedAgent");
      expect(sessionOptions.customTools).toBeUndefined();
      expect(sessionOptions.tools).not.toContain("Agent");
      expect(session.setActiveToolsByName).toHaveBeenLastCalledWith(expect.not.arrayContaining(["Agent"]));
      expect(childApi.tools).toHaveLength(0);
      expect(childApi.listeners).toHaveLength(0);
      expect(api.tools).toEqual(rootTools);
      expect(api.listeners).toEqual(rootListeners);
      expect(getPiInstance()).toBe(api.api);
      expect(getSessionCtx()).toBe(ctx);
      expect(getManager()).toBe(rootManager);
      expect(getCoordinator()).toBe(rootCoordinator);

      session.finish("Direct result");
      await expect(run).resolves.toMatchObject({ responseText: "Direct result" });
    } finally {
      if (started) await listener(api, "session_shutdown")({}, ctx);
    }
  });

  it("keeps concurrent root sessions isolated and never supplies an Agent proxy", async () => {
    const api = createOfflinePi();
    const sessions: OfflineSession[] = [];
    const runtimes: Array<{ options: any; runtime: ReturnType<typeof getSubagentRuntimeContext>; extensionApi: ReturnType<typeof createOfflinePi> }> = [];

    boundary.createAgentSession.mockImplementation(async (options: any) => {
      const session = createOfflineSession();
      const extensionApi = createOfflinePi();
      runtimes.push({ options, runtime: getSubagentRuntimeContext(), extensionApi });
      sessions.push(session);
      // Pi binds the extension while the session is initialized. ALS must make
      // that registration inert without sharing root state between runs.
      extension(extensionApi.api as any);
      return { session };
    });

    const ctx = {
      cwd: "/offline/project",
      hasUI: false,
      isIdle: () => true,
      isProjectTrusted: () => false,
      model: { provider: "offline", id: "test-model" },
      modelRegistry: {
        find: vi.fn(() => ({ provider: "offline", id: "test-model" })),
        getAvailable: vi.fn(() => []),
      },
      getSystemPrompt: () => "parent prompt",
      ui: { notify: vi.fn() },
    };

    extension(api.api as any);
    let started = false;
    try {
      await listener(api, "session_start")({}, ctx);
      started = true;
      const rootAgent = api.tools.find((tool) => tool.name === "Agent")!;
      const first = rootAgent.execute("root-1", { agent: "implementer", prompt: "first root" }, undefined, undefined, ctx);
      await vi.waitFor(() => expect(runtimes).toHaveLength(1));
      const second = rootAgent.execute("root-2", { agent: "scout", prompt: "second root" }, undefined, undefined, ctx);
      await vi.waitFor(() => expect(runtimes).toHaveLength(2));

      expect(api.tools.map((tool) => tool.name)).toEqual(["Agent", "AgentContinue", "StopAgent", "AgentStatus"]);
      for (const setup of runtimes) {
        expect(setup.runtime).toMatchObject({ isChildRuntime: true });
        expect(Object.keys(setup.runtime!)).toEqual(["isChildRuntime"]);
        expect(setup.options.customTools).toBeUndefined();
        expect(setup.options.tools).not.toContain("Agent");
        expect(setup.extensionApi.tools).toHaveLength(0);
        expect(setup.extensionApi.listeners).toHaveLength(0);
        expect(setup.options.resourceLoader.options.noExtensions).toBe(true);
      }
      expect(getPiInstance()).toBe(api.api);
      expect(getSessionCtx()).toBe(ctx);
      expect(getManager()).not.toBeNull();
      expect(getCoordinator()).not.toBeNull();

      sessions[0]!.finish("First result");
      sessions[1]!.finish("Second result");
      await expect(first).resolves.toMatchObject({ content: [expect.objectContaining({ text: expect.stringContaining("First result") })] });
      await expect(second).resolves.toMatchObject({ content: [expect.objectContaining({ text: expect.stringContaining("Second result") })] });
      expect(api.api.sendMessage).not.toHaveBeenCalled();
    } finally {
      if (started) await listener(api, "session_shutdown")({}, ctx);
    }
  });
});
