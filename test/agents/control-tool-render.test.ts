import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellMock } from "../fixtures.ts";
import { AGENT_RENDER_DETAILS_KEY } from "../../src/agents/agent-renderer.js";
import { AgentRenderMetadataBridge } from "../../src/agents/agent-render-bridge.js";

const state = vi.hoisted(() => ({
  getRecord: vi.fn(),
  listAgents: vi.fn(() => []),
  abort: vi.fn(),
  continueAgent: vi.fn(),
}));

vi.mock("../../src/shell.js", () => ({
  ...shellMock({
    manager: {
      getRecord: state.getRecord,
      listAgents: state.listAgents,
      abort: state.abort,
    },
    coordinator: { continueAgent: state.continueAgent },
  }),
  getSubagentRuntimeContext: () => undefined,
}));

vi.mock("../../src/agents/usage.js", () => ({
  getSessionUsageSnapshot: vi.fn(() => undefined),
}));

import { executeContinueAgentTool, executeStopAgentTool } from "../../src/agents/tool-execution.js";

const fullId = "agent-full-id-123";

function record(
  status: string,
  options: { session?: boolean; prompt?: string } = {},
): any {
  return {
    id: fullId,
    result: "completed result",
    display: {
      type: "reviewer",
      description: "Review",
      invocation: {
        modelKey: "queued/provider-model",
        thinkingLevel: "high",
      },
    },
    lifecycle: { status, startedAt: 1, completedAt: 2, settled: true },
    execution: options.session
      ? {
        session: {
          model: { provider: "actual", id: "provider-model" },
          thinkingLevel: "high",
        },
      }
      : {},
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      cacheRead: 0,
      toolUses: 0,
      compactionCount: 0,
      executions: options.prompt ? [{ prompt: options.prompt, mode: "foreground", status }] : [],
    },
  };
}

function ctx(): any {
  return { cwd: "/project" };
}

describe("AgentContinue and StopAgent control rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.listAgents.mockReturnValue([]);
  });

  it("resolves a prefix before foreground continue and preserves full prompt/details", async () => {
    const root = record("completed", { session: true });
    state.getRecord.mockReturnValue(undefined);
    (state.listAgents as any).mockReturnValue([root]);
    (state.continueAgent as any).mockResolvedValue({ record: { ...root, lifecycle: { ...root.lifecycle, status: "completed" } } });
    const bridge = new AgentRenderMetadataBridge();
    bridge.startSession();
    bridge.start("continue-call", "AgentContinue");
    const onUpdate = vi.fn();
    const prompt = "line one\nline two\n日本語 🚀";

    const result = await executeContinueAgentTool(
      "continue-call",
      { agent_id: "agent-full", prompt, run_in_background: false },
      undefined,
      onUpdate,
      ctx(),
      bridge,
    );

    expect(state.continueAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ agentId: fullId, prompt }),
    );
    expect(result.content[0].text).toBe("completed result");
    expect(result.details[AGENT_RENDER_DETAILS_KEY]).toMatchObject({
      agentId: fullId,
      role: "reviewer",
      model: "actual/provider-model",
      thinking: "high",
      prompt,
    });
    expect(onUpdate).toHaveBeenCalledWith({
      content: [],
      details: {
        [AGENT_RENDER_DETAILS_KEY]: expect.objectContaining({ agentId: fullId, prompt }),
      },
    });
  });

  it("renders a queued background continuation from retained record metadata", async () => {
    const root = record("completed", { session: false });
    state.getRecord.mockReturnValue(root);
    const queued = { ...root, lifecycle: { ...root.lifecycle, status: "queued" } };
    (state.continueAgent as any).mockResolvedValue({ record: queued });

    const result = await executeContinueAgentTool(
      "queued-continue",
      { agent_id: fullId, prompt: "queued follow-up", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.content[0].text).toContain("[AgentContinue]");
    expect(result.content[0].text).toContain(`Agent ID: ${fullId}`);
    expect(result.details[AGENT_RENDER_DETAILS_KEY]).toMatchObject({
      agentId: fullId,
      model: "queued/provider-model",
      thinking: "high",
      prompt: "queued follow-up",
    });
  });

  it("hydrates terminal continuation errors instead of losing control metadata", async () => {
    const terminal = record("error", { session: false });
    state.getRecord.mockReturnValue(terminal);
    (state.continueAgent as any).mockRejectedValue(new Error("cannot continue"));

    const result = await executeContinueAgentTool(
      "terminal-continue",
      { agent_id: "agent-full", prompt: "retry", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("cannot continue");
    expect(result.details[AGENT_RENDER_DETAILS_KEY]).toMatchObject({
      agentId: fullId,
      role: "reviewer",
      model: "queued/provider-model",
      prompt: "retry",
    });
  });

  it("keeps unknown Continue IDs defensive and does not call the coordinator", async () => {
    state.getRecord.mockReturnValue(undefined);
    state.listAgents.mockReturnValue([]);

    const result = await executeContinueAgentTool(
      "unknown-continue",
      { agent_id: "missing-prefix", prompt: "try again", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Agent missing-prefix not found");
    expect(result.details[AGENT_RENDER_DETAILS_KEY]).toEqual({
      agentId: "missing-prefix",
      role: "—",
      prompt: "try again",
    });
    expect(state.continueAgent).not.toHaveBeenCalled();
  });

  it("resolves a queued StopAgent prefix and uses persisted provider/model metadata", async () => {
    const queued = record("queued", { session: false });
    state.getRecord.mockReturnValue(undefined);
    (state.listAgents as any).mockReturnValue([queued]);
    (state.abort as any).mockReturnValue(true);

    const result = await executeStopAgentTool(
      "queued-stop",
      { agent_id: "agent-full" },
      undefined,
      undefined,
      ctx(),
    );

    expect(state.abort).toHaveBeenCalledWith(fullId, "agent");
    expect(result.content[0].text).toBe("Stopped agent agent-fu");
    expect(result.details[AGENT_RENDER_DETAILS_KEY]).toEqual({
      agentId: fullId,
      role: "reviewer",
      model: "queued/provider-model",
      thinking: "high",
      prompt: "",
    });
  });
});
