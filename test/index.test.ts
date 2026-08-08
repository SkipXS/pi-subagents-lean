import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedSpawnFixture } from "./fixtures.ts";
import { createMockExtensionAPI, loadExtension, type MockExtensionAPI } from "./fixtures";

const boundary = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loadChildExtension: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(() => "/home/test/.pi/agent"),
  createAgentSession: boundary.createAgentSession,
  DefaultResourceLoader: class {
    constructor(readonly options: any) {}
    reload = vi.fn(async () => boundary.loadChildExtension());
    getExtensions = vi.fn(() => ({ extensions: [], errors: [], runtime: {} }));
  },
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { create: vi.fn(() => ({})) },
  loadProjectContextFiles: vi.fn(() => []),
}));

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
  setPiInstance,
  setSessionCtx,
} from "../src/shell.js";

function tool(api: MockExtensionAPI, name: string) {
  return api.tools.find((candidate) => candidate.name === name)!;
}

describe("public foreground tool contracts", () => {
  let api: MockExtensionAPI;

  it("registers exactly Agent and AgentContinue", async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
    expect(api.tools.map((candidate) => candidate.name)).toEqual(["Agent", "AgentContinue"]);
    expect(api.api.registerTool).toHaveBeenCalledTimes(2);
  });

  it("exposes the exact strict Agent schema and description", async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
    const definition = tool(api, "Agent");
    expect(definition.description).toBe(
      "Delegate to a context-isolated specialized agent and wait for its result. It cannot see the parent conversation, parent tool results, or other agents' output, so its prompt must be self-contained.",
    );
    expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["prompt", "agent"],
      properties: {
        prompt: { type: "string", maxLength: 262144 },
        agent: { type: "string" },
        description: { type: "string", maxLength: 8192 },
        worktree_path: { type: "string" },
      },
    });
    expect(definition.renderCall).toEqual(expect.any(Function));
    expect(definition.renderResult).toEqual(expect.any(Function));
  });

  it("exposes the exact strict AgentContinue schema and sampling preference", async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
    const definition = tool(api, "AgentContinue");
    expect(definition.description).toBe("Continue a finished agent's session with a new prompt and wait for its result.");
    expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "prompt"],
      properties: {
        agent_id: { type: "string", maxLength: 128 },
        prompt: { type: "string", maxLength: 262144 },
      },
    });
    expect(definition.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(definition.renderCall).toEqual(expect.any(Function));
    expect(definition.renderResult).toEqual(expect.any(Function));
  });

  it("rejects the removed property at the strict schema boundary", async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
    const definition = tool(api, "Agent");
    const removedProperty = ["removed", "execution", "switch"].join("_");
    expect(Object.hasOwn(definition.parameters.properties, removedProperty)).toBe(false);
    expect(definition.parameters.additionalProperties).toBe(false);
    expect(tool(api, "AgentContinue").parameters.additionalProperties).toBe(false);
  });

  it("keeps the throwing pre-abort contract", async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
    const controller = new AbortController();
    controller.abort();
    await expect(tool(api, "Agent").execute!("call", {}, controller.signal, undefined, {})).rejects.toThrow("Agent execution cancelled");
  });

  it("does not register a custom message renderer", async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
    expect((api.api as any).registerMessageRenderer).toBeUndefined();
  });
});

 describe("child registration guard", () => {
  it("keeps root tools and listeners out of an isolated child runtime", async () => {
    const shell = await import("../src/shell.js");
    const api = createMockExtensionAPI();
    await shell.runWithSubagentRuntime(shell.createSubagentRuntimeContext(), async () => {
      await loadExtension(api.api);
    });
    expect(api.tools).toEqual([]);
    expect(api.listeners).toEqual([]);
  });
});

function createOfflinePi(): any {
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

function createOfflineSession(): any {
  const listeners: Array<(event: any) => void> = [];
  let resolvePrompt!: () => void;
  let resolvePromptStarted!: () => void;
  let runtimeAtPrompt: ReturnType<typeof getSubagentRuntimeContext>;
  const promptStarted = new Promise<void>((resolve) => { resolvePromptStarted = resolve; });
  const prompt = vi.fn(() => {
    runtimeAtPrompt = getSubagentRuntimeContext();
    resolvePromptStarted();
    return new Promise<void>((resolve) => { resolvePrompt = resolve; });
  });
  const emit = (event: any) => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = {
    agent: {},
    messages: [] as any[],
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => undefined),
    getActiveToolNames: vi.fn(() => ["read", "bash", "Agent", "AgentContinue"]),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    prompt,
    promptStarted,
    dispose: vi.fn(),
    abort: vi.fn(),
    finish: (text: string) => {
      emit({ type: "message_start" });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text }] });
      resolvePrompt?.();
    },
    get runtimeAtPrompt() {
      return runtimeAtPrompt;
    },
  };
  return session;
}

const childBindings: any[] = [];
const setups: any[] = [];
let bindingIndex = 0;

function context(): any {
  return {
    cwd: "/offline/project",
    model: { provider: "offline", id: "test-model" },
    thinkingLevel: "off",
    isProjectTrusted: () => false,
    ui: { notify: vi.fn() },
  };
}

