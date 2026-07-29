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
import { getCoordinator, getManager } from "../src/shell.js";

interface OfflineSession {
  prompt: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  finish: (text: string) => void;
}

function createOfflineSession(): OfflineSession & Record<string, unknown> {
  const listeners: Array<(event: any) => void> = [];
  let finishPrompt!: () => void;
  const prompt = vi.fn(() => new Promise<void>((resolve) => {
    finishPrompt = resolve;
  }));
  const emit = (event: any) => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = {
    agent: {},
    messages: [] as any[],
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => undefined),
    getActiveToolNames: vi.fn(() => ["read", "grep", "Agent"]),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    prompt,
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

    await listener(api, "session_start")({}, ctx);
    expect(getManager()).not.toBeNull();
    expect(getCoordinator()).not.toBeNull();

    const agentTool = api.tools.find((tool) => tool.name === "Agent");
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
  });
});
