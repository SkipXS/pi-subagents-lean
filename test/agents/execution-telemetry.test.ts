import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import {
  ExecutionTelemetry,
  MAX_COMPACTION_REASON_TEXT_BYTES,
  MAX_RETAINED_COMPACTION_REASONS,
} from "../../src/agents/execution-telemetry.js";
import { utf8ByteLength } from "../../src/utils.js";

function makeRecord(session: any = {}): AgentRecord {
  return {
    id: "agent-1",
    lifecycle: { status: "running", startedAt: 1, settled: false },
    display: { type: "scout", description: "Scout" },
    execution: { session },
    stats: {
      lifetimeUsage: { input: 10, output: 2, cacheWrite: 1, cost: 0.1 },
      cacheRead: 3,
      compactionCount: 1,
      executions: [{
        id: "execution-1",
        prompt: "task",
        mode: "foreground",
        status: "running",
        startedAt: 1,
      }],
    },
  };
}

describe("ExecutionTelemetry", () => {
  it("tracks baselines, cache-hit rates, deltas, and stale callbacks", () => {
    const record = makeRecord();
    const telemetry = new ExecutionTelemetry((candidate) => candidate === record);
    telemetry.initializeRecord(record);
    const baseline = telemetry.beginExecution("execution-1", record);
    const onAssistantUsage = vi.fn();
    const callbacks = telemetry.createCallbacks(record, { onAssistantUsage }, "execution-1");

    callbacks.onAssistantUsage({ input: 20, output: 4, cacheWrite: 2, cacheRead: 10, cost: 0.2 });
    callbacks.onSupplementalUsage({ input: 5, output: 1, cacheWrite: 0, cacheRead: 2, cost: 0.05 });
    record.stats.compactionCount++;

    expect(onAssistantUsage).toHaveBeenCalledOnce();
    expect(record.stats.lifetimeUsage).toMatchObject({ input: 35, output: 7, cacheWrite: 3 });
    expect(record.stats.lifetimeUsage.cost).toBeCloseTo(0.35);
    expect(record.stats.cacheRead).toBe(15);
    expect(record.stats.latestCacheHitRate).toBeCloseTo((15 / 53) * 100);
    expect(telemetry.delta(record, "execution-1", baseline)).toMatchObject({
      usage: { input: 25, output: 5, cacheWrite: 2, cacheRead: 12 },
      compactionCount: 1,
    });
    expect(telemetry.delta(record, "execution-1", baseline)!.usage.cost).toBeCloseTo(0.25);

    record.stats.executions!.push({
      id: "execution-2", prompt: "next", mode: "foreground", status: "running", startedAt: 2,
    });
    callbacks.onAssistantUsage({ input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    expect(record.stats.lifetimeUsage.input).toBe(35);
    expect(onAssistantUsage).toHaveBeenCalledOnce();
  });

  it("bounds newest compaction metadata and caps nested multibyte strings without changing fields", () => {
    const huge = "界".repeat(5_000);
    const record = makeRecord();
    record.stats.compactionReasons = [{
      reason: "threshold",
      tokensBefore: 1,
      summary: huge,
      error: huge,
      nested: { text: huge, count: 7 },
    } as any];
    const telemetry = new ExecutionTelemetry((candidate) => candidate === record);
    telemetry.initializeRecord(record);

    const existing = record.stats.compactionReasons![0] as any;
    for (const value of [existing.summary, existing.error, existing.nested.text]) {
      expect(utf8ByteLength(value)).toBeLessThanOrEqual(MAX_COMPACTION_REASON_TEXT_BYTES);
      expect(value).toContain("[TRUNCATED]");
    }
    expect(existing.nested.count).toBe(7);

    const callbacks = telemetry.createCallbacks(record, {}, "execution-1");
    for (let index = 0; index < MAX_RETAINED_COMPACTION_REASONS + 2; index++) {
      callbacks.onCompaction({ reason: "threshold", tokensBefore: index + 1 });
    }

    const reasons = record.stats.compactionReasons!;
    expect(reasons).toHaveLength(MAX_RETAINED_COMPACTION_REASONS);
    expect(reasons[0]!.tokensBefore).toBe(3);
    expect(reasons.at(-1)!.tokensBefore).toBe(MAX_RETAINED_COMPACTION_REASONS + 2);
  });

  it("caps compaction summary, boundary id, and leaf id at UTF-8 byte boundaries", () => {
    const huge = "😀界".repeat(4_000);
    const session = {
      sessionManager: {
        getLeafEntry: () => ({
          type: "compaction",
          id: huge,
          tokensBefore: 900,
          summary: huge,
          firstKeptEntryId: huge,
        }),
      },
    };
    const record = makeRecord(session);
    const telemetry = new ExecutionTelemetry((candidate) => candidate === record);
    telemetry.initializeRecord(record);
    const callbacks = telemetry.createCallbacks(record, {}, "execution-1");

    callbacks.onCompaction({
      reason: "threshold",
      tokensBefore: 900,
      summary: huge,
      firstKeptEntryId: huge,
    });

    const metadata = record.stats.compactionReasons![0]!;
    for (const key of ["summary", "firstKeptEntryId", "entryId"] as const) {
      const value = metadata[key]!;
      expect(utf8ByteLength(value)).toBeLessThanOrEqual(MAX_COMPACTION_REASON_TEXT_BYTES);
      expect(value).toContain("[TRUNCATED]");
    }
  });

  it("persists context snapshots and compaction metadata through guarded callbacks", () => {
    const session = {
      getContextUsage: () => ({ percent: 42, contextWindow: 128_000 }),
      model: { provider: "anthropic", contextWindow: 128_000 },
      autoCompactionEnabled: true,
      modelRuntime: { isUsingOAuth: () => true },
      sessionManager: {
        getLeafEntry: () => ({ type: "compaction", id: "entry-1", tokensBefore: 900 }),
      },
    };
    const record = makeRecord(session);
    const telemetry = new ExecutionTelemetry((candidate) => candidate === record);
    telemetry.initializeRecord(record);
    const onCompaction = vi.fn();
    const callbacks = telemetry.createCallbacks(record, { onCompaction }, "execution-1");

    telemetry.observeContext(record);
    callbacks.onCompaction({ reason: "threshold", tokensBefore: 900 });

    expect(record.stats.contextStats).toMatchObject({ current: 42, lastKnown: 42, peak: 42, window: 128_000, count: 2 });
    expect(record.stats.contextPercent).toBe(42);
    expect(record.stats.contextWindow).toBe(128_000);
    expect(record.stats.autoCompactionEnabled).toBe(true);
    expect(record.stats.usingSubscription).toBe(true);
    expect(record.stats.compactionReasons).toEqual([{
      reason: "threshold",
      tokensBefore: 900,
      entryId: "entry-1",
    }]);
    expect(onCompaction).toHaveBeenCalledWith({ reason: "threshold", tokensBefore: 900 });
  });
});
