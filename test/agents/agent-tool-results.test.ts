import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import {
  agentRenderDetails,
  cancelledResult,
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
      lifecycle: { status: "stopped", stoppedBy: "agent", startedAt: 1, completedAt: 2 },
    });

    expect(formatResultContent(stopped, "current response")).toBe(
      "current response (stopped before completion — output is partial; the task was NOT finished)",
    );
    expect(formatForegroundAgentResultContent(stopped)).toBe(
      "Agent ID: agent-result-id\n\nResponse:\nretained result (stopped before completion — output is partial; the task was NOT finished)",
    );
  });

  it("projects renderer metadata without changing public details", () => {
    const details = agentRenderDetails(
      { agentId: "agent-result-id", status: "completed" },
      { role: "builder", prompt: "Build it", mode: "foreground", kind: "new" },
    );

    expect(details).toEqual({
      agentId: "agent-result-id",
      status: "completed",
      [AGENT_RENDER_DETAILS_KEY]: {
        role: "builder",
        prompt: "Build it",
        mode: "foreground",
        kind: "new",
      },
    });
  });
});
