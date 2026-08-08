import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi, resolvedSpawnFixture } from "../fixtures.ts";

const state = vi.hoisted(() => ({
  runAgent: vi.fn(),
  executeAgentTurn: vi.fn(),
}));
vi.mock("../../src/agents/agent-runner.js", () => ({ runAgent: state.runAgent }));
vi.mock("../../src/agents/agent-session-runtime.js", () => ({ executeAgentTurn: state.executeAgentTurn }));

import { AgentManager, MAX_QUEUED_ROOT_EXECUTIONS, QUEUE_QUOTA_ERROR } from "../../src/agents/agent-manager.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function session() {
  return { messages: [], subscribe: vi.fn(() => () => {}), dispose: vi.fn() } as any;
}

function runResult(responseText = "done") {
  return { responseText, aborted: false, session: session() };
}

describe("AgentContinue root control", () => {
  let manager: AgentManager;

  beforeEach(() => {
    state.runAgent.mockReset();
    state.executeAgentTurn.mockReset();
    state.runAgent.mockResolvedValue(runResult("initial"));
  });

  afterEach(() => manager?.dispose());

  async function completedRoot() {
    manager = new AgentManager({ default: 1 });
    const coordinator = new SpawnCoordinator(manager);
    return coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "initial" }));
  }

  it("accepts an exact id or unique prefix and reuses the settled session", async () => {
    const root = await completedRoot();
    const turn = deferred<{ responseText: string; aborted: boolean }>();
    state.executeAgentTurn.mockReturnValue(turn.promise);
    const continuation = manager.continueAgent(root.agentId.slice(0, 8), "continue");
    expect(continuation.record.execution.session).toBe(root.record.execution.session);
    turn.resolve({ responseText: "continued", aborted: false });
    await expect(continuation.promise).resolves.toBe("continued");
  });

  it("rejects missing, ambiguous, active, failed, and unavailable sessions", async () => {
    manager = new AgentManager({ default: 2 });
    expect(() => manager.continueAgent("missing", "prompt")).toThrow("not found");
    const firstDeferred = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(firstDeferred.promise).mockResolvedValueOnce(runResult("second"));
    const coordinator = new SpawnCoordinator(manager);
    const first = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "one" }));
    const second = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "two" }));
    const secondResult = await second;
    const prefix = manager.listAgents()[0]!.id.slice(0, 1);
    if (manager.listAgents().filter((record) => record.id.startsWith(prefix)).length > 1) {
      expect(() => manager.continueAgent(prefix, "prompt")).toThrow("ambiguous");
    }
    const firstRecord = manager.listAgents().find((record) => record.display.description === "one")!;
    expect(() => manager.continueAgent(firstRecord.id, "prompt")).toThrow(/running|cannot be continued/);
    firstDeferred.resolve(runResult("one"));
    await first;

    const failed = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(failed.promise);
    const failedCall = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "failed" }));
    failed.reject(new Error("provider unavailable"));
    await failedCall;
    const failedRecord = manager.listAgents().find((record) => record.display.description === "failed")!;
    expect(() => manager.continueAgent(failedRecord.id, "prompt")).toThrow("cannot be continued");

    const noSession = manager.getRecord(secondResult.agentId)!;
    noSession.execution.session = undefined;
    expect(() => manager.continueAgent(secondResult.agentId, "prompt")).toThrow("session is no longer available");
  });

  it("rejects invalid prompts before allocating continuation history", async () => {
    const root = await completedRoot();
    const before = root.record.stats.executions?.length;
    expect(() => manager.continueAgent(root.agentId, "   ")).toThrow("prompt is required");
    expect(() => manager.continueAgent(root.agentId, "x".repeat(256 * 1024 + 1))).toThrow("256 KiB");
    expect(root.record.stats.executions?.length).toBe(before);
  });

  it("enforces the bounded FIFO root queue for continuations and spawns", async () => {
    manager = new AgentManager({ default: 1 });
    const first = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(first.promise);
    const coordinator = new SpawnCoordinator(manager);
    const running = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "running" }));
    for (let i = 0; i < MAX_QUEUED_ROOT_EXECUTIONS; i++) {
      coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: `queued-${i}` }));
    }
    expect(() => manager.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "overflow" })))
      .toThrow(QUEUE_QUOTA_ERROR);
    first.resolve(runResult("running"));
    await running;
  });

  it("keeps promise release identity-safe across continuation generations", async () => {
    const root = await completedRoot();
    const firstTurn = deferred<{ responseText: string; aborted: boolean }>();
    const secondTurn = deferred<{ responseText: string; aborted: boolean }>();
    state.executeAgentTurn.mockReturnValueOnce(firstTurn.promise).mockReturnValueOnce(secondTurn.promise);
    const first = manager.continueAgent(root.agentId, "first follow-up");
    firstTurn.resolve({ responseText: "first", aborted: false });
    await first.promise;
    const second = manager.continueAgent(root.agentId, "second follow-up");
    expect(manager.releaseExecutionPromise(root.record, first.promise)).toBe(false);
    expect(root.record.execution.promise).toBe(second.promise);
    secondTurn.resolve({ responseText: "second", aborted: false });
    await second.promise;
    expect(manager.releaseExecutionPromise(root.record, second.promise)).toBe(true);
  });

  it("stops a running continuation when its parent call is aborted", async () => {
    const root = await completedRoot();
    const turn = deferred<{ responseText: string; aborted: boolean }>();
    state.executeAgentTurn.mockReturnValueOnce(turn.promise);
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    const continuation = manager.continueAgent(root.agentId, "running follow-up", { signal: parent.signal });

    expect(root.record.lifecycle.status).toBe("running");
    parent.abort();
    expect(root.record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });

    turn.resolve({ responseText: "partial", aborted: true });
    await expect(continuation.promise).resolves.toBe("partial");
    expect(root.record.lifecycle).toMatchObject({ status: "stopped", settled: true });
    expect(removeListener).toHaveBeenCalled();
  });

  it("cleans a running continuation and its session during manager shutdown", async () => {
    const root = await completedRoot();
    const turn = deferred<{ responseText: string; aborted: boolean }>();
    state.executeAgentTurn.mockReturnValueOnce(turn.promise);
    const continuation = manager.continueAgent(root.agentId, "shutdown follow-up");
    const childSession = root.record.execution.session;

    manager.dispose();
    await expect(continuation.promise).rejects.toThrow("Agent session shut down");
    expect(manager.getRecord(root.agentId)).toBeUndefined();
    expect(childSession?.dispose).toHaveBeenCalledOnce();
    expect(root.record.execution.session).toBeUndefined();
    expect(root.record.execution.abortController).toBeUndefined();

    turn.resolve({ responseText: "late", aborted: true });
    await Promise.resolve();
  });

  it("rejects a queued continuation when its parent call is aborted", async () => {
    manager = new AgentManager({ default: 1 });
    const root = await new SpawnCoordinator(manager).spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "root" }));
    const blocker = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValue(blocker.promise);
    const running = new SpawnCoordinator(manager).spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "blocker" }));
    const parent = new AbortController();
    const continuation = manager.continueAgent(root.agentId, "queued follow-up", { signal: parent.signal });
    parent.abort();
    await expect(continuation.promise).rejects.toThrow("stopped");
    blocker.resolve(runResult("blocker"));
    await running;
  });
});
