import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpawnCoordinator } from "../src/spawn/spawn-coordinator.js";
import type { AgentRecord, AgentExecutionSummary } from "../src/types.js";
import { resolvedSpawnFixture } from "./fixtures.ts";

const { mockPi, mockGetPiInstance, mockIsIdle } = vi.hoisted(() => ({
  mockPi: { sendMessage: vi.fn() },
  mockGetPiInstance: vi.fn(),
  mockIsIdle: vi.fn(() => true),
}));

vi.mock("../src/shell.js", () => ({
  getSubagentRuntimeContext: () => undefined,
  getPiInstance: () => mockGetPiInstance(),
  getSessionCtx: () => ({ isIdle: mockIsIdle }),
}));

function execution(id: string, mode: "foreground" | "background", status: AgentExecutionSummary["status"]): AgentExecutionSummary {
  return {
    id,
    prompt: "boundary prompt",
    mode,
    kind: "new",
    status,
    startedAt: 10,
    completedAt: status === "running" ? undefined : 20,
    responseText: status === "running" ? undefined : "boundary result",
  };
}

function record(
  id: string,
  mode: "foreground" | "background",
  status: AgentExecutionSummary["status"],
): AgentRecord {
  const current = execution(`${id}-execution`, mode, status);
  return {
    id,
    result: current.responseText,
    lifecycle: {
      status,
      startedAt: 10,
      completedAt: current.completedAt,
      settled: status !== "running" && status !== "queued",
    },
    display: { type: "scout", description: "boundary" },
    execution: { promise: Promise.resolve(current.responseText ?? "") },
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      cacheRead: 0,
      executions: [current],
    },
  };
}

function managerDouble() {
  const records = new Map<string, AgentRecord>();
  let sequence = 0;
  const manager = {
    spawn: vi.fn((_pi: unknown, _ctx: unknown, resolved: ReturnType<typeof resolvedSpawnFixture>) => {
      const id = `boundary-${sequence++}`;
      const status = resolved.runInBackground ? "completed" : "running";
      const item = record(id, resolved.runInBackground ? "background" : "foreground", status);
      records.set(id, item);
      return id;
    }),
    getRecord: vi.fn((id: string) => records.get(id)),
    continueAgent: vi.fn((id: string, _prompt: string, options: { isBackground?: boolean }) => {
      const item = records.get(id)!;
      const idForExecution = `${id}-continued`;
      const current = execution(idForExecution, options.isBackground ? "background" : "foreground", "completed");
      item.stats.executions = [...(item.stats.executions ?? []), current];
      item.lifecycle.status = "completed";
      item.lifecycle.settled = true;
      item.result = current.responseText;
      item.execution.promise = Promise.resolve(current.responseText ?? "");
      return { executionId: idForExecution, record: item, promise: item.execution.promise };
    }),
    setRetentionProtection: vi.fn(),
    pruneRetainedRecords: vi.fn(() => []),
  };
  return { manager, records };
}

describe("scheduling and delivery coverage boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetPiInstance.mockReset().mockReturnValue(mockPi);
    mockPi.sendMessage.mockReset();
    mockIsIdle.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the production spawn/continue facade through each delivery boundary", async () => {
    const { manager, records } = managerDouble();
    const coordinator = new SpawnCoordinator(manager as any);
    const observer = vi.fn();
    const unsubscribe = coordinator.subscribeDeliveryActivity(observer);

    const foreground = await coordinator.spawn(
      mockPi as any,
      {} as any,
      resolvedSpawnFixture({ type: "scout", prompt: "foreground", runInBackground: false }),
      (accepted) => expect(accepted.id).toBe("boundary-0"),
    );
    expect(foreground.record.lifecycle.resultConsumed).toBe(true);

    const background = await coordinator.spawn(
      mockPi as any,
      {} as any,
      resolvedSpawnFixture({ type: "scout", prompt: "background", runInBackground: true }),
    );
    expect(coordinator.getDeliveryActivitySnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(background.record.delivery).toMatchObject({ state: "accepted", attempts: 1 });

    const continued = await coordinator.continueAgent(mockPi as any, {} as any, {
      agentId: foreground.agentId,
      prompt: "continue",
      runInBackground: true,
    });
    expect(records.get(continued.record.id)).toBe(continued.record);
    expect(coordinator.getDeliveryActivitySnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(continued.record.delivery).toMatchObject({ state: "accepted", attempts: 1 });

    coordinator.onAgentComplete(foreground.record, foreground.record.stats.executions![0]!);
    expect(manager.pruneRetainedRecords).toHaveBeenCalled();
    expect(observer).toHaveBeenCalled();
    unsubscribe();
    coordinator.dispose();
  });

  it("covers queued/terminal acceptance and a foreground continuation rejection", async () => {
    const queued = record("boundary-queued", "foreground", "queued");
    const emptyBackground = record("boundary-empty", "background", "completed");
    emptyBackground.stats.executions = [];
    const records = new Map([[queued.id, queued], [emptyBackground.id, emptyBackground]]);
    const manager: any = {
      spawn: vi.fn((_pi: unknown, _ctx: unknown, resolved: ReturnType<typeof resolvedSpawnFixture>) =>
        resolved.runInBackground ? emptyBackground.id : queued.id),
      getRecord: vi.fn((id: string) => records.get(id)),
      continueAgent: vi.fn(() => ({
        executionId: "rejected-continuation",
        record: queued,
        promise: Promise.reject(new Error("continuation rejected")),
      })),
    };
    const coordinator = new SpawnCoordinator(manager);

    const queuedResult = await coordinator.spawn(
      mockPi as any,
      {} as any,
      resolvedSpawnFixture({ type: "scout", prompt: "queued", runInBackground: false }),
    );
    expect(queuedResult.record.lifecycle.resultConsumed).toBe(true);

    const emptyResult = await coordinator.spawn(
      mockPi as any,
      {} as any,
      resolvedSpawnFixture({ type: "scout", prompt: "empty", runInBackground: true }),
    );
    expect(emptyResult.record.delivery).toBeUndefined();

    await expect(coordinator.continueAgent(mockPi as any, {} as any, {
      agentId: queued.id,
      prompt: "reject",
      runInBackground: false,
    })).rejects.toThrow("continuation rejected");
    expect(queued.lifecycle.resultConsumed).toBe(true);
    coordinator.dispose();
  });

  it("keeps facade cleanup and pruning failure-safe", async () => {
    const { manager } = managerDouble();
    manager.pruneRetainedRecords.mockImplementation(() => { throw new Error("prune failed"); });
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(
      mockPi as any,
      {} as any,
      resolvedSpawnFixture({ type: "scout", prompt: "failure", runInBackground: true }),
    );
    result.record.lifecycle.status = "completed";
    coordinator.onAgentComplete(result.record, result.record.stats.executions![0]!);
    vi.advanceTimersByTime(200);

    expect(mockPi.sendMessage).toHaveBeenCalledOnce();
    expect(result.record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
    expect(manager.setRetentionProtection.mock.calls[0]![0](result.record)).toBe(false);
    coordinator.dispose();
  });
});