function acceptedSpawn(type: string, prompt: string) {
  return acceptedSpawnFixture({
    type,
    prompt,
    projectTrusted: false,
    agentConfig: {
      name: type,
      description: `${type} test agent`,
      extensions: true,
      skills: false,
      systemPrompt: "Test child instructions.",
    },
    runtimeSettings: {
      agent: {
        includeContextFiles: false,
        disableDefaultAgents: false,
        orchestrationPrompt: true,
      },
    },
  });
}

function mountRoot(api: any, ctx: any) {
  extension(api.api as any);
  const manager = { name: "root-manager" };
  const coordinator = { name: "root-coordinator" };
  setManager(manager as any);
  setCoordinator(coordinator as any);
  setSessionCtx(ctx);
  return {
    manager,
    coordinator,
    tools: [...api.tools],
    listeners: [...api.listeners],
  };
}

function expectChildIsolation(setup: any) {
  expect(setup.runtime).toMatchObject({ isChildRuntime: true });
  expect(setup.session.runtimeAtPrompt).toBe(setup.runtime);
  expect(setup.options.tools).not.toEqual(expect.arrayContaining(["Agent", "AgentContinue"]));
  expect(setup.options.customTools).toBeUndefined();
  expect(setup.session.bindExtensions).toHaveBeenCalledOnce();
  expect(setup.session.setActiveToolsByName).toHaveBeenLastCalledWith(
    expect.not.arrayContaining(["Agent", "AgentContinue"]),
  );
  expect(setup.extensionApi.tools).toHaveLength(0);
  expect(setup.extensionApi.listeners).toHaveLength(0);
  expect(setup.session.agent).not.toHaveProperty("Agent");
}

function expectRootUnchanged(api: any, ctx: any, root: ReturnType<typeof mountRoot>) {
  expect(api.tools).toEqual(root.tools);
  expect(api.listeners).toEqual(root.listeners);
  expect(getPiInstance()).toBe(api.api);
  expect(getSessionCtx()).toBe(ctx);
  expect(getManager()).toBe(root.manager);
  expect(getCoordinator()).toBe(root.coordinator);
}

describe("foreground child-session ALS integration", () => {
  beforeEach(() => {
    childBindings.length = 0;
    setups.length = 0;
    bindingIndex = 0;
    boundary.loadChildExtension.mockReset();
    boundary.loadChildExtension.mockImplementation(() => {
      const extensionApi = createOfflinePi();
      const runtime = getSubagentRuntimeContext();
      extension(extensionApi.api as any);
      childBindings.push({ extensionApi, runtime });
    });
    boundary.createAgentSession.mockReset();
    boundary.createAgentSession.mockImplementation(async (options: any) => {
      const binding = childBindings[bindingIndex++];
      if (!binding) throw new Error("child extension was not loaded before session creation");
      const session = createOfflineSession();
      setups.push({ ...binding, options, session });
      return { session };
    });
  });

  afterEach(() => {
    setManager(null);
    setCoordinator(null);
    setSessionCtx(null);
    setPiInstance(null as any);
  });

  it("wraps a foreground run before child extension binding", async () => {
    const api = createOfflinePi();
    const ctx = context();
    const root = mountRoot(api, ctx);
    const run = runAgent(ctx, "implementer", "Inspect directly", {
      pi: api.api,
      acceptedSpawn: acceptedSpawn("implementer", "Inspect directly"),
    });

    await vi.waitFor(() => expect(setups).toHaveLength(1));
    const setup = setups[0]!;
    await setup.session.promptStarted;

    expectChildIsolation(setup);
    expect(setup.options.resourceLoader.options.noExtensions).toBe(false);
    expectRootUnchanged(api, ctx, root);

    setup.session.finish("Direct result");
    await expect(run).resolves.toMatchObject({ responseText: "Direct result", session: setup.session });
    expectRootUnchanged(api, ctx, root);
  });

  it("keeps concurrent foreground child runs isolated without changing root state", async () => {
    const api = createOfflinePi();
    const ctx = context();
    const root = mountRoot(api, ctx);
    const first = runAgent(ctx, "implementer", "first root", {
      pi: api.api,
      acceptedSpawn: acceptedSpawn("implementer", "first root"),
    });
    await vi.waitFor(() => expect(setups).toHaveLength(1));
    const second = runAgent(ctx, "scout", "second root", {
      pi: api.api,
      acceptedSpawn: acceptedSpawn("scout", "second root"),
    });
    await vi.waitFor(() => expect(setups).toHaveLength(2));
    await Promise.all(setups.map((setup) => setup.session.promptStarted));

    expectChildIsolation(setups[0]);
    expectChildIsolation(setups[1]);
    expect(setups[0]!.runtime).not.toBe(setups[1]!.runtime);
    expect(setups[0]!.session).not.toBe(setups[1]!.session);
    expectRootUnchanged(api, ctx, root);

    setups[0]!.session.finish("First result");
    setups[1]!.session.finish("Second result");
    await expect(first).resolves.toMatchObject({ responseText: "First result", session: setups[0]!.session });
    await expect(second).resolves.toMatchObject({ responseText: "Second result", session: setups[1]!.session });
    expectRootUnchanged(api, ctx, root);
  });
});
