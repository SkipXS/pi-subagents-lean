import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedSpawnFixture, fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";
import { AgentExecutionService, type SpawnExecutionTask } from "../../src/agents/agent-execution-service.js";
import { AgentRecordStore } from "../../src/agents/agent-record-store.js";
import { ExecutionTelemetry } from "../../src/agents/execution-telemetry.js";

const mockModules = vi.hoisted(() => ({
  runAgent: vi.fn(),
  outputLog: vi.fn().mockImplementation((id: string) => ({
    path: `/private/${id}.log`,
    append: vi.fn(),
    attach: vi.fn(),
    finalize: vi.fn(),
  })),
  releaseOutputRoot: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/agents/agent-runner.js", () => ({ runAgent: mockModules.runAgent }));
vi.mock("../../src/agents/output-file.js", () => ({
  AgentOutputLog: mockModules.outputLog,
  createOutputRoot: vi.fn(() => "/private"),
  releaseOutputRoot: mockModules.releaseOutputRoot,
}));

function session(): any {
  return { messages: [], subscribe: vi.fn(), dispose: vi.fn() };
}

function runResult(): { responseText: string; session: any; aborted: boolean } {
  return { responseText: "done", session: session(), aborted: false };
}

describe("AgentExecutionService", () => {
  beforeEach(() => {
    mockModules.releaseOutputRoot.mockClear();
  });

  it("removes a queued task on parent abort without consuming a slot", async () => {
    mockModules.runAgent.mockReset();
    const blocker = makeResolvablePromise();
    mockModules.runAgent.mockReturnValueOnce(blocker.promise);
    const store = new AgentRecordStore();
    const telemetry = new ExecutionTelemetry((record) => store.get(record.id) === record);
    const service = new AgentExecutionService({ store, telemetry, concurrency: 1 });

    const first = acceptedSpawnFixture({ prompt: "first", runInBackground: true });
    const firstCreated = store.createSpawnRecord(first, "running", new AbortController());
    telemetry.initializeRecord(firstCreated.record);
    telemetry.beginExecution(firstCreated.execution.id, firstCreated.record);
    service.submit(spawnTask(firstCreated, first));

    const parent = new AbortController();
    let resolveQueued!: (result: string) => void;
    const queuedPromise = new Promise<string>((resolve) => { resolveQueued = resolve; });
    const second = acceptedSpawnFixture({ prompt: "second", runInBackground: true });
    const secondCreated = store.createSpawnRecord(second, "queued", new AbortController(), queuedPromise);
    telemetry.initializeRecord(secondCreated.record);
    telemetry.beginExecution(secondCreated.execution.id, secondCreated.record);
    service.submit(spawnTask(secondCreated, second, parent.signal, resolveQueued));

    expect(store.get(secondCreated.id)?.lifecycle.status).toBe("queued");
    expect(service.pendingCount).toBe(1);
    parent.abort();
    expect(service.pendingCount).toBe(0);
    await expect(queuedPromise).resolves.toBe("");
    expect(store.get(secondCreated.id)?.lifecycle).toMatchObject({ status: "stopped", settled: true, stoppedBy: "parent" });
    expect(mockModules.runAgent).toHaveBeenCalledOnce();

    blocker.resolve(runResult());
    await firstCreated.record.execution.promise;
    service.dispose();
  });

  it("releases a completed turn and starts the next FIFO entry", async () => {
    mockModules.runAgent.mockReset();
    const firstRun = makeResolvablePromise();
    const secondRun = makeResolvablePromise();
    mockModules.runAgent.mockReturnValueOnce(firstRun.promise).mockReturnValueOnce(secondRun.promise);
    const store = new AgentRecordStore();
    const telemetry = new ExecutionTelemetry((record) => store.get(record.id) === record);
    const service = new AgentExecutionService({ store, telemetry, concurrency: 1 });
    const first = acceptedSpawnFixture({ prompt: "first" });
    const firstCreated = store.createSpawnRecord(first, "running", new AbortController());
    telemetry.initializeRecord(firstCreated.record);
    telemetry.beginExecution(firstCreated.execution.id, firstCreated.record);
    service.submit(spawnTask(firstCreated, first));

    let resolveSecond!: (result: string) => void;
    const secondPromise = new Promise<string>((resolve) => { resolveSecond = resolve; });
    const second = acceptedSpawnFixture({ prompt: "second" });
    const secondCreated = store.createSpawnRecord(second, "queued", new AbortController(), secondPromise);
    telemetry.initializeRecord(secondCreated.record);
    telemetry.beginExecution(secondCreated.execution.id, secondCreated.record);
    service.submit(spawnTask(secondCreated, second, undefined, resolveSecond));

    firstRun.resolve(runResult());
    await vi.waitFor(() => expect(store.get(secondCreated.id)?.lifecycle.status).toBe("running"));
    expect(mockModules.runAgent).toHaveBeenCalledTimes(2);

    secondRun.resolve(runResult());
    await expect(secondPromise).resolves.toBe("done");
    service.dispose();
    expect(mockModules.releaseOutputRoot).toHaveBeenCalledWith("/private");
  });
});

function spawnTask(
  created: ReturnType<AgentRecordStore["createSpawnRecord"]>,
  acceptedSpawn: ReturnType<typeof acceptedSpawnFixture>,
  signal?: AbortSignal,
  resolve?: (result: string) => void,
): SpawnExecutionTask {
  const contract = signal ? { ...acceptedSpawn, signal } : acceptedSpawn;
  return {
    kind: "spawn",
    id: created.id,
    record: created.record,
    execution: created.execution,
    pi: fakePi(),
    ctx: fakeCtx(),
    acceptedSpawn: contract,
    resolve,
  };
}
