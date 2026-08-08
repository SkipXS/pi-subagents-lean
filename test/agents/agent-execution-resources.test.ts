import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import { AgentExecutionResources } from "../../src/agents/agent-execution-resources.js";

function makeRecord(id: string, dispose = vi.fn()) {
  const promise = Promise.resolve("result");
  const session = { dispose };
  const record = {
    id,
    execution: {
      session,
      abortController: new AbortController(),
      promise,
    },
  } as unknown as AgentRecord;
  return { record, session, dispose, promise };
}

describe("AgentExecutionResources", () => {
  it("binds and clears a parent-abort listener", () => {
    const resources = new AgentExecutionResources();
    const parent = new AbortController();
    const onAbort = vi.fn();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");

    resources.bindParentAbortSignal("queued", parent.signal, onAbort);
    resources.clearParentAbortSignal("queued");
    parent.abort();

    expect(onAbort).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("handles an already-aborted parent signal immediately", () => {
    const resources = new AgentExecutionResources();
    const parent = new AbortController();
    const onAbort = vi.fn();
    parent.abort();

    resources.bindParentAbortSignal("aborted", parent.signal, onAbort);

    expect(onAbort).toHaveBeenCalledOnce();
    resources.clearParentAbortSignal("aborted");
  });

  it("allows clearing a listener twice", () => {
    const resources = new AgentExecutionResources();
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");

    resources.bindParentAbortSignal("queued", parent.signal, vi.fn());
    resources.clearParentAbortSignal("queued");
    resources.clearParentAbortSignal("queued");

    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("disposes a record session and clears its execution state", () => {
    const resources = new AgentExecutionResources();
    const parent = new AbortController();
    const onAbort = vi.fn();
    const { record, dispose } = makeRecord("one");
    resources.bindParentAbortSignal(record.id, parent.signal, onAbort);

    resources.releaseExecution(record);

    expect(dispose).toHaveBeenCalledOnce();
    expect(record.execution.session).toBeUndefined();
    expect(record.execution.abortController).toBeUndefined();
    expect(record.execution.promise).toBeUndefined();
    parent.abort();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("cleans one record without affecting another", () => {
    const resources = new AgentExecutionResources();
    const firstParent = new AbortController();
    const secondParent = new AbortController();
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();
    const first = makeRecord("first");
    const second = makeRecord("second");
    resources.bindParentAbortSignal(first.record.id, firstParent.signal, firstAbort);
    resources.bindParentAbortSignal(second.record.id, secondParent.signal, secondAbort);

    resources.releaseExecution(first.record);
    firstParent.abort();
    secondParent.abort();

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(firstAbort).not.toHaveBeenCalled();
    expect(secondAbort).toHaveBeenCalledOnce();
    expect(second.record.execution.session).toBe(second.session);
    expect(second.record.execution.promise).toBe(second.promise);
  });

  it("disposes all parent-abort listeners", () => {
    const resources = new AgentExecutionResources();
    const first = new AbortController();
    const second = new AbortController();
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();

    resources.bindParentAbortSignal("first", first.signal, firstAbort);
    resources.bindParentAbortSignal("second", second.signal, secondAbort);
    resources.dispose();
    resources.dispose();
    first.abort();
    second.abort();

    expect(firstAbort).not.toHaveBeenCalled();
    expect(secondAbort).not.toHaveBeenCalled();
  });

  it("clears execution state even when session disposal throws", () => {
    const resources = new AgentExecutionResources();
    const dispose = vi.fn(() => { throw new Error("dispose failed"); });
    const { record } = makeRecord("throws", dispose);

    expect(() => resources.releaseExecution(record)).not.toThrow();

    expect(dispose).toHaveBeenCalledOnce();
    expect(record.execution.session).toBeUndefined();
    expect(record.execution.abortController).toBeUndefined();
    expect(record.execution.promise).toBeUndefined();
  });
});
