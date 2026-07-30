import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const catalog = new Map<string, { displayName: string }>([["reviewer", { displayName: "Reviewer" }]]);
  return {
    catalog,
    manager: undefined as unknown,
    widget: undefined as unknown,
    pi: undefined as unknown,
    registerAgents: vi.fn(),
    renderAgentToolCall: vi.fn(),
    renderAgentToolResult: vi.fn(),
    renderSubagentResult: vi.fn(),
    showAgentsMainMenu: vi.fn(),
    executeAgentTool: vi.fn(),
    executeStopAgentTool: vi.fn(),
    executeAgentStatusTool: vi.fn(),
    getStore: vi.fn(),
    scanAndMerge: vi.fn(async () => new Map(catalog)),
    store: {
      concurrency: 1,
      agent: {
        disableDefaultAgents: false,
        outputThinkingBufferSize: 0,
        showCost: false,
      },
      reload: vi.fn(),
      setDeps: vi.fn(),
      notifyToolsExpanded: vi.fn(),
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(() => "/home/test/.pi/agent"),
}));
vi.mock("@earendil-works/pi-tui", () => ({
  isKeyRelease: vi.fn(() => false),
  matchesKey: vi.fn(() => false),
}));
vi.mock("../src/agents/tool-execution.js", () => ({
  executeAgentTool: state.executeAgentTool,
  executeStopAgentTool: state.executeStopAgentTool,
  toolCallListener: vi.fn(),
}));
vi.mock("../src/agents/agent-status.js", () => ({ executeAgentStatusTool: state.executeAgentStatusTool }));
vi.mock("../src/agents/agent-types.js", () => ({
  getAvailableAgents: vi.fn(() => [...state.catalog.keys()]),
  registerAgents: state.registerAgents,
  scanAndMerge: state.scanAndMerge,
  setAgentScanDirs: vi.fn(),
}));
vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class {
    setOnComplete = vi.fn();
  },
}));
vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class {
    onAgentComplete = vi.fn();
  },
}));
vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {},
}));
vi.mock("../src/prompt/orchestration.js", () => ({
  getOrchestrationPromptUpdate: vi.fn(),
}));
vi.mock("../src/ui/renderer.js", () => ({
  renderAgentToolCall: state.renderAgentToolCall,
  renderAgentToolResult: state.renderAgentToolResult,
  renderSubagentResult: state.renderSubagentResult,
}));
vi.mock("../src/ui/menu/menus.js", () => ({ showAgentsMainMenu: state.showAgentsMainMenu }));
vi.mock("../src/shell.js", () => ({
  getCoordinator: () => undefined,
  getManager: () => state.manager,
  getPiInstance: () => state.pi,
  getStore: state.getStore,
  getWidget: () => state.widget,
  isInsideSubagentSpawn: () => false,
  getSubagentRuntimeContext: () => undefined,
  setCoordinator: vi.fn(),
  setManager: (manager: unknown) => { state.manager = manager; },
  setPiInstance: (pi: unknown) => { state.pi = pi; },
  setSessionCtx: vi.fn(),
  setWidget: (widget: unknown) => { state.widget = widget; },
}));

import extension from "../src/index.ts";

function createApi() {
  const tools: Array<Record<string, any>> = [];
  const listeners: Array<{ event: string; handler: (...args: any[]) => unknown }> = [];
  const messageRenderers: Array<{ type: string; renderer: (...args: any[]) => unknown }> = [];
  const commands: Array<{ name: string; command: Record<string, any> }> = [];
  return {
    tools,
    listeners,
    messageRenderers,
    commands,
    api: {
      registerTool: vi.fn((tool: Record<string, any>) => tools.push(tool)),
      registerMessageRenderer: vi.fn((type: string, renderer: (...args: any[]) => unknown) => messageRenderers.push({ type, renderer })),
      registerCommand: vi.fn((name: string, command: Record<string, any>) => commands.push({ name, command })),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => listeners.push({ event, handler })),
    },
  };
}

function agentTool(api: ReturnType<typeof createApi>): Record<string, any> {
  const tool = api.tools.find(({ name }) => name === "Agent");
  if (!tool) throw new Error("Agent tool was not registered");
  return tool;
}

function sessionContext() {
  return {
    cwd: "/workspace/project",
    hasUI: false,
    isProjectTrusted: () => false,
  };
}

