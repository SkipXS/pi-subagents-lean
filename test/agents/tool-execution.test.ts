import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeValidationResult } from "../../src/spawn/worktree-validator.js";
import { fakeCtx } from "../fixtures.ts";

const state = vi.hoisted(() => ({
  validate: vi.fn(),
  revalidate: vi.fn(),
  discover: vi.fn(),
  coordinatorSpawn: vi.fn(),
  coordinatorAvailable: true,
  managerAvailable: true,
  manager: { getRecord: vi.fn(), listAgents: vi.fn(() => []) },
  storeAgent: { disableDefaultAgents: false },
  runtimeSettings: undefined as any,
  nextId: 0,
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: state.validate,
  revalidateWorktreePath: state.revalidate,
}));
vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getAgentConfig: vi.fn((name: string) => ({ name, description: name, systemPrompt: "instructions" })),
  discoverNewAgents: state.discover,
  resolveAgentCatalog: vi.fn(async () => new Map([["reviewer", { name: "reviewer", description: "reviewer", systemPrompt: "instructions" }]])),
  resolveProjectFreeAgentCatalog: vi.fn(async () => new Map([["reviewer", { name: "reviewer", description: "reviewer", systemPrompt: "instructions" }]])),
  resolveTypeInCatalog: vi.fn((catalog: Map<string, unknown>, type: string) => catalog.has(type) ? type : undefined),
}));
vi.mock("../../src/shell.js", () => {
  const coordinator = { spawn: state.coordinatorSpawn };
  return {
  getStore: () => ({
    agent: state.storeAgent,
    createSubagentRuntimeSettings: () => state.runtimeSettings,
  }),
  getPiInstance: () => ({ exec: vi.fn() }),
  getSessionCtx: () => ({ cwd: "/parent/project" }),
  getManager: () => state.managerAvailable ? state.manager : null,
  getCoordinator: () => state.coordinatorAvailable ? coordinator : null,
  getSubagentRuntimeContext: () => undefined,
};
});

import { executeAgentTool } from "../../src/agents/tool-execution.js";

function record(id: string, type: string, prompt: string): any {
  return {
    id,
    lifecycle: { status: "completed", startedAt: 1, completedAt: 2, settled: true },
    display: { type, description: prompt },
    execution: {},
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      cacheRead: 0,
      compactionCount: 0,
      executions: [{ id: "execution", prompt, kind: "new", status: "completed", startedAt: 1, completedAt: 2, responseText: "complete" }],
    },
    result: "complete",
  };
}

beforeEach(() => {
  state.validate.mockReset();
  state.revalidate.mockReset();
  state.discover.mockReset();
  state.coordinatorSpawn.mockReset();
  state.coordinatorAvailable = true;
  state.managerAvailable = true;
  state.manager.getRecord.mockReset();
  state.manager.listAgents.mockReset().mockReturnValue([]);
  state.runtimeSettings = undefined;
  state.nextId = 0;
  state.validate.mockResolvedValue({ ok: true, resolvedPath: "/parent/worktree", worktreeRoot: "/parent", label: "worktree" } satisfies WorktreeValidationResult);
  state.revalidate.mockResolvedValue({ ok: true, resolvedPath: "/parent/worktree", worktreeRoot: "/parent", label: "worktree" } satisfies WorktreeValidationResult);
  state.coordinatorSpawn.mockImplementation(async (_pi: unknown, _ctx: unknown, resolved: any, onAccepted?: (value: any) => void) => {
    const id = `agent-${++state.nextId}`;
    const current = record(id, resolved.type, resolved.prompt);
    onAccepted?.(current);
    return { agentId: id, record: current, responseText: `full response for ${resolved.prompt}` };
  });
});

afterEach(() => vi.restoreAllMocks());

