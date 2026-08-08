import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellMock } from "../fixtures.ts";
import { AGENT_RENDER_DETAILS_KEY } from "../../src/agents/agent-renderer.js";
import { AgentRenderMetadataBridge } from "../../src/agents/agent-render-bridge.js";

const state = vi.hoisted(() => ({
  getRecord: vi.fn(),
  listAgents: vi.fn(() => []),
  continueAgent: vi.fn(),
}));

vi.mock("../../src/shell.js", () => ({
  ...shellMock({
    manager: { getRecord: state.getRecord, listAgents: state.listAgents },
    coordinator: { continueAgent: state.continueAgent },
  }),
  getSubagentRuntimeContext: () => undefined,
}));
vi.mock("../../src/agents/usage.js", () => ({ getSessionUsageSnapshot: vi.fn(() => undefined) }));

import { executeContinueAgentTool } from "../../src/agents/agent-control-execution.js";

const fullId = "agent-full-id-123";

function record(status = "completed"): any {
  return {
    id: fullId,
    result: "completed result",
    display: {
      type: "reviewer",
      description: "Review",
      invocation: { modelKey: "queued/provider-model", thinkingLevel: "high" },
    },
    lifecycle: { status, startedAt: 1, completedAt: 2, settled: status === "completed" },
    execution: {
      session: { model: { provider: "actual", id: "provider-model" }, thinkingLevel: "high" },
    },
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      cacheRead: 0,
      compactionCount: 0,
      executions: [{ id: "execution", prompt: "initial", kind: "new", status, startedAt: 1 }],
    },
  };
}

describe("AgentContinue control rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getRecord.mockReset();
    state.listAgents.mockReset().mockReturnValue([]);
    state.continueAgent.mockReset();
  });

  it("resolves a unique prefix before awaiting continuation and preserves prompt/details", async () => {
    const root = record();
    (state.listAgents as any).mockReturnValue([root]);
    state.continueAgent.mockImplementation(async (intent: any, onAccepted?: (value: any) => void) => {
      onAccepted?.(root);
      return { executionId: "continuation", record: root, responseText: "complete continuation" };
    });
    const bridge = new AgentRenderMetadataBridge();
    bridge.startSession();
    bridge.start("continue-call", "AgentContinue");
    const onUpdate = vi.fn();
    const prompt = "line one\nline two\n日本語 🚀";

    const result = await executeContinueAgentTool(
      "continue-call",
      { agent_id: "agent-full", prompt },
      undefined,
      onUpdate,
      { cwd: "/project" } as any,
      bridge,
    );

    expect(state.continueAgent).toHaveBeenCalledWith(
      { agentId: fullId, prompt, signal: undefined },
      expect.any(Function),
    );
    expect(result.content[0].text).toBe("Agent ID: agent-full-id-123\n\nResponse:\ncomplete continuation");
    expect(result.details[AGENT_RENDER_DETAILS_KEY]).toMatchObject({
      agentId: fullId,
      role: "reviewer",
      model: "actual/provider-model",
      thinking: "high",
      prompt,
      kind: "continued",
    });
    expect(onUpdate).toHaveBeenCalled();
  });

  it("returns a useful error for unknown or ambiguous IDs", async () => {
    (state.listAgents as any).mockReturnValue([]);
    const unknown = await executeContinueAgentTool(
      "unknown", { agent_id: "missing", prompt: "try again" }, undefined, undefined, {} as any,
    );
    expect(unknown).toMatchObject({ isError: true, content: [{ text: "Agent missing not found" }] });
    expect(state.continueAgent).not.toHaveBeenCalled();

    const first = record();
    const second = { ...record(), id: "agent-full-id-999" };
    (state.listAgents as any).mockReturnValue([first, second]);
    const ambiguous = await executeContinueAgentTool(
      "ambiguous", { agent_id: "agent-full-id-", prompt: "try again" }, undefined, undefined, {} as any,
    );
    expect(ambiguous.content[0].text).toContain("ambiguous");
  });

  it("rejects oversized IDs and prompts before record reflection", async () => {
    const oversizedAscii = "a".repeat(129);
    const result = await executeContinueAgentTool(
      "oversized", { agent_id: oversizedAscii, prompt: "continue" }, undefined, undefined, {} as any,
    );
    expect(result.content[0].text).toContain("128 UTF-8 bytes");
    expect(state.getRecord).not.toHaveBeenCalled();
    expect(state.listAgents).not.toHaveBeenCalled();
  });
});
