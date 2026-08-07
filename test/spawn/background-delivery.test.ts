import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionSummary, AgentRecord } from "../../src/types.js";
import { buildAgentDetails } from "../../src/agents/agent-details.js";
import {
  BackgroundDeliveryService,
  MAX_BACKGROUND_FAILURE_BYTES,
} from "../../src/spawn/background-delivery.js";
import { utf8ByteLength } from "../../src/utils.js";

const { mockPi, mockGetPiInstance, mockIsIdle } = vi.hoisted(() => ({
  mockPi: { sendMessage: vi.fn() },
  mockGetPiInstance: vi.fn(),
  mockIsIdle: vi.fn(() => true),
}));

vi.mock("../../src/shell.js", () => ({
  getPiInstance: () => mockGetPiInstance(),
  getSessionCtx: () => ({ isIdle: mockIsIdle }),
}));

function makeExecution(
  id: string,
  responseText: string,
  overrides: Partial<AgentExecutionSummary> = {},
): AgentExecutionSummary {
  return {
    id,
    prompt: "background work",
    mode: "background",
    kind: "new",
    status: "completed",
    startedAt: 10,
    completedAt: 20,
    responseText,
    ...overrides,
  };
}

function makeRecord(execution: AgentExecutionSummary, result = execution.responseText): AgentRecord {
  return {
    id: "agent-background",
    result,
    lifecycle: {
      status: execution.status,
      startedAt: 10,
      completedAt: execution.completedAt,
      settled: true,
    },
    display: { type: "builder", description: "background test" },
    execution: {},
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      cacheRead: 0,
      executions: [execution],
    },
  };
}

function makeManager(record: AgentRecord) {
  return {
    getRecord: vi.fn(() => record),
  } as any;
}

