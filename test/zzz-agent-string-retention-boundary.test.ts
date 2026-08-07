import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionSummary, AgentRecord } from "../src/types.js";
import {
  BackgroundDeliveryService,
  buildBackgroundContent,
} from "../src/spawn/background-delivery.js";

const { pi, getPiInstance } = vi.hoisted(() => ({
  pi: { sendMessage: vi.fn() },
  getPiInstance: vi.fn(),
}));

vi.mock("../src/shell.js", () => ({
  getPiInstance: () => getPiInstance(),
  getSessionCtx: () => ({ isIdle: () => true }),
}));

function fixture(): { record: AgentRecord; execution: AgentExecutionSummary } {
  const execution: AgentExecutionSummary = {
    id: "execution-boundary",
    prompt: "task",
    mode: "background",
    kind: "new",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    responseText: "result",
  };
  const record: AgentRecord = {
    id: "agent-boundary",
    result: "result",
    lifecycle: { status: "completed", startedAt: 1, completedAt: 2, settled: true },
    display: { type: "builder", description: "description" },
    execution: {},
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      cacheRead: 0,
      compactionCount: 0,
      executions: [execution],
    },
  };
  return { record, execution };
}

describe("agent string retention boundary coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pi.sendMessage.mockReset();
    getPiInstance.mockReset().mockReturnValue(pi);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("covers the complete bounded background projection sequence", () => {
    const { record, execution } = fixture();
    const manager = { getRecord: vi.fn(() => record) } as any;
    const service = new BackgroundDeliveryService(manager);
    const observer = vi.fn();
    const unsubscribe = service.subscribeActivity(observer);
    const parent = new AbortController();

    expect(buildBackgroundContent(record, execution, "new", "result", {})).toContain("Response:");
    service.claim(record, execution.id, parent.signal);
    service.onAgentComplete(record, execution);
    expect(service.getActivitySnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(200);

    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalled();
    unsubscribe();
    service.dispose();
  });
});
