/**
 * spawn-coordinator.test.ts — Tests for SpawnCoordinator.

 * Verifies: spawn (foreground/background), delayed individual nudges, completion delivery,
 * onAgentComplete, dispose, stale pi protection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/types.js";
import { AgentManager } from "../../src/agents/agent-manager.js";

// --- Mock modules ---

const { mockAgentConfig, mockRunAgent, mockExecuteAgentTurn } = vi.hoisted(() => ({
  mockAgentConfig: vi.fn(() => undefined),
  mockRunAgent: vi.fn(),
  mockExecuteAgentTurn: vi.fn(),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  snapshotAgentConfig: vi.fn((config: any) => ({
    ...config,
    registeredTools: config.registeredTools && [...config.registeredTools],
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    extensions: Array.isArray(config.extensions) ? [...config.extensions] : config.extensions,
    skills: Array.isArray(config.skills) ? [...config.skills] : config.skills,
    excludeSkills: config.excludeSkills && [...config.excludeSkills],
  })),
  getAgentConfig: mockAgentConfig,
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: vi.fn(async () => ({ ok: true, resolvedPath: "/wt", label: "wt" })),
}));

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: mockRunAgent,
  executeAgentTurn: mockExecuteAgentTurn,
}));

vi.mock("../../src/utils.js", () => ({
  findModelInRegistry: vi.fn((_key: unknown, _registry: unknown, fallback: unknown) => fallback),
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

vi.mock("../../src/config/config-io.js", () => ({
  loadConfig: vi.fn(() => ({ agent: { default: null }, concurrency: { default: 4 } })),
  saveConfigAtomic: vi.fn(),
  DEFAULT_CONFIG: { agent: { default: null }, concurrency: { default: 4 } },
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
    createSubagentRuntimeSettings: () => ({ agent: {} }),
  }),
  getPiInstance: () => mockGetPiInstance(),
  getSessionCtx: () => ({ isIdle: mockIsIdle }),
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

          compactionCount: 0,
          executions: [{
            id: `${id}-execution`,
            prompt,
            mode: options.isBackground ? "background" : "foreground",
            status: "running",
            startedAt: Date.now(),
          }],
        },
        result: "done",
      };
      records.set(id, record);
      return id;
    }),
    getRecord: vi.fn((id: string) => records.get(id)),
    listAgents: vi.fn(() => [...records.values()]),
    abort: vi.fn(() => true),
    steer: vi.fn(async () => true),
    continueAgent: vi.fn(),
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

/** Current per-execution delivery entries (test introspection). */
function deliveryEntries(coordinator: any): any[] {
  return [...coordinator.backgroundDeliveries.values()];
}