describe("BackgroundDeliveryService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetPiInstance.mockReset().mockReturnValue(mockPi);
    mockPi.sendMessage.mockReset();
    mockIsIdle.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles a terminal completion that happened before its claim", () => {
    const execution = makeExecution("execution-race", "race result");
    const record = makeRecord(execution);
    const service = new BackgroundDeliveryService(makeManager(record));

    // The manager callback can run before the facade installs its claim.
    service.onAgentComplete(record, execution);
    service.claim(record, execution.id);
    service.reconcile(record, execution.id);
    vi.advanceTimersByTime(200);

    expect(mockPi.sendMessage).toHaveBeenCalledOnce();
    expect(mockPi.sendMessage.mock.calls[0]![0].content).toContain("race result");
    expect(record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
  });

  it("keeps claim/reconcile idempotent across duplicate and disposed races", () => {
    const execution = makeExecution("execution-guards", "guarded result");
    const record = makeRecord(execution);
    const service = new BackgroundDeliveryService(makeManager(record));

    service.reconcile(record);
    service.reconcile(record, "missing");
    execution.status = "running";
    service.reconcile(record, execution.id);
    execution.status = "completed";
    service.claim(record, execution.id);
    service.claim(record, execution.id);
    service.reconcile(record, execution.id);
    service.onAgentComplete(record, execution);
    service.dispose();
    service.claim(record, "after-dispose");

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect((service as any).backgroundDeliveries.size).toBe(0);
    expect((service as any).terminalDiagnostics.size).toBe(0);
  });

  it("abandons an already aborted claim before retaining a payload", () => {
    const execution = makeExecution("execution-already-aborted", "cancelled result");
    const record = makeRecord(execution);
    const controller = new AbortController();
    controller.abort();
    const service = new BackgroundDeliveryService(makeManager(record));

    service.claim(record, execution.id, controller.signal);
    service.onAgentComplete(record, execution);
    vi.advanceTimersByTime(200);

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(record.delivery).toMatchObject({ state: "abandoned", attempts: 0 });
    expect((service as any).latestDeliveryKeys.size).toBe(0);
  });

  it("abandons a completed delivery when its parent aborts before the timer fires", () => {
    const execution = makeExecution("execution-abort-before-delivery", "aborted result");
    const record = makeRecord(execution);
    const parent = new AbortController();
    const service = new BackgroundDeliveryService(makeManager(record));

    service.claim(record, execution.id, parent.signal);
    service.onAgentComplete(record, execution);
    parent.abort();
    vi.advanceTimersByTime(200);

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(record.delivery).toMatchObject({ state: "abandoned", attempts: 0 });
  });

  it("rechecks parent abort immediately before the send handoff", () => {
    const execution = makeExecution("execution-abort-at-handoff", "handoff result");
    const record = makeRecord(execution);
    const parent = new AbortController();
    const service = new BackgroundDeliveryService(makeManager(record));
    mockGetPiInstance.mockImplementationOnce(() => {
      parent.abort();
      return mockPi;
    });

    service.claim(record, execution.id, parent.signal);
    service.onAgentComplete(record, execution);
    vi.advanceTimersByTime(200);

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(record.delivery).toMatchObject({ state: "abandoned", attempts: 1 });
  });

  it("handles a record disappearing before an armed delivery fires", () => {
    const execution = makeExecution("execution-missing-record", "missing record");
    const record = makeRecord(execution);
    let available = true;
    const manager = { getRecord: vi.fn(() => available ? record : undefined) } as any;
    const service = new BackgroundDeliveryService(manager);

    service.claim(record, execution.id);
    service.onAgentComplete(record, execution);
    available = false;
    vi.advanceTimersByTime(200);

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect((service as any).terminalDiagnostics.get(execution.id)).toMatchObject({ state: "abandoned" });
    expect((service as any).latestDeliveryKeys.size).toBe(0);
  });

  it("does not lose settlement when the retention callback throws", () => {
    const execution = makeExecution("execution-settled-callback", "callback result");
    const record = makeRecord(execution);
    const settled = vi.fn(() => { throw new Error("retention unavailable"); });
    const service = new BackgroundDeliveryService(makeManager(record), settled);

    service.claim(record, execution.id);
    service.onAgentComplete(record, execution);
    vi.advanceTimersByTime(200);

    expect(record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
    expect(settled).toHaveBeenCalledOnce();
  });

  it("turns an unavailable completion payload into one bounded failure", () => {
    const execution = makeExecution("execution-no-payload", "payload result");
    const record = makeRecord(execution);
    const service = new BackgroundDeliveryService(makeManager(record));

    service.claim(record, execution.id);
    service.onAgentComplete(record, execution);
    const entry = (service as any).backgroundDeliveries.get(execution.id);
    entry.payload = undefined;
    vi.advanceTimersByTime(200);

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(record.delivery).toMatchObject({ state: "failed", attempts: 1, lastError: "Background result payload is unavailable" });
    expect((service as any).terminalDiagnostics.size).toBe(1);
  });

  it("delivers the completion-time payload after the record advances", () => {
    const execution = makeExecution("execution-frozen", "first result");
    const record = makeRecord(execution, "first result");
    const service = new BackgroundDeliveryService(makeManager(record));

    service.claim(record, execution.id);
    service.onAgentComplete(record, execution);
    record.result = "later result";
    execution.responseText = "later execution text";
    vi.advanceTimersByTime(200);

    const message = mockPi.sendMessage.mock.calls[0]![0];
    expect(message.content).toContain("first result");
    expect(message.content).not.toContain("later result");
    expect(message.content).not.toContain("later execution text");
  });

  it("makes one send attempt and retains a diagnostic failure without retrying", () => {
    const execution = makeExecution("execution-failure", "failure result");
    const record = makeRecord(execution);
    const service = new BackgroundDeliveryService(makeManager(record));
    mockPi.sendMessage.mockImplementation(() => { throw new Error("stale host"); });

    service.claim(record, execution.id);
    service.onAgentComplete(record, execution);
    vi.advanceTimersByTime(200);
    service.onAgentComplete(record, execution);
    vi.advanceTimersByTime(500);

    expect(mockPi.sendMessage).toHaveBeenCalledOnce();
    expect(record.delivery).toMatchObject({ state: "failed", attempts: 1, lastError: "stale host" });
  });

  it("keeps an older failure visible after a newer background continuation claim", () => {
    const initial = makeExecution("execution-initial-failure", "initial result");
    const continued = makeExecution("execution-newer-claim", "continued result", { kind: "continued" });
    const record = makeRecord(initial);
    record.stats.executions = [initial, continued];
    const service = new BackgroundDeliveryService(makeManager(record));
    mockPi.sendMessage
      .mockImplementationOnce(() => { throw new Error("initial sendMessage failed"); })
      .mockImplementationOnce(() => undefined);

    // Arm the initial background execution, then claim its continuation before
    // either delayed handoff fires. The continuation owns the public state.
    service.claim(record, initial.id);
    service.onAgentComplete(record, initial);
    service.claim(record, continued.id, undefined, { resetRecordProjection: true });
    expect(record.delivery).toMatchObject({ state: "pending", attempts: 0 });

    // The older timer settles first. Its failure is visible without changing
    // the newer claim's pending state or consumption marker.
    vi.advanceTimersByTime(200);
    expect(mockPi.sendMessage).toHaveBeenCalledOnce();
    expect(record.delivery).toMatchObject({
      state: "pending",
      attempts: 0,
      lastFailure: {
        executionId: initial.id,
        lastError: "initial sendMessage failed",
      },
    });
    expect(record.lifecycle.resultConsumed).toBe(false);

    service.onAgentComplete(record, continued);
    vi.advanceTimersByTime(200);

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    expect(record.delivery).toMatchObject({
      state: "accepted",
      attempts: 1,
      lastFailure: {
        executionId: initial.id,
        lastError: "initial sendMessage failed",
      },
    });
    expect(record.delivery?.lastError).toBeUndefined();
    expect(record.lifecycle.resultConsumed).toBe(true);
    expect(utf8ByteLength(record.delivery!.lastFailure!.lastError)).toBeLessThanOrEqual(MAX_BACKGROUND_FAILURE_BYTES);

    const details = buildAgentDetails(record, { includeStatus: true });
    expect(details.delivery).toMatchObject({
      state: "accepted",
      lastFailure: { executionId: initial.id, lastError: "initial sendMessage failed" },
    });
  });

  it("bounds an aggregated failure projection without retaining payload data", () => {
    const initial = makeExecution("execution-bounded-failure", "failure payload");
    const record = makeRecord(initial);
    const service = new BackgroundDeliveryService(makeManager(record));
    mockPi.sendMessage.mockImplementation(() => { throw new Error("界".repeat(5_000)); });

    service.claim(record, initial.id);
    service.onAgentComplete(record, initial);
    vi.advanceTimersByTime(200);

    expect(utf8ByteLength(record.delivery!.lastFailure!.lastError)).toBeLessThanOrEqual(MAX_BACKGROUND_FAILURE_BYTES);
    expect(record.delivery!.lastFailure!.lastError).toContain("[TRUNCATED]");
    expect(record.delivery!.lastFailure).not.toHaveProperty("payload");
  });

  it("releases the failed payload and abort binding while retaining only a diagnostic", () => {
    const execution = makeExecution("execution-release-failure", "failure payload");
    const record = makeRecord(execution);
    const parent = new AbortController();
    const service = new BackgroundDeliveryService(makeManager(record));
    mockPi.sendMessage.mockImplementation(() => { throw new Error("delivery failed"); });

    service.claim(record, execution.id, parent.signal);
    service.onAgentComplete(record, execution);
    const entry = (service as any).backgroundDeliveries.get(execution.id);
    vi.advanceTimersByTime(200);

    expect(record.delivery).toMatchObject({ state: "failed", attempts: 1, lastError: "delivery failed" });
    expect((service as any).backgroundDeliveries.has(execution.id)).toBe(false);
    expect(entry.payload).toBeUndefined();
    expect(entry.timer).toBeNull();
    expect(entry.signal).toBeUndefined();
    expect(entry.onParentAbort).toBeUndefined();
    expect((service as any).latestDeliveryKeys.size).toBe(0);

    const diagnostics = (service as any).terminalDiagnostics as Map<string, any>;
    expect(diagnostics.size).toBe(1);
    const diagnostic = diagnostics.get(execution.id);
    expect(diagnostic).toMatchObject({
      executionId: execution.id,
      state: "failed",
      attempts: 1,
      lastError: "delivery failed",
    });
    expect(diagnostic).not.toHaveProperty("payload");
    expect(diagnostic).not.toHaveProperty("details");
  });

  it("releases transient state after an accepted handoff and keeps record diagnostics", () => {
    const execution = makeExecution("execution-release-accepted", "accepted payload");
    const record = makeRecord(execution);
    const parent = new AbortController();
    const service = new BackgroundDeliveryService(makeManager(record));

    service.claim(record, execution.id, parent.signal);
    service.onAgentComplete(record, execution);
    const entry = (service as any).backgroundDeliveries.get(execution.id);
    vi.advanceTimersByTime(200);

    expect(record.delivery).toMatchObject({ state: "accepted", attempts: 1 });
    expect(entry.payload).toBeUndefined();
    expect(entry.timer).toBeNull();
    expect(entry.signal).toBeUndefined();
    expect(entry.onParentAbort).toBeUndefined();
    expect((service as any).terminalDiagnostics.get(execution.id)).toMatchObject({ state: "accepted" });
    expect((service as any).latestDeliveryKeys.size).toBe(0);

    // A terminal execution id cannot be claimed again, even after its active
    // entry has been removed.
    service.claim(record, execution.id);
    service.onAgentComplete(record, execution);
    vi.advanceTimersByTime(200);
    expect(mockPi.sendMessage).toHaveBeenCalledOnce();
  });

  it("cancels a pending timer during shutdown", () => {
    const execution = makeExecution("execution-shutdown", "shutdown result");
    const record = makeRecord(execution);
    const service = new BackgroundDeliveryService(makeManager(record));

    service.claim(record, execution.id);
    service.onAgentComplete(record, execution);
    service.dispose();
    vi.advanceTimersByTime(500);

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(record.delivery).toMatchObject({ state: "abandoned" });
  });

  it("exposes pending protection and reports one terminal delivery to the coordinator", () => {
    const execution = makeExecution("execution-settled", "settled result");
    const record = makeRecord(execution);
    const settled = vi.fn();
    const service = new BackgroundDeliveryService(makeManager(record), settled);

    service.claim(record, execution.id);
    expect(service.getActivitySnapshot()).toEqual([]);
    expect(service.isPendingOrArmed(record.id)).toBe(true);
    service.onAgentComplete(record, execution);
    expect(service.getActivitySnapshot()).toEqual([{
      agentId: record.id,
      type: "builder",
      executionId: execution.id,
    }]);
    expect(service.isPendingOrArmed(record.id)).toBe(true);

    vi.advanceTimersByTime(200);

    expect(service.isPendingOrArmed(record.id)).toBe(false);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(record.id, execution.id);
    service.onAgentComplete(record, execution);
    expect(settled).toHaveBeenCalledOnce();
  });
});
