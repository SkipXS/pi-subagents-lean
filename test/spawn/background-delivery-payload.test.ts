import { describe, expect, it } from "vitest";
import type { AgentExecutionSummary, AgentRecord } from "../../src/types.js";
import { utf8ByteLength } from "../../src/utils.js";
import {
  buildBackgroundContent,
  captureBackgroundPayload,
  MAX_BACKGROUND_DETAILS_TEXT_BYTES,
  MAX_BACKGROUND_ERROR_BYTES,
  MAX_BACKGROUND_MESSAGE_TEXT_BYTES,
  MAX_BACKGROUND_RESULT_BYTES,
  retainBackgroundDeliveryError,
} from "../../src/spawn/background-delivery-payload.js";

function makeExecution(id: string, responseText: string, overrides: Partial<AgentExecutionSummary> = {}): AgentExecutionSummary {
  return {
    id,
    prompt: "background payload",
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
    id: "agent-payload",
    result,
    lifecycle: { status: execution.status, startedAt: 10, completedAt: execution.completedAt, settled: true },
    display: { type: "builder", description: "payload test" },
    execution: {},
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      cacheRead: 0,
      executions: [execution],
    },
  };
}

describe("background delivery payload", () => {
  it("builds the existing bounded status and response format", () => {
    const execution = makeExecution("execution-content-helper", "helper result");
    const content = buildBackgroundContent(makeRecord(execution), execution, "new", "helper result", {});

    expect(content).toContain("Mode: Background | Run: New");
    expect(content).toContain("\n\nResponse:\nhelper result");
  });

  it("captures an immutable completion payload before the record advances", () => {
    const execution = makeExecution("execution-frozen-payload", "first result");
    const record = makeRecord(execution, "first result");
    const payload = captureBackgroundPayload(record, execution);

    record.result = "later result";
    execution.responseText = "later execution text";

    expect(payload).toMatchObject({ agentId: record.id, type: "builder", result: "first result" });
    expect(payload.content).toContain("first result");
    expect(payload.content).not.toContain("later result");
    expect(payload.content).not.toContain("later execution text");
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it("fails closed for cyclic legacy details", () => {
    const execution = makeExecution("execution-cyclic-details", "cyclic result");
    const contextStats: any = { current: 1, lastKnown: 1, peak: 1, window: 1, count: 1 };
    contextStats.self = contextStats;
    const record = makeRecord(execution);
    record.stats.contextStats = contextStats;

    const payload = captureBackgroundPayload(record, execution);

    expect(payload.content).toBe("");
  });

  it("caps multibyte result, content, and secondary details by UTF-8 bytes", () => {
    const hugeResult = "😀界".repeat(20_000);
    const execution = makeExecution("execution-bounded", hugeResult);
    const record = makeRecord(execution, hugeResult);
    const payload = captureBackgroundPayload(record, execution);
    const detailsBytes = utf8ByteLength(JSON.stringify(payload.details));

    expect(utf8ByteLength(payload.content) + detailsBytes).toBeLessThanOrEqual(MAX_BACKGROUND_MESSAGE_TEXT_BYTES);
    expect(utf8ByteLength(payload.content)).toBeLessThanOrEqual(MAX_BACKGROUND_MESSAGE_TEXT_BYTES);
    expect(payload.content).toContain("[TRUNCATED]");
    expect(utf8ByteLength(payload.result)).toBeLessThanOrEqual(MAX_BACKGROUND_RESULT_BYTES);
    expect(payload.result).toContain("[TRUNCATED]");
    const detailResult = (payload.details.currentExecution as Record<string, unknown>).responseText as string;
    expect(utf8ByteLength(detailResult)).toBeLessThanOrEqual(MAX_BACKGROUND_DETAILS_TEXT_BYTES);
    expect(detailResult).not.toBe(hugeResult);
    expect(utf8ByteLength(record.result!)).toBeLessThanOrEqual(MAX_BACKGROUND_RESULT_BYTES);
    expect(record.result).toContain("[TRUNCATED]");
  });

  it("bounds thrown and non-Error delivery diagnostics", () => {
    const hugeError = "界".repeat(5_000);
    const retainedError = retainBackgroundDeliveryError(new Error(hugeError));

    expect(utf8ByteLength(retainedError)).toBeLessThanOrEqual(MAX_BACKGROUND_ERROR_BYTES);
    expect(retainedError).toContain("[TRUNCATED]");
    expect(retainBackgroundDeliveryError("plain failure")).toBe("plain failure");
  });
});
