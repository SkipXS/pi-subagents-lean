import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import {
  agentControlRenderMetadata,
  agentRenderDetails,
  cancelledResult,
  emitAgentRenderUpdate,
  finalAgentRenderMetadata,
  errorResult,
  formatForegroundAgentResultContent,
  formatResultContent,
  successResult,
} from "../../src/agents/agent-tool-results.js";
import { AGENT_RENDER_DETAILS_KEY } from "../../src/agents/agent-renderer.js";

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-result-id",
    result: "partial",
    display: { type: "builder", description: "Build it" },
    lifecycle: { status: "completed", startedAt: 1, completedAt: 2 },
    execution: {},
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      cacheRead: 0,
      compactionCount: 0,
    },
    ...overrides,
  };
}

describe("agent-tool-results", () => {
  it("keeps success, error, and cancellation envelopes distinct", () => {
    expect(successResult("done")).toEqual({
      content: [{ type: "text", text: "done" }],
      details: undefined,
    });
    expect(errorResult("failed", { status: "error" })).toEqual({
      content: [{ type: "text", text: "failed" }],
      isError: true,
      details: { status: "error" },
    });
    expect(cancelledResult()).toEqual({
      content: [{ type: "text", text: "Agent execution cancelled" }],
      isError: true,
      details: undefined,
    });
  });

  it("uses an explicit response projection and preserves lifecycle notes", () => {
    const stopped = record({
      result: "retained result",
      lifecycle: { status: "stopped", stoppedBy: "parent", startedAt: 1, completedAt: 2 },
    });

    expect(formatResultContent(stopped, "current response")).toBe(
      "current response (parent turn ended before completion — output is partial; the task was NOT finished)",
    );
    expect(formatForegroundAgentResultContent(stopped)).toBe(
      "Agent ID: agent-result-id\n\nResponse:\nretained result (parent turn ended before completion — output is partial; the task was NOT finished)",
    );
  });

  it("keeps renderer updates observational when the host callback throws", () => {
    const bridge = { update: vi.fn() } as any;
    expect(() => emitAgentRenderUpdate(
      "call",
      () => { throw new Error("renderer failed"); },
      { role: "builder", prompt: "Build it", kind: "new" },
      bridge,
    )).not.toThrow();
    expect(bridge.update).toHaveBeenCalledWith("call", { role: "builder", prompt: "Build it", kind: "new" });
  });

  it("hydrates continuation metadata from live and retained session fields", () => {
    const live = record({
      id: "full-id",
      display: { type: "reviewer", description: "Review", invocation: { modelKey: "retained/model", thinkingLevel: "low" } },
      execution: { session: { model: { provider: "live", id: "model" }, thinkingLevel: "high" } as any },
    });
    expect(finalAgentRenderMetadata(
      { role: "reviewer", prompt: "inspect", kind: "new" },
      live,
    )).toMatchObject({ agentId: "full-id", model: "live/model", thinking: "high" });
    expect(agentControlRenderMetadata(live, "prefix", "continue")).toMatchObject({
      agentId: "full-id",
      role: "reviewer",
      model: "live/model",
      thinking: "high",
      prompt: "continue",
      kind: "continued",
    });

    const retained = record({
      id: "retained-id",
      display: { type: "builder", description: "Build", invocation: { modelKey: "retained/model", thinkingLevel: "medium" } },
      execution: {},
    });
    expect(agentControlRenderMetadata(retained, "prefix")).toMatchObject({
      agentId: "retained-id",
      role: "builder",
      model: "retained/model",
      thinking: "medium",
    });
    expect(agentControlRenderMetadata(undefined, "requested", "follow up")).toEqual({
      agentId: "requested",
      role: "—",
      prompt: "follow up",
      kind: "continued",
    });
  });

  it("fails closed for malformed retained records while preserving safe metadata", () => {
    const malformed: any = {
      id: "",
      get display() { throw new Error("display unavailable"); },
      get execution() { throw new Error("session unavailable"); },
    };
    expect(finalAgentRenderMetadata({ role: "builder", prompt: "inspect", kind: "new" }, malformed)).toEqual({
      role: "builder",
      prompt: "inspect",
      kind: "new",
    });
    expect(agentControlRenderMetadata(malformed, "requested", "follow up")).toEqual({
      agentId: "requested",
      role: "—",
      prompt: "follow up",
      kind: "continued",
    });
  });

  it("projects renderer metadata without changing public details", () => {
    const details = agentRenderDetails(
      { agentId: "agent-result-id", status: "completed" },
      { role: "builder", prompt: "Build it", kind: "new" },
    );

    expect(details).toEqual({
      agentId: "agent-result-id",
      status: "completed",
      [AGENT_RENDER_DETAILS_KEY]: {
        role: "builder",
        prompt: "Build it",
        kind: "new",
      },
    });
  });
});
