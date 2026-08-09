import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi, resolvedSpawnFixture } from "../fixtures.ts";

const state = vi.hoisted(() => ({
  runAgent: vi.fn(),
  executeAgentTurn: vi.fn(),
}));

vi.mock("../../src/agents/agent-runner.js", () => ({ runAgent: state.runAgent }));
vi.mock("../../src/agents/agent-session-runtime.js", () => ({ executeAgentTurn: state.executeAgentTurn }));

import { AgentManager } from "../../src/agents/agent-manager.js";
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

function result(responseText: string, aborted = false, childSession = session()) {
  return { responseText, aborted, session: childSession };
}

describe("AgentManager foreground scheduling", () => {
  let manager: AgentManager;

  beforeEach(() => {
    state.runAgent.mockReset();
    state.executeAgentTurn.mockReset();
  });

  afterEach(() => manager?.dispose());

  it("starts two foreground calls concurrently and returns each complete response", async () => {
    const runs: Array<ReturnType<typeof deferred<ReturnType<typeof result>>>> = [];
    state.runAgent.mockImplementation(() => {
      const current = deferred<ReturnType<typeof result>>();
      runs.push(current);
      return current.promise;
    });
    manager = new AgentManager({ default: 2 });
    const coordinator = new SpawnCoordinator(manager);

    const first = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "first" }));
    const second = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "second" }));
    expect(state.runAgent).toHaveBeenCalledTimes(2);
    expect(manager.listAgents().filter((record) => record.lifecycle.status === "running")).toHaveLength(2);

    const firstResponse = "first response".repeat(20_000);
    const secondResponse = "second response";
    runs[0]!.resolve(result(firstResponse));
    runs[1]!.resolve(result(secondResponse));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.responseText).toBe(firstResponse);
    expect(secondResult.responseText).toBe(secondResponse);
    expect(firstResult.agentId).toBe(firstResult.record.id);
    expect(firstResult.record.result).not.toBe(firstResponse);
    expect(firstResult.record.execution.promise).toBeUndefined();
    expect(secondResult.record.execution.promise).toBeUndefined();
  });

  it("keeps excess foreground calls FIFO at concurrency one", async () => {
    const runs: Array<ReturnType<typeof deferred<ReturnType<typeof result>>>> = [];
    state.runAgent.mockImplementation(() => {
      const current = deferred<ReturnType<typeof result>>();
      runs.push(current);
      return current.promise;
    });
    manager = new AgentManager({ default: 1 });
    const coordinator = new SpawnCoordinator(manager);

    const first = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "one" }));
    const second = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "two" }));
    expect(state.runAgent).toHaveBeenCalledTimes(1);
    expect(manager.listAgents().some((record) => record.lifecycle.status === "queued")).toBe(true);

    runs[0]!.resolve(result("one result"));
    await first;
    await Promise.resolve();
    expect(state.runAgent).toHaveBeenCalledTimes(2);
    expect(state.runAgent.mock.calls[1]![2]).toBe("two");

    runs[1]!.resolve(result("two result"));
    await expect(second).resolves.toMatchObject({ responseText: "two result" });
  });

  it("cancels queued and running work through the caller AbortSignal", async () => {
    const runs: Array<ReturnType<typeof deferred<ReturnType<typeof result>>>> = [];
    state.runAgent.mockImplementation(() => {
      const current = deferred<ReturnType<typeof result>>();
      runs.push(current);
      return current.promise;
    });
    manager = new AgentManager({ default: 1 });
    const coordinator = new SpawnCoordinator(manager);

    const firstParent = new AbortController();
    const first = coordinator.spawn(
      fakePi(),
      fakeCtx(),
      resolvedSpawnFixture({ prompt: "running cancellation", signal: firstParent.signal }),
    );
    const queuedParent = new AbortController();
    const queued = coordinator.spawn(
      fakePi(),
      fakeCtx(),
      resolvedSpawnFixture({ prompt: "queued cancellation", signal: queuedParent.signal }),
    );
    queuedParent.abort();
    const queuedResult = await queued;
    expect(queuedResult.record.lifecycle.status).toBe("stopped");

    firstParent.abort();
    runs[0]!.resolve(result("partial", true));
    const firstResult = await first;
    expect(firstResult.record.lifecycle.status).toBe("stopped");
    expect(firstResult.responseText).toBe("partial");
  });

  it("settles and removes active records during shutdown", async () => {
    const run = deferred<ReturnType<typeof result>>();
    state.runAgent.mockReturnValue(run.promise);
    manager = new AgentManager({ default: 1 });
    const coordinator = new SpawnCoordinator(manager);
    const pending = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "shutdown" }));

    manager.dispose();
    const settled = await pending;
    expect(settled.record.lifecycle.status).toBe("stopped");
    expect(manager.listAgents()).toEqual([]);
    // A late runner completion cannot release a disposed slot or resurrect a record.
    run.resolve(result("late"));
    await Promise.resolve();
  });

  it("retains a deterministic bounded set of terminal root records and disposes only evicted sessions", async () => {
    const sessions = Array.from({ length: 65 }, () => session());
    let nextSession = 0;
    state.runAgent.mockImplementation(async () => result("done", false, sessions[nextSession++]));
    manager = new AgentManager({ default: 1 });
    const coordinator = new SpawnCoordinator(manager);
    const ids: string[] = [];
    for (let index = 0; index < 65; index++) {
      const completed = await coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: `record-${index}` }));
      ids.push(completed.agentId);
    }
    await Promise.resolve();
    expect(manager.listAgents()).toHaveLength(64);
    expect(manager.getRecord(ids[0]!)).toBeUndefined();
    expect(manager.getRecord(ids.at(-1)!)).toBeDefined();
    expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
    expect(sessions.at(-1)!.dispose).not.toHaveBeenCalled();
  });

  it("continues only a retained successful root session and awaits its full result", async () => {
    const initial = deferred<ReturnType<typeof result>>();
    const continuation = deferred<{ responseText: string; aborted: boolean }>();
    state.runAgent.mockReturnValue(initial.promise);
    state.executeAgentTurn.mockReturnValue(continuation.promise);
    manager = new AgentManager({ default: 1 });
    const coordinator = new SpawnCoordinator(manager);

    const spawned = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "initial" }));
    initial.resolve(result("initial response"));
    const initialResult = await spawned;
    const initialExecution = initialResult.record.stats.currentExecution;
    const continued = coordinator.continueAgent({
      agentId: initialResult.agentId.slice(0, 8),
      prompt: "follow up",
    });
    expect(state.executeAgentTurn).toHaveBeenCalledTimes(1);
    continuation.resolve({ responseText: "complete follow-up", aborted: false });
    const continuedResult = await continued;

    expect(continuedResult.responseText).toBe("complete follow-up");
    expect(continuedResult.executionId).not.toBe(initialExecution?.id);
    expect(continuedResult.record.stats.currentExecution).not.toBe(initialExecution);
    expect(continuedResult.record.stats.currentExecution?.kind).toBe("continued");
    expect(continuedResult.record.execution.promise).toBeUndefined();
  });
});
