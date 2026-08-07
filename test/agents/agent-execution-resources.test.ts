import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOutputRoot: vi.fn(() => "/private"),
  releaseOutputRoot: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/agents/output-file.js", () => ({
  createOutputRoot: mocks.createOutputRoot,
  releaseOutputRoot: mocks.releaseOutputRoot,
}));

import { AgentExecutionResources } from "../../src/agents/agent-execution-resources.js";

describe("AgentExecutionResources", () => {
  beforeEach(() => {
    mocks.createOutputRoot.mockClear();
    mocks.releaseOutputRoot.mockClear();
  });

  it("owns one lazy output root and releases it once", () => {
    const resources = new AgentExecutionResources();

    expect(resources.getOutputRoot()).toBe("/private");
    expect(resources.getOutputRoot()).toBe("/private");
    expect(mocks.createOutputRoot).toHaveBeenCalledOnce();

    resources.dispose();
    resources.dispose();
    expect(mocks.releaseOutputRoot).toHaveBeenCalledOnce();
    expect(mocks.releaseOutputRoot).toHaveBeenCalledWith("/private");
  });

  it("removes queued parent-abort listeners without retaining the callback", () => {
    const resources = new AgentExecutionResources();
    const parent = new AbortController();
    const onAbort = vi.fn();

    resources.bindParentAbortSignal("queued", parent.signal, onAbort);
    parent.abort();
    expect(onAbort).toHaveBeenCalledOnce();

    resources.clearParentAbortSignal("queued");
    parent.abort();
    expect(onAbort).toHaveBeenCalledOnce();
  });
});
