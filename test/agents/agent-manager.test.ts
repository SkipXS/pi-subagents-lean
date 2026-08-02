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
import type { AgentHierarchy, AgentRecord } from "../../src/types.js";
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
  getWidget,
  isInsideSubagentSpawn,
  runWithSubagentRuntime,
  setCoordinator,
  setManager,
  setPiInstance,
  setSessionCtx,
  setWidget,
} from "../../src/shell.js";
import { createNestedAgentExecutor } from "../../src/agents/tool-execution.js";
import { createNestedAgentProxy } from "../../src/agents/nested-agent-proxy.js";
import { registerAgents } from "../../src/agents/agent-types.js";

const childSettings = () => getStore().createSubagentRuntimeSettings();

/** Manager-created records always have hierarchy, unlike the public legacy shape. */
function managedHierarchy(record: AgentRecord): AgentHierarchy {
  if (!record.hierarchy) throw new Error("Expected manager-created record hierarchy");
  return record.hierarchy;
}

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
    const settings = childSettings();
    await runWithSubagentRuntime(createSubagentRuntimeContext(
      async () => ({ content: [] }),
      settings,
    ), async () => {
      expect(() => getPiInstance()).toThrow("Root ExtensionAPI is unavailable");
      expect(() => getSessionCtx()).toThrow("Root session context is unavailable");
      expect(() => getStore()).toThrow("Root ConfigStore is unavailable");
      expect(() => setPiInstance({} as any)).toThrow("Root ExtensionAPI setter is unavailable");
      expect(() => setSessionCtx({} as any)).toThrow("Root session context setter is unavailable");
      expect(() => setManager(null)).toThrow("Root manager setter is unavailable");
      expect(() => setWidget(null)).toThrow("Root widget setter is unavailable");
      expect(() => setCoordinator(null)).toThrow("Root coordinator setter is unavailable");
      expect(getManager()).toBeNull();
      expect(getCoordinator()).toBeNull();
      expect(getWidget()).toBeNull();
      expect(Object.keys(settings).sort()).toEqual(["agent", "mode", "modelFor", "modelSettingForMode", "thinkingSettingFor", "thinkingSettingForMode"]);
    });
  });

  it("does not let deprecated spawn hooks clear ALS shell guards", async () => {
    manager = new AgentManager(onComplete);
    const pi = fakePi();
    const ctx = fakeCtx();

    enterSubagentSpawn();
    await runWithSubagentRuntime(createSubagentRuntimeContext(
      async () => ({ content: [] }),
      childSettings(),
    ), async () => {
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

    await runWithSubagentRuntime(createSubagentRuntimeContext(
      async () => ({ content: [] }),
      childSettings(),
    ), async () => {
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
    const settings = childSettings();
    const runtime = createSubagentRuntimeContext(async () => ({ content: [] }), settings);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.keys(runtime).sort()).toEqual(["executeNestedAgent", "isChildRuntime", "settings"]);
    const forgedRuntime = {
      isChildRuntime: true,
      executeNestedAgent: async () => ({ content: [] }),
      settings,
    };

    const expectChildIsolation = async () => {
      expect(() => getPiInstance()).toThrow("Root ExtensionAPI is unavailable");
      expect(() => getSessionCtx()).toThrow("Root session context is unavailable");
      expect(() => getStore()).toThrow("Root ConfigStore is unavailable");
      expect(getManager()).toBeNull();
      expect(getCoordinator()).toBeNull();
      expect(getWidget()).toBeNull();
      expect(() => setPiInstance({} as any)).toThrow("Root ExtensionAPI setter is unavailable");
      expect(() => setSessionCtx({} as any)).toThrow("Root session context setter is unavailable");
      expect(() => setManager(null)).toThrow("Root manager setter is unavailable");
      expect(() => setWidget(null)).toThrow("Root widget setter is unavailable");
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

  it("captures a registered delegating root config and canonical role for direct manager spawns", () => {
    const parentRun = makeResolvablePromise();
    const childRun = makeResolvablePromise();
    const delegator = {
      name: "Implementer", description: "delegates", systemPrompt: "captured parent",
      delegateTo: ["scout"], maxChildAgents: 1,
    };
    registerAgents(new Map<string, any>([
      ["implementer", delegator],
      ["scout", { name: "scout", description: "", systemPrompt: "captured child" }],
    ]));
    mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
    manager = new AgentManager(undefined, { default: 1 });

    const parentId = manager.spawn(fakePi(), fakeCtx(), "IMPLEMENTER", "parent", { description: "parent" });
    // Mutating the registered source after acceptance cannot alter the private
    // ledger or the queued runner's detached config snapshot.
    delegator.systemPrompt = "mutated parent";
    delegator.delegateTo[0] = "reviewer";

    const parent = manager.getRecord(parentId)!;
    expect(parent.display.type).toBe("implementer");
    expect(managedHierarchy(parent).delegateTo).toEqual(["scout"]);
    expect(mockModules.mockRunAgent.mock.calls[0]?.[1]).toBe("implementer");
    expect(mockModules.mockRunAgent.mock.calls[0]?.[3].agentConfig).toMatchObject({
      name: "Implementer", systemPrompt: "captured parent", delegateTo: ["scout"], maxChildAgents: 1,
    });

    expect(manager.preflightNested(parentId, "scout")).toEqual(expect.objectContaining({ ok: true, type: "scout" }));
    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", { description: "child" });
    expect(managedHierarchy(manager.getRecord(childId)!).parentId).toBe(parentId);
    childRun.resolve(mockRunResult());
    parentRun.resolve(mockRunResult());
  });

  it("withholds root shell controls in child ALS while the bound nested proxy remains usable", async () => {
    const parentRun = makeResolvablePromise();
    const otherParentRun = makeResolvablePromise();
    manager = new AgentManager(undefined, { default: 3 });
    const coordinator = new SpawnCoordinator(manager);
    setManager(manager);
    setCoordinator(coordinator);
    const parentConfig = { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 };
    mockModules.mockRunAgent
      .mockReturnValueOnce(parentRun.promise)
      .mockReturnValueOnce(otherParentRun.promise)
      .mockResolvedValueOnce(mockRunResult());

    try {
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", { description: "parent", agentConfig: parentConfig });
      const otherParentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "other", { description: "other", agentConfig: parentConfig });
      const runtime = createSubagentRuntimeContext(
        createNestedAgentExecutor(parentId, fakePi(), manager, coordinator),
        childSettings(),
      );

      await runWithSubagentRuntime(runtime, async () => {
        expect(getManager()).toBeNull();
        expect(getCoordinator()).toBeNull();
        expect(getWidget()).toBeNull();
        // The root ConfigStore itself is unavailable; child settings are the
        // only configuration surface in the runtime context.
        expect(() => getStore()).toThrow("Root ConfigStore is unavailable");
        expect(getManager()?.spawnNested(otherParentId, fakePi(), fakeCtx(), "scout", "bypass", { description: "bypass" })).toBeUndefined();
        expect(getCoordinator()?.spawnNested(otherParentId, fakePi(), fakeCtx(), {
          type: "scout", prompt: "bypass", description: "bypass", graceTurns: 6, runInBackground: false,
        })).toBeUndefined();

        const proxy: any = createNestedAgentProxy(runtime);
        const result = await proxy.execute("nested", {
          agent: "scout", prompt: "allowed child",
        }, undefined, undefined, fakeCtx());
        expect(result).not.toHaveProperty("isError");
      });

      const children = managedHierarchy(manager.getRecord(parentId)!).childIds;
      expect(children).toHaveLength(1);
      expect(managedHierarchy(manager.getRecord(children[0]!)!).parentId).toBe(parentId);
      expect(managedHierarchy(manager.getRecord(otherParentId)!).childIds).toEqual([]);
      parentRun.resolve(mockRunResult());
      otherParentRun.resolve(mockRunResult());
    } finally {
      setCoordinator(null);
      setManager(null);
      coordinator.dispose();
    }
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

    it("runs a queued Eco root with its accepted model, thinking, and mode snapshot", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const coordinator = new SpawnCoordinator(manager);
      const blocker = makeResolvablePromise();
      const queued = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise).mockReturnValueOnce(queued.promise);
      const store = getStore();

      store.mutate.session.setMode("eco");
      store.mutate.session.setEcoModelOverride("scout", "accepted/eco");
      store.mutate.session.setEcoThinkingOverride("scout", "low");

      try {
        manager.spawn(fakePi(), fakeCtx(), "scout", "block queue", {
          description: "block queue", isBackground: true,
        });
        const acceptedSettings = store.createSubagentRuntimeSettings();
        const acceptedModel = { provider: "accepted", id: "eco", reasoning: true } as any;
        const result = await coordinator.spawn(fakePi(), fakeCtx(), {
          type: "scout",
          prompt: "queued Eco work",
          description: "queued Eco work",
          graceTurns: 6,
          runInBackground: true,
          model: acceptedModel,
          modelKey: "accepted/eco",
          thinkingLevel: "low",
          runtimeSettingsSnapshot: acceptedSettings,
          invocation: { modelName: "eco", thinkingLevel: "low" },
        });
        expect(result.record.lifecycle.status).toBe("queued");
        expect(mockModules.mockRunAgent).toHaveBeenCalledOnce();

        store.mutate.session.setMode("default");
        store.mutate.session.setEcoModelOverride("scout", "later/eco");
        store.mutate.session.setEcoThinkingOverride("scout", "high");

        blocker.resolve(mockRunResult());
        await vi.waitFor(() => expect(result.record.lifecycle.status).toBe("running"));

        const queuedOptions = mockModules.mockRunAgent.mock.calls[1]![3];
        expect(queuedOptions.model).toBe(acceptedModel);
        expect(queuedOptions.thinkingLevel).toBe("low");
        expect(queuedOptions.runtimeSettings).toBe(acceptedSettings);
        expect(queuedOptions.runtimeSettings.mode).toBe("eco");
        expect(queuedOptions.runtimeSettings.modelSettingForMode("scout", "test/model").value).toBe("accepted/eco");
        expect(queuedOptions.runtimeSettings.thinkingSettingForMode("scout", undefined).value).toBe("low");
        expect(result.record.display.invocation).toMatchObject({ mode: "eco", thinkingLevel: "low" });

        queued.resolve(mockRunResult());
        await result.record.execution.promise;
      } finally {
        coordinator.dispose();
        store.mutate.session.setMode(undefined);
        store.mutate.session.clearEcoModelOverride("scout");
        store.mutate.session.clearEcoThinkingOverride("scout");
      }
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
      expect(record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
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
      expect(queuedRecord.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
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
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
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

      // Retention bounds result text even while a failed delivery is retryable.
      record.delivery = { state: "failed", attempts: 1, lastError: "Pi unavailable" };
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
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
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;

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

  it("keeps parent and nested-agent cache-hit rates session-local", async () => {
    const parentRun = makeResolvablePromise();
    const childRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
    manager = new AgentManager(onComplete, { default: 1 });
    const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
      description: "parent",
      agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 },
    });
    const parentOnUsage = mockModules.mockRunAgent.mock.calls[0]![3].onAssistantUsage;
    parentOnUsage({ input: 20, output: 0, cacheRead: 80, cacheWrite: 0, cost: 0 });

    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", { description: "child" });
    const childOnUsage = mockModules.mockRunAgent.mock.calls[1]![3].onAssistantUsage;
    childOnUsage({ input: 50, output: 0, cacheRead: 50, cacheWrite: 0, cost: 0 });
    parentOnUsage({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

    expect(manager.getRecord(parentId)!.stats.latestCacheHitRate).toBeCloseTo((80 / 200) * 100);
    expect(manager.getRecord(childId)!.stats.latestCacheHitRate).toBeCloseTo((50 / 100) * 100);

    childRun.resolve(mockRunResult());
    parentRun.resolve(mockRunResult());
    await Promise.all([
      manager.getRecord(parentId)!.execution.promise,
      manager.getRecord(childId)!.execution.promise,
    ]);
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

  it("refreshes active telemetry once for a leaf/model switch and ignores terminal records", async () => {
    manager = new AgentManager(onComplete);
    let leafId = "leaf-1";
    let contextWindow = 100;
    const getLeafId = vi.fn(() => leafId);
    const getBranch = vi.fn(() => []);
    const getContextUsage = vi.fn(() => {
      getBranch();
      return { percent: 12, contextWindow };
    });
    const session = {
      ...mockAgentSession(),
      getContextUsage,
      sessionManager: { getLeafId, getBranch },
      model: { provider: "test", id: "model-1", contextWindow },
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    mockModules.mockRunAgent.mock.calls[0]![3].onSessionCreated(session);

    expect(getContextUsage).toHaveBeenCalledOnce();
    getContextUsage.mockClear();
    getBranch.mockClear();

    // Repeated widget cadence checks only the O(1) leaf/model identity.
    for (let tick = 0; tick < 8; tick++) manager.refreshActiveSessions();
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getBranch).not.toHaveBeenCalled();

    // An idle branch/model switch takes one coalesced context/auth snapshot.
    leafId = "leaf-2";
    contextWindow = 200;
    session.model = { provider: "test", id: "model-2", contextWindow };
    expect(manager.refreshActiveSessions()).toBe(true);
    expect(getContextUsage).toHaveBeenCalledOnce();
    expect(getBranch).toHaveBeenCalledOnce();
    expect(record.stats.contextWindow).toBe(200);

    getContextUsage.mockClear();
    getBranch.mockClear();
    for (let tick = 0; tick < 8; tick++) manager.refreshActiveSessions();
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getBranch).not.toHaveBeenCalled();

    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;
    getContextUsage.mockClear();
    getBranch.mockClear();

    // Terminal records remain persisted projections and are never sampled by
    // the active-session cadence.
    expect(manager.refreshActiveSessions()).toBe(false);
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getBranch).not.toHaveBeenCalled();
    expect((manager as any).sessionRevisions.size).toBe(1);

    manager.dispose();
    expect((manager as any).sessionRevisions.size).toBe(0);
  });

  it("does not resample a session after dispose races a late runner settlement", async () => {
    manager = new AgentManager(onComplete);
    const getContextUsage = vi.fn(() => ({ percent: 20, contextWindow: 100 }));
    const session = {
      ...mockAgentSession(),
      getContextUsage,
      sessionManager: { getLeafId: () => "leaf-1" },
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
    expect((manager as any).sessionRevisions.size).toBe(0);
  });

  it("coalesces an idle tick with the deferred assistant persistence sample", async () => {
    manager = new AgentManager(onComplete);
    let leafId = "leaf-1";
    let persisted = false;
    const getLeafId = vi.fn(() => leafId);
    const getBranch = vi.fn(() => []);
    const getContextUsage = vi.fn(() => {
      getBranch();
      return persisted
        ? { percent: 40, contextWindow: 200 }
        : { percent: null, contextWindow: 100 };
    });
    const session = {
      ...mockAgentSession(),
      getContextUsage,
      sessionManager: { getLeafId, getBranch },
      model: { provider: "test", id: "model-1", contextWindow: 100 },
    };
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" });
    const record = manager.getRecord(id)!;
    const callbacks = mockModules.mockRunAgent.mock.calls[0]![3];
    callbacks.onSessionCreated(session);
    getContextUsage.mockClear();
    getBranch.mockClear();

    callbacks.onAssistantUsage({ input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 0 });
    persisted = true;
    leafId = "leaf-2";

    // The pending post-persistence observation owns this boundary; an idle
    // widget tick must not race it with a second full read.
    expect(manager.refreshActiveSessions()).toBe(false);
    expect(getContextUsage).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(getContextUsage).toHaveBeenCalledOnce();
    expect(getBranch).toHaveBeenCalledOnce();
    expect(record.stats.contextWindow).toBe(200);
    getContextUsage.mockClear();
    getBranch.mockClear();
    expect(manager.refreshActiveSessions()).toBe(false);
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getBranch).not.toHaveBeenCalled();

    deferred.resolve(mockRunResult({ session }));
    await record.execution.promise;
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
    expect(record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
    expect(record.lifecycle.completedAt).toEqual(expect.any(Number));
    expect(removeListener).toHaveBeenCalledOnce();

    const session = mockAgentSession();
    runnerOptions.onSessionCreated(session);
    deferred.resolve(mockRunResult({ session, aborted: true }));
    await record.execution.promise;
    expect(record.lifecycle.status).toBe("stopped");
  });

  describe("spawnNested", () => {
    const parentConfig = { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 };
    const childConfig = { name: "scout", description: "", systemPrompt: "" };

    it("rejects background children and missing or stopped parents", async () => {
      manager = new AgentManager(undefined, { default: 1 });
      const options = { description: "child", agentConfig: childConfig };

      expect(() => manager.spawnNested("missing", fakePi(), fakeCtx(), "scout", "child", options))
        .toThrow("Nested agent parent is no longer running");

      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentConfig: parentConfig,
      });
      await manager.getRecord(parentId)!.execution.promise;

      expect(() => manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", options))
        .toThrow("Nested agent parent is no longer running");

      mockModules.mockRunAgent.mockReturnValue(new Promise(() => {}));
      const activeParent = manager.spawn(fakePi(), fakeCtx(), "implementer", "active parent", {
        description: "active parent", agentConfig: parentConfig,
      });
      expect(() => manager.spawnNested(activeParent, fakePi(), fakeCtx(), "scout", "child", {
        ...options, isBackground: true,
      })).toThrow("Nested agents must run in the foreground");
    });

    it("keeps its total child budget on the parent after sequential completion", async () => {
      const parentRun = makeResolvablePromise();
      const childRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentConfig: parentConfig,
      });
      const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
        description: "child", agentConfig: { ...childConfig, maxChildAgents: 99 },
      });

      childRun.resolve(mockRunResult());
      await manager.getRecord(childId)!.execution.promise;

      // The child cannot expand the manager-owned budget, and completed direct
      // children still count against the parent's total allowance.
      expect(() => manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "another child", {
        description: "another child", agentConfig: { ...childConfig, maxChildAgents: 99 },
      })).toThrow("Child-agent budget exhausted");
      parentRun.resolve(mockRunResult());
    });

    it("rejects a second concurrently active child even when budget remains", () => {
      const parentRun = makeResolvablePromise();
      const childRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentConfig: { ...parentConfig, maxChildAgents: 2 },
      });
      manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "first child", {
        description: "first child", agentConfig: childConfig,
      });

      expect(() => manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "second child", {
        description: "second child", agentConfig: childConfig,
      })).toThrow("This agent already has an active child");
    });

    it("centrally preflights captured catalog permissions, budget, and active children", async () => {
      const parentRun = makeResolvablePromise();
      const childRun = makeResolvablePromise();
      const catalog = new Map<string, any>([
        ["scout", { name: "scout", description: "", systemPrompt: "" }],
        ["reviewer", { name: "reviewer", description: "", systemPrompt: "" }],
      ]);
      mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentCatalog: catalog,
        agentConfig: { ...parentConfig, maxChildAgents: 1 },
      });

      expect(manager.preflightNested(parentId, "reviewer")).toEqual(expect.objectContaining({
        ok: false, error: 'Agent "reviewer" is not allowed. Allowed child agents: scout',
      }));
      expect(manager.preflightNested(parentId, "scout")).toEqual(expect.objectContaining({ ok: true, type: "scout" }));
      manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", { description: "child" });
      expect(manager.preflightNested(parentId, "scout")).toEqual(expect.objectContaining({
        ok: false, error: "This agent already has an active child",
      }));

      childRun.resolve(mockRunResult());
      await managedHierarchy(manager.getRecord(parentId)!).childIds.map((id) => manager.getRecord(id)!.execution.promise)[0];
      expect(manager.preflightNested(parentId, "scout")).toEqual(expect.objectContaining({
        ok: false, error: "Child-agent budget exhausted",
      }));
      parentRun.resolve(mockRunResult());
    });

    it("enforces its configured cap at nested preflight despite a caller-supplied cap", () => {
      const parentRun = makeResolvablePromise();
      const childRun = makeResolvablePromise();
      const catalog = new Map<string, any>([
        ["scout", { name: "scout", description: "", systemPrompt: "", delegateTo: ["reviewer"] }],
        ["reviewer", { name: "reviewer", description: "", systemPrompt: "" }],
      ]);
      mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
      manager = new AgentManager(undefined, { default: 1 }, undefined, 0, 2);
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentCatalog: catalog, agentConfig: parentConfig,
      });
      const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
        description: "child", ...({ maxNestingDepth: 2 } as any),
      });
      manager.setMaxNestingDepth(1);

      // The legacy third preflight argument is untrusted and ignored at runtime.
      expect((manager.preflightNested as any)(childId, "reviewer", 2)).toEqual(expect.objectContaining({
        ok: false, error: "Maximum nesting depth reached",
      }));
      expect(() => manager.spawnNested(childId, fakePi(), fakeCtx(), "reviewer", "grandchild", {
        description: "grandchild", ...({ maxNestingDepth: 2 } as any),
      })).toThrow("Maximum nesting depth reached");
    });

    it("prevents a depth-2 parent from spawning a child even when called directly", () => {
      const parentRun = makeResolvablePromise();
      const childRun = makeResolvablePromise();
      const catalog = new Map<string, any>([
        ["scout", { name: "scout", description: "", systemPrompt: "", delegateTo: ["reviewer"] }],
        ["reviewer", { name: "reviewer", description: "", systemPrompt: "" }],
      ]);
      mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentCatalog: catalog, agentConfig: parentConfig,
      });
      const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", { description: "child" });

      expect(() => manager.spawnNested(childId, fakePi(), fakeCtx(), "reviewer", "grandchild", { description: "grandchild" }))
        .toThrow("Maximum nesting depth reached");
    });

    it("keeps nested authorization and accounting in its private ledger when public records are mutated", async () => {
      const parentRun = makeResolvablePromise();
      const childRun = makeResolvablePromise();
      const catalog = new Map<string, any>([
        ["scout", { name: "scout", description: "captured child", systemPrompt: "captured prompt" }],
        ["reviewer", { name: "reviewer", description: "", systemPrompt: "" }],
      ]);
      mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentCatalog: catalog, agentConfig: parentConfig,
      });
      const publicParent = manager.getRecord(parentId)!;
      const publicParentHierarchy = managedHierarchy(publicParent);
      publicParentHierarchy.depth = 0;
      publicParentHierarchy.delegateTo = ["reviewer"];
      publicParentHierarchy.maxChildAgents = 99;
      publicParentHierarchy.childIds = [];
      (publicParentHierarchy.agentCatalog as Map<string, any>).set("reviewer", { name: "reviewer", description: "", systemPrompt: "forged" });
      publicParent.lifecycle.status = "completed";

      expect(manager.preflightNested(parentId, "reviewer")).toEqual(expect.objectContaining({
        ok: false, error: 'Agent "reviewer" is not allowed. Allowed child agents: scout',
      }));
      const preflight = manager.preflightNested(parentId, "scout");
      expect(preflight.ok).toBe(true);
      if (!preflight.ok) throw new Error(preflight.error);
      preflight.agentConfig.systemPrompt = "forged child config";
      const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
        description: "child", agentConfig: { name: "scout", description: "", systemPrompt: "caller config" },
      });
      const child = manager.getRecord(childId)!;
      const childHierarchy = managedHierarchy(child);
      childHierarchy.depth = 1;
      childHierarchy.delegateTo = ["reviewer"];
      childHierarchy.maxChildAgents = 99;
      childHierarchy.childIds = [];
      (childHierarchy.agentCatalog as Map<string, any>).set("reviewer", { name: "reviewer", description: "", systemPrompt: "forged" });
      child.lifecycle.status = "running";

      // The child uses a fresh private config, and a forged child hierarchy
      // cannot turn a depth-2 child into a delegating root.
      expect(mockModules.mockRunAgent.mock.calls[1][3].agentConfig.systemPrompt).toBe("captured prompt");
      expect(manager.preflightNested(childId, "reviewer")).toEqual(expect.objectContaining({
        ok: false, error: "Maximum nesting depth reached",
      }));

      childRun.resolve(mockRunResult());
      await child.execution.promise;
      publicParentHierarchy.childIds = [];
      publicParentHierarchy.maxChildAgents = 99;
      publicParent.lifecycle.status = "running";
      expect(manager.preflightNested(parentId, "scout")).toEqual(expect.objectContaining({
        ok: false, error: "Child-agent budget exhausted",
      }));

      parentRun.resolve(mockRunResult());
      await manager.getRecord(parentId)!.execution.promise;
      publicParent.lifecycle.status = "running";
      expect(manager.preflightNested(parentId, "scout")).toEqual(expect.objectContaining({
        ok: false, error: "Nested agent parent is no longer running",
      }));
    });

    it("inherits a parent worktree at the direct manager nested boundary", () => {
      const parentRun = makeResolvablePromise();
      const childRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentConfig: parentConfig,
        worktreePath: "/parent-worktree", worktreeLabel: "parent-label",
        worktreeParentCwd: "/parent-repo", worktreeSelectionPath: "/links/parent-worktree",
      });
      const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
        description: "child", worktreePath: "/caller-worktree", worktreeLabel: "caller-label",
        worktreeParentCwd: "/caller-repo", worktreeSelectionPath: "/links/caller-worktree",
      });

      expect(mockModules.mockRunAgent.mock.calls[1][3]).toMatchObject({
        cwd: "/parent-worktree",
        worktreeParentCwd: "/parent-repo",
        worktreeSelectionPath: "/links/parent-worktree",
      });
      expect(manager.getRecord(childId)?.display).toMatchObject({ worktreePath: "/parent-worktree", worktreeLabel: "parent-label" });
    });

    it("clears a parent waiting child when an already-aborted nested signal prevents startup", () => {
      const parentRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentConfig: parentConfig,
      });
      const abort = new AbortController();
      abort.abort();
      const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
        description: "child", signal: abort.signal,
      });

      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);
      expect(manager.getRecord(childId)?.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent", settled: true });
      expect(managedHierarchy(manager.getRecord(parentId)!).waitingOnChildId).toBeUndefined();
    });

    it("rolls back parent hierarchy state when nested startup throws", () => {
      const parentRun = makeResolvablePromise();
      const childRun = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(parentRun.promise)
        .mockImplementationOnce(() => { throw new Error("child startup failed"); })
        .mockReturnValueOnce(childRun.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
        description: "parent", agentConfig: parentConfig,
      });
      const parent = manager.getRecord(parentId)!;

      expect(() => manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "broken child", {
        description: "broken child", agentConfig: childConfig,
      })).toThrow("child startup failed");
      expect(managedHierarchy(parent).childIds).toEqual([]);
      expect(managedHierarchy(parent).waitingOnChildId).toBeUndefined();
      expect(manager.getTotalAgentCount()).toBe(1);

      expect(() => manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "replacement child", {
        description: "replacement child", agentConfig: childConfig,
      })).not.toThrow();
    });
  });

  it("keeps a parent active and clears its waiting child after stopping that child", async () => {
    const parentRun = makeResolvablePromise();
    const childRun = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(parentRun.promise).mockReturnValueOnce(childRun.promise);
    manager = new AgentManager(undefined, { default: 1 });
    const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
      description: "parent",
      agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"] },
    });
    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
      description: "child", agentConfig: { name: "scout", description: "", systemPrompt: "" },
    });

    expect(managedHierarchy(manager.getRecord(parentId)!).waitingOnChildId).toBe(childId);
    expect(manager.abort(childId, "user")).toBe(true);
    expect(manager.getRecord(parentId)?.lifecycle.status).toBe("running");
    childRun.resolve(mockRunResult({ aborted: true }));
    await manager.getRecord(childId)!.execution.promise;
    expect(managedHierarchy(manager.getRecord(parentId)!).waitingOnChildId).toBeUndefined();
    expect(manager.getRecord(parentId)?.lifecycle.status).toBe("running");

    parentRun.resolve(mockRunResult());
    await manager.getRecord(parentId)!.execution.promise;
  });

  it("stops an active child and retains the root slot when the parent runner fails", async () => {
    let rejectParent!: (error: Error) => void;
    const parentRun = new Promise<unknown>((_resolve, reject) => { rejectParent = reject; });
    const childRun = makeResolvablePromise();
    const queuedRun = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(parentRun)
      .mockReturnValueOnce(childRun.promise)
      .mockReturnValueOnce(queuedRun.promise);
    manager = new AgentManager(undefined, { default: 1 });
    const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
      description: "parent",
      agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 },
    });
    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
      description: "child",
      agentConfig: { name: "scout", description: "", systemPrompt: "" },
    });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "reviewer", "queued", { description: "queued" });

    rejectParent(new Error("parent runner failed"));
    await manager.getRecord(parentId)!.execution.promise;

    expect(manager.getRecord(parentId)?.lifecycle).toMatchObject({ status: "error" });
    expect(manager.getRecord(parentId)?.error).toBe("parent runner failed");
    expect(manager.getRecord(childId)?.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

    childRun.resolve(mockRunResult({ aborted: true }));
    await manager.getRecord(childId)!.execution.promise;
    await vi.waitFor(() => expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("running"));

    queuedRun.resolve(mockRunResult());
    await manager.getRecord(queuedId)!.execution.promise;
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it("holds a handed-off slot until a stopped parent's child settles, then drains", async () => {
    const parentRun = makeResolvablePromise();
    const childRun = makeResolvablePromise();
    const queuedRun = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(parentRun.promise)
      .mockReturnValueOnce(childRun.promise)
      .mockReturnValueOnce(queuedRun.promise);
    manager = new AgentManager(undefined, { default: 1 });
    const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
      description: "parent",
      agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 },
    });
    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
      description: "child",
      agentConfig: { name: "scout", description: "", systemPrompt: "" },
    });

    expect(manager.getRecord(childId)?.hierarchy).toMatchObject({ parentId, depth: 2, usesParentSlot: true });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "reviewer", "queued", { description: "queued" });
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

    expect(manager.abort(parentId, "user")).toBe(true);
    // The parent runner settles first, while the stopped borrowed child is
    // still unwinding. The unrelated queued agent must not start yet.
    parentRun.resolve(mockRunResult({ aborted: true }));
    await manager.getRecord(parentId)!.execution.promise;
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

    childRun.resolve(mockRunResult({ aborted: true }));
    await vi.waitFor(() => expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("running"));
    queuedRun.resolve(mockRunResult());
    await manager.getRecord(queuedId)!.execution.promise;
  });

  it("lets four full owner chains borrow their slots without starting a fifth root", async () => {
    const parentRuns = Array.from({ length: 4 }, makeResolvablePromise);
    const childRuns = Array.from({ length: 4 }, makeResolvablePromise);
    const queuedRun = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockImplementationOnce(() => parentRuns[0]!.promise)
      .mockImplementationOnce(() => parentRuns[1]!.promise)
      .mockImplementationOnce(() => parentRuns[2]!.promise)
      .mockImplementationOnce(() => parentRuns[3]!.promise)
      .mockImplementationOnce(() => childRuns[0]!.promise)
      .mockImplementationOnce(() => childRuns[1]!.promise)
      .mockImplementationOnce(() => childRuns[2]!.promise)
      .mockImplementationOnce(() => childRuns[3]!.promise)
      .mockImplementationOnce(() => queuedRun.promise);
    manager = new AgentManager(undefined, { default: 4 });
    const parentConfig = { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 };
    const childConfig = { name: "scout", description: "", systemPrompt: "" };

    const parentIds = parentRuns.map((_, index) => manager.spawn(fakePi(), fakeCtx(), "implementer", `parent ${index}`, {
      description: `parent ${index}`, agentConfig: parentConfig,
    }));
    const childIds = parentIds.map((parentId, index) => manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", `child ${index}`, {
      description: `child ${index}`, agentConfig: childConfig,
    }));
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "reviewer", "queued root", { description: "queued root" });

    // Four roots consume the four global slots, but every foreground child
    // starts immediately on its parent's slot rather than joining the queue.
    expect(parentIds.every((id) => manager.getRecord(id)?.lifecycle.status === "running")).toBe(true);
    expect(childIds.every((id) => manager.getRecord(id)?.lifecycle.status === "running")).toBe(true);
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(8);
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

    // Settled roots still retain their slots while their borrowed children run.
    parentRuns.forEach((run) => run.resolve(mockRunResult()));
    await Promise.all(parentIds.map((id) => manager.getRecord(id)!.execution.promise));
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

    childRuns.forEach((run) => run.resolve(mockRunResult()));
    await Promise.all(childIds.map((id) => manager.getRecord(id)!.execution.promise));
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("running");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(9);

    queuedRun.resolve(mockRunResult());
    await manager.getRecord(queuedId)!.execution.promise;
  });

  it("holds a root slot through parent/child cancellation until the child settles", async () => {
    const onComplete = vi.fn();
    const parentRun = makeResolvablePromise();
    const childRun = makeResolvablePromise();
    const queuedRun = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(parentRun.promise)
      .mockReturnValueOnce(childRun.promise)
      .mockReturnValueOnce(queuedRun.promise);
    manager = new AgentManager(onComplete, { default: 1 });
    const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
      description: "parent",
      agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 },
    });
    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
      description: "child", agentConfig: { name: "scout", description: "", systemPrompt: "" },
    });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "reviewer", "queued root", { description: "queued root" });
    const records = [parentId, childId, queuedId].map((id) => manager.getRecord(id)!);
    records.forEach((record, index) => { record.stats.lifetimeUsage.cost = (index + 1) / 10; });

    expect(manager.abort(parentId, "user")).toBe(true);
    expect(manager.getRecord(childId)?.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent" });
    parentRun.resolve(mockRunResult({ aborted: true }));
    await manager.getRecord(parentId)!.execution.promise;
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

    childRun.resolve(mockRunResult({ aborted: true }));
    await manager.getRecord(childId)!.execution.promise;
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("running");
    queuedRun.resolve(mockRunResult());
    await manager.getRecord(queuedId)!.execution.promise;
    expect(manager.getTotalAgentCount()).toBe(3);
    expect(manager.getTotalAgentCost()).toBeCloseTo(0.6);
    expect(onComplete).toHaveBeenCalledTimes(3);
  });

  it("aborts parent and child controllers when the manager is disposed", async () => {
    const parentRun = makeResolvablePromise();
    const childRun = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(parentRun.promise)
      .mockReturnValueOnce(childRun.promise);
    manager = new AgentManager(undefined, { default: 1 });
    const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
      description: "parent",
      agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 },
    });
    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
      description: "child", agentConfig: { name: "scout", description: "", systemPrompt: "" },
    });
    const promises = [parentId, childId].map((id) => manager.getRecord(id)!.execution.promise!);
    const signals = mockModules.mockRunAgent.mock.calls.map((call) => call[3].signal as AbortSignal);

    manager.dispose();

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(manager.listAgents()).toEqual([]);

    parentRun.resolve(mockRunResult({ aborted: true }));
    childRun.resolve(mockRunResult({ aborted: true }));
    await Promise.all(promises);
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

  it("releases a parent slot after its settled child is evicted by retention", async () => {
    const parentRun = makeResolvablePromise();
    const childRun = makeResolvablePromise();
    const queuedRun = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(parentRun.promise)
      .mockReturnValueOnce(childRun.promise)
      .mockReturnValueOnce(queuedRun.promise);
    manager = new AgentManager(undefined, { default: 1 });
    const parentId = manager.spawn(fakePi(), fakeCtx(), "implementer", "parent", {
      description: "parent",
      agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"], maxChildAgents: 1 },
    });
    const childId = manager.spawnNested(parentId, fakePi(), fakeCtx(), "scout", "child", {
      description: "child",
      agentConfig: { name: "scout", description: "", systemPrompt: "" },
    });

    childRun.resolve(mockRunResult());
    await manager.getRecord(childId)!.execution.promise;
    const child = manager.getRecord(childId)!;
    child.lifecycle.completedAt = Date.now() - 2 * 60_000;
    manager.setRetentionMinutes(1);
    (manager as any).cleanup();
    expect(manager.getRecord(childId)).toBeUndefined();

    const queuedId = manager.spawn(fakePi(), fakeCtx(), "reviewer", "queued", { description: "queued" });
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");

    parentRun.resolve(mockRunResult());
    await manager.getRecord(parentId)!.execution.promise;
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("running");

    queuedRun.resolve(mockRunResult());
    await manager.getRecord(queuedId)!.execution.promise;
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
