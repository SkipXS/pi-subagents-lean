/**
 * agent-manager-continue.test.ts — AgentManager.continueAgent execution model.
 *
 * Covers the strict continuation gate (completed + settled + usable session),
 * the global concurrency slot consumption, per-execution generation/delivery/
 * usage deltas, StopAgent handling of queued/running continuations, output-log
 * append semantics, ID resolution, and the root-only contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";
import { readFile } from "node:fs/promises";

let uuidCounter = 0;

const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockExecuteAgentTurn: vi.fn(),
  mockRandomUUID: vi.fn(() => {
    uuidCounter++;
    return `agent-${String(uuidCounter).padStart(8, "0")}`;
  }),
  resetUuidCounter: () => { uuidCounter = 0; },
  fsMock: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockModules.mockRandomUUID,
}));

vi.mock("node:fs", () => mockModules.fsMock);

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
  executeAgentTurn: mockModules.mockExecuteAgentTurn,
}));

function mockAgentSession(messages: unknown[] = []): any {
  return { subscribe: vi.fn(), messages, dispose: vi.fn(), steer: vi.fn(), abort: vi.fn() };
}

type MockRunResult = {
  responseText: string;
  session: ReturnType<typeof mockAgentSession>;
  aborted: boolean;
};

function mockRunResult(overrides?: Partial<MockRunResult>): MockRunResult {
  return {
    responseText: "done",
    session: mockAgentSession(),
    aborted: false,
    ...overrides,
  };
}

import { AgentManager } from "../../src/agents/agent-manager.js";
import type { OnAgentComplete } from "../../src/agents/agent-manager.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import {
  createSubagentRuntimeContext,
  runWithSubagentRuntime,
} from "../../src/shell.js";
import { buildAgentDetails } from "../../src/agents/agent-details.js";
import { whenOutputLogsIdle } from "../../src/agents/output-file.js";

describe("AgentManager.continueAgent", () => {
  let manager: AgentManager;
  let onComplete: ReturnType<typeof vi.fn<OnAgentComplete>>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockExecuteAgentTurn.mockReset();
    mockModules.fsMock.writeFileSync.mockClear();
    mockModules.fsMock.appendFileSync.mockClear();
    registerAgents(new Map([
      ["scout", { name: "scout", description: "", systemPrompt: "" }],
      ["implementer", { name: "implementer", description: "", systemPrompt: "" }],
    ]));
    onComplete = vi.fn<OnAgentComplete>();
  });

  afterEach(() => {
    manager?.dispose();
  });

  /** Spawn a completed root agent whose session is retained for continuation. */
  async function spawnCompletedAgent(
    prompt = "initial task",
    options: { session?: any; runResult?: Partial<MockRunResult> } = {},
  ): Promise<{ id: string; session: any }> {
    const session = options.session ?? mockAgentSession();
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult({ session, ...options.runResult }));
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", prompt, { description: "initial" });
    await manager.getRecord(id)!.execution.promise;
    return { id, session };
  }

  it("continues the same session with the shared turn executor", async () => {
    manager = new AgentManager(onComplete);
    const session = mockAgentSession(["user", "assistant"]);
    const { id } = await spawnCompletedAgent("initial task", { session });
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "follow-up result",
      aborted: false,
    });

    const { executionId, record, promise } = manager.continueAgent(id, "follow up", {});
    const result = await promise;

    expect(result).toBe("follow-up result");
    expect(record).toBe(manager.getRecord(id));
    expect(manager.listAgents()).toContain(record);
    expect(mockModules.mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    const [turnSession, turnPrompt, turnOptions] = mockModules.mockExecuteAgentTurn.mock.calls[0]!;
    expect(turnSession).toBe(session); // same-session continuation
    expect(turnPrompt).toBe("follow up");
    expect(turnOptions.signal).toBeInstanceOf(AbortSignal);
    expect(turnOptions.signal!.aborted).toBe(false);

    expect(record.lifecycle.status).toBe("completed");
    expect(record.result).toBe("follow-up result");
    expect(record.lifecycle.settled).toBe(true);
    expect(record.stats.executions).toHaveLength(2);
    expect(record.stats.executions![0]!.kind).toBe("new");
    expect(executionId).toBe(record.stats.executions![1]!.id);
    expect(record.stats.executions![1]).toMatchObject({
      prompt: "follow up",
      mode: "foreground",
      kind: "continued",
      status: "completed",
      responseText: "follow-up result",
      deliveredText: "follow-up result",
    });
    expect(onComplete).toHaveBeenCalledWith(record, record.stats.executions![1]);
  });

  it("continues an old completed record until parent-session shutdown", async () => {
    vi.useFakeTimers();
    try {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      const { id } = await spawnCompletedAgent("initial task", { session });
      const record = manager.getRecord(id)!;
      record.lifecycle.completedAt = Date.now() - 70 * 60_000;
      vi.advanceTimersByTime(60 * 60_000);

      mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
        responseText: "continued after time", aborted: false,
      });
      const { promise } = manager.continueAgent(id, "follow-up", {});

      await expect(promise).resolves.toBe("continued after time");
      expect(manager.getRecord(id)).toBe(record);
      expect(record.lifecycle.status).toBe("completed");
      expect(session.dispose).not.toHaveBeenCalled();
    } finally {
      manager?.dispose();
      vi.useRealTimers();
    }
  });

  it("records per-execution usage deltas and cumulative lifetime usage", async () => {
    manager = new AgentManager(onComplete);
    const firstRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "initial task", { description: "initial" });
    const record = manager.getRecord(id)!;

    // First execution usage: drive the captured onAssistantUsage callback
    // while the run is still pending, then let it finish.
    const runOptions = mockModules.mockRunAgent.mock.calls[0]![3];
    runOptions.onAssistantUsage({ input: 10, output: 5, cacheWrite: 2, cacheRead: 3, cost: 0.01 });
    firstRun.resolve(mockRunResult());
    await record.execution.promise;

    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const { promise } = manager.continueAgent(id, "second task", {});
    const turnOptions = mockModules.mockExecuteAgentTurn.mock.calls[0]![2];
    turnOptions.onAssistantUsage({ input: 20, output: 6, cacheWrite: 1, cacheRead: 4, cost: 0.02 });
    secondRun.resolve({ responseText: "second", aborted: false });
    await promise;

    expect(record.stats.executions![0]!.usage).toMatchObject({ input: 10, output: 5, cacheWrite: 2, cacheRead: 3 });
    expect(record.stats.executions![0]!.usage!.cost).toBeCloseTo(0.01);
    expect(record.stats.executions![1]!.usage).toMatchObject({ input: 20, output: 6, cacheWrite: 1, cacheRead: 4 });
    expect(record.stats.executions![1]!.usage!.cost).toBeCloseTo(0.02);
    expect(record.stats.lifetimeUsage).toEqual({ input: 30, output: 11, cacheWrite: 3, cost: 0.03 });
    expect(record.stats.cacheRead).toBe(7);
    expect(manager.getTotalAgentCost()).toBeCloseTo(0.03);
  });

  it("records per-execution usage and compaction deltas against nonzero initial totals", async () => {
    manager = new AgentManager(onComplete);
    const firstRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "initial task", { description: "initial" });
    const record = manager.getRecord(id)!;

    // Initial execution accumulates real usage and compactions.
    const runOptions = mockModules.mockRunAgent.mock.calls[0]![3];
    runOptions.onAssistantUsage({ input: 10, output: 5, cacheWrite: 2, cacheRead: 3, cost: 0.01 });
    runOptions.onCompaction({ reason: "threshold", tokensBefore: 100 });
    firstRun.resolve(mockRunResult());
    await record.execution.promise;

    // The initial execution summary carries its own delta only.
    expect(record.stats.executions![0]!.compactionCount).toBe(1);

    // Continuation runs on top of the nonzero initial totals.
    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const { promise } = manager.continueAgent(id, "second task", {});
    const turnOptions = mockModules.mockExecuteAgentTurn.mock.calls[0]![2];
    turnOptions.onAssistantUsage({ input: 20, output: 6, cacheWrite: 1, cacheRead: 4, cost: 0.02 });
    turnOptions.onCompaction({ reason: "overflow", tokensBefore: 200 });
    secondRun.resolve({ responseText: "second", aborted: false });
    await promise;

    // The continuation summary reports only its own delta, never the initial
    // (or cumulative) totals.
    expect(record.stats.executions![1]!.compactionCount).toBe(1);
    expect(record.stats.executions![1]!.usage).toMatchObject({ input: 20, output: 6, cacheWrite: 1, cacheRead: 4 });
    expect(record.stats.executions![1]!.usage!.cost).toBeCloseTo(0.02);
    // Cumulative usage and compaction totals keep lifetime semantics.
    expect(record.stats.compactionCount).toBe(2);
    expect(record.stats.lifetimeUsage).toEqual({ input: 30, output: 11, cacheWrite: 3, cost: 0.03 });
    expect(manager.getTotalAgentCost()).toBeCloseTo(0.03);
  });

  it("rejects a continuation while the agent is running", async () => {
    manager = new AgentManager(onComplete);
    const firstRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    expect(manager.getRecord(id)!.lifecycle.status).toBe("running");

    expect(() => manager.continueAgent(id, "nope", {}))
      .toThrow("is running and cannot be continued");
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();

    firstRun.resolve(mockRunResult());
    await manager.getRecord(id)!.execution.promise;
    expect(manager.getRecord(id)!.stats.executions).toHaveLength(1);
  });

  it("rejects a continuation while the initial spawn is still queued for a slot", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    const blocker = makeResolvablePromise();
    const queuedRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise).mockReturnValueOnce(queuedRun.promise);
    manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "scout", "queued", { description: "queued" });
    expect(manager.getRecord(queuedId)!.lifecycle.status).toBe("queued");

    expect(() => manager.continueAgent(queuedId, "nope", {}))
      .toThrow("is queued and cannot be continued");

    blocker.resolve(mockRunResult());
    queuedRun.resolve(mockRunResult());
    await manager.getRecord(queuedId)!.execution.promise;
    expect(manager.getRecord(queuedId)!.lifecycle.status).toBe("completed");
  });

  it("rejects all non-completed terminal statuses", async () => {
    manager = new AgentManager(onComplete);

    const aborted = await spawnCompletedAgent("aborted", { runResult: { aborted: true } });
    expect(() => manager.continueAgent(aborted.id, "nope", {}))
      .toThrow("is aborted and cannot be continued");

    mockModules.mockRunAgent.mockRejectedValueOnce(new Error("boom"));
    const failedId = manager.spawn(fakePi(), fakeCtx(), "scout", "fail", { description: "fail" });
    await manager.getRecord(failedId)!.execution.promise;
    expect(() => manager.continueAgent(failedId, "nope", {}))
      .toThrow("is error and cannot be continued");
  });

  it("queues a continuation on the global queue until a slot frees, without re-counting it", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const firstId = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    await manager.getRecord(firstId)!.execution.promise; // completed; slot released

    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });

    const continuationRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(continuationRun.promise);
    const { executionId, record, promise } = manager.continueAgent(firstId, "continue", {});
    const acceptedSession = record.execution.session;
    expect(record.lifecycle.status).toBe("queued");
    expect(record.lifecycle.settled).toBe(false);
    expect(record.stats.executions![1]!.status).toBe("queued");
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();

    // A second continuation while the first is queued is rejected.
    expect(() => manager.continueAgent(firstId, "again", {}))
      .toThrow("is queued and cannot be continued");

    // The blocker releases its slot → the queued continuation starts.
    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
    await vi.waitFor(() => expect(mockModules.mockExecuteAgentTurn).toHaveBeenCalledTimes(1));
    expect(record.lifecycle.status).toBe("running");
    expect(record.lifecycle.settled).toBe(false);
    expect(record.stats.executions![1]!.status).toBe("running");
    expect(mockModules.mockExecuteAgentTurn.mock.calls[0]![0]).toBe(acceptedSession);
    // A second continuation while the first is running is rejected too.
    expect(() => manager.continueAgent(firstId, "again", {}))
      .toThrow("is running and cannot be continued");

    continuationRun.resolve({ responseText: "continued", aborted: false });
    const result = await promise;
    expect(result).toBe("continued");
    expect(record.lifecycle.status).toBe("completed");
    expect(record.lifecycle.settled).toBe(true);
    expect(executionId).toBe(record.stats.executions![1]!.id);
    // Continuations never increment the accepted-agent count.
    expect(manager.getTotalAgentCount()).toBe(2); // first + blocker only
  });

  it("accepts a background continuation on a completed record and runs it immediately", async () => {
    manager = new AgentManager(onComplete);
    const session = mockAgentSession(["user", "assistant"]);
    const { id } = await spawnCompletedAgent("initial task", { session });
    const bg = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(bg.promise);

    const { executionId, promise, record } = manager.continueAgent(id, "bg follow-up", { isBackground: true });
    expect(mockModules.mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockModules.mockExecuteAgentTurn.mock.calls[0]![0]).toBe(session);
    expect(record.stats.executions![1]).toMatchObject({ mode: "background", status: "running" });
    expect(executionId).toBe(record.stats.executions![1]!.id);

    bg.resolve({ responseText: "bg done", aborted: false });
    await promise;
    expect(record.stats.executions![1]).toMatchObject({ mode: "background", status: "completed" });
    expect(record.lifecycle.status).toBe("completed");
  });

  it("delivers the latest execution's result and notifies once per executed turn", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "first follow-up", aborted: false,
    });
    const first = manager.continueAgent(id, "follow-up one", {});
    await first.promise;

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "second follow-up", aborted: false,
    });
    const second = manager.continueAgent(id, "follow-up two", {});
    await second.promise;

    const record = manager.getRecord(id)!;
    expect(record.result).toBe("second follow-up");
    expect(onComplete).toHaveBeenCalledTimes(3); // initial + two continuations
    expect(onComplete.mock.calls[0]![1]).toBe(record.stats.executions![0]);
    expect(onComplete.mock.calls[1]![1]).toBe(record.stats.executions![1]);
    expect(onComplete.mock.calls[2]![1]).toBe(record.stats.executions![2]);
  });

  it("StopAgent rejects a queued continuation without leaks", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    await manager.getRecord(id)!.execution.promise;
    const initialRecord = manager.getRecord(id)!;
    initialRecord.stats.lifetimeUsage = { input: 101, output: 202, cacheWrite: 303, cost: 0.404 };
    initialRecord.stats.cacheRead = 505;
    initialRecord.stats.compactionCount = 8;

    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });

    const queued = manager.continueAgent(id, "queued follow-up", {});
    expect(manager.getRecord(id)!.lifecycle.status).toBe("queued");
    expect(manager.abort(id, "agent")).toBe(true);

    await expect(queued.promise).rejects.toThrow("was stopped");
    const record = manager.getRecord(id)!;
    expect(record.lifecycle.status).toBe("stopped");
    expect(record.lifecycle.settled).toBe(true);
    expect(record.stats.executions![1]).toMatchObject({
      status: "stopped",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
    });
    const foregroundDetails = buildAgentDetails(record, { includeStats: true });
    expect(foregroundDetails).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      compactions: 0,
      compactionCount: 0,
      currentExecution: { status: "stopped", compactionCount: 0 },
    });
    expect(foregroundDetails.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();

    // The stopped continuation must not start when the slot frees.
    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();
    expect(() => manager.continueAgent(id, "after stop", {}))
      .toThrow("is stopped and cannot be continued");
  });

  it("StopAgent stops a running continuation and settles the record", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    const running = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(running.promise);
    const { promise } = manager.continueAgent(id, "second", {});
    expect(manager.getRecord(id)!.lifecycle.status).toBe("running");

    expect(manager.abort(id, "agent")).toBe(true);
    expect(manager.getRecord(id)!.lifecycle.status).toBe("stopped");

    running.resolve({ responseText: "partial", aborted: true });
    await promise;
    const record = manager.getRecord(id)!;
    expect(record.lifecycle.status).toBe("stopped");
    expect(record.lifecycle.settled).toBe(true);
    expect(record.stats.executions![1]).toMatchObject({ status: "stopped", responseText: "partial" });
  });

  it("settles a continuation whose parent signal is already aborted", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    const aborted = new AbortController();
    aborted.abort();

    const { promise, record } = manager.continueAgent(id, "nope", { signal: aborted.signal });
    await expect(promise).rejects.toThrow("was stopped");
    expect(record.lifecycle.status).toBe("stopped");
    expect(record.lifecycle.settled).toBe(true);
    expect(record.stats.executions![1]!.status).toBe("stopped");
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();
  });

  it("surfaces a synchronous continuation start failure without leaking the slot", async () => {
    // A continuation start is the only onStart invocation on a record that
    // already has an execution entry; throwing there simulates a synchronous
    // start failure without affecting the initial spawn or later spawns.
    manager = new AgentManager(onComplete, { default: 1 }, (record) => {
      if ((record.stats.executions?.length ?? 0) > 1) throw new Error("start boom");
    });
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    await manager.getRecord(id)!.execution.promise;

    const { promise, record } = manager.continueAgent(id, "second", {});
    await expect(promise).rejects.toThrow("start boom");
    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("start boom");
    expect(record.lifecycle.settled).toBe(true);
    expect(record.stats.executions![1]).toMatchObject({
      status: "error",
      error: "start boom",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
    });
    expect(record.execution.outputLog).toBeUndefined();
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();

    // The claimed slot was released: the next spawn starts immediately.
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const nextId = manager.spawn(fakePi(), fakeCtx(), "scout", "next", { description: "next" });
    expect(manager.getRecord(nextId)!.lifecycle.status).toBe("running");
    await manager.getRecord(nextId)!.execution.promise;
  });

  it("fails a queued continuation cleanly when its session disappears before start", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    await manager.getRecord(id)!.execution.promise;

    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });

    const { promise } = manager.continueAgent(id, "queued", {});
    expect(manager.getRecord(id)!.lifecycle.status).toBe("queued");
    // Simulate the record losing its retained session while waiting for the slot.
    (manager as any).releaseExecution(manager.getRecord(id));

    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
    await expect(promise).rejects.toThrow("session is no longer available");
    const record = manager.getRecord(id)!;
    expect(record.lifecycle.status).toBe("error");
    expect(record.lifecycle.settled).toBe(true);
    expect(record.stats.executions![1]).toMatchObject({ status: "error" });
  });

  it("releases the queue after a continuation startup failure and starts later work", async () => {
    manager = new AgentManager(onComplete, { default: 1 }, (record) => {
      if ((record.stats.executions?.length ?? 0) > 1) throw new Error("queued continuation start failed");
    });
    const { id } = await spawnCompletedAgent("first");

    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });

    const queued = manager.continueAgent(id, "queued follow-up", {});
    const queuedRejection = expect(queued.promise).rejects.toThrow("queued continuation start failed");
    const laterRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(laterRun.promise);
    const laterId = manager.spawn(fakePi(), fakeCtx(), "scout", "later", { description: "later" });

    expect(manager.getRecord(id)!.lifecycle.status).toBe("queued");
    expect(manager.getRecord(laterId)!.lifecycle.status).toBe("queued");
    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
    await queuedRejection;

    const failed = manager.getRecord(id)!;
    expect(failed.lifecycle).toMatchObject({ status: "error", settled: true });
    expect(failed.error).toBe("queued continuation start failed");
    expect(failed.stats.executions![1]).toMatchObject({
      status: "error",
      error: "queued continuation start failed",
    });
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(manager.getRecord(laterId)!.lifecycle.status).toBe("running"));

    laterRun.resolve(mockRunResult());
    await manager.getRecord(laterId)!.execution.promise;
  });

  it("stops a queued continuation when its parent signal aborts", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    const { id } = await spawnCompletedAgent("first");

    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    const queued = manager.continueAgent(id, "queued follow-up", { signal: parent.signal });
    const record = manager.getRecord(id)!;
    const stopped = expect(queued.promise).rejects.toThrow("was stopped");

    parent.abort();
    await stopped;
    expect(record.lifecycle).toMatchObject({ status: "stopped", settled: true, stoppedBy: "parent" });
    expect(record.stats.executions![1]).toMatchObject({
      status: "stopped",
      usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
      compactionCount: 0,
    });
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledOnce();

    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();
  });

  it("turns an aborted continuation into an aborted execution entry", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "partial", aborted: true,
    });
    const { promise } = manager.continueAgent(id, "second", {});
    await promise;
    const record = manager.getRecord(id)!;
    expect(record.lifecycle.status).toBe("aborted");
    expect(record.stats.executions![1]!.status).toBe("aborted");
    expect(record.result).toBe("partial");
  });

  it("records a runner failure as a per-execution error", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    mockModules.mockExecuteAgentTurn.mockRejectedValueOnce(new Error("turn failed"));
    const { promise } = manager.continueAgent(id, "second", {});
    await promise;
    const record = manager.getRecord(id)!;
    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("turn failed");
    expect(record.stats.executions![1]).toMatchObject({ status: "error", error: "turn failed" });
  });


  it("rejects root spawning and continuation from a child runtime", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    await runWithSubagentRuntime(
      createSubagentRuntimeContext(),
      async () => {
        expect(() => manager.spawn(fakePi(), fakeCtx(), "scout", "nope", { description: "nope" }))
          .toThrow("Root agent spawning is unavailable from a child runtime");
        expect(() => manager.continueAgent(id, "nope", {}))
          .toThrow("Root agent continuation is unavailable from a child runtime");
      },
    );
  });

  it("rejects unknown agents and empty prompts", async () => {
    manager = new AgentManager(onComplete);
    expect(() => manager.continueAgent("missing", "prompt", {})).toThrow("Agent missing not found");
    const { id } = await spawnCompletedAgent("initial task");
    expect(() => manager.continueAgent(id, "   ", {})).toThrow("AgentContinue prompt is required");
  });

  it("resolves unique short IDs and rejects ambiguous prefixes", async () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const first = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    await manager.getRecord(first)!.execution.promise;

    // A short prefix matching exactly one retained record resolves.
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "ok", aborted: false,
    });
    const { promise } = manager.continueAgent("agent-0000000", "short id", {});
    await promise;

    // With two retained records the same prefix is ambiguous.
    const second = manager.spawn(fakePi(), fakeCtx(), "scout", "second", { description: "second" });
    await manager.getRecord(second)!.execution.promise;
    expect(() => manager.continueAgent("agent-0000000", "ambiguous", {}))
      .toThrow("is ambiguous; use a longer ID prefix");
  });

  it("rejects continuation when the retained session is already gone", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    (manager as any).releaseExecution(manager.getRecord(id));
    expect(() => manager.continueAgent(id, "nope", {})).toThrow("session is no longer available");
  });

  it("rejects a queued continuation on dispose so callers cannot hang", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    await manager.getRecord(id)!.execution.promise;

    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });

    const queued = manager.continueAgent(id, "queued", {});
    expect(manager.getRecord(id)!.lifecycle.status).toBe("queued");
    manager.dispose();
    await expect(queued.promise).rejects.toThrow("Agent session shut down");
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("appends continuation prompts to the same output log without truncating", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "second", aborted: false,
    });
    const { promise } = manager.continueAgent(id, "second task", {});
    await promise;

    // Runtime logging is asynchronous. The shared writer preserves each
    // execution's prompt/DONE boundaries without truncating the log.
    const record = manager.getRecord(id)!;
    expect(record.display.outputFile).toBeTruthy();
    await whenOutputLogsIdle();
    const content = await readFile(record.display.outputFile!, "utf-8");
    expect(content.match(/\[USER\]/g)).toHaveLength(2);
    expect(content.match(/\[DONE\]/g)).toHaveLength(2);
    expect(content.indexOf("initial task")).toBeLessThan(content.indexOf("[DONE]"));
    expect(content.indexOf("second task")).toBeGreaterThan(content.indexOf("[DONE]"));
  });

  it("appends to an already attached output log only when the continuation starts", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    const record = manager.getRecord(id)!;
    const outputLog = {
      append: vi.fn(),
      attach: vi.fn(),
      finalize: vi.fn(),
      path: "/tmp/accepted-continuation.log",
    };
    record.execution.outputLog = outputLog as any;

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "continued", aborted: false,
    });
    const { promise } = manager.continueAgent(id, "second task", {});
    expect(outputLog.append).toHaveBeenCalledWith("second task");
    expect(outputLog.attach).toHaveBeenCalledWith(expect.anything(), expect.any(Number));
    await promise;
    expect(outputLog.finalize).toHaveBeenCalledOnce();
  });

  it("finalizes the output log at each terminal boundary and reopens it in append mode", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    const record = manager.getRecord(id)!;
    // The initial execution finalized and detached its log.
    expect(record.execution.outputLog).toBeUndefined();

    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const first = manager.continueAgent(id, "second", {});
    expect(record.execution.outputLog).toBeDefined();

    secondRun.resolve({ responseText: "second done", aborted: false });
    await first.promise;
    // Terminal again: the continuation log is finalized and detached.
    expect(record.execution.outputLog).toBeUndefined();
  });

  it("starts the continuation immediately on a completed record", async () => {
    manager = new AgentManager(onComplete);
    const session = mockAgentSession(["user"]);
    const { id } = await spawnCompletedAgent("initial task", { session });
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "immediate", aborted: false,
    });

    const { promise } = manager.continueAgent(id, "follow up", {});
    expect(mockModules.mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)!.lifecycle.status).toBe("running");
    await promise;
    expect(manager.getRecord(id)!.lifecycle.status).toBe("completed");
  });

  it("sets the queued initial execution summary to running when the runner starts", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    const blocker = makeResolvablePromise();
    const queuedRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise).mockReturnValueOnce(queuedRun.promise);
    manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "scout", "queued", { description: "queued" });
    const record = manager.getRecord(queuedId)!;
    expect(record.stats.executions![0]!.status).toBe("queued");

    blocker.resolve(mockRunResult());
    await vi.waitFor(() => expect(record.lifecycle.status).toBe("running"));
    expect(record.stats.executions![0]!.status).toBe("running");

    queuedRun.resolve(mockRunResult({ responseText: "queued done" }));
    await record.execution.promise;
    expect(record.stats.executions![0]!.status).toBe("completed");
  });

  it("stops a queued background continuation, observes its rejection, and never runs it", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    await manager.getRecord(id)!.execution.promise;

    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });

    const queued = manager.continueAgent(id, "bg follow-up", { isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.lifecycle.status).toBe("queued");
    expect(manager.abort(id, "agent")).toBe(true);

    // The background caller's promise settles with the stop; the manager
    // observed the rejection at acceptance so this is never unhandled.
    await expect(queued.promise).rejects.toThrow("was stopped");
    expect(record.lifecycle.status).toBe("stopped");
    expect(record.lifecycle.settled).toBe(true);
    expect(record.stats.executions![1]).toMatchObject({ status: "stopped" });
    expect(record.result).toBeUndefined(); // never reuses the prior result
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();

    // The stopped execution must not start when the slot frees.
    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
    expect(mockModules.mockExecuteAgentTurn).not.toHaveBeenCalled();
    // The exact stopped execution summary was reported once.
    expect(onComplete).toHaveBeenCalledWith(record, record.stats.executions![1]);
  });

  it("clears the prior result on a synchronous continuation start failure", async () => {
    manager = new AgentManager(onComplete, { default: 1 }, (record) => {
      if ((record.stats.executions?.length ?? 0) > 1) throw new Error("start boom");
    });
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    await manager.getRecord(id)!.execution.promise;

    const { promise, record } = manager.continueAgent(id, "second", {});
    await expect(promise).rejects.toThrow("start boom");
    // The failed execution never produced a result: no prior text may leak.
    expect(record.result).toBeUndefined();
    expect(record.error).toBe("start boom");
    expect(onComplete).toHaveBeenCalledWith(record, record.stats.executions![1]);
    expect(onComplete).toHaveBeenCalledTimes(2); // initial + failed continuation
  });

  it("ignores captured stale text callbacks from an older execution", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    const onTextDelta = vi.fn();

    const firstRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(firstRun.promise);
    const first = manager.continueAgent(id, "first follow-up", { onTextDelta });
    const firstCallbacks = mockModules.mockExecuteAgentTurn.mock.calls[0]![2];
    firstRun.resolve({ responseText: "first", aborted: false });
    await first.promise;

    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const second = manager.continueAgent(id, "second follow-up", { onTextDelta });
    const secondCallbacks = mockModules.mockExecuteAgentTurn.mock.calls[1]![2];
    onTextDelta.mockClear();

    firstCallbacks.onTextDelta("stale", "stale full text");
    await Promise.resolve();
    expect(onTextDelta).not.toHaveBeenCalled();

    secondCallbacks.onTextDelta("a", "second text");
    expect(onTextDelta).toHaveBeenCalledWith("a", "second text");

    secondRun.resolve({ responseText: "second", aborted: false });
    await second.promise;
    expect(manager.getRecord(id)!.stats.executions![2]).toMatchObject({
      status: "completed",
      responseText: "second",
    });
  });
  it("ignores a stale usage callback from a finished execution during a later execution", async () => {
    manager = new AgentManager(onComplete);
    const getContextUsage = vi.fn(() => ({ percent: 10, contextWindow: 1000 }));
    const session = {
      ...mockAgentSession(),
      getContextUsage,
      sessionManager: { getLeafId: () => "leaf-1" },
    };
    const { id } = await spawnCompletedAgent("initial task", { session });

    // Execution 1: capture its event callbacks, then complete it.
    const firstRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(firstRun.promise);
    const first = manager.continueAgent(id, "first follow-up", {});
    const firstCallbacks = mockModules.mockExecuteAgentTurn.mock.calls[0]![2];
    firstRun.resolve({ responseText: "first", aborted: false });
    await first.promise;
    const record = manager.getRecord(id)!;
    const samplesAfterFirst = record.stats.contextStats?.count ?? 0;

    // Execution 2 claims the record and runs on the same session.
    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const second = manager.continueAgent(id, "second follow-up", {});
    getContextUsage.mockClear();

    // Late events from execution 1 arrive while execution 2 runs. They must
    // not mutate the record, observe the session, or reach a live consumer.
    const usageBefore = { ...record.stats.lifetimeUsage };
    const compactionsBefore = record.stats.compactionCount;
    firstCallbacks.onAssistantUsage({ input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 0 });
    firstCallbacks.onSupplementalUsage({ input: 2, output: 2, cacheWrite: 0, cacheRead: 0, cost: 0 });
    firstCallbacks.onCompaction({ reason: "threshold", tokensBefore: 500 });
    await Promise.resolve();
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(record.stats.contextStats?.count ?? 0).toBe(samplesAfterFirst);
    expect(record.stats.lifetimeUsage).toEqual(usageBefore);
    expect(record.stats.compactionCount).toBe(compactionsBefore);

    secondRun.resolve({ responseText: "second", aborted: false });
    await second.promise;
    expect(record.stats.executions![2]).toMatchObject({ status: "completed", responseText: "second" });
  });

  it("continues when output-log attachment fails and still settles normally", async () => {
    manager = new AgentManager(onComplete);
    const session = mockAgentSession();
    const { id } = await spawnCompletedAgent("initial task", { session });
    session.subscribe.mockImplementationOnce(() => {
      throw new Error("output stream unavailable");
    });
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "continued", aborted: false,
    });

    const { promise, record } = manager.continueAgent(id, "follow-up", {});
    await expect(promise).resolves.toBe("continued");
    expect(session.subscribe).toHaveBeenCalledOnce();
    expect(record.lifecycle.status).toBe("completed");
    expect(record.execution.outputLog).toBeUndefined();
  });

  it("fails a queued continuation if its retained session disappears before start", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    const { id } = await spawnCompletedAgent("initial task");

    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(fakePi(), fakeCtx(), "scout", "blocker", { description: "blocker" });
    const queued = manager.continueAgent(id, "queued follow-up", {});
    const record = manager.getRecord(id)!;
    record.execution.session = undefined;

    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
    await expect(queued.promise).rejects.toThrow("session is no longer available");
    expect(record.lifecycle).toMatchObject({ status: "error", settled: true });
    expect(record.stats.executions![1]).toMatchObject({
      status: "error",
      error: expect.stringContaining("session is no longer available"),
    });
  });

  it("returns an empty continuation result instead of the prior execution's text", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    expect(manager.getRecord(id)!.result).toBe("done");

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "", aborted: false,
    });
    const { promise, record } = manager.continueAgent(id, "empty turn", {});
    await promise;
    expect(record.result).toBe("");
    expect(record.result).not.toBe("done"); // never reuses the prior assistant text
    expect(record.stats.executions![1]!.responseText).toBe("");
  });

  it("does not notify twice when an unstarted terminal path is reconciled", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    const aborted = new AbortController();
    aborted.abort();

    const { promise, record } = manager.continueAgent(id, "cancelled", { signal: aborted.signal });
    await expect(promise).rejects.toThrow("was stopped");
    const execution = record.stats.executions![1]!;
    expect((manager as any).finishUnstartedExecution(record, execution, "stopped")).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(2); // initial + one continuation terminal callback
  });

  it("keeps manager configuration and shutdown failure-safe around retained records", async () => {
    manager = new AgentManager(onComplete);
    manager.setConcurrency({ default: 0 });
    expect(manager.abort("missing", "agent")).toBe(false);

    const session = mockAgentSession();
    session.dispose.mockImplementation(() => { throw new Error("dispose failed"); });
    const { id } = await spawnCompletedAgent("initial task", { session });
    expect(manager.abort(id, "agent")).toBe(false);

    const record = manager.getRecord(id)!;
    manager.dispose();

    expect(manager.getRecord(id)).toBeUndefined();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(record.execution.session).toBeUndefined();
    expect(record.execution.abortController).toBeUndefined();
    expect(record.execution.promise).toBeUndefined();
  });
});
