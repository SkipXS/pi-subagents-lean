import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeNestedAgentTool: vi.fn(),
}));

vi.mock("../../src/agents/tool-execution.js", () => ({
  executeNestedAgentTool: mocks.executeNestedAgentTool,
}));

import { createNestedAgentProxy } from "../../src/agents/nested-agent-proxy.js";
import { createSubagentRuntimeContext } from "../../src/shell.js";

const createRuntime = () => createSubagentRuntimeContext(
  vi.fn(),
  { agent: { graceTurns: 6 } } as any,
);

describe("createNestedAgentProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fixed bare Agent schema with no additional properties", () => {
    const tool: any = createNestedAgentProxy(createRuntime());

    expect(tool).toMatchObject({ name: "Agent", label: "Agent" });
    expect(tool).not.toHaveProperty("description");
    expect(tool).toMatchObject({
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["prompt", "agent"],
      },
    });
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "prompt", "description", "agent", "run_in_background", "worktree_path",
    ]);
    expect(tool).not.toHaveProperty("renderCall");
    expect(tool).not.toHaveProperty("renderResult");
  });

  it("forwards execution to the nested tool boundary without a custom renderer", async () => {
    const runtime = createRuntime();
    const tool: any = createNestedAgentProxy(runtime);
    const params = { agent: "scout", prompt: "Inspect" };
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const ctx = { cwd: "/project" };
    mocks.executeNestedAgentTool.mockResolvedValueOnce({ content: [] });

    await expect(tool.execute("call-id", params, signal, onUpdate, ctx)).resolves.toEqual({ content: [] });
    expect(mocks.executeNestedAgentTool).toHaveBeenCalledWith(runtime, "call-id", params, signal, onUpdate, ctx);
  });
});
