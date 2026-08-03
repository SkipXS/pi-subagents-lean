import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  executeAgentTool: vi.fn(),
  executeContinueAgentTool: vi.fn(),
  executeStopAgentTool: vi.fn(),
  executeAgentStatusTool: vi.fn(),
}));

vi.mock("../src/agents/tool-execution.js", () => ({
  executeAgentTool: state.executeAgentTool,
  executeContinueAgentTool: state.executeContinueAgentTool,
  executeStopAgentTool: state.executeStopAgentTool,
}));
vi.mock("../src/agents/agent-status.js", () => ({ executeAgentStatusTool: state.executeAgentStatusTool }));

import { registerTools } from "../src/registration.js";

function createApi() {
  const tools: Array<Record<string, any>> = [];
  return {
    tools,
    api: {
      registerTool: vi.fn((tool: Record<string, any>) => tools.push(tool)),
    },
  };
}

function publicExecute(tool: Record<string, any>) {
  return tool.execute;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tool registration", () => {
  it("registers exactly the four public tools and no command or renderer", () => {
    const api = createApi();
    registerTools(api.api as any);

    expect(api.tools.map((tool) => tool.name)).toEqual([
      "Agent", "AgentContinue", "StopAgent", "AgentStatus",
    ]);
    expect(api.api.registerTool).toHaveBeenCalledTimes(4);
  });

  it("keeps the fixed Agent schema and registers only the Agent renderer", () => {
    const api = createApi();
    registerTools(api.api as any);
    const tool = api.tools[0]!;

    expect(tool.description).toBe("Delegate a task to a specialized agent.");
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["prompt", "agent"],
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
        agent: { type: "string" },
        run_in_background: { type: "boolean" },
        worktree_path: { type: "string" },
      },
    });
    expect(tool.renderCall).toEqual(expect.any(Function));
    expect(tool.renderResult).toEqual(expect.any(Function));
    for (const otherTool of api.tools.slice(1)) {
      expect(otherTool).not.toHaveProperty("renderCall");
      expect(otherTool).not.toHaveProperty("renderResult");
    }
  });

  it("keeps AgentContinue strict-mode requirements", () => {
    const api = createApi();
    registerTools(api.api as any);
    const tool = api.tools[1]!;

    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "prompt", "run_in_background"],
      properties: {
        agent_id: { type: "string" },
        prompt: { type: "string" },
        run_in_background: { type: "boolean" },
      },
    });
    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  it("keeps constrained StopAgent and AgentStatus schemas", () => {
    const api = createApi();
    registerTools(api.api as any);
    const stop = api.tools[2]!;
    const status = api.tools[3]!;

    expect(JSON.parse(JSON.stringify(stop.parameters))).toEqual({
      type: "object", additionalProperties: false,
      required: ["agent_id"], properties: { agent_id: { type: "string" } },
    });
    expect(JSON.parse(JSON.stringify(status.parameters))).toEqual({
      type: "object", additionalProperties: false, properties: {},
    });
    expect(stop.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(status.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  it("translates isError tool results into Pi errors", async () => {
    const api = createApi();
    registerTools(api.api as any);
    state.executeAgentTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "agent failed clearly" }],
      isError: true,
    });

    await expect(publicExecute(api.tools[0]!)!("call", {}, undefined, undefined, {}))
      .rejects.toThrow("agent failed clearly");
  });

  it("passes successful Agent results through unchanged", async () => {
    const api = createApi();
    registerTools(api.api as any);
    const result = { content: [{ type: "text", text: "done" }], details: { keep: true } };
    state.executeAgentTool.mockResolvedValueOnce(result);

    await expect(publicExecute(api.tools[0]!)!("call", {}, undefined, undefined, {}))
      .resolves.toBe(result);
  });

  it("keeps an undefined internal result defensive", async () => {
    const api = createApi();
    registerTools(api.api as any);
    state.executeAgentTool.mockResolvedValueOnce(undefined);

    await expect(publicExecute(api.tools[0]!)!("call", {}, undefined, undefined, {}))
      .resolves.toBeUndefined();
  });

  it("uses a defensive fallback for malformed error results", async () => {
    const api = createApi();
    registerTools(api.api as any);
    state.executeAgentTool.mockResolvedValueOnce({ isError: true });

    await expect(publicExecute(api.tools[0]!)!("call", {}, undefined, undefined, {}))
      .rejects.toThrow("Tool execution failed");
  });
});