beforeEach(() => {
  state.catalog.clear();
  state.catalog.set("reviewer", { displayName: "Reviewer" });
  state.manager = undefined;
  state.widget = undefined;
  state.pi = undefined;
  state.store.agent.showCost = false;
  state.getStore.mockImplementation(() => state.store);
  state.getStore.mockClear();
  state.registerAgents.mockClear();
  state.renderAgentToolCall.mockClear();
  state.renderAgentToolResult.mockClear();
  state.renderSubagentResult.mockClear();
  state.showAgentsMainMenu.mockClear();
  state.executeAgentTool.mockClear();
  state.executeStopAgentTool.mockClear();
  state.executeAgentStatusTool.mockClear();
  state.scanAndMerge.mockClear();
  state.store.reload.mockClear();
  state.store.setDeps.mockClear();
  state.store.notifyToolsExpanded.mockClear();
});

describe("Agent tool registration", () => {
  it("registers the exact fixed stealth envelope", () => {
    const api = createApi();
    extension(api.api as any);
    const tool = agentTool(api);

    expect(tool).not.toHaveProperty("description");
    expect(tool).not.toHaveProperty("promptSnippet");
    expect(tool).not.toHaveProperty("promptGuidelines");
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
      additionalProperties: false,
      type: "object",
      required: ["prompt", "agent"],
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
        agent: { type: "string" },
        run_in_background: { type: "boolean" },
        worktree_path: { type: "string" },
      },
    });
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "prompt", "description", "agent", "run_in_background", "worktree_path",
    ]);
    expect(tool.parameters.required).toEqual(["prompt", "agent"]);
    expect(tool.parameters.properties.agent).not.toHaveProperty("enum");
    expect(tool.parameters.properties.agent).not.toHaveProperty("description");
  });

  it("forwards tool, message, and command rendering through the public Pi registrations", async () => {
    const api = createApi();
    state.store.agent.showCost = true;
    extension(api.api as any);
    const theme = { name: "theme" };
    const callArgs = { agent: "reviewer" };
    const result = { content: [{ type: "text", text: "done" }] };

    agentTool(api).renderCall(callArgs, theme);
    agentTool(api).renderResult(result, { expanded: true }, theme);
    const messageRenderer = api.messageRenderers.find(({ type }) => type === "subagent-result");
    messageRenderer!.renderer({ content: "done" }, { expanded: false }, theme);
    const command = api.commands.find(({ name }) => name === "agents");
    const ctx = { modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-4o" }] } };
    await command!.command.handler("ignored", ctx);

    expect(state.renderAgentToolCall).toHaveBeenCalledWith(callArgs, theme);
    expect(state.renderAgentToolResult).toHaveBeenCalledWith(result, { expanded: true }, theme, true);
    expect(state.renderSubagentResult).toHaveBeenCalledWith({ content: "done" }, { expanded: false }, theme, true);
    expect(state.getStore).toHaveBeenCalledTimes(2);
    expect(state.showAgentsMainMenu).toHaveBeenCalledWith(ctx, ["openai/gpt-4o"]);
  });

  it("wires StopAgent and AgentStatus to constrained schema executors", () => {
    const api = createApi();
    extension(api.api as any);
    const stop = api.tools.find(({ name }) => name === "StopAgent")!;
    const status = api.tools.find(({ name }) => name === "AgentStatus")!;

    expect(stop.execute).toBe(state.executeStopAgentTool);
    expect(stop.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(JSON.parse(JSON.stringify(stop.parameters))).toEqual({
      type: "object", additionalProperties: false, required: ["agent_id"], properties: { agent_id: { type: "string" } },
    });
    expect(status.execute).toBe(state.executeAgentStatusTool);
    expect(status.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(JSON.parse(JSON.stringify(status.parameters))).toEqual({ type: "object", additionalProperties: false, properties: {} });
  });

  it("does not re-register when session_start refreshes a changed agent catalog", async () => {
    const api = createApi();
    extension(api.api as any);
    const schemaBeforeLifecycle = JSON.stringify(agentTool(api).parameters);
    const sessionStart = api.listeners.find(({ event }) => event === "session_start");

    expect(sessionStart).toBeDefined();
    await sessionStart!.handler({}, sessionContext());
    state.catalog.clear();
    state.catalog.set("planner", { displayName: "Planner" });
    await sessionStart!.handler({}, sessionContext());

    expect(state.registerAgents).toHaveBeenCalledTimes(2);
    expect([...state.registerAgents.mock.calls[0][0].keys()]).toEqual(["reviewer"]);
    expect([...state.registerAgents.mock.calls[1][0].keys()]).toEqual(["planner"]);
    expect(api.api.registerTool).toHaveBeenCalledTimes(3);
    expect(api.tools).toHaveLength(3);
    expect(JSON.stringify(agentTool(api).parameters)).toBe(schemaBeforeLifecycle);
  });
});