describe("executeAgentTool foreground boundary", () => {
  it("validates worktree input, passes the immutable resolved snapshot, and returns the full response", async () => {
    const ctx = fakeCtx();
    ctx.isProjectTrusted = () => true;
    const updates: any[] = [];
    const result = await executeAgentTool(
      "call-1",
      { agent: "reviewer", prompt: "inspect the worktree", worktree_path: "feature" },
      undefined,
      (update) => updates.push(update),
      ctx,
    );

    expect(state.validate).toHaveBeenCalledWith(expect.anything(), "feature", "/parent/project", expect.any(Function));
    expect(state.coordinatorSpawn).toHaveBeenCalledTimes(1);
    const resolved = state.coordinatorSpawn.mock.calls[0]![2];
    expect(resolved.worktreePath).toBe("/parent/worktree");
    expect(resolved).not.toHaveProperty(["removed", "Execution", "Switch"].join(""));
    expect(result.content[0].text).toContain("full response for inspect the worktree");
    expect(result.content[0].text).toContain("Agent ID: agent-1");
    expect(updates.length).toBeGreaterThan(0);
  });

  it("returns a root-readiness error before preflight when the session is unavailable", async () => {
    state.coordinatorAvailable = false;
    state.managerAvailable = false;
    const result = await executeAgentTool(
      "call-unavailable",
      { agent: "reviewer", prompt: "wait" },
      undefined,
      undefined,
      fakeCtx(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("unavailable until the root session is ready");
    expect(state.validate).not.toHaveBeenCalled();
  });

  it("treats a trust probe exception as an untrusted project", async () => {
    const ctx = fakeCtx();
    ctx.isProjectTrusted = () => { throw new Error("trust probe failed"); };
    await executeAgentTool("call-trust-error", { agent: "reviewer", prompt: "inspect" }, undefined, undefined, ctx);
    expect(state.coordinatorSpawn).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ projectTrusted: false }),
      expect.any(Function),
    );
  });

  it("flushes preflight warnings and returns the validation error", async () => {
    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };
    state.validate.mockImplementationOnce((_pi, _path, _cwd, onWarning) => {
      onWarning?.("worktree warning");
      return Promise.resolve({ ok: false, error: "worktree rejected" });
    });
    const result = await executeAgentTool(
      "call-warning",
      { agent: "reviewer", prompt: "inspect", worktree_path: "feature" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toContain("worktree rejected");
    expect(ctx.ui.notify).toHaveBeenCalledWith("[pi-subagents-lean] worktree warning", "warning");
  });

  it("returns a cancellation result when rendering aborts after preflight", async () => {
    const controller = new AbortController();
    const result = await executeAgentTool(
      "call-render-abort",
      { agent: "reviewer", prompt: "abort during render" },
      controller.signal,
      () => controller.abort(),
      fakeCtx(),
    );
    expect(result).toMatchObject({ isError: true, content: [{ text: "Agent execution cancelled" }] });
    expect(state.coordinatorSpawn).not.toHaveBeenCalled();
  });

  it("returns a root-readiness error when the session disappears after render metadata", async () => {
    const result = await executeAgentTool(
      "call-stale-root",
      { agent: "reviewer", prompt: "stale root" },
      undefined,
      () => { state.coordinatorAvailable = false; },
      fakeCtx(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("unavailable until the root session is ready");
  });

  it("returns coordinator failures and converts post-start cancellation", async () => {
    state.coordinatorSpawn.mockRejectedValueOnce(new Error("spawn failed"));
    const failure = await executeAgentTool("call-spawn-error", { agent: "reviewer", prompt: "fail" }, undefined, undefined, fakeCtx());
    expect(failure.content[0].text).toBe("spawn failed");

    const controller = new AbortController();
    state.coordinatorSpawn.mockImplementationOnce(async () => {
      await Promise.resolve();
      controller.abort();
      throw new Error("late failure");
    });
    await expect(executeAgentTool("call-spawn-cancel", { agent: "reviewer", prompt: "cancel" }, controller.signal, undefined, fakeCtx()))
      .resolves.toMatchObject({ content: [{ text: "Agent execution cancelled" }] });
  });

  it("returns terminal stopped, error, and successful foreground results", async () => {
    const stopped = record("terminal-stopped", "reviewer", "stopped");
    stopped.lifecycle.status = "stopped";
    state.coordinatorSpawn.mockResolvedValueOnce({ agentId: stopped.id, record: stopped, responseText: "partial" });
    await expect(executeAgentTool("call-stopped", { agent: "reviewer", prompt: "stopped" }, undefined, undefined, fakeCtx()))
      .resolves.toMatchObject({ content: [{ text: "Agent execution cancelled" }] });

    const failed = record("terminal-error", "reviewer", "failed");
    failed.lifecycle.status = "error";
    failed.error = "";
    state.coordinatorSpawn.mockResolvedValueOnce({ agentId: failed.id, record: failed, responseText: "" });
    await expect(executeAgentTool("call-error", { agent: "reviewer", prompt: "failed" }, undefined, undefined, fakeCtx()))
      .resolves.toMatchObject({ isError: true, content: [{ text: "Agent failed: unknown error" }] });
  });

  it("returns a validation error and never spawns for an invalid worktree", async () => {
    state.validate.mockResolvedValue({ ok: false, error: "worktree_path is outside the repository" });
    const result = await executeAgentTool(
      "call-2",
      { agent: "reviewer", prompt: "inspect", worktree_path: "../outside" },
      undefined,
      undefined,
      fakeCtx(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("outside the repository");
    expect(state.coordinatorSpawn).not.toHaveBeenCalled();
  });

  it("honors cancellation before any preflight or spawn work", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeAgentTool(
      "call-3",
      { agent: "reviewer", prompt: "do not run" },
      controller.signal,
      undefined,
      fakeCtx(),
    );
    expect(result).toMatchObject({ isError: true, content: [{ text: "Agent execution cancelled" }] });
    expect(state.validate).not.toHaveBeenCalled();
    expect(state.coordinatorSpawn).not.toHaveBeenCalled();
  });

  it("keeps model/thinking and worktree resolution out of the public parameters", async () => {
    const result = await executeAgentTool(
      "call-4",
      { agent: "reviewer", prompt: "self-contained", model: "ignored", thinking: "ignored" },
      undefined,
      undefined,
      fakeCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(state.coordinatorSpawn.mock.calls[0]![2]).not.toHaveProperty("modelOverride");
  });
});
