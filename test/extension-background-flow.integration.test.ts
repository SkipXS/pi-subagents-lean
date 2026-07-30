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

vi.mock("@earendil-works/pi-tui", () => {
  class Component {
    constructor(..._args: unknown[]) {}
    addChild(_child: unknown) {}
    clear() {}
    invalidate() {}
    render(_width: number) { return []; }
  }
  return {
    Box: Component,
    Container: Component,
    Spacer: Component,
    Text: Component,
    Input: Component,
    Markdown: Component,
    SelectList: Component,
    SettingsList: Component,
    matchesKey: () => false,
    isKeyRelease: () => false,
    isFocusable: () => true,
    truncateToWidth: (text: string) => text,
    visibleWidth: (text: string) => text.length,
    wrapTextWithAnsi: (text: string) => [text],
  };
});

import extension from "../src/index.js";
import { runAgent } from "../src/agents/agent-runner.js";
import {
  getCoordinator,
  getManager,
  getPiInstance,
  getSessionCtx,
  getSubagentRuntimeContext,
  setCoordinator,
  setManager,
} from "../src/shell.js";

interface OfflineSession {
  prompt: ReturnType<typeof vi.fn>;
  promptStarted: Promise<void>;
  setActiveToolsByName: ReturnType<typeof vi.fn>;
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
  const messageRenderers: string[] = [];
  return {
    tools,
    listeners,
    messageRenderers,
    api: {
      registerTool: vi.fn((tool: any) => tools.push(tool)),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn((customType: string) => messageRenderers.push(customType)),
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

describe("offline extension background flow", () => {
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
    expect(api.tools.map((tool) => tool.name)).toEqual(["Agent", "StopAgent", "AgentStatus"]);
    expect(api.messageRenderers).toContain("subagent-result");

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

    const firstSpawn = await agentTool.execute("call-1", {
      agent: "Scout",
      prompt: "Find the relevant files",
      run_in_background: true,
    }, undefined, undefined, ctx);
    expect(firstSpawn.isError).toBeUndefined();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    await vi.waitFor(() => expect(sessions[0].prompt).toHaveBeenCalledWith("Find the relevant files"));

    sessions[0].finish("First result");
    await vi.waitFor(() => expect(api.api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "subagent-result",
        content: expect.stringContaining("First result"),
        display: true,
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );

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
        content: expect.stringContaining("Second result"),
        display: true,
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

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

  it("keeps root lifecycle intact while nested proxy sessions load extensions in isolated contexts", async () => {
    const api = createOfflinePi();
    const sessions: OfflineSession[] = [];
    const setups: Array<{
      options: any;
      session: OfflineSession;
      extensionApi: ReturnType<typeof createOfflinePi>;
      runtime: ReturnType<typeof getSubagentRuntimeContext>;
    }> = [];
    const firstSetupEntered = createDeferred();
    const secondSetupEntered = createDeferred();
    const reviewerSetupEntered = createDeferred();
    const releaseFirstSetup = createDeferred();
    let creationCount = 0;

    boundary.createAgentSession.mockImplementation(async (options: any) => {
      const session = createOfflineSession();
      const extensionApi = createOfflinePi();
      const runtime = getSubagentRuntimeContext();
      setups.push({ options, session, extensionApi, runtime });
      sessions.push(session);

      // This is how Pi loads an extension while binding a child session. The
      // real AsyncLocalStorage context must make the root extension inert.
      extension(extensionApi.api as any);

      creationCount++;
      if (creationCount === 1) {
        firstSetupEntered.resolve();
        await releaseFirstSetup.promise;
      } else if (creationCount === 2) {
        secondSetupEntered.resolve();
      } else if (creationCount === 3) {
        reviewerSetupEntered.resolve();
      }
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

      // Keep the first session setup suspended while a second root agent starts.
      // The two actual AsyncLocalStorage contexts must retain separate parents.
      const firstRootResult = rootAgent.execute("root-1", {
        agent: "implementer",
        prompt: "Implement the change",
      }, undefined, undefined, ctx);
      await firstSetupEntered.promise;
      const secondRootResult = rootAgent.execute("root-2", {
        agent: "implementer",
        prompt: "Implement another change",
      }, undefined, undefined, ctx);
      await secondSetupEntered.promise;

      expect(setups).toHaveLength(2);
      for (const setup of setups) {
        expect(setup.runtime).toMatchObject({
          isChildRuntime: true,
          executeNestedAgent: expect.any(Function),
        });
        expect(Object.keys(setup.runtime!).sort()).toEqual(["executeNestedAgent", "isChildRuntime", "settings"]);
        expect(setup.runtime!.settings).toMatchObject({
          agent: expect.any(Object),
          modelFor: expect.any(Function),
          thinkingSettingFor: expect.any(Function),
        });
        expect(setup.runtime!.settings).not.toHaveProperty("mutate");
        expect(setup.runtime!.settings).not.toHaveProperty("store");
        expect(setup.runtime).not.toHaveProperty("manager");
        expect(setup.runtime).not.toHaveProperty("coordinator");
        expect(setup.runtime).not.toHaveProperty("pi");
        expect(setup.runtime).not.toHaveProperty("parentId");
        expect(setup.runtime).not.toHaveProperty("catalog");
        expect(setup.extensionApi.tools).toHaveLength(0);
        expect(setup.extensionApi.listeners).toHaveLength(0);
        expect(setup.options.resourceLoader.options.noExtensions).toBe(true);
        expect(setup.options.customTools.map((tool: any) => tool.name)).toEqual(["Agent"]);
      }
      expect(getPiInstance()).toBe(api.api);
      expect(getSessionCtx()).toBe(ctx);
      expect(getManager()).not.toBeNull();
      expect(getCoordinator()).not.toBeNull();
      expect(api.tools.map((tool) => tool.name)).toEqual(["Agent", "StopAgent", "AgentStatus"]);

      releaseFirstSetup.resolve();
      await Promise.all([setups[0].session.promptStarted, setups[1].session.promptStarted]);

      const implementerProxy = setups[0].options.customTools[0];
      const reviewerResult = implementerProxy.execute("nested-1", {
        agent: "reviewer",
        prompt: "Review the implementation",
      }, undefined, undefined, ctx);
      await reviewerSetupEntered.promise;

      const reviewer = setups[2];
      // The nested record remains attached to the implementer that invoked
      // the local proxy, although child runtime context exposes no parent ID.
      const manager = getManager()!;
      const reviewerRecord = manager.listAgents().find((record) => record.display.type === "reviewer")!;
      expect(reviewerRecord.hierarchy?.parentId).toEqual(expect.any(String));
      expect(manager.getRecord(reviewerRecord.hierarchy!.parentId!)!.display.type).toBe("implementer");
      expect(reviewer.runtime).toMatchObject({ isChildRuntime: true, executeNestedAgent: expect.any(Function) });
      expect(reviewer.runtime!.settings).toBe(setups[0].runtime!.settings);
      expect(reviewer.runtime).not.toHaveProperty("parentId");
      expect(reviewer.options.resourceLoader.options.noExtensions).toBe(true);
      expect(reviewer.options.customTools).toBeUndefined();
      expect(reviewer.options.tools).not.toContain("Agent");
      expect(reviewer.options.tools).not.toContain("StopAgent");
      expect(reviewer.options.tools).not.toContain("AgentStatus");
      expect(reviewer.extensionApi.tools).toHaveLength(0);
      expect(reviewer.extensionApi.listeners).toHaveLength(0);

      await reviewer.session.promptStarted;
      expect(reviewer.session.setActiveToolsByName).toHaveBeenLastCalledWith(["read", "grep"]);
      reviewer.session.finish("Reviewer result");
      const nestedResult = await reviewerResult;
      expect(nestedResult).toMatchObject({
        content: [expect.objectContaining({ text: expect.stringContaining("Reviewer result") })],
      });
      expect(nestedResult).not.toHaveProperty("isError");
      // The proxy re-enters its child ALS only for its bound call; neither the
      // foreground result nor its completion can leak into root delivery.
      expect(getSubagentRuntimeContext()).toBeUndefined();
      expect(api.api.sendMessage).not.toHaveBeenCalled();

      setups[0].session.finish("Implementer result");
      setups[1].session.finish("Second implementer result");
      await expect(firstRootResult).resolves.toMatchObject({
        content: [expect.objectContaining({ text: expect.stringContaining("Implementer result") })],
      });
      await expect(secondRootResult).resolves.toMatchObject({
        content: [expect.objectContaining({ text: expect.stringContaining("Second implementer result") })],
      });
      expect(api.api.sendMessage).not.toHaveBeenCalled();

      await listener(api, "session_shutdown")({}, ctx);
      started = false;
      expect(sessions).toHaveLength(3);
      expect(sessions.every((session) => session.dispose.mock.calls.length === 1)).toBe(true);
      expect(getManager()).toBeNull();
      expect(getCoordinator()).toBeNull();
    } finally {
      if (started) await listener(api, "session_shutdown")({}, ctx);
    }
  });
});
