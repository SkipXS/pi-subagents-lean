import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeNestedAgentTool: vi.fn(),
  renderAgentToolCall: vi.fn(() => "call"),
  renderAgentToolResult: vi.fn(() => "result"),
}));

vi.mock("../../src/agents/tool-execution.js", () => ({
  executeNestedAgentTool: mocks.executeNestedAgentTool,
}));
vi.mock("../../src/ui/renderer.js", () => ({
  renderAgentToolCall: mocks.renderAgentToolCall,
  renderAgentToolResult: mocks.renderAgentToolResult,
}));

import { createNestedAgentProxy } from "../../src/agents/nested-agent-proxy.js";
import { createSubagentRuntimeContext } from "../../src/shell.js";

const createRuntime = () => createSubagentRuntimeContext(
  vi.fn(),
  { agent: { showCost: true } } as any,
);

describe("createNestedAgentProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fixed bare Agent schema with no additional properties", () => {
    const tool: any = createNestedAgentProxy(createRuntime());

    expect(tool).toMatchObject({ name: "Agent", label: "Agent" });
    expect(tool).not.toHaveProperty("description");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["prompt", "agent"],
    });
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "prompt", "description", "agent", "run_in_background", "worktree_path",
    ]);
  });

  it("forwards execution and rendering to the nested tool boundaries", async () => {
    const runtime = createRuntime();
    const tool: any = createNestedAgentProxy(runtime);
    const params = { agent: "scout", prompt: "Inspect" };
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const ctx = { cwd: "/project" };
    mocks.executeNestedAgentTool.mockResolvedValueOnce({ content: [] });

    await expect(tool.execute("call-id", params, signal, onUpdate, ctx)).resolves.toEqual({ content: [] });
    expect(mocks.executeNestedAgentTool).toHaveBeenCalledWith(runtime, "call-id", params, signal, onUpdate, ctx);

    const theme = {};
    const options = {};
    expect(tool.renderCall(params, theme)).toBe("call");
    expect(mocks.renderAgentToolCall).toHaveBeenCalledWith(params, theme);
    expect(tool.renderResult({ content: [] }, options, theme)).toBe("result");
    expect(mocks.renderAgentToolResult).toHaveBeenCalledWith({ content: [] }, options, theme, true);
  });
});
