/**
 * agent-manager-continue.test.ts — AgentManager.continueAgent execution model.
 *
 * Covers the strict continuation gate (completed + settled + usable session),
 * the global concurrency slot consumption, per-execution generation/delivery/
 * usage deltas, StopAgent handling of queued/running continuations, output-log
 * append semantics, ID resolution, and the root-only / nested rejection
 * contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";

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
  turnLimited: boolean;
};

function mockRunResult(overrides?: Partial<MockRunResult>): MockRunResult {
  return {
    responseText: "done",
    session: mockAgentSession(),
    aborted: false,
    turnLimited: false,
    ...overrides,
  };
}

import { AgentManager } from "../../src/agents/agent-manager.js";
import type { OnAgentComplete } from "../../src/agents/agent-manager.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import {
  createSubagentRuntimeContext,
  getStore,
  runWithSubagentRuntime,
} from "../../src/shell.js";
import { buildAgentDetails } from "../../src/agents/tool-execution.js";

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
      ["implementer", { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 }],
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
      turnLimited: false,
    });

    const { executionId, record, promise } = manager.continueAgent(id, "follow up", { graceTurns: 6 });
    const result = await promise;

    expect(result).toBe("follow-up result");
    expect(record).toBe(manager.getRecord(id));
    expect(mockModules.mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    const [turnSession, turnPrompt, turnOptions] = mockModules.mockExecuteAgentTurn.mock.calls[0]!;
    expect(turnSession).toBe(session); // same-session continuation
    expect(turnPrompt).toBe("follow up");
    expect(turnOptions.signal).toBeInstanceOf(AbortSignal);
    expect(turnOptions.signal!.aborted).toBe(false);
    expect(typeof turnOptions.onTurnEnd).toBe("function");
    // The record's spawn turn budget is reused per execution.
    expect(turnOptions.maxTurns).toBeUndefined();
    expect(turnOptions.graceTurns).toBe(6); // explicit per-execution override

    expect(record.lifecycle.status).toBe("completed");
    expect(record.result).toBe("follow-up result");
    expect(record.lifecycle.settled).toBe(true);
    expect(record.stats.executions).toHaveLength(2);
    expect(executionId).toBe(record.stats.executions![1]!.id);
    expect(record.stats.executions![1]).toMatchObject({
      prompt: "follow up",
      mode: "foreground",
      status: "completed",
      responseText: "follow-up result",
      deliveredText: "follow-up result",
    });
    expect(onComplete).toHaveBeenCalledWith(record, record.stats.executions![1]);
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
    secondRun.resolve({ responseText: "second", aborted: false, turnLimited: false });
    await promise;

    expect(record.stats.executions![0]!.usage).toMatchObject({ input: 10, output: 5, cacheWrite: 2, cacheRead: 3 });
    expect(record.stats.executions![0]!.usage!.cost).toBeCloseTo(0.01);
    expect(record.stats.executions![1]!.usage).toMatchObject({ input: 20, output: 6, cacheWrite: 1, cacheRead: 4 });
    expect(record.stats.executions![1]!.usage!.cost).toBeCloseTo(0.02);
    expect(record.stats.lifetimeUsage).toEqual({ input: 30, output: 11, cacheWrite: 3, cost: 0.03 });
    expect(record.stats.cacheRead).toBe(7);
    expect(manager.getTotalAgentCost()).toBeCloseTo(0.03);
  });

  it("records per-execution tool-use and compaction deltas against nonzero initial totals", async () => {
    manager = new AgentManager(onComplete);
    const firstRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "initial task", { description: "initial" });
    const record = manager.getRecord(id)!;

    // Initial execution accumulates real usage, tool uses, and compactions.
    const runOptions = mockModules.mockRunAgent.mock.calls[0]![3];
    runOptions.onAssistantUsage({ input: 10, output: 5, cacheWrite: 2, cacheRead: 3, cost: 0.01 });
    runOptions.onToolActivity({ type: "start", toolName: "read" });
    runOptions.onToolActivity({ type: "end", toolName: "read" });
    runOptions.onToolActivity({ type: "end", toolName: "grep" });
    runOptions.onCompaction({ reason: "threshold", tokensBefore: 100 });
    firstRun.resolve(mockRunResult());
    await record.execution.promise;

    // The initial execution summary carries its own delta only.
    expect(record.stats.executions![0]!.toolUses).toBe(2);
    expect(record.stats.executions![0]!.compactionCount).toBe(1);

    // Continuation runs on top of the nonzero initial totals.
    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const { promise } = manager.continueAgent(id, "second task", {});
    const turnOptions = mockModules.mockExecuteAgentTurn.mock.calls[0]![2];
    turnOptions.onAssistantUsage({ input: 20, output: 6, cacheWrite: 1, cacheRead: 4, cost: 0.02 });
    turnOptions.onToolActivity({ type: "end", toolName: "read" });
    turnOptions.onToolActivity({ type: "end", toolName: "read" });
    turnOptions.onToolActivity({ type: "end", toolName: "read" });
    turnOptions.onCompaction({ reason: "overflow", tokensBefore: 200 });
    secondRun.resolve({ responseText: "second", aborted: false, turnLimited: false });
    await promise;

    // The continuation summary reports only its own delta, never the initial
    // (or cumulative) totals.
    expect(record.stats.executions![1]!.toolUses).toBe(3);
    expect(record.stats.executions![1]!.compactionCount).toBe(1);
    expect(record.stats.executions![1]!.usage).toMatchObject({ input: 20, output: 6, cacheWrite: 1, cacheRead: 4 });
    expect(record.stats.executions![1]!.usage!.cost).toBeCloseTo(0.02);
    // Cumulative record totals and the session cost keep lifetime semantics.
    expect(record.stats.toolUses).toBe(5);
    expect(record.stats.compactionCount).toBe(2);
    expect(record.stats.lifetimeUsage).toEqual({ input: 30, output: 11, cacheWrite: 3, cost: 0.03 });
    expect(manager.getTotalAgentCost()).toBeCloseTo(0.03);
  });

  it("accumulates per-execution turn counts into the cumulative record total", async () => {
    manager = new AgentManager(onComplete);
    const firstRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "initial task", { description: "initial" });
    const record = manager.getRecord(id)!;

    const runOptions = mockModules.mockRunAgent.mock.calls[0]![3];
    runOptions.onTurnEnd(2);
    firstRun.resolve(mockRunResult());
    await record.execution.promise;

    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const { promise } = manager.continueAgent(id, "second task", {});
    mockModules.mockExecuteAgentTurn.mock.calls[0]![2].onTurnEnd(3);
    secondRun.resolve({ responseText: "second", aborted: false, turnLimited: false });
    await promise;

    expect(record.stats.executions![0]!.turnCount).toBe(2);
    expect(record.stats.executions![1]!.turnCount).toBe(3);
    expect(record.stats.turnCount).toBe(5);
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

    const turnLimited = await spawnCompletedAgent("limited", { runResult: { turnLimited: true } });
    expect(() => manager.continueAgent(turnLimited.id, "nope", {}))
      .toThrow("is turn_limited and cannot be continued");

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
    // A second continuation while the first is running is rejected too.
    expect(() => manager.continueAgent(firstId, "again", {}))
      .toThrow("is running and cannot be continued");

    continuationRun.resolve({ responseText: "continued", aborted: false, turnLimited: false });
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

    bg.resolve({ responseText: "bg done", aborted: false, turnLimited: false });
    await promise;
    expect(record.stats.executions![1]).toMatchObject({ mode: "background", status: "completed" });
    expect(record.lifecycle.status).toBe("completed");
  });

  it("delivers the latest execution's result and notifies once per executed turn", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "first follow-up", aborted: false, turnLimited: false,
    });
    const first = manager.continueAgent(id, "follow-up one", {});
    await first.promise;

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "second follow-up", aborted: false, turnLimited: false,
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
    initialRecord.stats.toolUses = 6;
    initialRecord.stats.turnCount = 7;
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
      turnCount: 0,
      toolUses: 0,
      compactionCount: 0,
    });
    const foregroundDetails = buildAgentDetails(record, { includeStats: true });
    expect(foregroundDetails).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turnCount: 0,
      toolUses: 0,
      compactions: 0,
      compactionCount: 0,
      currentExecution: { status: "stopped", turnCount: 0, toolUses: 0, compactionCount: 0 },
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

    running.resolve({ responseText: "partial", aborted: true, turnLimited: false });
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
    expect(record.stats.executions![1]).toMatchObject({ status: "error", error: "start boom" });
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

  it("turns an aborted continuation into an aborted execution entry", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "partial", aborted: true, turnLimited: false,
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

  it("rejects continuation of a nested agent", async () => {
    manager = new AgentManager(onComplete);
    const parentRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockResolvedValueOnce(mockRunResult());
    const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
      description: "parent",
      agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 },
    });
    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
      description: "child",
      agentConfig: { name: "scout", description: "", systemPrompt: "" },
    });
    await manager.getRecord(childId)!.execution.promise;

    expect(() => manager.continueAgent(childId, "nope", {}))
      .toThrow("Nested agents cannot be continued");
    parentRun.resolve(mockRunResult());
    await manager.getRecord(parentId)!.execution.promise;
  });

  it("rejects continuation from a child runtime", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    await runWithSubagentRuntime(
      createSubagentRuntimeContext(async () => ({ content: [] }), getStore().createSubagentRuntimeSettings()),
      async () => {
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
      responseText: "ok", aborted: false, turnLimited: false,
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
    expect(mockModules.fsMock.writeFileSync).toHaveBeenCalledTimes(1); // initial [USER] entry

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "second", aborted: false, turnLimited: false,
    });
    const { promise } = manager.continueAgent(id, "second task", {});
    await promise;

    // Append mode writes the continuation [USER] entry via appendFileSync and
    // never re-truncates the file with writeFileSync.
    expect(mockModules.fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    expect(mockModules.fsMock.appendFileSync).toHaveBeenCalled();
    const record = manager.getRecord(id)!;
    expect(record.display.outputFile).toBeTruthy();
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

    secondRun.resolve({ responseText: "second done", aborted: false, turnLimited: false });
    await first.promise;
    // Terminal again: the continuation log is finalized and detached.
    expect(record.execution.outputLog).toBeUndefined();
  });

  it("reuses the spawn's stored maxTurns and graceTurns per continuation execution", async () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "initial", {
      description: "initial", maxTurns: 4, graceTurns: 9,
    });
    await manager.getRecord(id)!.execution.promise;

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "second", aborted: false, turnLimited: false,
    });
    const { promise } = manager.continueAgent(id, "second", {});
    await promise;
    expect(mockModules.mockExecuteAgentTurn.mock.calls[0]![2].maxTurns).toBe(4);
    expect(mockModules.mockExecuteAgentTurn.mock.calls[0]![2].graceTurns).toBe(9);
  });

  it("starts the continuation immediately on a completed record", async () => {
    manager = new AgentManager(onComplete);
    const session = mockAgentSession(["user"]);
    const { id } = await spawnCompletedAgent("initial task", { session });
    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "immediate", aborted: false, turnLimited: false,
    });

    const { promise } = manager.continueAgent(id, "follow up", {});
    expect(mockModules.mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)!.lifecycle.status).toBe("running");
    await promise;
    expect(manager.getRecord(id)!.lifecycle.status).toBe("completed");
  });

  it("persists the effective configured maxTurns and default graceTurns for continuations", async () => {
    manager = new AgentManager(onComplete);
    // No per-spawn override: the runner's effective budget comes from the
    // agent config (maxTurns) and the global default (graceTurns). The record
    // must persist those effective values so continuations reuse them.
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "initial", {
      description: "initial",
      agentConfig: { name: "scout", description: "", systemPrompt: "", maxTurns: 7 },
    });
    const record = manager.getRecord(id)!;
    expect(record.stats.maxTurns).toBe(7);
    expect(record.stats.graceTurns).toBe(6); // DEFAULT_GRACE_TURNS
    await record.execution.promise;

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "second", aborted: false, turnLimited: false,
    });
    const { promise } = manager.continueAgent(id, "second", {});
    await promise;
    // The continuation reuses the persisted effective budget.
    expect(mockModules.mockExecuteAgentTurn.mock.calls[0]![2].maxTurns).toBe(7);
    expect(mockModules.mockExecuteAgentTurn.mock.calls[0]![2].graceTurns).toBe(6);
  });

  it("normalizes a zero maxTurns to unlimited when persisting the effective budget", async () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "initial", {
      description: "initial", maxTurns: 0,
    });
    expect(manager.getRecord(id)!.stats.maxTurns).toBeUndefined();
    await manager.getRecord(id)!.execution.promise;
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

  it("ignores captured stale onTurnEnd and onTextDelta callbacks from an older execution", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    const onTextDelta = vi.fn();

    // Execution 1: capture its callbacks, drive its turn end, complete it.
    const firstRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(firstRun.promise);
    const first = manager.continueAgent(id, "first follow-up", { onTextDelta });
    const firstCallbacks = mockModules.mockExecuteAgentTurn.mock.calls[0]![2];
    firstCallbacks.onTurnEnd(2);
    firstRun.resolve({ responseText: "first", aborted: false, turnLimited: false });
    await first.promise;
    const record = manager.getRecord(id)!;
    expect(record.stats.turnCount).toBe(3); // 1 initial default + 2

    // Execution 2 claims the record and runs on the same session.
    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const second = manager.continueAgent(id, "second follow-up", { onTextDelta });
    const secondCallbacks = mockModules.mockExecuteAgentTurn.mock.calls[1]![2];
    onTextDelta.mockClear();

    // A late turn-end/text delta from execution 1 arrives while execution 2
    // runs: it must not mutate the cumulative total or the older summary, and
    // must never reach the caller's live view.
    firstCallbacks.onTurnEnd(9);
    firstCallbacks.onTextDelta("stale", "stale full text");
    await Promise.resolve();
    expect(record.stats.turnCount).toBe(3);
    expect(record.stats.executions![1]!.turnCount).toBe(2);
    expect(onTextDelta).not.toHaveBeenCalled();

    // The active execution's own callbacks still work.
    secondCallbacks.onTurnEnd(1);
    secondCallbacks.onTextDelta("a", "second text");
    expect(onTextDelta).toHaveBeenCalledWith("a", "second text");
    expect(record.stats.executions![2]!.turnCount).toBe(1);

    secondRun.resolve({ responseText: "second", aborted: false, turnLimited: false });
    await second.promise;
    expect(record.stats.turnCount).toBe(4); // 3 + 1
    expect(record.stats.executions![2]).toMatchObject({ status: "completed", turnCount: 1, responseText: "second" });
  });

  it("ignores a stale initial-spawn onTurnEnd callback during a continuation", async () => {
    manager = new AgentManager(onComplete);
    const initialRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(initialRun.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "scout", "initial task", { description: "initial" });
    const record = manager.getRecord(id)!;
    const initialCallbacks = mockModules.mockRunAgent.mock.calls[0]![3];
    initialCallbacks.onTurnEnd(2);
    initialRun.resolve(mockRunResult());
    await record.execution.promise;
    expect(record.stats.turnCount).toBe(2);

    // The continuation claims the record; the initial spawn's delayed
    // turn-end callback must not overwrite the cumulative total or the
    // initial execution summary afterwards.
    const contRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(contRun.promise);
    const cont = manager.continueAgent(id, "follow-up", {});
    initialCallbacks.onTurnEnd(7);
    expect(record.stats.turnCount).toBe(2);
    expect(record.stats.executions![0]!.turnCount).toBe(2);

    contRun.resolve({ responseText: "done", aborted: false, turnLimited: false });
    await cont.promise;
    expect(record.stats.executions![1]).toMatchObject({ status: "completed", responseText: "done" });
    expect(record.stats.turnCount).toBe(2); // unchanged by the stale callback
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
    firstRun.resolve({ responseText: "first", aborted: false, turnLimited: false });
    await first.promise;
    const record = manager.getRecord(id)!;
    const samplesAfterFirst = record.stats.contextStats?.count ?? 0;

    // Execution 2 claims the record and runs on the same session.
    const secondRun = makeResolvablePromise();
    mockModules.mockExecuteAgentTurn.mockReturnValueOnce(secondRun.promise);
    const second = manager.continueAgent(id, "second follow-up", {});
    getContextUsage.mockClear();

    // A late usage event from execution 1 arrives while execution 2 runs. It
    // must not mutate the record or observe the session.
    firstCallbacks.onAssistantUsage({ input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 0 });
    await Promise.resolve();
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(record.stats.contextStats?.count ?? 0).toBe(samplesAfterFirst);

    secondRun.resolve({ responseText: "second", aborted: false, turnLimited: false });
    await second.promise;
    expect(record.stats.executions![2]).toMatchObject({ status: "completed", responseText: "second" });
  });

  it("returns an empty continuation result instead of the prior execution's text", async () => {
    manager = new AgentManager(onComplete);
    const { id } = await spawnCompletedAgent("initial task");
    expect(manager.getRecord(id)!.result).toBe("done");

    mockModules.mockExecuteAgentTurn.mockResolvedValueOnce({
      responseText: "", aborted: false, turnLimited: false,
    });
    const { promise, record } = manager.continueAgent(id, "empty turn", {});
    await promise;
    expect(record.result).toBe("");
    expect(record.result).not.toBe("done"); // never reuses the prior assistant text
    expect(record.stats.executions![1]!.responseText).toBe("");
  });

  it("keeps the retention default at 60 minutes", () => {
    expect(AgentManager.DEFAULT_RETENTION_MINUTES).toBe(60);
  });
});
