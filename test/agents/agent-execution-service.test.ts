import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedSpawnFixture, fakeCtx, fakePi } from "../fixtures.ts";
import {
  AgentExecutionService,
  type ContinueExecutionTask,
  type SpawnExecutionTask,
} from "../../src/agents/agent-execution-service.js";
import { AgentRecordStore } from "../../src/agents/agent-record-store.js";
import { ExecutionTelemetry } from "../../src/agents/execution-telemetry.js";
import type { AgentExecutionSummary } from "../../src/types.js";

const state = vi.hoisted(() => ({
  runAgent: vi.fn(),
  executeAgentTurn: vi.fn(),
}));
vi.mock("../../src/agents/agent-runner.js", () => ({ runAgent: state.runAgent }));
vi.mock("../../src/agents/agent-session-runtime.js", () => ({ executeAgentTurn: state.executeAgentTurn }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(): any {
  return { messages: [], subscribe: vi.fn(), dispose: vi.fn() };
}

function runResult(responseText = "done", aborted = false, childSession = session()) {
  return { responseText, session: childSession, aborted };
}

const services = new Set<AgentExecutionService>();

describe("AgentExecutionService", () => {
  beforeEach(() => {
    state.runAgent.mockReset();
    state.executeAgentTurn.mockReset();
  });

  afterEach(() => {
    for (const service of services) service.dispose();
    services.clear();
  });

  it("discards a spawn whose runner cannot start synchronously", () => {
    const failure = new Error("spawn setup failed");
    state.runAgent.mockImplementation(() => { throw failure; });
    const { service, store, telemetry } = createService(1);
    const accepted = acceptedSpawnFixture({ prompt: "sync failure" });
    const created = store.createSpawnRecord(accepted, "running", new AbortController());
    initialize(telemetry, created.record, created.execution);

    expect(() => service.submit(spawnTask(created, accepted))).toThrow(failure);

    expect(store.get(created.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(service.pendingCount).toBe(0);
    expect(state.runAgent).toHaveBeenCalledOnce();
  });

  it("rejects a continuation whose turn cannot start synchronously and retains its session", async () => {
    const failure = new Error("continuation setup failed");
    state.executeAgentTurn.mockImplementation(() => { throw failure; });
    const { service, store, telemetry } = createService(1);
    const root = completedRecord(store, telemetry);
    const continuation = continuationTask(store, telemetry, root);

    service.submit(continuation.task);

    await expect(continuation.caller.promise).rejects.toThrow(failure);
    expect(root.record.lifecycle).toMatchObject({ status: "error", settled: true });
    expect(root.record.stats.currentExecution).toMatchObject({
      status: "error",
      error: "continuation setup failed",
    });
    expect(root.record.execution.session).toBe(root.session);
    expect(state.executeAgentTurn).toHaveBeenCalledOnce();
    expect(service.pendingCount).toBe(0);
  });

  it("rejects a stale continuation submission without changing the current record or queue", async () => {
    const { service, store, telemetry } = createService(1);
    const root = completedRecord(store, telemetry, "stale submission root");
    const current = root.record.stats.currentExecution!;
    const beforeLifecycle = { ...root.record.lifecycle };
    const beforeResult = root.record.result;
    const beforeError = root.record.error;
    const beforeSession = root.record.execution.session;
    const beforePromise = root.record.execution.promise;
    const staleExecution: AgentExecutionSummary = {
      id: current.id,
      kind: "continued",
      prompt: "stale follow-up",
      status: "queued",
      startedAt: current.startedAt + 1,
    };
    const baseline = telemetry.beginExecution(staleExecution, root.record);
    const caller = deferred<string>();
    const staleTask: ContinueExecutionTask = {
      kind: "continue",
      id: root.id,
      record: root.record,
      execution: staleExecution,
      request: {
        record: root.record,
        session: root.session,
        executionId: staleExecution.id,
        baseline,
        prompt: staleExecution.prompt,
        resolve: caller.resolve,
        reject: caller.reject,
        startedAt: staleExecution.startedAt,
      },
    };

    expect(service.pendingCount).toBe(0);
    service.submit(staleTask);
    await expect(caller.promise).rejects.toThrow("no longer current");
    expect(service.pendingCount).toBe(0);
    expect(root.record.lifecycle).toEqual(beforeLifecycle);
    expect(root.record.result).toBe(beforeResult);
    expect(root.record.error).toBe(beforeError);
    expect(root.record.execution.session).toBe(beforeSession);
    expect(root.record.execution.promise).toBe(beforePromise);
    expect(root.record.stats.currentExecution).toBe(current);
    expect(service.shouldQueue()).toBe(false);

    state.runAgent.mockResolvedValue(runResult("following task"));
    const following = spawnWithCaller(store, telemetry, "following task", "running");
    service.submit(following.task);
    await expect(following.caller.promise).resolves.toBe("following task");
    expect(state.runAgent).toHaveBeenCalledOnce();
    expect(service.pendingCount).toBe(0);
  });

  it("settles an asynchronously failed spawn and keeps its slot advancing FIFO", async () => {
    const firstFailure = deferred<ReturnType<typeof runResult>>();
    const secondRun = deferred<ReturnType<typeof runResult>>();
    const thirdRun = deferred<ReturnType<typeof runResult>>();
    state.runAgent
      .mockReturnValueOnce(firstFailure.promise)
      .mockReturnValueOnce(secondRun.promise)
      .mockReturnValueOnce(thirdRun.promise);
    const { service, store, telemetry } = createService(1);
    const first = spawnWithCaller(store, telemetry, "async failure", "running");
    const second = spawnWithCaller(store, telemetry, "second", "queued");
    const third = spawnWithCaller(store, telemetry, "third", "queued");
    service.submit(first.task);
    service.submit(second.task);
    service.submit(third.task);

    firstFailure.reject(new Error("provider unavailable"));
    await expect(first.caller.promise).resolves.toBe("");
    expect(first.created.record.lifecycle).toMatchObject({ status: "error", settled: true });
    expect(first.created.record.error).toBe("provider unavailable");
    expect(state.runAgent).toHaveBeenCalledTimes(2);
    expect(state.runAgent.mock.calls.map((call) => call[2])).toEqual(["async failure", "second"]);
    expect(second.created.record.lifecycle.status).toBe("running");
    expect(service.pendingCount).toBe(1);

    secondRun.resolve(runResult("second complete"));
    await expect(second.caller.promise).resolves.toBe("second complete");
    expect(state.runAgent).toHaveBeenCalledTimes(3);
    expect(state.runAgent.mock.calls.map((call) => call[2])).toEqual([
      "async failure",
      "second",
      "third",
    ]);
    expect(third.created.record.lifecycle.status).toBe("running");

    thirdRun.resolve(runResult("third complete"));
    await expect(third.caller.promise).resolves.toBe("third complete");
    expect(first.created.record.stats.currentExecution?.status).toBe("error");
    expect(second.created.record.lifecycle.status).toBe("completed");
    expect(third.created.record.lifecycle.status).toBe("completed");
    expect(service.pendingCount).toBe(0);
  });

  it("rejects generation-99 callbacks and completion after generation-100 without releasing generation-101", async () => {
    const { service, store, telemetry } = createService(1);
    const root = completedRecord(store, telemetry, "generation root");
    let generation = 0;
    let staleCallbacks: any;
    let stale: ReturnType<typeof continuationTask> | undefined;
    state.executeAgentTurn.mockImplementation((_session: unknown, _prompt: string, options: any) => {
      generation++;
      if (generation === 99) staleCallbacks = options;
      return Promise.resolve({ responseText: `generation-${generation}`, aborted: false });
    });

    for (let index = 1; index <= 100; index++) {
      const current = continuationTask(store, telemetry, root, `generation-${index}`);
      if (index === 99) stale = current;
      service.submit(current.task);
      await expect(current.caller.promise).resolves.toBe(`generation-${index}`);
    }
    expect(generation).toBe(100);
    expect(stale).toBeDefined();

    const liveTurn = deferred<{ responseText: string; aborted: boolean }>();
    state.executeAgentTurn.mockReturnValueOnce(liveTurn.promise);
    const live = continuationTask(store, telemetry, root, "generation-101");
    service.submit(live.task);
    const queued = spawnWithCaller(store, telemetry, "queued after stale", "queued");
    service.submit(queued.task);

    const beforeLifecycle = { ...root.record.lifecycle };
    const beforeUsage = { ...root.record.stats.lifetimeUsage };
    const beforeCacheRead = root.record.stats.cacheRead;
    const beforeCompactionCount = root.record.stats.compactionCount;
    const beforeReasons = root.record.stats.compactionReasons;
    const beforeResult = root.record.result;
    const beforeError = root.record.error;
    const current = live.task.execution;
    const currentPromise = live.caller.promise;
    const retainedSession = root.session;

    staleCallbacks.onAssistantUsage({ input: 1_000, output: 1_000, cacheWrite: 1_000, cacheRead: 1_000, cost: 1_000 });
    staleCallbacks.onCompaction({ reason: "overflow", tokensBefore: 999 });
    expect(() => (service as any).finishTurnExecution(
      stale!.task,
      { responseText: "stale result", aborted: false, error: "stale error" },
      stale!.task.request.baseline,
    )).not.toThrow();

    expect(root.record.lifecycle).toEqual(beforeLifecycle);
    expect(root.record.stats.currentExecution).toBe(current);
    expect(root.record.stats.lifetimeUsage).toEqual(beforeUsage);
    expect(root.record.stats.cacheRead).toBe(beforeCacheRead);
    expect(root.record.stats.compactionCount).toBe(beforeCompactionCount);
    expect(root.record.stats.compactionReasons).toBe(beforeReasons);
    expect(root.record.result).toBe(beforeResult);
    expect(root.record.error).toBe(beforeError);
    expect(root.record.execution.promise).toBe(currentPromise);
    expect(root.record.execution.session).toBe(retainedSession);
    expect(retainedSession.dispose).not.toHaveBeenCalled();
    expect(service.pendingCount).toBe(1);
    expect(state.runAgent).not.toHaveBeenCalled();

    state.runAgent.mockResolvedValue(runResult("queued after stale"));
    liveTurn.resolve({ responseText: "generation-101", aborted: false });
    await expect(live.caller.promise).resolves.toBe("generation-101");
    await expect(queued.caller.promise).resolves.toBe("queued after stale");
  });

  it("settles an asynchronously failed continuation without losing its retained session", async () => {
    const turnFailure = deferred<{ responseText: string; aborted: boolean }>();
    state.executeAgentTurn.mockReturnValue(turnFailure.promise);
    const { service, store, telemetry } = createService(1);
    const root = completedRecord(store, telemetry);
    const continuation = continuationTask(store, telemetry, root);

    service.submit(continuation.task);
    turnFailure.reject(new Error("turn failed"));

    await expect(continuation.caller.promise).resolves.toBe("");
    expect(root.record.lifecycle).toMatchObject({ status: "error", settled: true });
    expect(root.record.stats.currentExecution).toMatchObject({
      status: "error",
      error: "turn failed",
      responseText: "",
    });
    expect(root.record.execution.session).toBe(root.session);
    expect(state.executeAgentTurn).toHaveBeenCalledOnce();
    expect(service.pendingCount).toBe(0);
  });

  it("handles a queued synchronous start failure and preserves FIFO for the next task", async () => {
    const firstRun = deferred<ReturnType<typeof runResult>>();
    const thirdRun = deferred<ReturnType<typeof runResult>>();
    state.runAgent
      .mockReturnValueOnce(firstRun.promise)
      .mockImplementationOnce(() => { throw new Error("queued setup failed"); })
      .mockReturnValueOnce(thirdRun.promise);
    const { service, store, telemetry } = createService(1);
    const first = spawnWithCaller(store, telemetry, "first", "running");
    const second = spawnWithCaller(store, telemetry, "second", "queued");
    const third = spawnWithCaller(store, telemetry, "third", "queued");
    service.submit(first.task);
    service.submit(second.task);
    service.submit(third.task);

    firstRun.resolve(runResult("first complete"));
    await expect(first.caller.promise).resolves.toBe("first complete");
    await expect(second.caller.promise).resolves.toBe("");
    expect(second.created.record.lifecycle).toMatchObject({ status: "error", settled: true });
    expect(second.created.record.error).toBe("queued setup failed");
    expect(state.runAgent.mock.calls.map((call) => call[2])).toEqual(["first", "second", "third"]);
    expect(third.created.record.lifecycle.status).toBe("running");
    expect(service.pendingCount).toBe(0);

    thirdRun.resolve(runResult("third complete"));
    await expect(third.caller.promise).resolves.toBe("third complete");
    expect(first.created.record.lifecycle.status).toBe("completed");
    expect(third.created.record.lifecycle.status).toBe("completed");
  });

  it("rejects a queued continuation after synchronous setup failure and advances FIFO", async () => {
    const blockerRun = deferred<ReturnType<typeof runResult>>();
    const followingRun = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(blockerRun.promise).mockReturnValueOnce(followingRun.promise);
    state.executeAgentTurn.mockImplementation(() => { throw new Error("queued continuation setup failed"); });
    const { service, store, telemetry } = createService(1);
    const blocker = spawnWithCaller(store, telemetry, "blocker", "running");
    service.submit(blocker.task);
    const root = completedRecord(store, telemetry, "queued continuation root");
    const continuation = continuationTask(store, telemetry, root, "queued follow-up", "queued");
    service.submit(continuation.task);
    const following = spawnWithCaller(store, telemetry, "following spawn", "queued");
    service.submit(following.task);

    blockerRun.resolve(runResult("blocker complete"));
    await expect(blocker.caller.promise).resolves.toBe("blocker complete");
    await expect(continuation.caller.promise).rejects.toThrow("queued continuation setup failed");
    expect(root.record.lifecycle).toMatchObject({ status: "error", settled: true });
    expect(state.runAgent.mock.calls.map((call) => call[2])).toEqual(["blocker", "following spawn"]);
    expect(following.created.record.lifecycle.status).toBe("running");
    expect(service.pendingCount).toBe(0);

    followingRun.resolve(runResult("following complete"));
    await expect(following.caller.promise).resolves.toBe("following complete");
  });

  it("releases exactly one slot after running spawn cancellation and late completion", async () => {
    const firstRun = deferred<ReturnType<typeof runResult>>();
    const secondRun = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(firstRun.promise).mockReturnValueOnce(secondRun.promise);
    const { service, store, telemetry } = createService(1);
    const parent = new AbortController();
    const first = spawnWithCaller(store, telemetry, "cancelled", "running", parent.signal);
    const second = spawnWithCaller(store, telemetry, "after cancellation", "queued");
    service.submit(first.task);
    service.submit(second.task);

    parent.abort();
    parent.abort();
    expect(first.created.record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
    expect(service.pendingCount).toBe(1);
    expect(state.runAgent).toHaveBeenCalledOnce();

    firstRun.resolve(runResult("partial", true));
    await expect(first.caller.promise).resolves.toBe("partial");
    expect(state.runAgent).toHaveBeenCalledTimes(2);
    expect(second.created.record.lifecycle.status).toBe("running");
    expect(service.pendingCount).toBe(0);

    secondRun.resolve(runResult("after"));
    await expect(second.caller.promise).resolves.toBe("after");
    expect(first.created.record.lifecycle).toMatchObject({ status: "stopped", settled: true });
    expect(second.created.record.lifecycle.status).toBe("completed");
  });

  it("retains callbacks from a cancelled continuation until settlement", async () => {
    const turn = deferred<{ responseText: string; aborted: boolean }>();
    let callbacks: any;
    state.executeAgentTurn.mockImplementation((_session: unknown, _prompt: string, options: any) => {
      callbacks = options;
      return turn.promise;
    });
    const { service, store, telemetry } = createService(1);
    const root = completedRecord(store, telemetry, "cancelled continuation root");
    const parent = new AbortController();
    const continuation = continuationTask(store, telemetry, root, "cancelled follow-up", "running", parent.signal);
    service.submit(continuation.task);
    const next = spawnWithCaller(store, telemetry, "after cancelled continuation", "queued");
    service.submit(next.task);

    parent.abort();
    expect(root.record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
    callbacks.onAssistantUsage({ input: 7, output: 3, cacheWrite: 2, cacheRead: 5, cost: 0.25 });
    callbacks.onCompaction({ reason: "threshold", tokensBefore: 321 });
    expect(root.record.stats.lifetimeUsage).toMatchObject({ input: 7, output: 3, cacheWrite: 2, cost: 0.25 });
    expect(root.record.stats.cacheRead).toBe(5);
    expect(root.record.stats.compactionCount).toBe(1);

    state.runAgent.mockResolvedValue(runResult("after cancelled continuation"));
    turn.resolve({ responseText: "partial", aborted: true });
    await expect(continuation.caller.promise).resolves.toBe("partial");
    await expect(next.caller.promise).resolves.toBe("after cancelled continuation");

    expect(root.record.lifecycle).toMatchObject({ status: "stopped", settled: true });
    expect(root.record.stats.currentExecution).toMatchObject({
      status: "stopped",
      usage: { input: 7, output: 3, cacheWrite: 2, cacheRead: 5, cost: 0.25 },
      compactionCount: 1,
    });
    expect(service.pendingCount).toBe(0);
    expect(state.runAgent).toHaveBeenCalledOnce();
  });

  it("drops stale queued records without consuming the released slot", async () => {
    const blockerRun = deferred<ReturnType<typeof runResult>>();
    const liveRun = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(blockerRun.promise).mockReturnValueOnce(liveRun.promise);
    const { service, store, telemetry } = createService(1);
    const blocker = spawnWithCaller(store, telemetry, "blocker", "running");
    const staleAccepted = acceptedSpawnFixture({ prompt: "stale" });
    const staleCreated = store.createSpawnRecord(staleAccepted, "queued", new AbortController());
    initialize(telemetry, staleCreated.record, staleCreated.execution);
    const live = spawnWithCaller(store, telemetry, "live", "queued");
    service.submit(blocker.task);
    const staleTask = spawnTask(staleCreated, staleAccepted);
    service.submit(staleTask);
    service.submit(live.task);

    expect(service.finishUnstartedExecution(
      staleTask,
      "stopped",
      "stale queue entry",
    )).toBe(true);
    expect(staleCreated.record.lifecycle).toMatchObject({ status: "stopped", settled: true });
    expect(service.pendingCount).toBe(2);

    blockerRun.resolve(runResult("blocker complete"));
    await expect(blocker.caller.promise).resolves.toBe("blocker complete");
    expect(state.runAgent.mock.calls.map((call) => call[2])).toEqual(["blocker", "live"]);
    expect(live.created.record.lifecycle.status).toBe("running");
    expect(service.pendingCount).toBe(0);

    liveRun.resolve(runResult("live complete"));
    await expect(live.caller.promise).resolves.toBe("live complete");
  });

  it("settles mixed running and queued spawn/continuation work during shutdown", async () => {
    const runningSpawn = deferred<ReturnType<typeof runResult>>();
    const runningContinuation = deferred<{ responseText: string; aborted: boolean }>();
    state.runAgent.mockReturnValue(runningSpawn.promise);
    state.executeAgentTurn.mockReturnValue(runningContinuation.promise);
    const { service, store, telemetry } = createService(2);
    const spawn = spawnWithCaller(store, telemetry, "running spawn", "running");
    service.submit(spawn.task);
    const root = completedRecord(store, telemetry, "continuation root");
    const continuation = continuationTask(store, telemetry, root, "running continuation");
    service.submit(continuation.task);
    const queued = spawnWithCaller(store, telemetry, "queued spawn", "queued");
    service.submit(queued.task);
    const queuedRoot = completedRecord(store, telemetry, "queued continuation root");
    const queuedContinuation = continuationTask(
      store,
      telemetry,
      queuedRoot,
      "queued continuation",
      "queued",
    );
    service.submit(queuedContinuation.task);
    expect(queuedRoot.record.execution.session).toBe(queuedRoot.session);
    expect(service.pendingCount).toBe(2);

    service.dispose();

    await expect(spawn.caller.promise).resolves.toBe("");
    await expect(queued.caller.promise).resolves.toBe("");
    await expect(continuation.caller.promise).rejects.toThrow("Agent session shut down");
    await expect(queuedContinuation.caller.promise).rejects.toThrow("Agent session shut down");
    expect(queuedRoot.record.lifecycle).toMatchObject({ status: "stopped", settled: true });
    expect(queuedRoot.record.stats.currentExecution).toMatchObject({
      kind: "continued",
      status: "stopped",
    });
    expect(queuedRoot.record.execution.session).toBeUndefined();
    expect(queuedRoot.session.dispose).toHaveBeenCalledOnce();
    expect(store.get(queuedRoot.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(root.session.dispose).toHaveBeenCalledOnce();
    expect(state.runAgent).toHaveBeenCalledOnce();
    expect(state.executeAgentTurn).toHaveBeenCalledOnce();

    runningSpawn.resolve(runResult("late spawn"));
    runningContinuation.resolve({ responseText: "late continuation", aborted: true });
    await Promise.resolve();
    expect(state.runAgent).toHaveBeenCalledOnce();
    expect(state.executeAgentTurn).toHaveBeenCalledOnce();
  });

  it("removes a queued task on parent abort without consuming a slot", async () => {
    const blocker = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(blocker.promise);
    const { service, store, telemetry } = createService(1);
    const first = acceptedSpawnFixture({ prompt: "first" });
    const firstCreated = store.createSpawnRecord(first, "running", new AbortController());
    initialize(telemetry, firstCreated.record, firstCreated.execution);
    service.submit(spawnTask(firstCreated, first));

    const parent = new AbortController();
    let resolveQueued!: (result: string) => void;
    const queuedPromise = new Promise<string>((resolve) => { resolveQueued = resolve; });
    const second = acceptedSpawnFixture({ prompt: "second", signal: parent.signal });
    const secondCreated = store.createSpawnRecord(second, "queued", new AbortController(), queuedPromise);
    initialize(telemetry, secondCreated.record, secondCreated.execution);
    service.submit(spawnTask(secondCreated, second, resolveQueued));

    expect(service.pendingCount).toBe(1);
    parent.abort();
    expect(service.pendingCount).toBe(0);
    await expect(queuedPromise).resolves.toBe("");
    expect(store.get(secondCreated.id)?.lifecycle).toMatchObject({ status: "stopped", settled: true, stoppedBy: "parent" });
    expect(state.runAgent).toHaveBeenCalledOnce();

    blocker.resolve(runResult());
    await firstCreated.record.execution.promise;
    service.dispose();
  });

  it("releases one slot and starts the next entry in FIFO order", async () => {
    const firstRun = deferred<ReturnType<typeof runResult>>();
    const secondRun = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(firstRun.promise).mockReturnValueOnce(secondRun.promise);
    const { service, store, telemetry } = createService(1);
    const first = acceptedSpawnFixture({ prompt: "first" });
    const firstCreated = store.createSpawnRecord(first, "running", new AbortController());
    initialize(telemetry, firstCreated.record, firstCreated.execution);
    service.submit(spawnTask(firstCreated, first));

    let resolveSecond!: (result: string) => void;
    const secondPromise = new Promise<string>((resolve) => { resolveSecond = resolve; });
    const second = acceptedSpawnFixture({ prompt: "second" });
    const secondCreated = store.createSpawnRecord(second, "queued", new AbortController(), secondPromise);
    initialize(telemetry, secondCreated.record, secondCreated.execution);
    service.submit(spawnTask(secondCreated, second, resolveSecond));

    firstRun.resolve(runResult("first complete"));
    await vi.waitFor(() => expect(store.get(secondCreated.id)?.lifecycle.status).toBe("running"));
    expect(state.runAgent).toHaveBeenCalledTimes(2);
    expect(state.runAgent.mock.calls[1]![2]).toBe("second");

    secondRun.resolve(runResult("second complete"));
    await expect(secondPromise).resolves.toBe("second complete");
    expect(store.get(secondCreated.id)?.result).toBe("second complete");
    const completedRecord = store.get(secondCreated.id)!;
    expect(Object.keys(completedRecord.display)).not.toContain(["output", "File"].join(""));
    expect(Object.keys(completedRecord.execution)).not.toContain(["output", "Log"].join(""));
    service.dispose();
  });

  it("settles active caller promises and removes records during shutdown", async () => {
    const run = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValue(run.promise);
    const { service, store, telemetry } = createService(1);
    let resolveCaller!: (value: string) => void;
    const callerPromise = new Promise<string>((resolve) => { resolveCaller = resolve; });
    const accepted = acceptedSpawnFixture();
    const created = store.createSpawnRecord(accepted, "running", new AbortController(), callerPromise);
    initialize(telemetry, created.record, created.execution);
    service.submit(spawnTask(created, accepted, resolveCaller));

    service.dispose();
    await expect(callerPromise).resolves.toBe("");
    expect(store.list()).toEqual([]);
    run.resolve(runResult("late"));
    await Promise.resolve();
  });
});

function createService(concurrency: number) {
  const store = new AgentRecordStore();
  const telemetry = new ExecutionTelemetry((record) => store.get(record.id) === record);
  const service = new AgentExecutionService({ store, telemetry, concurrency });
  services.add(service);
  return { store, telemetry, service };
}

function completedRecord(
  store: AgentRecordStore,
  telemetry: ExecutionTelemetry,
  prompt = "initial",
) {
  const accepted = acceptedSpawnFixture({ prompt });
  const created = store.createSpawnRecord(accepted, "running", new AbortController());
  initialize(telemetry, created.record, created.execution);
  const retainedSession = session();
  created.record.execution.session = retainedSession;
  store.completeTurn(created.record, created.execution, { responseText: "initial response", aborted: false });
  store.markSettled(created.record);
  telemetry.forgetExecution(created.execution);
  return { ...created, session: retainedSession };
}

function spawnWithCaller(
  store: AgentRecordStore,
  telemetry: ExecutionTelemetry,
  prompt: string,
  status: "queued" | "running",
  signal?: AbortSignal,
) {
  const accepted = acceptedSpawnFixture(signal ? { prompt, signal } : { prompt });
  const caller = deferred<string>();
  const created = store.createSpawnRecord(
    accepted,
    status,
    new AbortController(),
    caller.promise,
  );
  initialize(telemetry, created.record, created.execution);
  return {
    created,
    caller,
    task: spawnTask(created, accepted, caller.resolve),
  };
}

function continuationTask(
  store: AgentRecordStore,
  telemetry: ExecutionTelemetry,
  root: ReturnType<typeof completedRecord>,
  prompt = "follow-up",
  status: "queued" | "running" = "running",
  signal?: AbortSignal,
): { task: ContinueExecutionTask; caller: ReturnType<typeof deferred<string>> } {
  const executionId = store.createExecutionId();
  const caller = deferred<string>();
  const execution = store.createContinuation(root.record, executionId, prompt, status);
  const baseline = telemetry.beginExecution(execution, root.record);
  root.record.execution.promise = caller.promise;
  return {
    task: {
      kind: "continue",
      id: root.id,
      record: root.record,
      execution,
      request: {
        record: root.record,
        session: root.session,
        executionId,
        baseline,
        prompt,
        signal,
        resolve: caller.resolve,
        reject: caller.reject,
        startedAt: Date.now(),
      },
    },
    caller,
  };
}

function initialize(telemetry: ExecutionTelemetry, record: any, execution: any): void {
  telemetry.initializeRecord(record);
  telemetry.beginExecution(execution, record);
}

function spawnTask(
  created: ReturnType<AgentRecordStore["createSpawnRecord"]>,
  acceptedSpawn: ReturnType<typeof acceptedSpawnFixture>,
  resolve?: (result: string) => void,
): SpawnExecutionTask {
  return {
    kind: "spawn",
    id: created.id,
    record: created.record,
    execution: created.execution,
    pi: fakePi(),
    ctx: fakeCtx(),
    acceptedSpawn,
    resolve,
  };
}
