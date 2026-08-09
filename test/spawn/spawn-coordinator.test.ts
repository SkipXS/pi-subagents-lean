import { describe, expect, it, vi } from "vitest";
import { resolvedSpawnFixture } from "../fixtures.ts";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import type { AgentRecord } from "../../src/types.js";
import { createSubagentRuntimeContext, runWithSubagentRuntime } from "../../src/shell.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function recordWithPromise(promise: Promise<string>): AgentRecord {
  return {
    id: "canonical-agent-id",
    lifecycle: { status: "running", startedAt: Date.now(), settled: false },
    display: { type: "reviewer", description: "review" },
    execution: { promise },
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      cacheRead: 0,
      currentExecution: { id: "execution", prompt: "prompt", kind: "new", status: "running", startedAt: Date.now() },
    },
  };
}

describe("SpawnCoordinator foreground boundary", () => {
  it("publishes accepted metadata before awaiting the exact caller promise", async () => {
    const execution = deferred<string>();
    const record = recordWithPromise(execution.promise);
    const manager = {
      spawn: vi.fn(() => record.id),
      getRecord: vi.fn(() => record),
      continueAgent: vi.fn(),
      releaseExecutionPromise: vi.fn(() => true),
    };
    const coordinator = new SpawnCoordinator(manager);
    const accepted = vi.fn();
    const pending = coordinator.spawn({} as any, {} as any, resolvedSpawnFixture(), accepted);

    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(record);
    expect(pending).toBeInstanceOf(Promise);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    execution.resolve("the complete response");
    await expect(pending).resolves.toMatchObject({
      agentId: record.id,
      record,
      responseText: "the complete response",
    });
    expect(manager.releaseExecutionPromise).toHaveBeenCalledWith(record, execution.promise);
  });

  it("handles a completion-before-coordinator-observation race", async () => {
    const execution = Promise.resolve("already complete");
    const record = recordWithPromise(execution);
    record.lifecycle.status = "completed";
    record.lifecycle.settled = true;
    const manager = {
      spawn: vi.fn(() => record.id),
      getRecord: vi.fn(() => record),
      continueAgent: vi.fn(),
      releaseExecutionPromise: vi.fn(() => true),
    };
    const result = await new SpawnCoordinator(manager).spawn({} as any, {} as any, resolvedSpawnFixture());
    expect(result.responseText).toBe("already complete");
  });

  it("rejects root spawning from a child runtime", async () => {
    const manager = {
      spawn: vi.fn(() => "child-id"),
      getRecord: vi.fn(),
      continueAgent: vi.fn(),
      releaseExecutionPromise: vi.fn(),
    };
    const coordinator = new SpawnCoordinator(manager);
    await runWithSubagentRuntime(createSubagentRuntimeContext(), async () => {
      await expect(coordinator.spawn({} as any, {} as any, resolvedSpawnFixture()))
        .rejects.toThrow("unavailable from a child runtime");
    });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("rejects an accepted spawn whose record is no longer retained", async () => {
    const manager = {
      spawn: vi.fn(() => "missing-id"),
      getRecord: vi.fn(() => undefined),
      continueAgent: vi.fn(),
      releaseExecutionPromise: vi.fn(),
    };
    await expect(new SpawnCoordinator(manager).spawn({} as any, {} as any, resolvedSpawnFixture()))
      .rejects.toThrow("was not retained after acceptance");
  });

  it("returns a retained result without a caller promise and isolates renderer cleanup", async () => {
    const record = recordWithPromise(Promise.resolve("ignored"));
    record.execution.promise = undefined;
    record.result = "retained response";
    const manager = {
      spawn: vi.fn(() => record.id),
      getRecord: vi.fn(() => record),
      continueAgent: vi.fn(),
      releaseExecutionPromise: vi.fn(() => { throw new Error("cleanup raced"); }),
    };
    const result = await new SpawnCoordinator(manager).spawn(
      {} as any,
      {} as any,
      resolvedSpawnFixture(),
      () => { throw new Error("renderer detached"); },
    );
    expect(result.responseText).toBe("retained response");
    expect(manager.releaseExecutionPromise).not.toHaveBeenCalled();
  });

  it("isolates continuation renderer callbacks and release failures", async () => {
    const continuation = Promise.resolve("continued");
    const record = recordWithPromise(continuation);
    const manager = {
      spawn: vi.fn(),
      getRecord: vi.fn(() => record),
      continueAgent: vi.fn(() => ({ executionId: "continuation", record, promise: continuation })),
      releaseExecutionPromise: vi.fn(() => { throw new Error("release raced"); }),
    };
    const result = await new SpawnCoordinator(manager).continueAgent(
      { agentId: record.id, prompt: "follow up" },
      () => { throw new Error("renderer detached"); },
    );
    expect(result.responseText).toBe("continued");
    expect(manager.releaseExecutionPromise).toHaveBeenCalledWith(record, continuation);
  });

  it("does not release a newer promise after an older foreground call settles", async () => {
    const oldExecution = deferred<string>();
    const newerExecution = deferred<string>();
    const record = recordWithPromise(oldExecution.promise);
    const manager = {
      spawn: vi.fn(() => record.id),
      getRecord: vi.fn(() => record),
      continueAgent: vi.fn(),
      releaseExecutionPromise: vi.fn((candidate: AgentRecord, promise: Promise<string>) => {
        if (candidate.execution.promise !== promise) return false;
        candidate.execution.promise = undefined;
        return true;
      }),
    };
    const pending = new SpawnCoordinator(manager).spawn({} as any, {} as any, resolvedSpawnFixture());
    record.execution.promise = newerExecution.promise;
    oldExecution.resolve("old response");
    await expect(pending).resolves.toMatchObject({ responseText: "old response" });
    expect(record.execution.promise).toBe(newerExecution.promise);
    expect(manager.releaseExecutionPromise).toHaveBeenCalledWith(record, oldExecution.promise);
  });

  it("awaits AgentContinue and returns its full response/details record", async () => {
    const continuation = deferred<string>();
    const record = recordWithPromise(continuation.promise);
    record.lifecycle.status = "completed";
    record.lifecycle.settled = true;
    const manager = {
      spawn: vi.fn(),
      getRecord: vi.fn(() => record),
      continueAgent: vi.fn(() => ({ executionId: "continuation-id", record, promise: continuation.promise })),
      releaseExecutionPromise: vi.fn(() => true),
    };
    const accepted = vi.fn();
    const pending = new SpawnCoordinator(manager).continueAgent(
      { agentId: "canonical-agent-id", prompt: "follow up" },
      accepted,
    );
    expect(accepted).toHaveBeenCalledWith(record);
    continuation.resolve("complete continuation");
    await expect(pending).resolves.toMatchObject({
      executionId: "continuation-id",
      record,
      responseText: "complete continuation",
    });
    expect(manager.releaseExecutionPromise).toHaveBeenCalledWith(record, continuation.promise);
  });

  it("has no delivery or presentation lifecycle surface", () => {
    const manager = {
      spawn: vi.fn(),
      getRecord: vi.fn(),
      continueAgent: vi.fn(),
      releaseExecutionPromise: vi.fn(),
    };
    const coordinator = new SpawnCoordinator(manager);
    expect(coordinator).not.toHaveProperty("dispose");
    expect(coordinator).not.toHaveProperty("onAgentComplete");
    expect(coordinator).not.toHaveProperty(["subscribe", "Delivery", "Activity"].join(""));
  });
});
