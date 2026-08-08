import { describe, expect, it } from "vitest";
import {
  AgentRecordStore,
  MAX_RETAINED_EXECUTION_SUMMARY_TEXT_BYTES,
} from "../../src/agents/agent-record-store.js";
import {
  MAX_RETAINED_EXECUTION_PROMPT_BYTES,
  utf8ByteLength,
} from "../../src/agents/agent-string-limits.js";
import { acceptedSpawnFixture } from "../fixtures.ts";

function makeStore() {
  let id = 0;
  return new AgentRecordStore({ createId: () => `id-${++id}` });
}

describe("AgentRecordStore foreground history", () => {
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
    expect(["delivered", "Text"].join("") in created.execution).toBe(false);
  });

  it("keeps continuation history usable and records kind, prompt, status, usage, and compaction", () => {
    const store = makeStore();
    const created = store.createSpawnRecord(acceptedSpawnFixture(), "running", new AbortController());
    store.completeTurn(created.record, created.execution, { responseText: "initial", aborted: false });
    store.markSettled(created.record);

    const continuation = store.createContinuation(created.record, "continuation", "follow up", "running");
    continuation.usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 };
    continuation.compactionCount = 1;
    store.completeTurn(created.record, continuation, { responseText: "continued", aborted: false });
    store.markSettled(created.record);

    expect(created.record.stats.executions).toHaveLength(2);
    expect(created.record.stats.executions?.[1]).toMatchObject({
      id: "continuation",
      prompt: "follow up",
      kind: "continued",
      status: "completed",
      responseText: "continued",
      usage: continuation.usage,
      compactionCount: 1,
    });
  });

  it("prunes oldest completed summaries deterministically while protecting active entries", () => {
    const store = makeStore();
    const created = store.createSpawnRecord(acceptedSpawnFixture(), "running", new AbortController());
    store.completeTurn(created.record, created.execution, { responseText: "initial", aborted: false });
    store.markSettled(created.record);

    for (let i = 0; i < 130; i++) {
      const execution = store.createContinuation(created.record, `execution-${i}`, `prompt-${i}`, "running");
      store.completeTurn(created.record, execution, { responseText: "response".repeat(2_000), aborted: false });
      store.markSettled(created.record);
    }

    expect(created.record.stats.executions!.length).toBeLessThanOrEqual(128);
    expect(created.record.stats.executions!.at(-1)?.id).toBe("execution-129");
    expect(created.record.stats.executions!.every((execution) => execution.status !== "queued" && execution.status !== "running")).toBe(true);
  });

  it("enforces the exact aggregate UTF-8 execution-history budget", () => {
    const store = makeStore();
    const created = store.createSpawnRecord(acceptedSpawnFixture(), "running", new AbortController());
    store.completeTurn(created.record, created.execution, { responseText: "initial", aborted: false });
    store.markSettled(created.record);

    const largePrompt = "😀".repeat(16 * 1024);
    const largeResponse = "界".repeat(32 * 1024);
    for (let i = 0; i < 24; i++) {
      const execution = store.createContinuation(created.record, `execution-${i}`, `${largePrompt}tail`, "running", i + 2);
      store.completeTurn(created.record, execution, { responseText: largeResponse, aborted: false }, i + 100);
      store.markSettled(created.record);
    }

    const active = store.createContinuation(
      created.record,
      "execution-active",
      "x".repeat(256 * 1024),
      "queued",
      1_000,
    );
    const executions = created.record.stats.executions ?? [];
    const textBytes = executions.reduce((total, execution) => total
      + utf8ByteLength(execution.prompt)
      + (execution.responseText ? utf8ByteLength(execution.responseText) : 0)
      + (execution.error ? utf8ByteLength(execution.error) : 0), 0);

    expect(textBytes).toBeLessThanOrEqual(MAX_RETAINED_EXECUTION_SUMMARY_TEXT_BYTES);
    expect(utf8ByteLength(active.prompt)).toBeLessThanOrEqual(MAX_RETAINED_EXECUTION_PROMPT_BYTES);
    expect(executions).toContain(active);
    expect(executions.some((execution) => execution.id === "execution-0")).toBe(false);
    expect(executions.at(-1)).toBe(active);
  });

  it("does not evict a queued or running summary when capping history", () => {
    const store = makeStore();
    const created = store.createSpawnRecord(acceptedSpawnFixture(), "running", new AbortController());
    store.completeTurn(created.record, created.execution, { responseText: "initial", aborted: false });
    store.markSettled(created.record);
    const active = store.createContinuation(created.record, "active", "active prompt", "running");

    for (let i = 0; i < 130; i++) {
      const execution = store.createContinuation(created.record, `done-${i}`, `done prompt ${i}`, "running");
      store.completeTurn(created.record, execution, { responseText: "done", aborted: false });
      store.markSettled(created.record);
    }

    expect(created.record.stats.executions).toContain(active);
  });
});
