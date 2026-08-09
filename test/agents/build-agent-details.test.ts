/**
 * build-agent-details.test.ts — Tests for the buildAgentDetails helper.
 *
 * buildAgentDetails consolidates the stats/details Record<string, unknown>
 * construction that was previously duplicated across emitIndividualNudge,
 * the Agent and AgentContinue result paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRecord } from "../../src/types.js";

// buildAgentDetails is a pure function. agent-details.ts's runtime import
// chain (types, execution-display, usage) never reaches npm packages at
// runtime — no mocks needed.

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("buildAgentDetails", () => {
  let buildAgentDetails: typeof import("../../src/agents/agent-details.js").buildAgentDetails;

  beforeEach(async () => {
    const mod = await import("../../src/agents/agent-details.js");
    buildAgentDetails = mod.buildAgentDetails;
  });

  it("remains available from the legacy tool-execution import path", async () => {
    const legacyModule = await import("../../src/agents/tool-execution.js");
    expect(legacyModule.buildAgentDetails).toBe(buildAgentDetails);
  });

  /** Helper to build a minimal AgentRecord for testing. */
  function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
    const base: AgentRecord = {
      id: "test-id-123",
      lifecycle: {
        status: "completed",
        startedAt: 1000,
        completedAt: 5000,
      },
      display: {
        type: "builder",
        description: "Build something",
      },
      execution: {},
      stats: {
        lifetimeUsage: { input: 100, output: 200, cacheWrite: 50, cost: 0.01 },
        compactionCount: 1,
        cacheRead: 75,
        latestCacheHitRate: 50,
        contextWindow: 128000,
        autoCompactionEnabled: true,
        usingSubscription: true,
      },
    };
    // Deep merge overrides into the base record
    return {
      ...base,
      ...overrides,
      lifecycle: { ...base.lifecycle, ...overrides.lifecycle },
      display: { ...base.display, ...overrides.display },
      execution: { ...base.execution, ...overrides.execution },
      stats: { ...base.stats, ...overrides.stats },
    } as AgentRecord;
  }

  // --- Baseline: no options (minimal) ---

  it("accepts flat AgentRecord shapes", () => {
    const record: AgentRecord = {
      id: "legacy-id",
      lifecycle: { status: "completed", startedAt: 1000, completedAt: 2000 },
      display: { type: "builder", description: "Legacy record" },
      execution: {},
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
        cacheRead: 0,
      },
    };

    expect(buildAgentDetails(record, { includeStatus: true })).toMatchObject({
      agentId: "legacy-id",
      type: "builder",
      description: "Legacy record",
    });
  });

  it("always includes the canonical agent ID", () => {
    const record = makeRecord();

    expect(buildAgentDetails(record).agentId).toBe("test-id-123");
    expect(buildAgentDetails(record, { includeStatus: true }).agentId).toBe("test-id-123");
    expect(buildAgentDetails(record, { includeStats: true }).agentId).toBe("test-id-123");
  });

  it("returns only identity, type, and description when no options given", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record);

    expect(details.agentId).toBe("test-id-123");
    expect(details.type).toBe("builder");
    expect(details.description).toBe("Build something");
    // Should NOT include stats or status fields
    expect(details.status).toBeUndefined();
    expect(details.input).toBeUndefined();
    expect(details.output).toBeUndefined();
    expect(Object.keys(details)).toEqual(["agentId", "type", "description"]);
  });

  // --- includeStats ---

  it("includes stats fields when includeStats is true", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.type).toBe("builder");
    expect(details.description).toBe("Build something");
    expect(details.input).toBeDefined();
    expect(details.output).toBeDefined();
    expect(details.cost).toBe(0.01);
    expect(details.contextPercent).toBeNull();
    expect(details.contextWindow).toBe(128000);
    expect(details.autoCompactionEnabled).toBe(true);
    expect(details.usingSubscription).toBe(true);
    expect(details.cacheRead).toBe(75);
    expect(details.cacheWrite).toBe(50);
    expect(details.latestCacheHitRate).toBe(50);
    expect(details.durationMs).toBeDefined();
    expect(details.compactions).toBe(1);
    expect(details.modelName).toBeUndefined(); // no invocation set
  });

  it("prefers the explicit current window over historical context telemetry", () => {
    const getContextUsage = vi.fn(() => {
      throw new Error("terminal session should not be read");
    });
    const record = makeRecord({
      execution: { session: { getContextUsage } as any },
      stats: {
        ...makeRecord().stats,
        contextWindow: 272_000,
        contextStats: { current: 40, lastKnown: 40, peak: 40, window: 128_000, count: 1 },
      },
    });

    const details = buildAgentDetails(record, { includeStats: true });
    expect(details.contextWindow).toBe(272_000);
    expect(getContextUsage).not.toHaveBeenCalled();
  });

  it("computes input and output from lifetimeUsage", () => {
    const record = makeRecord({
      stats: { lifetimeUsage: { input: 1000, output: 2000, cacheWrite: 500, cost: 0.05 }, compactionCount: 1, cacheRead: 0 },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.input).toBe(1000);
    expect(details.output).toBe(2000);
  });

  it("computes durationMs as completedAt - startedAt", () => {
    const record = makeRecord({ lifecycle: { status: "completed", startedAt: 1000, completedAt: 5000 } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.durationMs).toBe(4000);
  });

  it("sets durationMs to 0 when completedAt is undefined", () => {
    const record = makeRecord({ lifecycle: { status: "completed", startedAt: 1000, completedAt: undefined } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.durationMs).toBe(0);
  });

  it("includes modelName and thinkingLevel from invocation", () => {
    const record = makeRecord({ display: { type: "builder", description: "Build something", invocation: { modelName: "haiku", thinkingLevel: "high" } } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.modelName).toBe("haiku");
    expect(details.thinkingLevel).toBe("high");
  });

  it("uses the session thinking level over stale invocation metadata", () => {
    const record = makeRecord({
      display: { type: "builder", description: "Build something", invocation: { thinkingLevel: "high" } },
      execution: { session: { thinkingLevel: "low" } as any },
    });

    expect(buildAgentDetails(record, { includeStats: true }).thinkingLevel).toBe("low");
  });

  // --- includeStatus ---

  it("includes status without exposing a child transcript path", () => {
    const record = makeRecord({ lifecycle: { status: "completed", startedAt: 1000, completedAt: 5000 } });
    const details = buildAgentDetails(record, { includeStatus: true });

    expect(details.status).toBe("completed");
    expect(details[["output", "File"].join("")]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(details, ["output", "File"].join(""))).toBe(false);
    // Stats should NOT be included
    expect(details.tokens).toBeUndefined();
  });

  // --- Both options ---

  it("keeps status, telemetry, model, thinking, duration, and worktree without a transcript path", () => {
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: 1000, completedAt: 5000 },
      display: {
        type: "builder",
        description: "Build something",
        invocation: { modelName: "sonnet", thinkingLevel: "high" },
        worktreePath: "/worktrees/build",
      },
    });
    const details = buildAgentDetails(record, { includeStats: true, includeStatus: true });

    expect(details.status).toBe("error");
    expect(details[["output", "File"].join("")]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(details, ["output", "File"].join(""))).toBe(false);
    expect(details.input).toBe(100);
    expect(details.output).toBe(200);
    expect(details.contextWindow).toBe(128000);
    expect(details.compactions).toBe(1);
    expect(details.modelName).toBe("sonnet");
    expect(details.thinkingLevel).toBe("high");
    expect(details.durationMs).toBe(4000);
    expect(details.worktreePath).toBe("/worktrees/build");
  });

  // --- per-execution continuation deltas ---

  it("reports the exact current continuation projection instead of cumulative totals", () => {
    const record = makeRecord({
      stats: {
        ...makeRecord().stats,
        currentExecution: {
          id: "exec-1", prompt: "follow-up", kind: "continued", status: "completed",
          startedAt: 3000, completedAt: 4000, responseText: "follow-up",
          usage: { input: 40, output: 15, cacheWrite: 5, cacheRead: 20, cost: 0.02 },
          compactionCount: 2,
        },
      },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    // Continuation top-level fields come from the exact execution summary...
    expect(details.input).toBe(40);
    expect(details.output).toBe(15);
    expect(details.cacheRead).toBe(20);
    expect(details.cacheWrite).toBe(5);
    expect(details.cost).toBeCloseTo(0.02);
    expect(details.compactions).toBe(2);
    expect(details.compactionCount).toBe(2);
    expect(details.durationMs).toBe(1000);
    // ...never the cumulative record totals.
    expect(details.input).not.toBe(record.stats.lifetimeUsage.input);
    expect(details.cost).not.toBe(record.stats.lifetimeUsage.cost);
    // The current execution block mirrors the summary without ids or history.
    expect(details.currentExecution).toMatchObject({
      status: "completed",
      responseText: "follow-up",
      usage: { input: 40, output: 15, cacheWrite: 5, cacheRead: 20, cost: 0.02 },
      compactionCount: 2,
    });
    expect((details.currentExecution as Record<string, unknown>).id).toBeUndefined();
    expect(details.executions).toBeUndefined();
  });

  it("keeps lifetime-cumulative usage fields for the initial spawn execution", () => {
    const record = makeRecord({
      stats: {
        ...makeRecord().stats,
        currentExecution: {
          id: "exec-0", prompt: "initial", kind: "new", status: "completed",
          startedAt: 1000, completedAt: 5000, responseText: "initial",
          usage: { input: 100, output: 200, cacheWrite: 50, cacheRead: 75, cost: 0.01 },
          compactionCount: 1,
        },
      },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.input).toBe(100);
    expect(details.output).toBe(200);
    expect(details.cacheRead).toBe(75);
    expect(details.cacheWrite).toBe(50);
    expect(details.cost).toBeCloseTo(0.01);
    expect(details.compactions).toBe(1);
    expect(details.compactionCount).toBe(1);
    expect(details.currentExecution).toMatchObject({
      status: "completed", compactionCount: 1,
    });
  });

  it("falls back to cumulative totals when the current execution has no summary yet", () => {
    const record = makeRecord({
      stats: {
        ...makeRecord().stats,
        currentExecution: {
          id: "exec-1", prompt: "follow-up", kind: "continued", status: "running",
          startedAt: 3000,
        },
      },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    // A running execution has no finalized summary; keep the cumulative
    // fallback rather than exposing partial or undefined stats.
    expect(details.input).toBe(100);
    expect(details.cost).toBeCloseTo(0.01);
    expect(details.currentExecution).toMatchObject({ status: "running" });
  });

  // --- Edge cases ---

  it("handles record with no invocation", () => {
    const record = makeRecord({ display: { type: "builder", description: "Build something" } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.modelName).toBeUndefined();
  });

  it("handles zero lifetimeUsage", () => {
    const record = makeRecord({
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, compactionCount: 1, cacheRead: 0 },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.input).toBe(0);
    expect(details.output).toBe(0);
    expect(details.cost).toBe(0);
  });

  // --- worktreePath in details ---

  it("includes worktreePath when record has it set", () => {
    const record = makeRecord({
      display: { type: "builder", description: "Build something", worktreePath: "/wt/feature" },
    });
    const details = buildAgentDetails(record);

    expect(details.worktreePath).toBe("/wt/feature");
  });

  it("does not include worktreePath when record has none", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record);

    expect(details.worktreePath).toBeUndefined();
  });
});