/** The real manager always supplies the completed execution summary. */
function notifyCompletion(coordinator: any, record: any): void {
  const execution = record.stats.executions?.at(-1);
  if (execution) execution.status = record.lifecycle.status;
  coordinator.onAgentComplete(record, execution);
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
    mockExecuteAgentTurn.mockReset();
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

      runInBackground: true,
      signal,
    });

    expect(manager.spawn.mock.calls[0][4].signal).toBe(signal);
  });

  it("does not retain or nudge a synchronously parent-aborted background spawn", async () => {
    const realManager = new AgentManager(undefined, { default: 1 });
    const coordinator = new SpawnCoordinator(realManager);
    realManager.setOnComplete((record, execution) => coordinator.onAgentComplete(record, execution));
    const parent = new AbortController();
    parent.abort();

    try {
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Already cancelled",

        runInBackground: true,
        signal: parent.signal,
      });

      expect(result.record.lifecycle).toMatchObject({
        status: "stopped",
        stoppedBy: "parent",
        resultConsumed: true,
      });
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
    } as any;

    await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test config snapshot",
      agentConfig: config,

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
    }));
    expect(snapshot).not.toBe(config);
  });

  it("spawns a foreground agent and awaits its promise", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test foreground",

      runInBackground: false,
    });

    expect(result.agentId).toBeTruthy();
    expect(result.record).toBeTruthy();
    expect(manager.spawn.mock.calls[0][4].isBackground).toBe(false);
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

      invocation: { thinkingLevel: "max" },
      runInBackground: true,
    });

    const options = manager.spawn.mock.calls[0][4];
    expect(options.model).toBe(model);
    expect(options.modelKey).toBe("deepseek/deepseek-reasoner");
    expect(options.thinkingLevel).toBe("high");
    expect(options.invocation.thinkingLevel).toBe("high");
  });

  it("tracks a background execution in its delivery entries", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test bg",

      runInBackground: true,
    });

    expect(coordinator.isBackground(result.agentId)).toBe(true);
  });

  it("does not track a foreground execution for background delivery", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test fg",

      runInBackground: false,
    });

    expect(coordinator.isBackground(result.agentId)).toBe(false);
  });

  describe("nudge scheduling", () => {
    it("emits one individual nudge after a short delay", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test",

        runInBackground: true,
      });

      result.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(result.agentId);

      // Not yet emitted — timer pending
      expect(mockPi.sendMessage).not.toHaveBeenCalled();

      // Advance past the 200ms delivery delay
      vi.advanceTimersByTime(200);

      // Now the nudge should have been emitted
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("delivers multiple nudges as individual messages after the delay", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const r1 = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task 1", description: "Test 1", runInBackground: true,
      });
      const r2 = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task 2", description: "Test 2", runInBackground: true,
      });

      r1.record.lifecycle.status = "completed";
      r2.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(r1.agentId);
      coordinator.scheduleNudge(r2.agentId);

      // Advance past the individual delivery delay
      vi.advanceTimersByTime(200);

      // Both should be emitted as individual messages
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("ignores an accidental nudge for a running record and delivers once after completion", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Still running", runInBackground: true,
      });

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect(deliveryEntries(coordinator).some((e) => e.autoNudgeIssued)).toBe(false);

      result.record.lifecycle.status = "completed";
      notifyCompletion(coordinator, result.record);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledOnce();
      expect(result.record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
    });

    it("does not retain tracking or emit a nudge for an agent without a record", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      coordinator.scheduleNudge("agent-999");

      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect((coordinator as any).backgroundDeliveries.size).toBe(0);
    });

    it("delivers a later nudge after its own short delay", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const r1 = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task 1", description: "Test 1", runInBackground: true,
      });
      const r2 = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task 2", description: "Test 2", runInBackground: true,
      });

      r1.record.lifecycle.status = "completed";
      r2.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(r1.agentId);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      // A later execution gets its own delivery delay
      coordinator.scheduleNudge(r2.agentId);

      // Not yet emitted
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("continueAgent", () => {
    function continuedRecord(overrides: Record<string, unknown> = {}): any {
      return {
        id: "agent-x",
        display: { type: "builder", description: "continued" },
        lifecycle: { status: "running", startedAt: Date.now(), settled: false },
        stats: {
          lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
          compactionCount: 0,
        },
        execution: {},
        ...overrides,
      };
    }

    it("awaits the execution delta for a foreground continuation", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const record = continuedRecord();
      let resolveExecution!: (value: string) => void;
      manager.continueAgent.mockReturnValueOnce({
        executionId: "exec-1",
        record,
        promise: new Promise<string>((resolve) => { resolveExecution = resolve; }),
      });

      let settled = false;
      const pending = coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "wrap up", runInBackground: false,
      }).then((result) => { settled = true; return result; });
      await Promise.resolve();
      expect(settled).toBe(false); // foreground callers await the execution

      resolveExecution("final result");
      const result = await pending;
      expect(result.record).toBe(record);
      expect(record.lifecycle.resultConsumed).toBe(true);
      expect((coordinator as any).backgroundDeliveries.has("exec-1")).toBe(false);
    });

    it("acknowledges a background continuation immediately", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const record = continuedRecord();
      manager.continueAgent.mockReturnValueOnce({
        executionId: "exec-1",
        record,
        promise: new Promise<string>(() => {}), // never settles in this test
      });

      const result = await coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "wrap up", runInBackground: true,
      });
      expect(result.record).toBe(record);
      expect(record.delivery).toMatchObject({ state: "pending", attempts: 0 });
      expect(record.lifecycle.resultConsumed).toBe(false);
      expect(coordinator.isBackground("agent-x")).toBe(true);
      expect((coordinator as any).backgroundDeliveries.has("exec-1")).toBe(true);
    });

    it("reconciles a synchronously terminal continuation after claiming its execution id", async () => {
      const realManager = new AgentManager(undefined);
      const coordinator = new SpawnCoordinator(realManager);
      realManager.setOnComplete((record, execution) => coordinator.onAgentComplete(record, execution));
      mockRunAgent.mockResolvedValueOnce({
        responseText: "initial",
        session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() },
        aborted: false,

      });
      mockExecuteAgentTurn.mockReturnValueOnce({
        then: (resolve: (result: { responseText: string; aborted: boolean }) => unknown) => {
          // A conforming thenable may invoke the continuation synchronously;
          // this completes before SpawnCoordinator can install its claim.
          resolve({ responseText: "sync continuation", aborted: false });
          return { catch: () => undefined };
        },
        catch: () => undefined,
      } as any);

      try {
        const id = realManager.spawn(mockPi, ctx, "builder", "initial", { description: "initial" });
        await realManager.getRecord(id)!.execution.promise;
        mockPi.sendMessage.mockReset();

        const result = await coordinator.continueAgent(mockPi, ctx, {
          agentId: id,
          prompt: "follow up",
          runInBackground: true,
        });
        vi.advanceTimersByTime(200);

        expect(mockPi.sendMessage).toHaveBeenCalledOnce();
        expect(mockPi.sendMessage.mock.calls[0]![0].content).toContain("sync continuation");
        expect(result.record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
      } finally {
        realManager.dispose();
      }
    });

    it("delivers a synchronously rejected background continuation exactly once", async () => {
      const realManager = new AgentManager(
        undefined,
        undefined,
        (record) => {
          if ((record.stats.executions?.length ?? 0) > 1) throw new Error("sync start boom");
        },
      );
      const coordinator = new SpawnCoordinator(realManager);
      realManager.setOnComplete((record, execution) => coordinator.onAgentComplete(record, execution));
      mockRunAgent.mockResolvedValueOnce({
        responseText: "initial",
        session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() },
        aborted: false,

      });

      try {
        const id = realManager.spawn(mockPi, ctx, "builder", "initial", { description: "initial" });
        await realManager.getRecord(id)!.execution.promise;
        mockPi.sendMessage.mockReset();

        const result = await coordinator.continueAgent(mockPi, ctx, {
          agentId: id,
          prompt: "fails before turn",
          runInBackground: true,
        });
        vi.advanceTimersByTime(200);

        expect(mockPi.sendMessage).toHaveBeenCalledOnce();
        expect(mockPi.sendMessage.mock.calls[0]![0].details.currentExecution.error).toBe("sync start boom");
        expect(result.record.stats.executions?.at(-1)).toMatchObject({
          status: "error",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          compactionCount: 0,
        });
        expect(result.record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
      } finally {
        realManager.dispose();
      }
    });

    it("delivers exactly one automatic completion per background execution id", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const record = continuedRecord({ result: "bg result" });
      manager.getRecord.mockReturnValue(record);
      manager.continueAgent.mockReturnValueOnce({
        executionId: "exec-1",
        record,
        promise: new Promise<string>(() => {}),
      });
      await coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "wrap up", runInBackground: true,
      });

      record.lifecycle.status = "completed";
      const execution = { id: "exec-1", mode: "background", status: "completed", startedAt: Date.now() };
      coordinator.onAgentComplete(record, execution as any);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-result", content: expect.stringContaining("bg result") }),
        { deliverAs: "followUp", triggerTurn: true },
      );

      // A duplicate completion for the same generation is ignored.
      coordinator.onAgentComplete(record, execution as any);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      // A later continuation with a fresh execution id claims its own delivery.
      const second = continuedRecord({ result: "second bg result" });
      manager.getRecord.mockReturnValue(second);
      manager.continueAgent.mockReturnValueOnce({
        executionId: "exec-2",
        record: second,
        promise: new Promise<string>(() => {}),
      });
      await coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "more", runInBackground: true,
      });
      second.lifecycle.status = "completed";
      coordinator.onAgentComplete(second, { id: "exec-2", mode: "background", status: "completed", startedAt: Date.now() } as any);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
      expect(mockPi.sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: expect.stringContaining("second bg result") }),
        { deliverAs: "followUp", triggerTurn: true },
      );
    });

    it("delivers each same-record continuation's frozen result even when the record moves on", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const record = continuedRecord({ result: "first bg result" });
      manager.getRecord.mockReturnValue(record);
      manager.continueAgent.mockReturnValueOnce({
        executionId: "exec-1",
        record,
        promise: new Promise<string>(() => {}),
      });
      await coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "first", runInBackground: true,
      });
      record.lifecycle.status = "completed";
      coordinator.onAgentComplete(record, { id: "exec-1", mode: "background", status: "completed", startedAt: Date.now() } as any);

      // The same record is continued again BEFORE the first nudge timer fires;
      // the record's mutable result now belongs to the second execution.
      record.result = "second bg result";
      manager.continueAgent.mockReturnValueOnce({
        executionId: "exec-2",
        record,
        promise: new Promise<string>(() => {}),
      });
      await coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "second", runInBackground: true,
      });
      record.lifecycle.status = "completed";
      coordinator.onAgentComplete(record, { id: "exec-2", mode: "background", status: "completed", startedAt: Date.now() } as any);

      // Both timers fire in order; each delivers its own frozen payload. The
      // stale first timer can never send the later execution's result.
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
      const contents = mockPi.sendMessage.mock.calls.map((call) => call[0].content);
      expect(contents[0]).toContain("first bg result");
      expect(contents[0]).not.toContain("second bg result");
      expect(contents[1]).toContain("second bg result");
      expect(contents[1]).not.toContain("first bg result");
      // Exactly one success delivery per execution; the projection reflects
      // the latest execution only.
      expect(record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
      expect(deliveryEntries(coordinator)).toHaveLength(0);
    });

    it("does not mark a failed background handoff as delivered", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const record = continuedRecord({
        result: "bg result",
        stats: {
          lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
          compactionCount: 0,
          executions: [{
            id: "exec-1", mode: "background", status: "running", startedAt: Date.now(),
          }],
        },
      });
      manager.getRecord.mockReturnValue(record);
      manager.continueAgent.mockReturnValueOnce({
        executionId: "exec-1",
        record,
        promise: new Promise<string>(() => {}),
      });
      await coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "wrap up", runInBackground: true,
      });

      record.lifecycle.status = "completed";
      // First attempt fails: no handoff happened, so nothing is marked delivered.
      mockGetPiInstance.mockReturnValue(null);
      coordinator.onAgentComplete(record, { id: "exec-1", mode: "background", status: "completed", startedAt: Date.now() } as any);
      vi.advanceTimersByTime(200);
      expect(record.delivery).toMatchObject({ state: "failed", attempts: 1 });
      expect(record.lifecycle.resultConsumed).toBe(false); // never marked consumed without a handoff
      expect(record.stats.executions![0]!.deliveredText).toBeUndefined();

    });

    it("reports per-execution deltas, not lifetime totals, in background continuation details", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const execution = {
        id: "exec-1", mode: "background", kind: "continued", status: "completed", startedAt: 10_000, completedAt: 11_250,
        responseText: "bg result", compactionCount: 1,
        usage: { input: 20, output: 6, cacheWrite: 1, cacheRead: 4, cost: 0.02 },
      };
      const record = continuedRecord({
        result: "bg result",
        stats: {
          lifetimeUsage: { input: 50, output: 12, cacheWrite: 4, cost: 0.05 },
          compactionCount: 3,
          cacheRead: 9,
          executions: [
            {
              id: "exec-0", prompt: "initial", mode: "foreground", status: "completed",
              startedAt: Date.now(), compactionCount: 2,
              usage: { input: 30, output: 6, cacheWrite: 3, cacheRead: 5, cost: 0.03 },
            },
            execution,
          ],
        },
      });
      manager.getRecord.mockReturnValue(record);
      manager.continueAgent.mockReturnValueOnce({
        executionId: "exec-1",
        record,
        promise: new Promise<string>(() => {}),
      });
      await coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "wrap up", runInBackground: true,
      });

      record.lifecycle.status = "completed";
      coordinator.onAgentComplete(record, execution as any);
      // A later execution may mutate the record before this delivery timer fires.
      record.result = "later result";
      record.stats.executions!.push({
        id: "exec-2", prompt: "later", mode: "foreground", kind: "continued", status: "running", startedAt: 12_000,
      });
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      const message = mockPi.sendMessage.mock.calls[0]![0];
      expect(message.content).toContain("Mode: Background | Run: Continued");
      expect(message.content).toContain("\n\nResponse:\nbg result");
      expect(message.content).not.toContain("later result");
      const details = message.details;
      // The continuation delivery exposes the exact execution summary deltas,
      // never the cumulative lifetime totals on the record.
      expect(details.input).toBe(20);
      expect(details.output).toBe(6);
      expect(details.cacheRead).toBe(4);
      expect(details.cacheWrite).toBe(1);
      expect(details.cost).toBeCloseTo(0.02);
      expect(details.compactions).toBe(1);
      expect(details.compactionCount).toBe(1);
      expect(details.durationMs).toBe(1250);
      expect(details.currentExecution).toMatchObject({
        mode: "background", kind: "continued", status: "completed", compactionCount: 1,
      });
      // No execution ids or history leak into delivery details.
      expect((details.currentExecution as Record<string, unknown>).id).toBeUndefined();
      expect(details.executions).toBeUndefined();
      expect(record.stats.executions![1]!.deliveredText).toBe("bg result");
    });

    it("observes a rejected queued background continuation without an unhandled rejection", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const record = continuedRecord();
      let rejectExecution!: (error: Error) => void;
      const promise = new Promise<string>((_, reject) => { rejectExecution = reject; });
      manager.continueAgent.mockReturnValueOnce({ executionId: "exec-1", record, promise });

      await coordinator.continueAgent(mockPi, ctx, {
        agentId: "agent-x", prompt: "wrap up", runInBackground: true,
      });
      expect(coordinator.isBackground("agent-x")).toBe(true);

      // StopAgent rejects the queued continuation: the coordinator must
      // observe the rejection (never an unhandled rejection) and the
      // execution never runs.
      rejectExecution(new Error("Agent agent-x was stopped"));
      await Promise.resolve();
      expect(manager.continueAgent).toHaveBeenCalledOnce();
      expect((coordinator as any).backgroundDeliveries.has("exec-1")).toBe(true); // claim stays until completion/abandon
    });

    it("reports a queued background continuation stopped before start exactly once and never runs it", async () => {
      const realManager = new AgentManager(undefined, { default: 1 });
      const coordinator = new SpawnCoordinator(realManager);
      realManager.setOnComplete((record, execution) => coordinator.onAgentComplete(record, execution));
      try {
        mockRunAgent.mockResolvedValueOnce({
          responseText: "done",
          session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() },
          aborted: false,

        });
        const firstId = realManager.spawn(mockPi, ctx, "builder", "first", { description: "first" });
        await realManager.getRecord(firstId)!.execution.promise;
        const firstRecord = realManager.getRecord(firstId)!;
        firstRecord.stats.lifetimeUsage = { input: 11, output: 22, cacheWrite: 33, cost: 0.44 };
        firstRecord.stats.cacheRead = 55;
        firstRecord.stats.compactionCount = 8;

        const blocker = new Promise<any>(() => {});
        mockRunAgent.mockReturnValueOnce(blocker);
        realManager.spawn(mockPi, ctx, "builder", "blocker", { description: "blocker" });

        coordinator.continueAgent(mockPi, ctx, {
          agentId: firstId, prompt: "bg follow-up", runInBackground: true,
        });
        const record = realManager.getRecord(firstId)!;
        expect(record.lifecycle.status).toBe("queued");

        realManager.abort(firstId, "agent");
        await Promise.resolve(); // the coordinator observed the rejection
        expect(mockExecuteAgentTurn).not.toHaveBeenCalled(); // never runs
        mockPi.sendMessage.mockClear();
        vi.advanceTimersByTime(200);

        // Exactly one stopped notification for the stopped execution, never
        // the prior execution's result text.
        expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
        const content = mockPi.sendMessage.mock.calls[0]![0].content;
        expect(content).toContain("stopped");
        expect(content).not.toContain("done");
        expect(record.lifecycle).toMatchObject({ status: "stopped", settled: true });
        expect(record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
        expect(record.stats.executions![1]).toMatchObject({
          status: "stopped",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          compactionCount: 0,
        });
        const deliveryDetails = mockPi.sendMessage.mock.calls[0]![0].details;
        expect(deliveryDetails).toMatchObject({
          status: "stopped",
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          compactions: 0,
          compactionCount: 0,
          currentExecution: { status: "stopped", compactionCount: 0 },
        });
        expect(deliveryDetails.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        realManager.dispose();
      }
    });
  });

  describe("onAgentComplete", () => {
    it("schedules nudge for background agents", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", runInBackground: true,
      });

      // Simulate completion
      result.record.lifecycle.status = "completed";
      notifyCompletion(coordinator, result.record);

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

    it("delivers a root completion once even when the manager repeats its completion callback", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "duplicate completion", runInBackground: true,
      });
      result.record.lifecycle.status = "completed";

      notifyCompletion(coordinator, result.record);
      notifyCompletion(coordinator, result.record);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledOnce();
      expect(result.record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
    });

    it("uses steer delivery while the parent session is busy", async () => {
      mockIsIdle.mockReturnValue(false);
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", runInBackground: true,
      });

      result.record.lifecycle.status = "completed";
      notifyCompletion(coordinator, result.record);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-result" }),
        { deliverAs: "steer", triggerTurn: true },
      );
    });

    it("does not schedule nudge for foreground agents", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      // Foreground executions do not claim background delivery entries.

      coordinator.onAgentComplete(
        { id: "agent-1" } as AgentRecord,
        { id: "execution-1", mode: "foreground", status: "completed", startedAt: Date.now() } as any,
      );

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("records sendMessage errors as delivery diagnostics (stale pi)", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", runInBackground: true,
      });

      // Make sendMessage throw (simulates stale pi)
      mockPi.sendMessage.mockImplementation(() => { throw new Error("stale context"); });
      result.record.lifecycle.status = "completed";

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      // sendMessage was attempted once; the failed state is diagnostic until session shutdown.
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(result.record.delivery).toMatchObject({ state: "failed", attempts: 1, lastError: "stale context" });
    });

    it("skips nudge emission when disposed", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", runInBackground: true,
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
        type: "builder", prompt: "task", description: "Test", runInBackground: true,
      });
      result.record.lifecycle.status = "completed";
      coordinator.scheduleNudge(result.agentId);

      coordinator.dispose();

      // Timer should be cleared — advancing time should not emit
      vi.advanceTimersByTime(500);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

  });

  describe("stale pi protection", () => {
    it("reads pi from shell at nudge time, not from spawn", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test", runInBackground: true,
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
        type: "builder", prompt: "task", description: "Test", runInBackground: true,
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

    it("ignores a nudge for an unknown record", () => {
      const coordinator = new SpawnCoordinator(manager as any);

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
      ];

      for (const { status, expected } of statuses) {
        mockPi.sendMessage.mockClear();
        const coordinator = new SpawnCoordinator(manager as any);

        const result = await coordinator.spawn(mockPi, ctx, {
          type: "builder", prompt: "task", description: "Test", runInBackground: true,
        });

        manager.getRecord(result.agentId).lifecycle.status = status;
        manager.getRecord(result.agentId).result = "Result text";

        coordinator.scheduleNudge(result.agentId);
        vi.advanceTimersByTime(200);

        expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
        const content = mockPi.sendMessage.mock.calls[0][0].content;
        const shortId = result.agentId.slice(0, 8);
        expect(content).toContain(`[Subagent "builder" ${shortId} ${expected} | Mode: Background | Run: New]`);
      }
    });
  });

  describe("result consumption", () => {
    it("foreground spawn marks the result as consumed before returning", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "do something", description: "Test fg", runInBackground: false,
      });

      expect(result.record.lifecycle.resultConsumed).toBe(true);
    });

    it("background nudge emission marks the result as consumed", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "Test bg", runInBackground: true,
      });
      const record = manager.getRecord(result.agentId);
      // Reset any sendMessage impl leaked from other tests so this test exercises
      // the success path (default: returns without throwing).
      mockPi.sendMessage.mockReset();

      expect(record.lifecycle.resultConsumed).toBeUndefined();
      record.lifecycle.status = "completed";

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      // sendMessage delivered the full result to the LLM — the delivery entry can be cleared.
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(record.lifecycle.resultConsumed).toBe(true);
    });

    it("marks delivery failed when Pi is unavailable without consuming the result", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "No Pi", runInBackground: true,
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
        type: "builder", prompt: "task", description: "Test bg", runInBackground: true,
      });
      const record = manager.getRecord(result.agentId);

      // sendMessage throws — LLM never received the result, so the failure
      // remains diagnostic until session shutdown.
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
        type: "builder", prompt: "task", description: "Parent abort after complete",
        runInBackground: true, signal: parent.signal,
      });

      notifyCompletion(coordinator, result.record);
      expect(deliveryEntries(coordinator).some((e) => e.agentId === result.agentId && e.signal)).toBe(true);

      parent.abort();
      expect(result.record.lifecycle.resultConsumed).toBe(true);
      expect(deliveryEntries(coordinator).some((e) => e.agentId === result.agentId)).toBe(false);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("abandons background delivery without a nudge after its parent aborts", async () => {
      const realManager = new AgentManager(undefined, { default: 1 });
      const coordinator = new SpawnCoordinator(realManager);
      realManager.setOnComplete((record, execution) => coordinator.onAgentComplete(record, execution));
      const parent = new AbortController();
      const runner = new Promise<any>(() => {});
      mockRunAgent.mockReturnValue(runner);

      try {
        const result = await coordinator.spawn(mockPi, ctx, {
          type: "builder", prompt: "task", description: "Parent abort",
          runInBackground: true, signal: parent.signal,
        });
        parent.abort();

        expect(result.record.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "parent", resultConsumed: true });
        expect(result.record.delivery).toMatchObject({ state: "abandoned" });
        expect(coordinator.isBackground(result.agentId)).toBe(false);
        expect(deliveryEntries(coordinator).some((e) => e.agentId === result.agentId)).toBe(false);

        vi.advanceTimersByTime(200);
        expect(mockPi.sendMessage).not.toHaveBeenCalled();
      } finally {
        realManager.dispose();
      }
    });
  });

    it("abandons pending or failed delivery on parent abort, but cannot retract an accepted handoff", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const parent = new AbortController();
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "abort", runInBackground: true, signal: parent.signal,
      });
      result.record.lifecycle.status = "completed";
      notifyCompletion(coordinator, result.record);
      parent.abort();
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect(result.record.delivery?.state).toBe("abandoned");
      expect((coordinator as any).backgroundDeliveries.size).toBe(0);

      const acceptedParent = new AbortController();
      const accepted = await coordinator.spawn(mockPi, ctx, {
        type: "builder", prompt: "task", description: "accepted", runInBackground: true, signal: acceptedParent.signal,
      });
      accepted.record.lifecycle.status = "completed";
      mockPi.sendMessage.mockReset();
      notifyCompletion(coordinator, accepted.record);
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
        type: "builder", prompt: "task", description: "dispose", runInBackground: true, signal: parent.signal,
      });
      coordinator.dispose();
      result.record.lifecycle.status = "completed";
      notifyCompletion(coordinator, result.record);
      vi.advanceTimersByTime(500);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect(result.record.delivery?.state).toBe("abandoned");
      expect((coordinator as any).backgroundDeliveries.size).toBe(0);
    });


});
