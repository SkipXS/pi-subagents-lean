import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  executeAgentTool: vi.fn(),
  executeContinueAgentTool: vi.fn(),
}));
vi.mock("../src/agents/tool-execution.js", () => ({ executeAgentTool: state.executeAgentTool }));
vi.mock("../src/agents/agent-control-execution.js", () => ({ executeContinueAgentTool: state.executeContinueAgentTool }));

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

beforeEach(() => vi.clearAllMocks());

describe("tool registration", () => {
  it("registers only the two foreground tools and no message renderer", () => {
    const api = createApi();
    registerTools(api.api as any);
    expect(api.tools.map((tool) => tool.name)).toEqual(["Agent", "AgentContinue"]);
    expect(api.api.registerTool).toHaveBeenCalledTimes(2);
  });

  it("keeps the exact Agent schema and static description", () => {
    const api = createApi();
    registerTools(api.api as any);
    const tool = api.tools[0]!;
    expect(tool.description).toBe(
      "Delegate to a context-isolated specialized agent and wait for its result. It cannot see the parent conversation, parent tool results, or other agents' output, so its prompt must be self-contained.",
    );
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
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
    expect(tool.renderCall).toEqual(expect.any(Function));
    expect(tool.renderResult).toEqual(expect.any(Function));
  });

  it("keeps AgentContinue strict requirements and constrained sampling", () => {
    const api = createApi();
    registerTools(api.api as any);
    const tool = api.tools[1]!;
    expect(tool.description).toBe("Continue a finished agent's session with a new prompt and wait for its result.");
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "prompt"],
      properties: {
        agent_id: { type: "string", maxLength: 128 },
        prompt: { type: "string", maxLength: 262144 },
      },
    });
    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  it("translates internal errors into Pi throwing results", async () => {
    const api = createApi();
    registerTools(api.api as any);
    state.executeAgentTool.mockResolvedValueOnce({ content: [{ type: "text", text: "failed clearly" }], isError: true });
    await expect(api.tools[0]!.execute!("call", {}, undefined, undefined, {})).rejects.toThrow("failed clearly");
  });

  it("passes complete successful results through unchanged", async () => {
    const api = createApi();
    registerTools(api.api as any);
    const result = { content: [{ type: "text", text: "done" }], details: { keep: true } };
    state.executeContinueAgentTool.mockResolvedValueOnce(result);
    await expect(api.tools[1]!.execute!("call", {}, undefined, undefined, {})).resolves.toBe(result);
  });
});
