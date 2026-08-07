import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SpawnCoordinator } from "../src/spawn/spawn-coordinator.js";
import { buildBackgroundContent } from "../src/spawn/background-delivery.js";
import { resolvedSpawnFixture } from "./fixtures.js";
import type { AgentRecord } from "../src/types.js";

function completedRecord(): AgentRecord {
  return {
    id: "agent-boundary",
    lifecycle: {
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      settled: true,
    },
    display: { type: "scout", description: "boundary" },
    execution: {},
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      cacheRead: 0,
      executions: [{
        id: "execution-boundary",
        prompt: "inspect",
        mode: "foreground",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
      }],
    },
    result: "done",
  };
}

describe("SpawnCoordinator production boundary", () => {
  it("wires retention, observers, and an already-terminal foreground spawn", async () => {
    const record = completedRecord();
    const manager = {
      spawn: vi.fn(() => record.id),
      getRecord: vi.fn(() => record),
      setRetentionProtection: vi.fn(),
      pruneRetainedRecords: vi.fn(() => []),
    };
    const coordinator = new SpawnCoordinator(manager as any);
    const observer = vi.fn();
    const unsubscribe = coordinator.subscribeDeliveryActivity(observer);

    const result = await coordinator.spawn(
      {} as ExtensionAPI,
      {} as ExtensionContext,
      resolvedSpawnFixture({
        type: "scout",
        prompt: "inspect",
        description: "boundary",
        runInBackground: false,
      }),
    );

    expect(result).toEqual({ agentId: record.id, record });
    expect(buildBackgroundContent(
      record,
      record.stats.executions![0]!,
      "new",
      record.result!,
      {},
    )).toContain("Response:");
    expect(record.lifecycle.resultConsumed).toBe(true);
    expect(observer).toHaveBeenCalledWith([]);
    expect(manager.setRetentionProtection).toHaveBeenCalledOnce();

    unsubscribe();
    coordinator.dispose();
  });
});
