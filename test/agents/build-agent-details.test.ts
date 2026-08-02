/**
 * build-agent-details.test.ts — Tests for the buildAgentDetails helper.
 *
 * buildAgentDetails consolidates the stats/details Record<string, unknown>
 * construction that was previously duplicated across emitIndividualNudge,
 * executeSpawnForeground, and executeSpawnBackground.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRecord } from "../../src/types.js";

// buildAgentDetails is a pure function. tool-execution.ts's runtime import
// chain (types, agent-types, usage, worktree-validator, utils, shell ->
// config-store) never reaches npm packages at runtime — no mocks needed.

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("buildAgentDetails", () => {
  let buildAgentDetails: typeof import("../../src/agents/tool-execution.js").buildAgentDetails;

  beforeEach(async () => {
    const mod = await import("../../src/agents/tool-execution.js");
    buildAgentDetails = mod.buildAgentDetails;
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
      hierarchy: { depth: 1, childIds: [], delegateTo: [], maxChildAgents: 0, agentCatalog: new Map() },
      stats: {
        lifetimeUsage: { input: 100, output: 200, cacheWrite: 50, cost: 0.01 },
        toolUses: 5,
        turnCount: 10,
        maxTurns: 25,
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

  it("accepts legacy AgentRecord shapes without hierarchy", () => {
    const record: AgentRecord = {
      id: "legacy-id",
      lifecycle: { status: "completed", startedAt: 1000, completedAt: 2000 },
      display: { type: "builder", description: "Legacy record" },
      execution: {},
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
        cacheRead: 0,
      },
    };

    expect(buildAgentDetails(record, { includeStatus: true })).toMatchObject({
      type: "builder",
      description: "Legacy record",
      depth: 1,
    });
  });

  it("returns only type and description when no options given", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record);

    expect(details.type).toBe("builder");
    expect(details.description).toBe("Build something");
    // Should NOT include stats or status fields
    expect(details.turnCount).toBeUndefined();
    expect(details.status).toBeUndefined();
    expect(details.input).toBeUndefined();
    expect(details.output).toBeUndefined();
  });

  it("returns only two keys when no options given", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record);
    expect(Object.keys(details)).toEqual(["type", "description"]);
  });

  // --- includeStats ---

  it("exposes parent/depth/waiting-child hierarchy in result details", () => {
    const record = makeRecord({
      hierarchy: { depth: 2, parentId: "parent-id", childIds: ["child-id"], waitingOnChildId: "child-id", delegateTo: [], maxChildAgents: 0, agentCatalog: new Map() },
    });
    const details = buildAgentDetails(record, { includeStatus: true });
    expect(details.depth).toBe(2);
    expect(details.parentId).toBe("parent-id");
    expect(details.waitingOnChildId).toBe("child-id");
  });

  it("includes stats fields when includeStats is true", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.type).toBe("builder");
    expect(details.description).toBe("Build something");
    expect(details.turnCount).toBeDefined();
    expect(details.maxTurns).toBeDefined();
    expect(details.toolUses).toBe(5);
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
      stats: { lifetimeUsage: { input: 1000, output: 2000, cacheWrite: 500, cost: 0.05 }, toolUses: 5, compactionCount: 1, cacheRead: 0, turnCount: 10, maxTurns: 25 },
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

  it("includes status and outputFile when includeStatus is true", () => {
    const record = makeRecord({ lifecycle: { status: "completed", startedAt: 1000, completedAt: 5000 }, display: { type: "builder", description: "Build something", outputFile: "/tmp/out.log" } });
    const details = buildAgentDetails(record, { includeStatus: true });

    expect(details.status).toBe("completed");
    expect(details.outputFile).toBe("/tmp/out.log");
    // Stats should NOT be included
    expect(details.turnCount).toBeUndefined();
    expect(details.tokens).toBeUndefined();
  });

  // --- Both options ---

  it("includes both stats and status when both options are true", () => {
    const record = makeRecord({ lifecycle: { status: "error", startedAt: 1000, completedAt: 5000 }, display: { type: "builder", description: "Build something", outputFile: "/tmp/err.log" } });
    const details = buildAgentDetails(record, { includeStats: true, includeStatus: true });

    expect(details.status).toBe("error");
    expect(details.outputFile).toBe("/tmp/err.log");
    expect(details.input).toBeDefined();
    expect(details.output).toBeDefined();
    expect(details.durationMs).toBeDefined();
    expect(details.toolUses).toBe(5);
  });

  // --- turnCount from record ---

  it("uses record.turnCount for details", () => {
    const record = makeRecord({ stats: { lifetimeUsage: { input: 100, output: 200, cacheWrite: 50, cost: 0.01 }, toolUses: 5, turnCount: 42, maxTurns: 25, compactionCount: 1, cacheRead: 0 } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.turnCount).toBe(42);
  });

  // --- Edge cases ---

  it("handles record with no invocation", () => {
    const record = makeRecord({ display: { type: "builder", description: "Build something" } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.modelName).toBeUndefined();
  });

  it("handles zero lifetimeUsage", () => {
    const record = makeRecord({
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 5, compactionCount: 1, cacheRead: 0, turnCount: 10, maxTurns: 25 },
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
