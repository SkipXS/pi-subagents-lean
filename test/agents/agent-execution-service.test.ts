import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedSpawnFixture, fakeCtx, fakePi } from "../fixtures.ts";
import { AgentExecutionService, type SpawnExecutionTask } from "../../src/agents/agent-execution-service.js";
import { AgentRecordStore } from "../../src/agents/agent-record-store.js";
import { ExecutionTelemetry } from "../../src/agents/execution-telemetry.js";

const state = vi.hoisted(() => ({
  runAgent: vi.fn(),
  outputLog: vi.fn().mockImplementation((id: string) => ({
    path: `/private/${id}.log`,
    append: vi.fn(),
    attach: vi.fn(),
    finalize: vi.fn(),
  })),
  releaseOutputRoot: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/agents/agent-runner.js", () => ({ runAgent: state.runAgent }));
vi.mock("../../src/agents/output-file.js", () => ({
  AgentOutputLog: state.outputLog,
  createOutputRoot: vi.fn(() => "/private"),
  releaseOutputRoot: state.releaseOutputRoot,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function session(): any {
  return { messages: [], subscribe: vi.fn(), dispose: vi.fn() };
}

function runResult(responseText = "done") {
  return { responseText, session: session(), aborted: false };
}

describe("AgentExecutionService", () => {
  beforeEach(() => {
    state.runAgent.mockReset();
    state.releaseOutputRoot.mockClear();
  });

  it("removes a queued task on parent abort without consuming a slot", async () => {
    const blocker = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(blocker.promise);
    const { service, store, telemetry } = createService(1);
    const first = acceptedSpawnFixture({ prompt: "first" });
    const firstCreated = store.createSpawnRecord(first, "running", new AbortController());
    initialize(telemetry, firstCreated.record, firstCreated.execution);
    service.submit(spawnTask(firstCreated, first));

    const parent = new AbortController();
    let resolveQueued!: (result: string) => void;
    const queuedPromise = new Promise<string>((resolve) => { resolveQueued = resolve; });
    const second = acceptedSpawnFixture({ prompt: "second", signal: parent.signal });
    const secondCreated = store.createSpawnRecord(second, "queued", new AbortController(), queuedPromise);
    initialize(telemetry, secondCreated.record, secondCreated.execution);
    service.submit(spawnTask(secondCreated, second, resolveQueued));

    expect(service.pendingCount).toBe(1);
    parent.abort();
    expect(service.pendingCount).toBe(0);
    await expect(queuedPromise).resolves.toBe("");
    expect(store.get(secondCreated.id)?.lifecycle).toMatchObject({ status: "stopped", settled: true, stoppedBy: "parent" });
    expect(state.runAgent).toHaveBeenCalledOnce();

    blocker.resolve(runResult());
    await firstCreated.record.execution.promise;
    service.dispose();
  });

  it("releases one slot and starts the next entry in FIFO order", async () => {
    const firstRun = deferred<ReturnType<typeof runResult>>();
    const secondRun = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValueOnce(firstRun.promise).mockReturnValueOnce(secondRun.promise);
    const { service, store, telemetry } = createService(1);
    const first = acceptedSpawnFixture({ prompt: "first" });
    const firstCreated = store.createSpawnRecord(first, "running", new AbortController());
    initialize(telemetry, firstCreated.record, firstCreated.execution);
    service.submit(spawnTask(firstCreated, first));

    let resolveSecond!: (result: string) => void;
    const secondPromise = new Promise<string>((resolve) => { resolveSecond = resolve; });
    const second = acceptedSpawnFixture({ prompt: "second" });
    const secondCreated = store.createSpawnRecord(second, "queued", new AbortController(), secondPromise);
    initialize(telemetry, secondCreated.record, secondCreated.execution);
    service.submit(spawnTask(secondCreated, second, resolveSecond));

    firstRun.resolve(runResult("first complete"));
    await vi.waitFor(() => expect(store.get(secondCreated.id)?.lifecycle.status).toBe("running"));
    expect(state.runAgent).toHaveBeenCalledTimes(2);
    expect(state.runAgent.mock.calls[1]![2]).toBe("second");

    secondRun.resolve(runResult("second complete"));
    await expect(secondPromise).resolves.toBe("second complete");
    expect(store.get(secondCreated.id)?.result).toBe("second complete");
    service.dispose();
    expect(state.releaseOutputRoot).toHaveBeenCalledWith("/private");
  });

  it("settles active caller promises and removes records during shutdown", async () => {
    const run = deferred<ReturnType<typeof runResult>>();
    state.runAgent.mockReturnValue(run.promise);
    const { service, store, telemetry } = createService(1);
    let resolveCaller!: (value: string) => void;
    const callerPromise = new Promise<string>((resolve) => { resolveCaller = resolve; });
    const accepted = acceptedSpawnFixture();
    const created = store.createSpawnRecord(accepted, "running", new AbortController(), callerPromise);
    initialize(telemetry, created.record, created.execution);
    service.submit(spawnTask(created, accepted, resolveCaller));

    service.dispose();
    await expect(callerPromise).resolves.toBe("");
    expect(store.list()).toEqual([]);
    run.resolve(runResult("late"));
    await Promise.resolve();
  });
});

function createService(concurrency: number) {
  const store = new AgentRecordStore();
  const telemetry = new ExecutionTelemetry((record) => store.get(record.id) === record);
  const service = new AgentExecutionService({ store, telemetry, concurrency });
  return { store, telemetry, service };
}

function initialize(telemetry: ExecutionTelemetry, record: any, execution: any): void {
  telemetry.initializeRecord(record);
  telemetry.beginExecution(execution.id, record);
}

function spawnTask(
  created: ReturnType<AgentRecordStore["createSpawnRecord"]>,
  acceptedSpawn: ReturnType<typeof acceptedSpawnFixture>,
  resolve?: (result: string) => void,
): SpawnExecutionTask {
  return {
    kind: "spawn",
    id: created.id,
    record: created.record,
    execution: created.execution,
    pi: fakePi(),
    ctx: fakeCtx(),
    acceptedSpawn,
    resolve,
  };
}
