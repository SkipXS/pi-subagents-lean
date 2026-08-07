import { describe, expect, it, vi } from "vitest";
import { acceptedSpawnFixture } from "../fixtures.ts";
import {
  AgentRecordStore,
  MAX_RETAINED_EXECUTION_SUMMARY_TEXT_BYTES,
} from "../../src/agents/agent-record-store.js";
import {
  MAX_RETAINED_ERROR_BYTES,
  MAX_RETAINED_EXECUTION_PROMPT_BYTES,
  MAX_RETAINED_TEXT_BYTES,
  utf8ByteLength,
} from "../../src/agents/agent-string-limits.js";

describe("AgentRecordStore", () => {
  it("creates an accepted record and projects the active history entry", () => {
    const ids = ["agent-1", "execution-1", "execution-2"];
    const store = new AgentRecordStore({ createId: () => ids.shift()! });
    const accepted = acceptedSpawnFixture({
      type: "scout",
      prompt: "initial",
      description: "Initial task",
      runInBackground: true,
      modelKey: "provider/model",
      worktreePath: "/worktree/feature",
      worktreeLabel: "feature",
    });
    const root = store.createSpawnRecord(
      accepted,
      "running",
      new AbortController(),
      undefined,
      10,
    );

    expect(root.id).toBe("agent-1");
    expect(root.record.display).toMatchObject({
      type: "scout",
      description: "Initial task",
      worktreePath: "/worktree/feature",
      worktreeLabel: "feature",
      invocation: { modelKey: "provider/model" },
    });
    expect(root.execution).toMatchObject({
      id: "execution-1",
      prompt: "initial",
      mode: "background",
      kind: "new",
      status: "running",
      startedAt: 10,
    });

    const observer = vi.fn();
    store.subscribeActivity(observer);
    expect(observer).toHaveBeenCalledWith([
      {
        agentId: "agent-1",
        type: "scout",
        mode: "background",
        status: "running",
        executionId: "execution-1",
      },
    ]);

    const continuation = store.createContinuation(root.record, store.createExecutionId(), "follow-up", "foreground", "queued", 20);
    expect(root.record.stats.executions).toHaveLength(2);
    expect(root.record.lifecycle).toMatchObject({ status: "queued", settled: false });
    expect(store.getActivitySnapshot()).toEqual([
      {
        agentId: "agent-1",
        type: "scout",
        mode: "foreground",
        status: "queued",
        executionId: "execution-2",
      },
    ]);
    expect(store.resolveId("agent-")).toEqual({ ok: true, id: "agent-1" });
    expect(store.get(root.id)).toBe(root.record);
    expect(continuation.kind).toBe("continued");
  });

  it("retains only a 64 KiB prompt projection for a queued full-size input", () => {
    const store = new AgentRecordStore({ createId: () => "agent-1" });
    const fullPrompt = "a".repeat(256 * 1024);
    const root = store.createSpawnRecord(
      acceptedSpawnFixture({ prompt: fullPrompt }),
      "queued",
      new AbortController(),
    );

    expect(root.execution.prompt).not.toBe(fullPrompt);
    expect(utf8ByteLength(root.execution.prompt)).toBeLessThanOrEqual(MAX_RETAINED_EXECUTION_PROMPT_BYTES);
  });

  it("centralizes terminal transitions and keeps them idempotent", () => {
    const store = new AgentRecordStore({ createId: () => "agent-1" });
    const root = store.createSpawnRecord(
      acceptedSpawnFixture({ prompt: "initial" }),
      "running",
      new AbortController(),
      undefined,
      10,
    );

    store.completeTurn(root.record, root.execution, { responseText: "done", aborted: false }, 20);
    store.markSettled(root.record);
    expect(root.record).toMatchObject({
      result: "done",
      lifecycle: { status: "completed", completedAt: 20, settled: true },
    });
    expect(root.execution).toMatchObject({ status: "completed", responseText: "done", completedAt: 20 });

    const continuation = store.createContinuation(root.record, "execution-2", "cancelled", "foreground", "queued", 30);
    expect(store.finishUnstarted(root.record, continuation, "stopped", undefined, 40)).toBe(true);
    expect(store.finishUnstarted(root.record, continuation, "stopped", undefined, 50)).toBe(false);
    expect(continuation).toMatchObject({ status: "stopped", completedAt: 40 });
    expect(root.record.lifecycle).toMatchObject({ status: "stopped", completedAt: 40, settled: true });
    expect(root.record.result).toBeUndefined();
  });

  it("caps retained response and error projections at completeTurn", () => {
    const store = new AgentRecordStore({ createId: () => "agent-1" });
    const root = store.createSpawnRecord(
      acceptedSpawnFixture({ description: "d".repeat(8 * 1024 + 1) }),
      "running",
      new AbortController(),
    );
    const response = "😀界".repeat(Math.ceil(MAX_RETAINED_TEXT_BYTES / 4) + 10);
    const error = "界".repeat(MAX_RETAINED_ERROR_BYTES / 3 + 10);

    store.completeTurn(root.record, root.execution, { responseText: response, aborted: false, error }, 20);

    expect(utf8ByteLength(root.record.result!)).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
    expect(utf8ByteLength(root.execution.responseText!)).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
    expect(utf8ByteLength(root.record.error!)).toBeLessThanOrEqual(MAX_RETAINED_ERROR_BYTES);
    expect(utf8ByteLength(root.execution.error!)).toBeLessThanOrEqual(MAX_RETAINED_ERROR_BYTES);
    expect(root.record.result).toContain("[TRUNCATED]");
    expect(root.execution.responseText).toContain("[TRUNCATED]");
    expect(root.record.error).toContain("[TRUNCATED]");
    expect(root.execution.error).toContain("[TRUNCATED]");
    expect(utf8ByteLength(root.record.display.description)).toBeLessThanOrEqual(8 * 1024);
    expect(root.record.display.description).toContain("[TRUNCATED]");
  });

  it("caps retained history projections while preserving the active entry", () => {
    let id = 0;
    const store = new AgentRecordStore({ createId: () => `id-${++id}` });
    const root = store.createSpawnRecord(
      acceptedSpawnFixture({ prompt: "initial" }),
      "running",
      new AbortController(),
      undefined,
      1,
    );

    store.completeTurn(root.record, root.execution, { responseText: "initial", aborted: false }, 2);
    store.markSettled(root.record);
    for (let index = 2; index <= 141; index++) {
      const execution = store.createContinuation(
        root.record,
        `execution-${index}`,
        `prompt-${index}`,
        "foreground",
        "running",
        index,
      );
      store.completeTurn(root.record, execution, { responseText: `result-${index}`, aborted: false }, index + 1000);
      store.markSettled(root.record);
    }

    expect(root.record.stats.executions).toHaveLength(128);
    expect(root.record.stats.executions?.[0]?.id).toBe("execution-14");
    expect(root.record.stats.executions?.at(-1)?.id).toBe("execution-141");

    const active = store.createContinuation(
      root.record,
      "execution-active",
      "active prompt",
      "background",
      "queued",
      10_000,
    );
    expect(root.record.stats.executions).toHaveLength(129);
    expect(root.record.stats.executions?.filter((entry) => entry.status === "queued" || entry.status === "running"))
      .toEqual([active]);
    expect(root.record.stats.executions?.filter((entry) => entry.status !== "queued" && entry.status !== "running"))
      .toHaveLength(128);
  });

  it("prunes oldest completed summaries by aggregate text budget and bounds prompts", () => {
    let id = 0;
    const store = new AgentRecordStore({ createId: () => `id-${++id}` });
    const root = store.createSpawnRecord(
      acceptedSpawnFixture({ prompt: "initial" }),
      "running",
      new AbortController(),
    );
    store.completeTurn(root.record, root.execution, { responseText: "initial", aborted: false }, 1);

    const largePrompt = "😀".repeat(16 * 1024);
    const largeResponse = "界".repeat(32 * 1024);
    for (let index = 0; index < 24; index++) {
      const execution = store.createContinuation(
        root.record,
        `execution-${index}`,
        `${largePrompt}tail`,
        "foreground",
        "running",
        index + 2,
      );
      store.completeTurn(root.record, execution, {
        responseText: largeResponse,
        aborted: false,
      }, index + 100);
      store.markSettled(root.record);
    }

    const active = store.createContinuation(
      root.record,
      "execution-active",
      "x".repeat(256 * 1024),
      "background",
      "queued",
      1_000,
    );
    const executions = root.record.stats.executions ?? [];
    const textBytes = executions.reduce((total, execution) => total
      + utf8ByteLength(execution.prompt)
      + (execution.responseText ? utf8ByteLength(execution.responseText) : 0)
      + (execution.deliveredText ? utf8ByteLength(execution.deliveredText) : 0)
      + (execution.error ? utf8ByteLength(execution.error) : 0), 0);

    expect(utf8ByteLength(active.prompt)).toBeLessThanOrEqual(MAX_RETAINED_EXECUTION_PROMPT_BYTES);
    expect(textBytes).toBeLessThanOrEqual(MAX_RETAINED_EXECUTION_SUMMARY_TEXT_BYTES);
    expect(executions).toContain(active);
    expect(executions.some((execution) => execution.id === "execution-0")).toBe(false);
    expect(executions.at(-1)).toBe(active);
  });

  it("isolates observer failures and returns immutable activity snapshots", () => {
    const store = new AgentRecordStore({ createId: () => "agent-1" });
    store.createSpawnRecord(acceptedSpawnFixture(), "running", new AbortController());
    const failing = vi.fn(() => { throw new Error("presentation failed"); });
    store.subscribeActivity(failing);

    const snapshot = store.getActivitySnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(() => (snapshot as any).push({})).toThrow();
    expect(() => store.notifyActivityObservers()).not.toThrow();
  });
});
