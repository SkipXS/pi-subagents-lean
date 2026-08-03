/**
 * agent-manager.test.ts — Tests for AgentManager.
 *
 * Covers: global concurrency limits, queue draining, config updates, and cost accumulation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";

let uuidCounter = 0;

const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
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
}));

function mockAgentSession(): any {
  return { subscribe: vi.fn(), messages: [], dispose: vi.fn() };
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
import type { ConcurrencyConfig, OnAgentComplete } from "../../src/agents/agent-manager.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import {
  createSubagentRuntimeContext,
  enterSubagentSpawn,
  exitSubagentSpawn,
  getCoordinator,
  getManager,
  getPiInstance,
  getSessionCtx,
  getStore,
  getSubagentRuntimeContext,
  isInsideSubagentSpawn,
  runWithSubagentRuntime,
  setCoordinator,
  setManager,
  setPiInstance,
  setSessionCtx,
} from "../../src/shell.js";
import { registerAgents } from "../../src/agents/agent-types.js";

describe("AgentManager", () => {
  let manager: AgentManager;
  let onComplete: ReturnType<typeof vi.fn<OnAgentComplete>>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    registerAgents(new Map([
      ["scout", { name: "scout", description: "", systemPrompt: "" }],
      ["reviewer", { name: "reviewer", description: "", systemPrompt: "" }],
    ]));
    onComplete = vi.fn<OnAgentComplete>();
  });

  afterEach(() => {
    manager?.dispose();
  });

  it("denies root shell API, session, store, and every setter in a child runtime", async () => {
    await runWithSubagentRuntime(createSubagentRuntimeContext(), async () => {
      expect(() => getPiInstance()).toThrow("Root ExtensionAPI is unavailable");
      expect(() => getSessionCtx()).toThrow("Root session context is unavailable");
      expect(() => getStore()).toThrow("Root ConfigStore is unavailable");
      expect(() => setPiInstance({} as any)).toThrow("Root ExtensionAPI setter is unavailable");
      expect(() => setSessionCtx({} as any)).toThrow("Root session context setter is unavailable");
      expect(() => setManager(null)).toThrow("Root manager setter is unavailable");
      expect(() => setCoordinator(null)).toThrow("Root coordinator setter is unavailable");
      expect(getManager()).toBeNull();
      expect(getCoordinator()).toBeNull();
    });
  });

  it("does not let deprecated spawn hooks clear ALS shell guards", async () => {
    manager = new AgentManager(onComplete);
    const pi = fakePi();
    const ctx = fakeCtx();

    enterSubagentSpawn();
    await runWithSubagentRuntime(createSubagentRuntimeContext(), async () => {
      // This consumes the legacy marker, but must not affect ALS isolation.
      exitSubagentSpawn();
      expect(isInsideSubagentSpawn()).toBe(true);
      expect(() => getPiInstance()).toThrow("Root ExtensionAPI is unavailable");
      expect(() => manager.spawn(pi, ctx, "scout", "bypass", { description: "bypass" }))
        .toThrow("Root agent spawning is unavailable from a child runtime");
    });

    expect(isInsideSubagentSpawn()).toBe(false);
  });

  it("rejects direct root manager and coordinator spawns inside a child runtime", async () => {
    manager = new AgentManager(onComplete);
    const coordinator = new SpawnCoordinator(manager);
    const pi = fakePi();
    const ctx = fakeCtx();

    await runWithSubagentRuntime(createSubagentRuntimeContext(), async () => {
      expect(() => manager.spawn(pi, ctx, "scout", "bypass", { description: "bypass" }))
        .toThrow("Root agent spawning is unavailable from a child runtime");
      await expect(coordinator.spawn(pi, ctx, {
        type: "scout", prompt: "bypass", description: "bypass", graceTurns: 6, runInBackground: false,
      })).rejects.toThrow("Root agent spawning is unavailable from a child runtime");
    });

    expect(manager.listAgents()).toHaveLength(0);
    expect(mockModules.mockRunAgent).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("rejects unregistered ALS values without clearing active child isolation", async () => {
    manager = new AgentManager(onComplete);
    const coordinator = new SpawnCoordinator(manager);
    const pi = fakePi();
    const ctx = fakeCtx();
    const runtime = createSubagentRuntimeContext();
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.keys(runtime)).toEqual(["isChildRuntime"]);
    const forgedRuntime = { isChildRuntime: true };

    const expectChildIsolation = async () => {
      expect(() => getPiInstance()).toThrow("Root ExtensionAPI is unavailable");
      expect(() => getSessionCtx()).toThrow("Root session context is unavailable");
      expect(() => getStore()).toThrow("Root ConfigStore is unavailable");
      expect(getManager()).toBeNull();
      expect(getCoordinator()).toBeNull();
      expect(() => setPiInstance({} as any)).toThrow("Root ExtensionAPI setter is unavailable");
      expect(() => setSessionCtx({} as any)).toThrow("Root session context setter is unavailable");
      expect(() => setManager(null)).toThrow("Root manager setter is unavailable");
      expect(() => setCoordinator(null)).toThrow("Root coordinator setter is unavailable");
      expect(() => manager.spawn(pi, ctx, "scout", "bypass", { description: "bypass" }))
        .toThrow("Root agent spawning is unavailable from a child runtime");
      await expect(coordinator.spawn(pi, ctx, {
        type: "scout", prompt: "bypass", description: "bypass", graceTurns: 6, runInBackground: false,
      })).rejects.toThrow("Root agent spawning is unavailable from a child runtime");
    };

    try {
      await runWithSubagentRuntime(runtime, async () => {
        for (const invalidContext of [undefined, null, forgedRuntime]) {
          let callbackRan = false;
          expect(() => runWithSubagentRuntime(invalidContext, async () => {
            callbackRan = true;
          })).toThrow("Invalid child subagent runtime context");
          expect(callbackRan).toBe(false);
          await expectChildIsolation();
        }

        const currentRuntime = getSubagentRuntimeContext();
        expect(currentRuntime).toBe(runtime);
        await runWithSubagentRuntime(currentRuntime, async () => {
          await expectChildIsolation();
        });
      });

      expect(manager.listAgents()).toHaveLength(0);
      expect(mockModules.mockRunAgent).not.toHaveBeenCalled();
    } finally {
      coordinator.dispose();
    }
  });


  // ── Concurrency ──

  describe("concurrency", () => {
    it("retains the resolved model key in invocation metadata for queued controls", () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(first.promise);

      const active = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "active", {
        description: "active",
        modelKey: "provider/active",
        isBackground: true,
      });
      const queued = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", {
        description: "queued",
        modelKey: "provider/queued",
        isBackground: true,
      });

      expect(manager.getRecord(active)?.display.invocation?.modelKey).toBe("provider/active");
      expect(manager.getRecord(queued)?.display.invocation?.modelKey).toBe("provider/queued");
      first.resolve(mockRunResult());
    });

    it("uses the default global limit for agents with every model key, including none", () => {
      const config: ConcurrencyConfig = { default: 2 };
      manager = new AgentManager(onComplete, config);
      const first = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(first.promise);

      const pi = fakePi();
      const ctx = fakeCtx();
      const id1 = manager.spawn(pi, ctx, "general-purpose", "one", { description: "one", modelKey: "llamacpp/4b", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "two", { description: "two", modelKey: "anthropic/claude", isBackground: true });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "three", { description: "three", isBackground: false });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
      first.resolve(mockRunResult());
    });

    it("starts queued agents when a global slot frees", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      const second = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const id1 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "one", { description: "one", modelKey: "provider/first", isBackground: true });
      const id2 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "two", { description: "two", modelKey: "other/second", isBackground: true });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      first.resolve(mockRunResult());
      await vi.waitFor(() => expect(manager.getRecord(id2)?.lifecycle.status).toBe("running"));
      second.resolve(mockRunResult());
    });

    it("releases its slot and continues the queue after an asynchronous runner failure", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const continuation = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockRejectedValueOnce(new Error("runner setup failed"))
        .mockReturnValueOnce(continuation.promise);

      const failedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "failed", {
        description: "failed", isBackground: true,
      });
      const continuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "continued", {
        description: "continued", isBackground: true,
      });

      await manager.getRecord(failedId)!.execution.promise;
      expect(manager.getRecord(failedId)?.lifecycle).toMatchObject({ status: "error" });
      expect(manager.getRecord(failedId)?.error).toBe("runner setup failed");
      await vi.waitFor(() => expect(manager.getRecord(continuedId)?.lifecycle.status).toBe("running"));

      continuation.resolve(mockRunResult());
      await manager.getRecord(continuedId)!.execution.promise;
    });

    it("reports a queued synchronous startup failure, releases its slot, and continues the queue", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      const continuation = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(first.promise)
        .mockImplementationOnce(() => { throw new Error("queued startup failed"); })
        .mockReturnValueOnce(continuation.promise);

      manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first", isBackground: true,
      });
      const failedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "failed", {
        description: "failed", isBackground: false,
      });
      const continuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "continued", {
        description: "continued", isBackground: true,
      });
      const failedRecord = manager.getRecord(failedId)!;
      const failedWaiter = failedRecord.execution.promise!;

      first.resolve(mockRunResult());
      await expect(failedWaiter).resolves.toBe("");

      expect(failedRecord.lifecycle.status).toBe("error");
      expect(failedRecord.lifecycle.completedAt).toEqual(expect.any(Number));
      expect(failedRecord.error).toBe("queued startup failed");
      // Every terminal path reports its exact execution summary.
      expect(onComplete).toHaveBeenCalledWith(failedRecord, failedRecord.stats.executions![0]);
      expect(failedRecord.stats.executions![0]).toMatchObject({ status: "error", error: "queued startup failed" });
      expect(manager.getRecord(continuedId)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);

      continuation.resolve(mockRunResult());
    });

    it("starts a queued agent and frees queue capacity when output-log initialization fails", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      const queued = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(queued.promise);
      mockModules.fsMock.writeFileSync
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw new Error("queued log init failed"); });

      manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first", isBackground: true,
      });
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", {
        description: "queued", isBackground: false,
      });
      const queuedRecord = manager.getRecord(queuedId)!;
      const queuedWaiter = queuedRecord.execution.promise!;

      first.resolve(mockRunResult());
      await vi.waitFor(() => expect(queuedRecord.lifecycle.status).toBe("running"));
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
      expect(queuedRecord.execution.outputLog).toBeUndefined();
      expect(queuedRecord.display.outputFile).toBeUndefined();

      queued.resolve(mockRunResult({ responseText: "queued done" }));
      await expect(queuedWaiter).resolves.toBe("queued done");
      expect(queuedRecord.lifecycle.status).toBe("completed");
    });

    it("keeps foreground waiters pending until their queued agent completes", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      const second = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      manager.spawn(fakePi(), fakeCtx(), "general-purpose", "one", { description: "one", isBackground: true });
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "two", { description: "two", isBackground: false });
      const queuedPromise = manager.getRecord(queuedId)!.execution.promise!;
      let settled = false;
      void queuedPromise.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      first.resolve(mockRunResult());
      await vi.waitFor(() => expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("running"));
      expect(settled).toBe(false);

      second.resolve(mockRunResult({ responseText: "queued done" }));
      await expect(queuedPromise).resolves.toBe("queued done");
    });

    it("settles and reports a queued agent when it is stopped", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(first.promise);

      manager.spawn(fakePi(), fakeCtx(), "general-purpose", "one", { description: "one", isBackground: true });
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "two", { description: "two", isBackground: true });
      const queuedRecord = manager.getRecord(queuedId)!;

      expect(manager.abort(queuedId, "user")).toBe(true);
      await expect(queuedRecord.execution.promise).resolves.toBe("");
      expect(queuedRecord.lifecycle.status).toBe("stopped");
      expect(onComplete).toHaveBeenCalledWith(queuedRecord, queuedRecord.stats.executions![0]);
      expect(queuedRecord.stats.executions![0]).toMatchObject({ status: "stopped" });
      first.resolve(mockRunResult());
    });

    it("does not start an agent when its parent signal was already aborted", () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const parent = new AbortController();
      const removeListener = vi.spyOn(parent.signal, "removeEventListener");
      parent.abort();

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task", signal: parent.signal,
      });
      const record = manager.getRecord(id)!;

      expect(mockModules.mockRunAgent).not.toHaveBeenCalled();
      expect(record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
      expect(record.lifecycle.completedAt).toEqual(expect.any(Number));
      expect(onComplete).toHaveBeenCalledWith(record, record.stats.executions![0]);
      expect(record.stats.executions![0]).toMatchObject({ status: "stopped" });
      expect(removeListener).toHaveBeenCalledOnce();
    });

    it("keeps a root slot held after parent abort until the runner settles", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      const second = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const parent = new AbortController();

      const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first", signal: parent.signal,
      });
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", {
        description: "queued",
      });
      const firstRecord = manager.getRecord(firstId)!;
      expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

      parent.abort();
      expect(firstRecord.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent", settled: false });
      expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

      first.resolve(mockRunResult({ aborted: true }));
      await firstRecord.execution.promise;
      await vi.waitFor(() => expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("running"));

      second.resolve(mockRunResult());
      await manager.getRecord(queuedId)!.execution.promise;
    });

    it("removes a queued agent when its parent signal aborts before capacity frees", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(first.promise);
      const parent = new AbortController();
      const removeListener = vi.spyOn(parent.signal, "removeEventListener");

      const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first", isBackground: true,
      });
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", {
        description: "queued", signal: parent.signal,
      });
      const queuedRecord = manager.getRecord(queuedId)!;

      parent.abort();
      await expect(queuedRecord.execution.promise).resolves.toBe("");
      expect(queuedRecord.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
      expect(onComplete).toHaveBeenCalledWith(queuedRecord, queuedRecord.stats.executions![0]);
      expect(queuedRecord.stats.executions![0]).toMatchObject({ status: "stopped" });
      expect(removeListener).toHaveBeenCalledOnce();

      first.resolve(mockRunResult());
      await manager.getRecord(firstId)!.execution.promise;
      expect(mockModules.mockRunAgent).toHaveBeenCalledOnce();
    });

    it("applies an expanded global limit immediately", () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      manager.spawn(fakePi(), fakeCtx(), "general-purpose", "one", { description: "one", modelKey: "provider/one", isBackground: true });
      const queued = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "two", { description: "two", modelKey: "other/two", isBackground: true });
      manager.setConcurrency({ default: 2 });

      expect(manager.getRecord(queued)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
      deferred.resolve(mockRunResult());
    });

    it("keeps a queued resolved config snapshot across registry-style mutation", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const first = makeResolvablePromise();
      const second = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const config = { name: "review", description: "worktree", systemPrompt: "frozen prompt", tools: ["read"] };
      manager.spawn(fakePi(), fakeCtx(), "review", "first", { description: "first", modelKey: "test/model", isBackground: true });
      manager.spawn(fakePi(), fakeCtx(), "review", "queued", { description: "queued", agentConfig: config, isBackground: true });
      config.systemPrompt = "refreshed parent prompt";
      config.tools[0] = "bash";
      first.resolve(mockRunResult());
      await vi.waitFor(() => expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2));
      expect(mockModules.mockRunAgent.mock.calls[1]?.[3].agentConfig).toMatchObject({ systemPrompt: "frozen prompt", tools: ["read"] });
      second.resolve(mockRunResult());
    });
  });

  // ── Cost accumulation ──

  describe("totalAgentCost", () => {
    it("starts at zero", () => {
      manager = new AgentManager(onComplete);
      expect(manager.getTotalAgentCost()).toBe(0);
    });

    it("accumulates cost when an agent completes", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "test task", modelKey: "test/model" });
      manager.getRecord(id)!.stats.lifetimeUsage.cost = 0.05;
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.05);
    });

    it("persists cost after agent is evicted from map", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "test task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      record.stats.lifetimeUsage.cost = 0.03;
      await record.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.03);

      // Record is consumed (result read) — eligible for eviction when old.
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 70 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(manager.getTotalAgentCost()).toBe(0.03);
    });

    it("accumulates cost from multiple agents", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "first", modelKey: "test/model" });
      manager.getRecord(id1)!.stats.lifetimeUsage.cost = 0.02;
      await manager.getRecord(id1)!.execution.promise;
      expect(manager.getTotalAgentCost()).toBe(0.02);

      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "second", modelKey: "test/model" });
      manager.getRecord(id2)!.stats.lifetimeUsage.cost = 0.05;
      await manager.getRecord(id2)!.execution.promise;
      expect(manager.getTotalAgentCost()).toBe(0.07);
    });

    it("includes cost from failed agents", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockRejectedValueOnce(new Error("boom"));

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "failing", modelKey: "test/model" });
      manager.getRecord(id)!.stats.lifetimeUsage.cost = 0.01;
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.01);
    });

    it("includes cost from stopped agents", async () => {
      manager = new AgentManager(onComplete);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "stoppable", modelKey: "test/model" });
      manager.getRecord(id)!.stats.lifetimeUsage.cost = 0.04;

      manager.abort(id, "agent");

      deferred.resolve({
        responseText: "",
        session: mockAgentSession(),
        aborted: true,
        turnLimited: false,
      });

      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.04);
    });
  });

  // ── Cumulative agent count ──

  describe("totalAgentCount", () => {
    it("counts accepted running and queued spawns exactly once", async () => {
      const config: ConcurrencyConfig = { default: 1 };
      manager = new AgentManager(onComplete, config);
      const first = makeResolvablePromise();
      const second = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      const id1 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", { description: "first", modelKey: "test/model" });
      const id2 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", { description: "second", modelKey: "test/model" });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(manager.getTotalAgentCount()).toBe(2);

      first.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getTotalAgentCount()).toBe(2);

      second.resolve(mockRunResult());
      await manager.getRecord(id2)!.execution.promise;
      await manager.getRecord(id1)!.execution.promise;
    });

    it("releases global capacity after a synchronously failed start", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      mockModules.mockRunAgent
        .mockImplementationOnce(() => { throw new Error("start failed"); })
        .mockResolvedValueOnce(mockRunResult());

      expect(() => manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" })).toThrow("start failed");
      expect(manager.getTotalAgentCount()).toBe(0);
      expect(manager.listAgents()).toHaveLength(0);

      const nextId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "next", { description: "next" });
      expect(manager.getRecord(nextId)?.lifecycle.status).toBe("running");
      await manager.getRecord(nextId)!.execution.promise;
    });

    it("runs a foreground agent when output-log initialization fails", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      mockModules.fsMock.writeFileSync.mockImplementationOnce(() => {
        throw new Error("log init failed");
      });
      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult({ responseText: "done without log" }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task", modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;

      expect(mockModules.mockRunAgent).toHaveBeenCalledOnce();
      expect(record.execution.outputLog).toBeUndefined();
      expect(record.display.outputFile).toBeUndefined();
      await expect(record.execution.promise).resolves.toBe("done without log");
      expect(record.lifecycle.status).toBe("completed");
      expect(manager.getTotalAgentCount()).toBe(1);
    });

    it("persists after an agent is evicted", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 70 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(manager.getTotalAgentCount()).toBe(1);
    });
  });

  // ── Cleanup eviction ──

  describe("cleanup", () => {
    it("evicts failed-delivery completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Retention bounds result text while a failed delivery remains diagnostic.
      record.delivery = { state: "failed", attempts: 1, lastError: "Pi unavailable" };
      record.lifecycle.completedAt = Date.now() - 70 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("fully evicts old unconsumed settled records and releases their session", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      record.lifecycle.completedAt = Date.now() - 70 * 60_000;

      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(session.dispose).toHaveBeenCalledOnce();
    });

    it("does not release a stopped runner before it has actually settled", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      const session = mockAgentSession();
      record.execution.session = session;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;

      manager.abort(id, "agent");
      (manager as any).cleanup();

      expect(record.lifecycle).toMatchObject({ status: "stopped", settled: false });
      expect(session.dispose).not.toHaveBeenCalled();
      expect(record.execution.abortController).toBeDefined();
      expect(record.execution.promise).toBeDefined();

      deferred.resolve(mockRunResult({ session, aborted: true }));
      await record.execution.promise;
    });

    it("evicts consumed completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Once the LLM has read the result, the record is safe to evict when old.
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 70 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("does not evict records younger than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
      // Just completed — well within the 60-minute retention window.
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeDefined();
    });

    it("uses configurable retention via setRetentionMinutes", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Set retention to 1 minute
      manager.setRetentionMinutes(1);

      // Record completed 2 minutes ago — should be evicted
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 2 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("retention update takes effect at next cleanup", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Record completed 70 minutes ago — would be evicted with the default 60-min retention
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 70 * 60_000;

      // But bump retention to 90 minutes before cleanup
      manager.setRetentionMinutes(90);
      (manager as any).cleanup();

      // Should survive because retention was raised
      expect(manager.getRecord(id)).toBeDefined();
    });

    it("runs scheduled cleanup for an old settled record", async () => {
      vi.useFakeTimers();
      try {
        manager = new AgentManager(onComplete);
        mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

        const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
        const record = manager.getRecord(id)!;
        await record.execution.promise;
        record.lifecycle.completedAt = Date.now() - 70 * 60_000;

        vi.advanceTimersByTime(60_000);

        expect(manager.getRecord(id)).toBeUndefined();
      } finally {
        manager?.dispose();
        vi.useRealTimers();
      }
    });
  });

describe("usage accounting", () => {
  /**
   * Helper: capture the onAssistantUsage callback passed to runAgent,
   * so we can invoke it manually with different usage values.
   */
  function getOnAssistantUsage() {
    const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
    const callbacks = call[3]; // 4th arg is the callbacks object
    return callbacks.onAssistantUsage;
  }

  function getOnSupplementalUsage() {
    const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
    const callbacks = call[3]; // 4th arg is the callbacks object
    return callbacks.onSupplementalUsage;
  }

  it("adds each assistant usage report in full", () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    const record = manager.getRecord(id)!;
    const onUsage = getOnAssistantUsage();

    onUsage({ input: 100, output: 50, cacheWrite: 0, cost: 0, cacheRead: 0 });
    onUsage({ input: 250, output: 30, cacheWrite: 0, cost: 0, cacheRead: 0 });

    expect(record.stats.lifetimeUsage.input).toBe(350);
    expect(record.stats.lifetimeUsage.output).toBe(80);
  });

  it("retains the cumulative cache-hit rate after a high-hit request is followed by a miss", () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    const onUsage = getOnAssistantUsage();

    onUsage({ input: 20, output: 10, cacheRead: 80, cacheWrite: 0, cost: 0 });
    onUsage({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0 });

    const stats = manager.getRecord(id)!.stats;
    expect(stats.cacheRead).toBe(80);
    expect(stats.lifetimeUsage.input).toBe(120);
    expect(stats.latestCacheHitRate).toBeCloseTo((80 / 200) * 100);
  });

  it("updates the cumulative cache-hit rate for supplemental usage", () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    const onAssistantUsage = getOnAssistantUsage();
    const onSupplementalUsage = getOnSupplementalUsage();

    onAssistantUsage({ input: 100, output: 10, cacheRead: 80, cacheWrite: 20, cost: 0.01 });
    const stats = manager.getRecord(id)!.stats;
    onSupplementalUsage({ input: 400, output: 50, cacheRead: 300, cacheWrite: 25, cost: 0.12 });

    expect(stats.lifetimeUsage).toEqual({ input: 500, output: 60, cacheWrite: 45, cost: 0.13 });
    expect(stats.cacheRead).toBe(380);
    expect(stats.latestCacheHitRate).toBeCloseTo((380 / 925) * 100);

    onAssistantUsage({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0 });
    expect(stats.lifetimeUsage.input).toBe(700);
    expect(stats.latestCacheHitRate).toBeCloseTo((380 / 1125) * 100);
  });


  it("keeps root completion safe when session telemetry getters throw", async () => {
    manager = new AgentManager(onComplete);
    const session = {
      ...mockAgentSession(),
      getContextUsage: () => { throw new Error("disposed context"); },
      get model(): never { throw new Error("disposed model"); },
    };
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    await manager.getRecord(id)!.execution.promise;

    expect(manager.getRecord(id)?.lifecycle.status).toBe("completed");
    expect(manager.getRecord(id)?.stats.contextPercent).toBeUndefined();
  });

  it("persists final context, auto-compaction, and subscription snapshots", async () => {
    manager = new AgentManager(onComplete);
    const session = {
      ...mockAgentSession(),
      getContextUsage: () => ({ percent: 23.4, contextWindow: 272_000 }),
      autoCompactionEnabled: true,
      model: { provider: "kimi-coding" },
    };
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    await manager.getRecord(id)!.execution.promise;

    expect(manager.getRecord(id)!.stats).toMatchObject({
      contextPercent: 23.4,
      contextWindow: 272_000,
      autoCompactionEnabled: true,
      usingSubscription: true,
    });
  });

  it("disposes a late session when shutdown evicted the record before setup finished", async () => {
    manager = new AgentManager(onComplete);
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const onSessionCreated = mockModules.mockRunAgent.mock.calls[0]![3].onSessionCreated;

    manager.dispose();
    const lateSession = mockAgentSession();
    onSessionCreated(lateSession);
    expect(lateSession.dispose).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("does not resample a session after dispose races a late runner settlement", async () => {
    manager = new AgentManager(onComplete);
    const getContextUsage = vi.fn(() => ({ percent: 20, contextWindow: 100 }));
    const session = {
      ...mockAgentSession(),
      getContextUsage,
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    mockModules.mockRunAgent.mock.calls[0]![3].onSessionCreated(session);
    const runnerPromise = record.execution.promise!;

    manager.dispose();
    getContextUsage.mockClear();
    deferred.resolve(mockRunResult({ session }));
    await runnerPromise;

    expect(getContextUsage).not.toHaveBeenCalled();
  });

  it("resamples context after message_end persistence while keeping accounting immediate", async () => {
    manager = new AgentManager(onComplete);
    let persisted = false;
    const contextReads: boolean[] = [];
    const session = {
      ...mockAgentSession(),
      getContextUsage: () => {
        contextReads.push(persisted);
        return persisted
          ? { tokens: 40, percent: 40, contextWindow: 100 }
          : { tokens: null, percent: null, contextWindow: 100 };
      },
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    record.execution.session = session;
    const onUsage = mockModules.mockRunAgent.mock.calls[0]![3].onAssistantUsage;

    // AgentSession notifies subscribers before SessionManager.appendMessage().
    onUsage({ input: 7, output: 3, cacheWrite: 0, cacheRead: 0, cost: 0.2 });
    expect(record.stats.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 0, cost: 0.2 });
    expect(record.stats.contextStats).toMatchObject({ current: null });

    // This represents the upstream appendMessage() that runs after all event listeners.
    persisted = true;
    await Promise.resolve();

    expect(contextReads).toEqual([true]);
    expect(record.stats.contextStats).toMatchObject({ current: 40, lastKnown: 40, peak: 40, count: 1 });
    expect(record.stats.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 0, cost: 0.2 });

    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;
  });

  it("coalesces post-persistence context reads and retains estimated peaks", async () => {
    manager = new AgentManager(onComplete);
    let percent = 125;
    const contextReads: number[] = [];
    const session = {
      ...mockAgentSession(),
      getContextUsage: () => {
        contextReads.push(percent);
        return { tokens: percent, percent, contextWindow: 100 };
      },
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    record.execution.session = session;
    const onUsage = mockModules.mockRunAgent.mock.calls[0]![3].onAssistantUsage;

    onUsage({ input: 1, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    await Promise.resolve();
    expect(contextReads).toEqual([125]);
    expect(record.stats.contextStats).toMatchObject({ current: 125, lastKnown: 125, peak: 125, count: 1 });

    percent = 40;
    // Two synchronous reports share one assistant-event boundary read.
    onUsage({ input: 3, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    onUsage({ input: 4, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    await Promise.resolve();

    expect(contextReads).toEqual([125, 40]);
    expect(record.stats.contextStats).toMatchObject({ current: 40, lastKnown: 40, peak: 125, count: 2 });
    expect(record.stats.lifetimeUsage.input).toBe(8);

    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;
  });

  it("always samples the final lower context and keeps the earlier peak", async () => {
    manager = new AgentManager(onComplete);
    let percent: number | null = 80;
    const session = {
      ...mockAgentSession(),
      getContextUsage: () => ({ tokens: percent == null ? null : percent, percent, contextWindow: 100 }),
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    record.execution.session = session;
    mockModules.mockRunAgent.mock.calls[0]![3].onAssistantUsage({ input: 1, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    await Promise.resolve();

    percent = 40;
    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;

    expect(record.stats.contextStats).toMatchObject({ current: 40, lastKnown: 40, peak: 80, window: 100, count: 2 });
  });

  it("retains lastKnown and peak when the final persisted context is null", async () => {
    manager = new AgentManager(onComplete);
    let percent: number | null = 80;
    const session = {
      ...mockAgentSession(),
      getContextUsage: () => ({ tokens: percent == null ? null : percent, percent, contextWindow: 100 }),
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    record.execution.session = session;
    mockModules.mockRunAgent.mock.calls[0]![3].onAssistantUsage({ input: 1, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    await Promise.resolve();

    percent = null;
    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;

    expect(record.stats.contextStats).toMatchObject({ current: null, lastKnown: 80, peak: 80, window: 100, count: 2 });
  });

  it("preserves the last valid context when the final read fails", async () => {
    manager = new AgentManager(onComplete);
    let fail = false;
    let reads = 0;
    const session = {
      ...mockAgentSession(),
      getContextUsage: () => {
        reads++;
        if (fail) throw new Error("session disposed");
        return { percent: 80, contextWindow: 100 };
      },
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    record.execution.session = session;
    mockModules.mockRunAgent.mock.calls[0]![3].onAssistantUsage({ input: 1, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    await Promise.resolve();

    fail = true;
    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;

    expect(reads).toBe(2);
    expect(record.stats).toMatchObject({ contextPercent: 80, contextWindow: 100 });
    expect(record.stats.contextStats).toMatchObject({ current: 80, lastKnown: 80, peak: 80, count: 1 });
  });

  it("keeps a known context window when a legacy final stats sample omits it", async () => {
    manager = new AgentManager(onComplete);
    let contextUsage: { percent: number | null; contextWindow?: number } = { percent: 80, contextWindow: 100 };
    const session = {
      ...mockAgentSession(),
      getSessionStats: () => ({ contextUsage }),
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    record.execution.session = session;
    mockModules.mockRunAgent.mock.calls[0]![3].onAssistantUsage({ input: 1, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    await Promise.resolve();

    contextUsage = { percent: null };
    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;

    expect(record.stats).toMatchObject({ contextPercent: null, contextWindow: 100 });
  });

  it("persists compaction metadata from the leaf without scanning the branch", async () => {
    manager = new AgentManager(onComplete);
    const compactionEntry = {
      type: "compaction",
      id: "compact-1",
      parentId: "before",
      timestamp: "2024-01-01T10:00:00.000Z",
      summary: "summary",
      firstKeptEntryId: "kept-1",
      tokensBefore: 1_200,
    };
    const getBranch = vi.fn(() => [compactionEntry]);
    const getLeafEntry = vi.fn(() => compactionEntry);
    const getContextUsage = vi.fn(() => {
      // The real context reader walks the branch; metadata lookup must not add
      // another walk while handling the same compaction event.
      getBranch();
      return { tokens: null, percent: null, contextWindow: 100 };
    });
    const session = {
      ...mockAgentSession(),
      getContextUsage,
      sessionManager: { getBranch, getLeafEntry },
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    record.execution.session = session;

    mockModules.mockRunAgent.mock.calls[0]![3].onCompaction({
      reason: "threshold",
      tokensBefore: 1_200,
      summary: "summary",
      firstKeptEntryId: "kept-1",
    });

    expect(record.stats.compactionReasons).toEqual([{
      reason: "threshold",
      tokensBefore: 1_200,
      summary: "summary",
      firstKeptEntryId: "kept-1",
      entryId: "compact-1",
    }]);
    expect(getLeafEntry).toHaveBeenCalledOnce();
    expect(getContextUsage).toHaveBeenCalledOnce();
    // The sole branch walk is the context sample above, not metadata lookup.
    expect(getBranch).toHaveBeenCalledOnce();

    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;
  });
});
}); // end describe AgentManager

describe("AgentManager steering and shutdown", () => {
  let manager: AgentManager;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    registerAgents(new Map([
      ["scout", { name: "scout", description: "", systemPrompt: "" }],
      ["reviewer", { name: "reviewer", description: "", systemPrompt: "" }],
    ]));
  });

  afterEach(() => {
    manager?.dispose();
  });

  it("removes the parent abort listener after normal completion", async () => {
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    manager = new AgentManager(undefined, { default: 1 });

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
      description: "task", signal: parent.signal,
    });
    await manager.getRecord(id)!.execution.promise;

    expect(manager.getRecord(id)?.lifecycle.status).toBe("completed");
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("removes parent abort listeners when disposed during a run", () => {
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(deferred.promise);
    manager = new AgentManager(undefined, { default: 1 });

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
      description: "task", signal: parent.signal,
    });
    const signal = mockModules.mockRunAgent.mock.calls[0][3].signal as AbortSignal;
    manager.dispose();

    expect(signal.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledOnce();
    deferred.resolve(mockRunResult());
  });

  it("forwards a parent abort during root runner initialization and finalizes late setup", async () => {
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    const deferred = makeResolvablePromise();
    let runnerOptions: any;
    mockModules.mockRunAgent.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      runnerOptions = options;
      return deferred.promise;
    });
    manager = new AgentManager(undefined, { default: 1 });

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
      description: "task", signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    parent.abort();

    expect(runnerOptions.signal.aborted).toBe(true);
    expect(record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
    expect(record.lifecycle.completedAt).toEqual(expect.any(Number));
    expect(removeListener).toHaveBeenCalledOnce();

    const session = mockAgentSession();
    runnerOptions.onSessionCreated(session);
    expect(record.execution.session).toBe(session);
    deferred.resolve(mockRunResult({ session, aborted: true }));
    await record.execution.promise;
    expect(record.lifecycle.status).toBe("stopped");
  });

  it("continues disposing all records when one session dispose throws", async () => {
    const firstRun = makeResolvablePromise();
    const secondRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise).mockReturnValueOnce(secondRun.promise);
    manager = new AgentManager(undefined, { default: 2 });
    manager.spawn(fakePi(), fakeCtx(), "scout", "first", { description: "first" });
    manager.spawn(fakePi(), fakeCtx(), "reviewer", "second", { description: "second" });
    const firstSession = mockAgentSession();
    firstSession.dispose.mockImplementation(() => { throw new Error("dispose failed"); });
    const secondSession = mockAgentSession();
    mockModules.mockRunAgent.mock.calls[0]![3].onSessionCreated(firstSession);
    mockModules.mockRunAgent.mock.calls[1]![3].onSessionCreated(secondSession);

    expect(() => manager.dispose()).not.toThrow();
    expect(firstSession.dispose).toHaveBeenCalledOnce();
    expect(secondSession.dispose).toHaveBeenCalledOnce();
    expect(manager.listAgents()).toEqual([]);

    firstRun.resolve(mockRunResult({ aborted: true }));
    secondRun.resolve(mockRunResult({ aborted: true }));
  });


  it("forwards record callbacks and aborts an active controller on dispose", async () => {
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const onToolActivity = vi.fn();
    const onAssistantUsage = vi.fn();
    const onCompaction = vi.fn();
    manager = new AgentManager(undefined, { default: 1 });
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
      description: "task", onToolActivity, onAssistantUsage, onCompaction,
    });
    const callbacks = mockModules.mockRunAgent.mock.calls[0][3];

    callbacks.onToolActivity({ type: "end", toolName: "read" });
    callbacks.onAssistantUsage({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
    callbacks.onCompaction({ reason: "threshold", tokensBefore: 10 });
    expect(onToolActivity).toHaveBeenCalledWith({ type: "end", toolName: "read" });
    expect(onAssistantUsage).toHaveBeenCalledOnce();
    expect(onCompaction).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.stats).toMatchObject({ toolUses: 1, compactionCount: 1 });

    const signal = callbacks.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    manager.dispose();
    expect(signal.aborted).toBe(true);
    deferred.resolve(mockRunResult());
  });
});
