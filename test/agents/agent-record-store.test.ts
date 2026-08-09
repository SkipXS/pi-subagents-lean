import { describe, expect, it } from "vitest";
import { AgentRecordStore } from "../../src/agents/agent-record-store.js";
import {
  MAX_RETAINED_EXECUTION_PROMPT_BYTES,
  utf8ByteLength,
} from "../../src/agents/agent-string-limits.js";
import { acceptedSpawnFixture } from "../fixtures.ts";

function makeStore() {
  let id = 0;
  return new AgentRecordStore({ createId: () => `id-${++id}` });
}

describe("AgentRecordStore current execution projection", () => {
  it("retains bounded response projections while the caller may keep the full promise result", () => {
    const store = makeStore();
    const accepted = acceptedSpawnFixture({ prompt: "initial" });
    const full = "😀".repeat(50_000);
    const created = store.createSpawnRecord(accepted, "running", new AbortController());

    store.completeTurn(created.record, created.execution, {
      responseText: full,
      aborted: false,
    });
    store.markSettled(created.record);

    expect(created.record.result).not.toBe(full);
    expect(Buffer.byteLength(created.record.result!, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(created.execution.responseText).toBe(created.record.result);
    expect(created.record.stats.currentExecution).toBe(created.execution);
    expect(["delivered", "Text"].join("") in created.execution).toBe(false);
  });

  it("keeps the spawn projection through settlement and replaces it for continuation", () => {
    const store = makeStore();
    const created = store.createSpawnRecord(acceptedSpawnFixture(), "running", new AbortController());
    const initial = created.execution;

    store.completeTurn(created.record, initial, { responseText: "initial", aborted: false });
    store.markSettled(created.record);
    expect(created.record.stats.currentExecution).toBe(initial);
    expect(initial.kind).toBe("new");

    const continuation = store.createContinuation(created.record, "continuation", "follow up", "running");
    expect(created.record.stats.currentExecution).toBe(continuation);
    expect(created.record.stats.currentExecution).not.toBe(initial);
    continuation.usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 };
    continuation.compactionCount = 1;
    store.completeTurn(created.record, continuation, { responseText: "continued", aborted: false });
    store.markSettled(created.record);

    expect(created.record.stats.currentExecution).toMatchObject({
      id: "continuation",
      prompt: "follow up",
      kind: "continued",
      status: "completed",
      responseText: "continued",
      usage: continuation.usage,
      compactionCount: 1,
    });
    expect("executions" in created.record.stats).toBe(false);
  });

  it("keeps prompt, response, and error bounds independently", () => {
    const store = makeStore();
    const created = store.createSpawnRecord(
      acceptedSpawnFixture({ prompt: "😀".repeat(20_000) }),
      "running",
      new AbortController(),
    );

    expect(utf8ByteLength(created.execution.prompt)).toBeLessThanOrEqual(MAX_RETAINED_EXECUTION_PROMPT_BYTES);
    const response = "界".repeat(80_000);
    const error = "🚀".repeat(8_000);
    store.completeTurn(created.record, created.execution, { responseText: response, aborted: false, error });
    store.markSettled(created.record);

    const current = created.record.stats.currentExecution!;
    expect(utf8ByteLength(current.prompt)).toBeLessThanOrEqual(64 * 1024);
    expect(utf8ByteLength(current.responseText!)).toBeLessThanOrEqual(64 * 1024);
    expect(utf8ByteLength(current.error!)).toBeLessThanOrEqual(8 * 1024);
    expect(current.responseText).toContain("[TRUNCATED]");
    expect(current.error).toContain("[TRUNCATED]");
  });

  it("only reports the current execution as active", () => {
    const store = makeStore();
    const created = store.createSpawnRecord(acceptedSpawnFixture(), "running", new AbortController());
    expect(store.activeExecution(created.record, "running")).toBe(created.execution);
    store.completeTurn(created.record, created.execution, { responseText: "done", aborted: false });
    store.markSettled(created.record);
    expect(store.activeExecution(created.record)).toBeUndefined();
  });
});
