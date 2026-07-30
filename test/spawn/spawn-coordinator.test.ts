/**
 * spawn-coordinator.test.ts — Tests for SpawnCoordinator.

 * Verifies: spawn (foreground/background), nudge batching, live-view lifecycle,
 * onAgentComplete, dispose, stale pi protection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/types.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { buildInvocationTags } from "../../src/ui/format.js";

// --- Mock modules ---

const { mockAgentConfig, mockRunAgent } = vi.hoisted(() => ({
  mockAgentConfig: vi.fn(() => undefined),
  mockRunAgent: vi.fn(),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  resolveTypeInCatalog: vi.fn((catalog: Map<string, unknown>, name: string) => catalog.has(name) ? name : undefined),
  snapshotAgentConfig: vi.fn((config: any) => ({ ...config, delegateTo: config.delegateTo && [...config.delegateTo] })),
  snapshotRegisteredAgentCatalog: vi.fn(() => new Map()),
  getAgentConfig: mockAgentConfig,
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: vi.fn(async () => ({ ok: true, resolvedPath: "/wt", label: "wt" })),
}));

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: mockRunAgent,
}));

vi.mock("../../src/utils.js", () => ({
  parseModelKey: vi.fn(() => null),
  findModelInRegistry: vi.fn(() => undefined),
  parseThinkingLevel: vi.fn(() => undefined),
}));

vi.mock("../../src/config/config-io.js", () => ({
  loadConfig: vi.fn(() => ({ agent: { default: null, forceBackground: false }, concurrency: { default: 4 } })),
  saveConfigAtomic: vi.fn(),
  DEFAULT_CONFIG: { agent: { default: null, forceBackground: false }, concurrency: { default: 4 } },
}));

// Hoist mock pi so shell mock can return it
const { mockPi, mockGetPiInstance, mockIsIdle } = vi.hoisted(() => ({
  mockPi: { sendMessage: vi.fn(), sendUserMessage: vi.fn(), exec: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), on: vi.fn() } as unknown as ExtensionAPI & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
  },
  mockGetPiInstance: vi.fn<() => ExtensionAPI | null>(() => null),
  mockIsIdle: vi.fn(() => true),
}));

vi.mock("../../src/shell.js", () => ({
  getSubagentRuntimeContext: () => undefined,
  getStore: () => ({
    createSubagentRuntimeSettings: () => ({
      agent: { graceTurns: 6, forceBackground: false, showCost: false, maxNestingDepth: 2 },
      modelFor: (_type: string, parent: string, config?: { model?: string }) => config?.model ?? parent,
      thinkingSettingFor: () => ({ value: undefined }),
    }),
  }),
  getPiInstance: () => mockGetPiInstance(),
  getSessionCtx: () => ({ isIdle: mockIsIdle }),
  getWidget: () => null,
}));

function makeMockManager() {
  const records = new Map<string, any>();
  return {
    spawn: vi.fn((pi: any, ctx: any, type: string, prompt: string, options: any) => {
      const id = `agent-${records.size}`;
      const record: any = {
        id,
        display: { type, description: options.description },
        lifecycle: { status: options.isBackground ? "running" : "running", startedAt: Date.now() },
        execution: { promise: Promise.resolve("done") },
        stats: {
          lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
          toolUses: 0,
          turnCount: 1,
          maxTurns: options.maxTurns,
          compactionCount: 0,
        },
        result: "done",
      };
      records.set(id, record);
      return id;
    }),
    preflightNested: vi.fn((_parentId: string, type: string) => ({
      ok: true,
      parent: { hierarchy: { agentCatalog: new Map([[type, { name: type, description: "", systemPrompt: "" }]]) } },
      type,
      agentConfig: { name: type, description: "", systemPrompt: "" },
    })),
    spawnNested: vi.fn((parentId: string, pi: any, ctx: any, type: string, prompt: string, options: any) => {
      const id = `nested-${records.size}`;
      records.set(id, {
        id,
        display: { type, description: options.description },
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { promise: Promise.resolve("done") },
        hierarchy: { parentId, depth: 2, childIds: [], delegateTo: [], maxChildAgents: 0 },
        stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 1, compactionCount: 0 },
        result: "done",
      });
      return id;
    }),
    getRecord: vi.fn((id: string) => records.get(id)),
    listAgents: vi.fn(() => [...records.values()]),
    abort: vi.fn(() => true),
    steer: vi.fn(async () => true),
    getTotalAgentCost: vi.fn(() => 0),
    getTotalAgentCount: vi.fn(() => 0),
    dispose: vi.fn(),
    onComplete: undefined as any,
    onStart: undefined as any,
  };
}

function makeMockCtx() {
  return { cwd: "/test", model: undefined, modelRegistry: {} } as unknown as ExtensionContext;
}

// --- Tests ---

describe("SpawnCoordinator", () => {
  // Dynamically import after mocks are set up
  let SpawnCoordinator: typeof import("../../src/spawn/spawn-coordinator.js").SpawnCoordinator;
  let manager: ReturnType<typeof makeMockManager>;
  let ctx: ExtensionContext;

  beforeEach(async () => {
    vi.useFakeTimers();
    manager = makeMockManager();
    ctx = makeMockCtx();
    mockPi.sendMessage.mockClear();
    mockRunAgent.mockReset();
    mockAgentConfig.mockReset().mockReturnValue(undefined);
    mockGetPiInstance.mockReturnValue(mockPi);
    mockIsIdle.mockReturnValue(true);
    const mod = await import("../../src/spawn/spawn-coordinator.js");
    SpawnCoordinator = mod.SpawnCoordinator;
  });


  it("spawns a background agent and returns result", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test spawn",
      graceTurns: 6,
      runInBackground: true,
    });

    expect(result.agentId).toBeTruthy();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(manager.spawn.mock.calls[0][2]).toBe("builder");
    expect(manager.spawn.mock.calls[0][3]).toBe("do something");
    expect(manager.spawn.mock.calls[0][4].isBackground).toBe(true);
  });

  it("forwards the parent abort signal to the agent manager", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const signal = new AbortController().signal;

    await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test parent abort forwarding",
      graceTurns: 6,
      runInBackground: true,
      signal,
    });

    expect(manager.spawn.mock.calls[0][4].signal).toBe(signal);
  });

  it("does not retain or nudge a synchronously parent-aborted background spawn", async () => {
    const realManager = new AgentManager(undefined, { default: 1 });
    const coordinator = new SpawnCoordinator(realManager);
    realManager.setOnComplete((record) => coordinator.onAgentComplete(record));
    const parent = new AbortController();
    parent.abort();

    try {
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Already cancelled",
        graceTurns: 6,
        runInBackground: true,
        signal: parent.signal,
      });

      expect(result.record.lifecycle).toMatchObject({
        status: "stopped",
        stoppedBy: "parent",
        resultConsumed: true,
      });
      expect(coordinator.liveView(result.agentId)).toBeUndefined();
      expect(coordinator.isBackground(result.agentId)).toBe(false);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    } finally {
      realManager.dispose();
    }
  });

  it("snapshots an explicitly resolved agent config before handing it to the manager", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const config = {
      name: "builder",
      description: "A-only",
      systemPrompt: "Use A instructions.",
      registeredTools: ["read"],
      tools: ["read"],
      extensions: ["a-extension"],
      skills: ["a-skill"],
      maxTurns: 3,
      maxTokens: 200,
    } as any;

    await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test config snapshot",
      agentConfig: config,
      graceTurns: 6,
      runInBackground: true,
    });
    config.registeredTools.push("bash");
    config.tools.push("bash");

    const snapshot = manager.spawn.mock.calls[0][4].agentConfig;
    expect(snapshot).toEqual(expect.objectContaining({
      systemPrompt: "Use A instructions.",
      registeredTools: ["read"],
      tools: ["read"],
      extensions: ["a-extension"],
      skills: ["a-skill"],
      maxTurns: 3,
      maxTokens: 200,
    }));
    expect(snapshot).not.toBe(config);
  });

  it("spawns a foreground agent and awaits its promise", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test foreground",
      graceTurns: 6,
      runInBackground: false,
    });

    expect(result.agentId).toBeTruthy();
    expect(result.record).toBeTruthy();
    expect(manager.spawn.mock.calls[0][4].isBackground).toBe(false);
  });

  it("awaits a nested foreground child without registering a background nudge", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    let resolveChild!: (value: string) => void;
    const record: any = {
      id: "nested-child",
      display: { type: "scout", description: "Inspect" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: { promise: new Promise<string>((resolve) => { resolveChild = resolve; }) },
      hierarchy: { parentId: "parent", depth: 2, childIds: [], delegateTo: [], maxChildAgents: 0 },
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, compactionCount: 0 },
    };
    manager.spawnNested.mockReturnValueOnce(record.id);
    manager.getRecord.mockImplementation((id: string) => id === record.id ? record : undefined);

    let settled = false;
    const spawned = coordinator.spawnNested("parent", mockPi, ctx, {
      type: "scout", prompt: "Inspect", description: "Inspect", graceTurns: 6, runInBackground: false,
    }).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(manager.spawnNested).toHaveBeenCalledWith(
      "parent", mockPi, ctx, "scout", "Inspect", expect.objectContaining({ isBackground: false }),
    );

    record.lifecycle.status = "completed";
    resolveChild("done");
    const result = await spawned;
    expect(result.record.lifecycle.resultConsumed).toBe(true);
    expect(coordinator.isBackground(result.agentId)).toBe(false);
    vi.advanceTimersByTime(500);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("inherits the parent worktree through the coordinator nested path", async () => {
    const realManager = new AgentManager(undefined, { default: 1 });
    const coordinator = new SpawnCoordinator(realManager);
    const parentRun = new Promise<any>(() => {});
    mockRunAgent.mockReturnValueOnce(parentRun).mockResolvedValueOnce({
      responseText: "done", session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() }, aborted: false, turnLimited: false,
    });
    try {
      const parentId = realManager.spawn(mockPi, ctx, "implementer", "parent", {
        description: "parent",
        worktreePath: "/parent-worktree",
        worktreeLabel: "parent-label",
        agentConfig: { name: "implementer", description: "", systemPrompt: "", delegateTo: ["scout"] },
        agentCatalog: new Map([["scout", { name: "scout", description: "", systemPrompt: "" }]]),
      });
      const result = await coordinator.spawnNested(parentId, mockPi, ctx, {
        type: "scout", prompt: "child", description: "child", graceTurns: 6, runInBackground: false,
        worktreePath: "/caller-worktree", worktreeLabel: "caller-label",
      });

      expect(mockRunAgent.mock.calls[1][3].cwd).toBe("/parent-worktree");
      expect(result.record.display).toMatchObject({ worktreePath: "/parent-worktree", worktreeLabel: "parent-label" });
    } finally {
      realManager.dispose();
    }
  });

  it("uses manager preflight before preparing a nested spawn", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    (manager.preflightNested as any).mockReturnValueOnce({ ok: false, error: "Child-agent budget exhausted" });

    await expect(coordinator.spawnNested("parent", mockPi, ctx, {
      type: "scout", prompt: "Inspect", description: "Inspect", graceTurns: 6, runInBackground: false,
    })).rejects.toThrow("Child-agent budget exhausted");
    expect(manager.spawnNested).not.toHaveBeenCalled();
  });

  it("rejects nested background requests before calling the manager", async () => {
    const coordinator = new SpawnCoordinator(manager as any);

    await expect(coordinator.spawnNested("parent", mockPi, ctx, {
      type: "scout", prompt: "Inspect", description: "Inspect", graceTurns: 6, runInBackground: true,
    })).rejects.toThrow("Nested agents must run in the foreground");
    expect(manager.spawnNested).not.toHaveBeenCalled();
  });

  it("normalizes thinking before passing options and invocation to the manager", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const model = {
      provider: "deepseek",
      id: "deepseek-reasoner",
      reasoning: true,
      thinkingLevelMap: { xhigh: null, max: null },
    } as any;
    ctx = { ...ctx, model };

    await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test",
      thinkingLevel: "max",
      graceTurns: 6,
      invocation: { thinkingLevel: "max" },
      runInBackground: true,
    });

    const options = manager.spawn.mock.calls[0][4];
    expect(options.model).toBe(model);
    expect(options.modelKey).toBe("deepseek/deepseek-reasoner");
    expect(options.thinkingLevel).toBe("high");
    expect(options.invocation.thinkingLevel).toBe("high");
    expect(buildInvocationTags(options.invocation).tags).not.toContain("thinking: high");
  });

  it("creates a live view on spawn", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test",
      graceTurns: 6,
      runInBackground: true,
    });

    const view = coordinator.liveView(result.agentId);
    expect(view).toBeDefined();
    expect(view!.activeTools).toBeInstanceOf(Map);
    expect(view!.responseText).toBe("");
  });

  it("cleans up live view on foreground completion", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test",
      graceTurns: 6,
      runInBackground: false,
    });

    // After foreground spawn completes, live view should be cleaned up
    const view = coordinator.liveView(result.agentId);
    expect(view).toBeUndefined();
  });

  it("registers background agent in backgroundAgentIds", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test bg",
      graceTurns: 6,
      runInBackground: true,
    });

    expect(coordinator.isBackground(result.agentId)).toBe(true);
  });

  it("does not register foreground agent in backgroundAgentIds", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test fg",
      graceTurns: 6,
      runInBackground: false,
    });

    expect(coordinator.isBackground(result.agentId)).toBe(false);
  });

  describe("nudge scheduling", () => {
    it("emits individual nudge after delay window", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      result.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(result.agentId);

      // Not yet emitted — timer pending
      expect(mockPi.sendMessage).not.toHaveBeenCalled();

      // Advance past the 200ms batch window
      vi.advanceTimersByTime(200);

      // Now the nudge should have been emitted
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("batches multiple nudges within the delay window", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const r1 = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task 1", description: "Test 1", graceTurns: 6, runInBackground: true,
      });
      const r2 = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task 2", description: "Test 2", graceTurns: 6, runInBackground: true,
      });

      r1.record.lifecycle.status = "completed";
      r2.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(r1.agentId);
      coordinator.scheduleNudge(r2.agentId);

      // Advance past the batch window
      vi.advanceTimersByTime(200);

      // Both should be emitted as individual messages
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("ignores an accidental nudge for a running record and delivers once after completion", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Still running", graceTurns: 6, runInBackground: true,
      });

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect((coordinator as any).autoNudgeIssued.has(result.agentId)).toBe(false);

      result.record.lifecycle.status = "completed";
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledOnce();
      expect(result.record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
    });

    it("does not retain tracking or emit a nudge for an agent without a record", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      coordinator.scheduleNudge("agent-999");

      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect((coordinator as any).autoNudgeIssued.has("agent-999")).toBe(false);
    });

    it("starts new batch window for nudges arriving after the previous window", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const r1 = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task 1", description: "Test 1", graceTurns: 6, runInBackground: true,
      });
      const r2 = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task 2", description: "Test 2", graceTurns: 6, runInBackground: true,
      });

      r1.record.lifecycle.status = "completed";
      r2.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(r1.agentId);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      // New nudge after the window
      coordinator.scheduleNudge(r2.agentId);

      // Not yet emitted
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("onAgentComplete", () => {
    it("deletes live view on completion", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      // Manually add a live view
      (coordinator as any).liveViews.set("agent-1", { activeTools: new Map(), responseText: "" });

      coordinator.onAgentComplete({ id: "agent-1" } as AgentRecord);

      expect(coordinator.liveView("agent-1")).toBeUndefined();
    });

    it("schedules nudge for background agents", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });

      // Simulate completion
      result.record.lifecycle.status = "completed";
      coordinator.onAgentComplete(result.record);

      // Nudge should be scheduled with Pi's custom-message contract.
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-result", display: true }),
        { deliverAs: "followUp", triggerTurn: true },
      );

      // Should be removed from background set
      expect(coordinator.isBackground(result.agentId)).toBe(false);
    });

    it("uses steer delivery while the parent session is busy", async () => {
      mockIsIdle.mockReturnValue(false);
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });

      result.record.lifecycle.status = "completed";
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-result" }),
        { deliverAs: "steer", triggerTurn: true },
      );
    });

    it("does not schedule nudge for foreground agents", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      // Not in backgroundAgentIds

      coordinator.onAgentComplete({ id: "agent-1" } as AgentRecord);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("catches sendMessage errors silently (stale pi)", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });

      // Make sendMessage throw (simulates stale pi)
      mockPi.sendMessage.mockImplementation(() => { throw new Error("stale context"); });
      result.record.lifecycle.status = "completed";

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      // sendMessage was attempted
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("skips nudge emission when disposed", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });

      result.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(result.agentId);

      // Dispose before timer fires — should prevent emission
      coordinator.dispose();

      vi.advanceTimersByTime(500);

      // No sendMessage because disposed
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("clears nudge timer", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });
      result.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(result.agentId);

      coordinator.dispose();

      // Timer should be cleared — advancing time should not emit
      vi.advanceTimersByTime(500);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("clears live views", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      (coordinator as any).liveViews.set("agent-1", { activeTools: new Map(), responseText: "" });

      coordinator.dispose();

      expect(coordinator.liveView("agent-1")).toBeUndefined();
    });
  });

  describe("stale pi protection", () => {
    it("reads pi from shell at nudge time, not from spawn", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });

      // Coordinator no longer stores pi
      expect((coordinator as any).pi).toBeUndefined();

      // Nudge still works because it reads from shell at call time
      result.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("uses fresh shell pi when shell is updated between spawn and nudge", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });

      // Simulate shell being updated (e.g. after reload)
      const freshPi = { ...mockPi, sendMessage: vi.fn() } as unknown as ExtensionAPI;
      mockGetPiInstance.mockReturnValue(freshPi);
      result.record.lifecycle.status = "completed";

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      // Fresh pi was used, not the original mockPi
      expect(freshPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("skips nudge silently when shell has no pi", () => {
      const coordinator = new SpawnCoordinator(manager as any);

      // Simulate shell having no pi
      mockGetPiInstance.mockReturnValue(null);

      coordinator.scheduleNudge("agent-999");
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("constructor does not store pi", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      expect(coordinator).toBeDefined();
      expect((coordinator as any).pi).toBeUndefined();
    });
  });

  describe("nudge message status", () => {
    it("uses lifecycle status in the nudge message", async () => {
      const statuses: Array<{ status: string; expected: string }> = [
        { status: "completed", expected: "completed" },
        { status: "error", expected: "error" },
        { status: "aborted", expected: "aborted" },
        { status: "stopped", expected: "stopped" },
        { status: "turn_limited", expected: "turn_limited" },
      ];

      for (const { status, expected } of statuses) {
        mockPi.sendMessage.mockClear();
        const coordinator = new SpawnCoordinator(manager as any);

        const result = await coordinator.spawn(mockPi, ctx, {
          type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
        });

        manager.getRecord(result.agentId).lifecycle.status = status;
        manager.getRecord(result.agentId).result = "Result text";

        coordinator.scheduleNudge(result.agentId);
        vi.advanceTimersByTime(200);

        expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
        const content = mockPi.sendMessage.mock.calls[0][0].content;
        const shortId = result.agentId.slice(0, 8);
        expect(content).toContain(`[Subagent "builder" ${shortId} ${expected}]`);
      }
    });
  });

  describe("result consumption", () => {
    it("foreground spawn marks the result as consumed before returning", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "do something", description: "Test fg", graceTurns: 6, runInBackground: false,
      });

      expect(result.record.lifecycle.resultConsumed).toBe(true);
    });

    it("background nudge emission marks the result as consumed", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test bg", graceTurns: 6, runInBackground: true,
      });
      const record = manager.getRecord(result.agentId);
      // Reset any sendMessage impl leaked from other tests so this test exercises
      // the success path (default: returns without throwing).
      mockPi.sendMessage.mockReset();

      expect(record.lifecycle.resultConsumed).toBeUndefined();
      record.lifecycle.status = "completed";

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      // sendMessage delivered the full result to the LLM — record is safe to evict.
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(record.lifecycle.resultConsumed).toBe(true);
    });

    it("marks delivery failed when Pi is unavailable without consuming the result", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "No Pi", graceTurns: 6, runInBackground: true,
      });
      const record = manager.getRecord(result.agentId);
      mockGetPiInstance.mockReturnValue(null);
      record.lifecycle.status = "completed";

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      expect(record.lifecycle.resultConsumed).toBeUndefined();
      expect(record.delivery).toMatchObject({ state: "failed", attempts: 1 });
      expect(coordinator.isBackground(result.agentId)).toBe(false);
    });

    it("marks delivery failed and preserves the result when nudge delivery throws", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test bg", graceTurns: 6, runInBackground: true,
      });
      const record = manager.getRecord(result.agentId);

      // sendMessage throws — LLM never received the result, so it remains
      // available for the explicit manual retry path.
      mockPi.sendMessage.mockImplementation(() => { throw new Error("stale context"); });
      record.lifecycle.status = "completed";
      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(record.lifecycle.resultConsumed).toBeUndefined();
      expect(record.delivery).toMatchObject({ state: "failed", attempts: 1, lastError: "stale context" });
      expect(coordinator.isBackground(result.agentId)).toBe(false);
    });

    it("suppresses a delayed nudge when the parent aborts after onAgentComplete", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const parent = new AbortController();
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Parent abort after complete", graceTurns: 6,
        runInBackground: true, signal: parent.signal,
      });

      coordinator.onAgentComplete(result.record);
      expect((coordinator as any).backgroundParentAborts.has(result.agentId)).toBe(true);

      parent.abort();
      expect(result.record.lifecycle.resultConsumed).toBe(true);
      expect((coordinator as any).backgroundParentAborts.has(result.agentId)).toBe(false);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("abandons background delivery without a nudge after its parent aborts", async () => {
      const realManager = new AgentManager(undefined, { default: 1 });
      const coordinator = new SpawnCoordinator(realManager);
      realManager.setOnComplete((record) => coordinator.onAgentComplete(record));
      const parent = new AbortController();
      const runner = new Promise<any>(() => {});
      mockRunAgent.mockReturnValue(runner);

      try {
        const result = await coordinator.spawn(mockPi, ctx, {
          type: "builder", prompt: "task", description: "Parent abort", graceTurns: 6,
          runInBackground: true, signal: parent.signal,
        });
        parent.abort();

        expect(result.record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent", resultConsumed: true });
        expect(result.record.delivery).toMatchObject({ state: "abandoned" });
        expect(coordinator.isBackground(result.agentId)).toBe(false);
        expect((coordinator as any).backgroundParentAborts.has(result.agentId)).toBe(false);

        vi.advanceTimersByTime(200);
        expect(mockPi.sendMessage).not.toHaveBeenCalled();
      } finally {
        realManager.dispose();
      }
    });
  });

  describe("delivery interleavings", () => {
    it("fails once, manually retries once, then accepts without duplicate sends", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "retry", graceTurns: 6, runInBackground: true,
      });
      result.record.lifecycle.status = "completed";
      mockPi.sendMessage.mockReset().mockImplementation(() => { throw new Error("stale Pi"); });

      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);
      expect(result.record.delivery).toMatchObject({ state: "failed", attempts: 1, lastError: "stale Pi" });
      expect(mockPi.sendMessage).toHaveBeenCalledOnce();

      mockPi.sendMessage.mockReset().mockImplementation(() => {
        // Reentrant UI selection cannot create a parallel manual attempt.
        expect(coordinator.retryDelivery(result.agentId)).toBe(false);
      });
      expect(coordinator.retryDelivery(result.agentId)).toBe(true);
      expect(mockPi.sendMessage).toHaveBeenCalledOnce();
      expect(result.record.delivery).toMatchObject({ state: "accepted", attempts: 2 });
      expect(result.record.lifecycle.resultConsumed).toBe(true);
      expect(coordinator.retryDelivery(result.agentId)).toBe(false);
      expect(mockPi.sendMessage).toHaveBeenCalledOnce();
    });

    it("abandons pending or failed delivery on parent abort, but cannot retract an accepted handoff", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const parent = new AbortController();
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "abort", graceTurns: 6, runInBackground: true, signal: parent.signal,
      });
      result.record.lifecycle.status = "completed";
      coordinator.onAgentComplete(result.record);
      parent.abort();
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect(result.record.delivery?.state).toBe("abandoned");
      expect((coordinator as any).backgroundParentAborts.size).toBe(0);

      const acceptedParent = new AbortController();
      const accepted = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "accepted", graceTurns: 6, runInBackground: true, signal: acceptedParent.signal,
      });
      accepted.record.lifecycle.status = "completed";
      mockPi.sendMessage.mockReset();
      coordinator.onAgentComplete(accepted.record);
      vi.advanceTimersByTime(200);
      expect(accepted.record.delivery?.state).toBe("accepted");
      acceptedParent.abort();
      expect(accepted.record.delivery?.state).toBe("accepted");
      expect(mockPi.sendMessage).toHaveBeenCalledOnce();
    });

    it("marks pending records abandoned when dispose races completion and leaves no timer or listener tracking", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const parent = new AbortController();
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "dispose", graceTurns: 6, runInBackground: true, signal: parent.signal,
      });
      coordinator.dispose();
      result.record.lifecycle.status = "completed";
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(500);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect(result.record.delivery?.state).toBe("abandoned");
      expect((coordinator as any).pendingNudges.size).toBe(0);
      expect((coordinator as any).backgroundParentAborts.size).toBe(0);
      expect((coordinator as any).autoNudgeIssued.size).toBe(0);
    });

    it("clears failed-delivery parent tracking when retention evicts its record", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const parent = new AbortController();
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "evict", graceTurns: 6, runInBackground: true, signal: parent.signal,
      });
      result.record.lifecycle.status = "completed";
      mockGetPiInstance.mockReturnValue(null);
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);
      expect(result.record.delivery?.state).toBe("failed");
      expect((coordinator as any).backgroundParentAborts.has(result.agentId)).toBe(true);

      coordinator.onRecordEvicted(result.record);
      expect((coordinator as any).backgroundParentAborts.has(result.agentId)).toBe(false);
      expect((coordinator as any).autoNudgeIssued.has(result.agentId)).toBe(false);
    });

    it("cleans failed-delivery parent tracking when only its manager is disposed", async () => {
      const realManager = new AgentManager(undefined, { default: 1 });
      const coordinator = new SpawnCoordinator(realManager);
      realManager.setOnComplete((record) => coordinator.onAgentComplete(record));
      realManager.setOnRecordEvicted((record) => coordinator.onRecordEvicted(record));
      const parent = new AbortController();
      const removeListener = vi.spyOn(parent.signal, "removeEventListener");
      mockRunAgent.mockResolvedValueOnce({
        responseText: "done",
        session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() },
        aborted: false,
        turnLimited: false,
      });
      mockGetPiInstance.mockReturnValue(null);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "manager shutdown", graceTurns: 6, runInBackground: true, signal: parent.signal,
      });
      await result.record.execution.promise;
      vi.advanceTimersByTime(200);
      expect(result.record.delivery?.state).toBe("failed");
      expect((coordinator as any).backgroundParentAborts.has(result.agentId)).toBe(true);

      realManager.dispose();

      expect((coordinator as any).backgroundParentAborts.has(result.agentId)).toBe(false);
      expect((coordinator as any).autoNudgeIssued.has(result.agentId)).toBe(false);
      expect(removeListener).toHaveBeenCalledTimes(2);
    });
  });
});
