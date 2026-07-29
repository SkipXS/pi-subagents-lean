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

describe("AgentManager", () => {
  let manager: AgentManager;
  let onComplete: ReturnType<typeof vi.fn<OnAgentComplete>>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    onComplete = vi.fn<OnAgentComplete>();
  });

  afterEach(() => {
    manager?.dispose();
  });

  // ── Concurrency ──

  describe("concurrency", () => {
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
      expect(onComplete).toHaveBeenCalledWith(failedRecord);
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
      expect(onComplete).toHaveBeenCalledWith(queuedRecord);
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
      expect(record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "agent" });
      expect(record.lifecycle.completedAt).toEqual(expect.any(Number));
      expect(onComplete).toHaveBeenCalledWith(record);
      expect(removeListener).toHaveBeenCalledOnce();
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
      expect(queuedRecord.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "agent" });
      expect(onComplete).toHaveBeenCalledWith(queuedRecord);
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
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
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

      await new Promise(r => setTimeout(r, 10));

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
      await new Promise((resolve) => setTimeout(resolve, 10));
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
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(manager.getTotalAgentCount()).toBe(1);
    });
  });

  // ── Cleanup eviction ──

  describe("cleanup", () => {
    it("preserves unconsumed completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Result never consumed by the LLM — must not be evicted, even when old.
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeDefined();
    });

    it("evicts consumed completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Once the LLM has read the result, the record is safe to evict when old.
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
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
      // Just completed — well within the 10-minute retention window.
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

      // Record completed 15 minutes ago — would be evicted with default 10-min retention
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 15 * 60_000;

      // But bump retention to 20 minutes before cleanup
      manager.setRetentionMinutes(20);
      (manager as any).cleanup();

      // Should survive because retention was raised
      expect(manager.getRecord(id)).toBeDefined();
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

  it("accumulates cache reads and retains only the newest cache-hit rate", () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    const onUsage = getOnAssistantUsage();

    onUsage({ input: 100, output: 10, cacheRead: 80, cacheWrite: 20, cost: 0 });
    onUsage({ input: 200, output: 10, cacheRead: 150, cacheWrite: 50, cost: 0 });

    const stats = manager.getRecord(id)!.stats;
    expect(stats.cacheRead).toBe(230);
    expect(stats.latestCacheHitRate).toBeCloseTo((150 / 400) * 100);
    expect(stats.lifetimeUsage.cacheWrite).toBe(70);
  });

  it("counts supplemental usage without changing assistant cache-hit state", () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    const onAssistantUsage = getOnAssistantUsage();
    const onSupplementalUsage = getOnSupplementalUsage();

    onAssistantUsage({ input: 100, output: 10, cacheRead: 80, cacheWrite: 20, cost: 0.01 });
    const stats = manager.getRecord(id)!.stats;
    const assistantCacheHitRate = stats.latestCacheHitRate;

    onSupplementalUsage({ input: 400, output: 50, cacheRead: 300, cacheWrite: 25, cost: 0.12 });

    expect(stats.lifetimeUsage).toEqual({ input: 500, output: 60, cacheWrite: 45, cost: 0.13 });
    expect(stats.cacheRead).toBe(380);
    expect(stats.latestCacheHitRate).toBe(assistantCacheHitRate);

    onAssistantUsage({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0 });
    expect(stats.lifetimeUsage.input).toBe(700);
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
});
}); // end describe AgentManager

describe("AgentManager steering and shutdown", () => {
  let manager: AgentManager;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
  });

  afterEach(() => {
    manager?.dispose();
  });

  it("queues steering until a session exists, then forwards later steering failures", async () => {
    let runnerOptions: any;
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      runnerOptions = options;
      return deferred.promise;
    });
    manager = new AgentManager(undefined, { default: 1 });
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });

    expect(await manager.steer(id, "first instruction")).toBe(true);
    const session = { steer: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), subscribe: vi.fn(), messages: [] };
    runnerOptions.onSessionCreated(session);
    await vi.waitFor(() => expect(session.steer).toHaveBeenCalledWith("first instruction"));

    session.steer.mockRejectedValueOnce(new Error("closed"));
    expect(await manager.steer(id, "second instruction")).toBe(false);
    deferred.resolve(mockRunResult({ session }));
    await manager.getRecord(id)!.execution.promise;
  });

  it("returns false when steering or aborting an unknown agent", async () => {
    manager = new AgentManager(undefined, { default: 1 });

    expect(await manager.steer("missing", "instruction")).toBe(false);
    expect(manager.abort("missing", "user")).toBe(false);
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

  it("forwards a parent abort during runner initialization and retains stopped status", async () => {
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
    expect(record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "agent" });
    expect(record.lifecycle.completedAt).toEqual(expect.any(Number));
    expect(removeListener).toHaveBeenCalledOnce();

    const session = mockAgentSession();
    runnerOptions.onSessionCreated(session);
    deferred.resolve(mockRunResult({ session, aborted: true }));
    await record.execution.promise;
    expect(record.lifecycle.status).toBe("stopped");
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
