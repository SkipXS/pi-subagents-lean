/**
 * worktree-tool-execution.test.ts — Acceptance tests for worktree_path
 * validation in the Agent tool execution flow.
 *
 * Verifies:
 *   - Valid worktree_path: validator is called, spawn uses resolved path as cwd
 *   - Invalid worktree_path: validator error returned to LLM, no spawn
 *   - Omitted worktree_path: no validator call, spawn uses parent cwd
 *   - Error details from validator are surfaced to the LLM
 *
 * Tests the integration boundary between executeAgentTool and the validator.
 * Mocks the validator module and the spawn flow; tests observable behavior
 * (tool result content) not internal call order.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorktreeValidationResult } from "../../src/spawn/worktree-validator.js";
import { fakeCtx } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

// Use vi.hoisted so mock factories can reference these at hoisting time
const {
  mockValidateWorktreePath,
  mockRevalidateWorktreePath,
  mockSpawn,
  mockGetRecord,
  mockDiscoverNewAgents,
  mockResolveWorktreeAgent,
  mockResolveAgentCatalog,
  mockCoordinatorSpawn,
  runtimeSettingsSnapshot,
  liveStoreAgent,
} = vi.hoisted(() => ({
  runtimeSettingsSnapshot: { current: undefined as any },
  liveStoreAgent: { current: {} },
  mockValidateWorktreePath: vi.fn(),
  mockRevalidateWorktreePath: vi.fn(async (_pi: unknown, path: string): Promise<WorktreeValidationResult> => ({
    ok: true, resolvedPath: path, worktreeRoot: path, label: "feature",
  })),
  mockSpawn: vi.fn().mockReturnValue("agent-id-123"),
  mockGetRecord: vi.fn(),
  mockDiscoverNewAgents: vi.fn(),
  mockResolveWorktreeAgent: vi.fn((type: string) => ({
    type,
    config: { thinkingLevel: undefined },
  })),
  mockResolveAgentCatalog: vi.fn(async () => new Map<string, any>([["general-purpose", { thinkingLevel: undefined }]])),
  mockCoordinatorSpawn: vi.fn(async (_pi: any, _ctx: any, intent: any) => {
    const id = mockSpawn(_pi, _ctx, intent.type, intent.prompt, {
      description: intent.description,
      agentConfig: intent.agentConfig,
      model: intent.model,
      invocation: intent.invocation,
      thinkingLevel: intent.thinkingLevel,
      modelKey: intent.modelKey,
      projectTrusted: intent.projectTrusted,
      worktreePath: intent.worktreePath,
      worktreeLabel: intent.worktreeLabel,
      worktreeParentCwd: intent.worktreeParentCwd,
      worktreeSelectionPath: intent.worktreeSelectionPath,
      isBackground: intent.runInBackground,
      signal: intent.signal,
    });
    const record = mockGetRecord(id);
    if (!intent.runInBackground && record?.execution?.promise) {
      await record.execution.promise;
    }
    return { agentId: id, record };
  }),
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mockValidateWorktreePath,
  revalidateWorktreePath: mockRevalidateWorktreePath,
  computeLabel: vi.fn((resolved: string, root: string) => {
    if (resolved === root) return root.split("/").pop() || root;
    const rel = resolved.slice(root.length + 1);
    return `${root.split("/").pop()}/${rel}`;
  }),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((type: string) => type),
  getAgentConfig: vi.fn(() => ({ thinkingLevel: undefined })),
  discoverNewAgents: mockDiscoverNewAgents,
  resolveWorktreeAgent: mockResolveWorktreeAgent,
  resolveAgentCatalog: mockResolveAgentCatalog,
  resolveTypeInCatalog: vi.fn((catalog: Map<string, unknown>, type: string) => catalog.has(type) ? type : undefined),
}));

vi.mock("../../src/utils.js", () => ({
  findModelInRegistry: vi.fn(() => null),
}));

vi.mock("../../src/shell.js", () => {
  const coordinator = {
    spawn: mockCoordinatorSpawn,
    isBackground: vi.fn(() => false),
    scheduleNudge: vi.fn(),
    onAgentComplete: vi.fn(),
    dispose: vi.fn(),
  };
  return {
  createSubagentRuntimeContext: () => Object.freeze({ isChildRuntime: true as const }),
  runWithSubagentRuntime: (_runtime: unknown, work: () => Promise<unknown>) => work(),
  getStore: () => ({
    get agent() {
      return liveStoreAgent.current;
    },
    createSubagentRuntimeSettings: () => runtimeSettingsSnapshot.current,
  }),
  getPiInstance: () => ({ sendMessage: vi.fn(), exec: vi.fn() }),
  getSessionCtx: () => ({ cwd: "/home/test/project" }),
  getManager: () => ({
    spawn: mockSpawn,
    getRecord: mockGetRecord,
    listAgents: vi.fn(() => []),
    getTotalAgentCost: vi.fn(() => 0),
    abort: vi.fn(() => false),
  }),
  getCoordinator: () => coordinator,
};
});

vi.mock("../../src/agents/usage.js", () => ({
  getSessionUsageSnapshot: vi.fn(() => undefined),
  addUsage: vi.fn(),
  getLifetimeTotal: vi.fn(() => 0),
}));

// Import after mocks are in place
import {
  executeAgentTool,
  formatForegroundAgentResultContent,
} from "../../src/agents/tool-execution.js";
import { AGENT_RENDER_DETAILS_KEY } from "../../src/agents/agent-renderer.js";
import * as agentTypes from "../../src/agents/agent-types.js";
import * as utils from "../../src/utils.js";

afterEach(() => {
  runtimeSettingsSnapshot.current = undefined;
  liveStoreAgent.current = {};
});

/* ------------------------------------------------------------------ */
/*  Factories                                                         */
/* ------------------------------------------------------------------ */

function makeParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: "Do something useful",
    description: "Test agent",
    agent: "general-purpose",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("executeAgentTool — explicit agent type", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeSettingsSnapshot.current = undefined;
    ctx = fakeCtx();
  });

  it("fails clearly when the agent type is missing", async () => {
    const result = await executeAgentTool(
      "tc-missing-type",
      makeParams({ agent: undefined }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Agent type is required");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("fails clearly for an unknown agent type", async () => {
    (agentTypes.resolveType as any).mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);

    const result = await executeAgentTool(
      "tc-unknown-type",
      makeParams({ agent: "unknown-agent" }),
      undefined,
      undefined,
      ctx,
    );

    expect(mockDiscoverNewAgents).toHaveBeenCalledWith({ disableDefaultAgents: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown agent type: unknown-agent");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does not spawn when cancellation wins an asynchronous discovery preflight", async () => {
    let releaseDiscovery!: () => void;
    const discovery = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    mockDiscoverNewAgents.mockReturnValueOnce(discovery);
    (agentTypes.resolveType as any).mockReturnValueOnce(undefined);
    const controller = new AbortController();

    const run = executeAgentTool(
      "cancelled-preflight",
      makeParams(),
      controller.signal,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(mockDiscoverNewAgents).toHaveBeenCalledOnce());
    controller.abort();
    releaseDiscovery();

    const result = await run;
    expect(result.content[0].text).toBe("Agent execution cancelled");
    expect(mockCoordinatorSpawn).not.toHaveBeenCalled();
  });

  it("publishes resolved Markdown model and normalized thinking metadata", async () => {
    const model = { provider: "openai", id: "gpt-4o", reasoning: true };
    (agentTypes.getAgentConfig as any).mockReturnValueOnce({
      model: "openai/gpt-4o", thinkingLevel: "high", name: "general-purpose", description: "Test", systemPrompt: "",
    });
    const record = {
      id: "agent-render-details", result: "done",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: 0, completedAt: 1 },
      execution: { session: { model, thinkingLevel: "low" } },
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, compactionCount: 0 },
    };
    mockGetRecord.mockReturnValueOnce(record);
    (utils.findModelInRegistry as any).mockReturnValueOnce(model);
    const onUpdate = vi.fn();
    const prompt = "first line\nsecond line";

    const result = await executeAgentTool(
      "tc-render-details",
      makeParams({ prompt }),
      undefined,
      onUpdate,
      ctx,
    );

    expect(onUpdate).toHaveBeenCalledWith({
      content: [],
      details: {
        [AGENT_RENDER_DETAILS_KEY]: {
          role: "general-purpose",
          model: "openai/gpt-4o",
          thinking: "high",
          prompt,
          mode: "foreground",
          kind: "new",
        },
      },
    });
    expect(result.content[0].text).toBe("Agent ID: agent-render-details\n\nResponse:\ndone");
    expect(result.details.agentId).toBe("agent-render-details");
    expect(result.details[AGENT_RENDER_DETAILS_KEY]).toEqual({
      role: "general-purpose",
      model: "openai/gpt-4o",
      thinking: "low",
      prompt,
      mode: "foreground",
      kind: "new",
    });
  });

  it("keeps the canonical ID visible when a foreground agent returns no text", async () => {
    mockGetRecord.mockReturnValueOnce({
      id: "agent-empty-result",
      result: "",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: 0, completedAt: 1 },
      execution: {},
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, cacheRead: 0, compactionCount: 0 },
    });

    const result = await executeAgentTool("tc-empty-result", makeParams(), undefined, undefined, ctx);

    expect(result.content[0].text).toBe("Agent ID: agent-empty-result\n\nResponse:\n");
    expect(result.details.agentId).toBe("agent-empty-result");
  });

  it("preserves an existing status note after the canonical ID", () => {
    const text = formatForegroundAgentResultContent({
      id: "agent-partial-result",
      result: "partial",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "stopped", stoppedBy: "agent", startedAt: 0, completedAt: 1 },
      execution: {},
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, cacheRead: 0, compactionCount: 0 },
    });

    expect(text).toBe(
      "Agent ID: agent-partial-result\n\nResponse:\npartial (stopped before completion — output is partial; the task was NOT finished)",
    );
  });

  it("ignores non-schema model and thinking fields from the caller", async () => {
    const model = { provider: "markdown", id: "role-model", reasoning: true };
    (agentTypes.getAgentConfig as any).mockReturnValueOnce({
      name: "general-purpose", description: "Test", systemPrompt: "",
      model: "markdown/role-model", thinkingLevel: "high",
    });
    (utils.findModelInRegistry as any).mockReturnValueOnce(model);
    mockGetRecord.mockReturnValueOnce({
      id: "agent-markdown-settings", result: "done",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: 0, completedAt: 1 }, execution: {},
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, compactionCount: 0 },
    });

    await executeAgentTool(
      "tc-markdown-settings",
      makeParams({ model: "caller/model", thinking: "low" }),
      undefined,
      undefined,
      ctx,
    );

    expect(mockCoordinatorSpawn).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ model, thinkingLevel: "high" }),
    );
  });

  it("keeps foreground terminal failures on the ToolResult contract", async () => {
    const terminalCases = [
      { status: "error", error: "runner setup failed", expected: "Agent failed: runner setup failed" },
      { status: "aborted", error: undefined, expected: "Agent execution cancelled" },
      { status: "stopped", error: undefined, expected: "Agent execution cancelled" },
    ] as const;

    for (const { status, error, expected } of terminalCases) {
      mockGetRecord.mockReturnValueOnce({
        id: `terminal-${status}`,
        result: "partial response",
        error,
        display: { type: "general-purpose", description: "Test agent" },
        lifecycle: { status, startedAt: 0, completedAt: 1 },
        execution: { promise: Promise.resolve("partial response") },
        stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, compactionCount: 0 },
      });

      const result = await executeAgentTool(`terminal-${status}`, makeParams(), undefined, undefined, ctx);

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(expected);
    }
  });

  it("returns a spawn setup failure as an error result", async () => {
    mockCoordinatorSpawn.mockRejectedValueOnce(new Error("spawn setup failed"));

    const result = await executeAgentTool("spawn-failure", makeParams(), undefined, undefined, ctx);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe("spawn setup failed");
  });

  it("reports cancellation when the root coordinator rejects after cancellation", async () => {
    let rejectSpawn!: (error: Error) => void;
    const pendingSpawn = new Promise<never>((_resolve, reject) => { rejectSpawn = reject; });
    mockCoordinatorSpawn.mockReturnValueOnce(pendingSpawn);
    const controller = new AbortController();

    const run = executeAgentTool("cancelled-spawn", makeParams(), controller.signal, undefined, ctx);
    await vi.waitFor(() => expect(mockCoordinatorSpawn).toHaveBeenCalledOnce());
    controller.abort();
    rejectSpawn(new Error("root coordinator failed after cancellation"));

    const result = await run;
    expect(result.content[0].text).toBe("Agent execution cancelled");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});


describe("executeAgentTool — worktree_path validation", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: { promise: Promise.resolve("done") },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
      },
    });
  });

  it("forwards the parent abort signal to the spawn coordinator", async () => {
    const signal = new AbortController().signal;

    await executeAgentTool("tc-parent-abort", makeParams(), signal, undefined, ctx);

    expect(mockCoordinatorSpawn).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ signal }),
    );
    expect(mockSpawn.mock.calls[0][4].signal).toBe(signal);
  });

  it("snapshots parent trust before an asynchronous worktree preflight", async () => {
    let trusted = true;
    ctx.isProjectTrusted = vi.fn(() => trusted);
    let releaseValidation!: () => void;
    const validation = new Promise<void>((resolve) => { releaseValidation = resolve; });
    mockValidateWorktreePath.mockImplementationOnce(async () => {
      await validation;
      return { ok: true, resolvedPath: "/wt/feature", worktreeRoot: "/wt/feature", label: "feature" };
    });

    const run = executeAgentTool(
      "tc-trust-snapshot",
      makeParams({ worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(mockValidateWorktreePath).toHaveBeenCalledOnce());
    trusted = false;
    releaseValidation();
    await run;

    expect(ctx.isProjectTrusted).toHaveBeenCalledOnce();
    expect(mockCoordinatorSpawn).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ projectTrusted: true }),
    );
    const spawnArgument = mockCoordinatorSpawn.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Object.isFrozen(spawnArgument)).toBe(true);
    expect(Object.keys(spawnArgument).some((key) => key === "resolvedSpawn")).toBe(false);
  });

  it("returns a cancellation error when the parent aborts after foreground start", async () => {
    const parent = new AbortController();
    const record = {
      id: "agent-cancelled",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "stopped", startedAt: Date.now(), completedAt: Date.now(), resultConsumed: true },
      execution: {},
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
      },
    };
    mockCoordinatorSpawn.mockImplementationOnce(async () => {
      // The real manager bridges this signal to its own child controller; this
      // boundary test observes the foreground tool contract after that start.
      parent.abort();
      return { agentId: record.id, record };
    });

    const result = await executeAgentTool("tc-abort-after-start", makeParams(), parent.signal, undefined, ctx);

    expect(mockCoordinatorSpawn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe("Agent execution cancelled");
  });

  it("returns a cancellation error when the parent aborts during a background spawn", async () => {
    const parent = new AbortController();
    const record = {
      id: "agent-background-cancelled",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "stopped", startedAt: Date.now(), completedAt: Date.now(), resultConsumed: true },
      execution: {},
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
      },
    };
    mockCoordinatorSpawn.mockImplementationOnce(async () => {
      parent.abort();
      return { agentId: record.id, record };
    });

    const result = await executeAgentTool(
      "tc-background-abort-during-spawn",
      makeParams({ run_in_background: true }),
      parent.signal,
      undefined,
      ctx,
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe("Agent execution cancelled");
  });

  it("uses local worktree model and thinking for the spawned display", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true, resolvedPath: "/wt/feature", worktreeRoot: "/wt/feature", label: "feature",
    });
    ctx.isProjectTrusted = () => true;
    mockResolveAgentCatalog.mockResolvedValueOnce(new Map([[
      "general-purpose", { model: "openai/gpt-4o", thinkingLevel: "high" },
    ]]));
    const utils = await import("../../src/utils.js");
    (utils.findModelInRegistry as any).mockReturnValueOnce({ provider: "openai", id: "gpt-4o", reasoning: true });

    await executeAgentTool("tc-local-display", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    expect(mockSpawn.mock.calls[0][4]).toMatchObject({
      agentConfig: { model: "openai/gpt-4o", thinkingLevel: "high" },
      model: { provider: "openai", id: "gpt-4o" },
      thinkingLevel: "high",
      invocation: { modelName: "gpt-4o" },
    });
  });

  it("does not load a worktree overlay or spawn when revalidation finds a deleted path", async () => {
    mockValidateWorktreePath.mockResolvedValueOnce({
      ok: true, resolvedPath: "/wt/feature", worktreeRoot: "/wt/feature", label: "feature",
    });
    mockRevalidateWorktreePath.mockResolvedValueOnce({
      ok: false, error: "worktree_path does not exist: the specified path was not found on disk",
    });
    ctx.isProjectTrusted = () => true;

    const result = await executeAgentTool("tc-worktree-deleted", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("does not exist");
    expect(mockResolveAgentCatalog).not.toHaveBeenCalled();
    expect(mockCoordinatorSpawn).not.toHaveBeenCalled();
  });

  it("retains the raw selection with its canonical worktree for runner revalidation", async () => {
    mockValidateWorktreePath.mockResolvedValueOnce({
      ok: true, resolvedPath: "/real/worktree", worktreeRoot: "/real/worktree", label: "worktree",
    });
    mockRevalidateWorktreePath.mockResolvedValueOnce({
      ok: true, resolvedPath: "/real/worktree", worktreeRoot: "/real/worktree", label: "worktree",
    });
    ctx.isProjectTrusted = () => true;

    await executeAgentTool("tc-worktree-metadata", makeParams({ worktree_path: "/links/worktree" }), undefined, undefined, ctx);

    expect(mockSpawn.mock.calls[0][4]).toMatchObject({
      worktreePath: "/real/worktree",
      worktreeSelectionPath: "/links/worktree",
      worktreeParentCwd: "/home/test/project",
    });
  });

  it("calls the validator when worktree_path is provided", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });

    await executeAgentTool("tc-1", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    expect(mockValidateWorktreePath).toHaveBeenCalledTimes(1);
    expect(mockValidateWorktreePath).toHaveBeenCalledWith(
      expect.anything(), // pi
      "/wt/feature",
      expect.any(String), // parent cwd
      expect.any(Function), // onWarning
    );
  });

  it("returns an error when worktree_path validation fails", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "Path '/etc' is not inside a git repository",
    });

    const result = await executeAgentTool(
      "tc-2",
      makeParams({ worktree_path: "/etc" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not inside a git repository");
    // Should NOT have spawned
    expect(mockSpawn).not.toHaveBeenCalled();
  });
  it("flushes validator warnings via ctx.ui.notify on validation failure", async () => {
    // Mock validateWorktreePath to invoke the onWarning callback before returning failure
    mockValidateWorktreePath.mockImplementation((_pi, _path, _cwd, onWarning) => {
      onWarning?.("git rev-parse --path-format=absolute --git-common-dir failed in /etc: EACCES permission denied");
      return Promise.resolve({ ok: false, error: "worktree_path validation failed: git rev-parse failed: EACCES permission denied" });
    });

    ctx.ui = { notify: vi.fn() };
    const result = await executeAgentTool(
      "tc-warn",
      makeParams({ worktree_path: "/etc" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[pi-subagents-lean] git rev-parse --path-format=absolute --git-common-dir failed in /etc: EACCES permission denied",
      "warning",
    );
  });


  it("does not call the validator when worktree_path is omitted", async () => {
    await executeAgentTool("tc-3", makeParams(), undefined, undefined, ctx);

    expect(mockValidateWorktreePath).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("uses the resolved worktree path as cwd when validation succeeds", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });

    await executeAgentTool("tc-4", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    // Verify spawn was called and worktree path was set on the record
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // worktreePath is set on the record's display AFTER spawn, not in spawn options
    // Verify spawn received the worktree path via options
    const spawnCall = mockSpawn.mock.calls[0];
    const spawnOptions = spawnCall[4]; // options is 5th arg (pi, ctx, type, prompt, options)
    expect(spawnOptions.worktreePath).toBe("/wt/feature");
  });

  it("surfaces specific validator error reasons to the LLM", async () => {
    const rejectionReasons = [
      { error: "Path does not exist", match: "does not exist" },
      { error: "Path is not a directory", match: "not a directory" },
      { error: "Path is not inside a git repository", match: "not inside a git" },
      { error: "Path is inside a git repository that is not the parent's", match: "not the parent" },
      { error: "Parent itself is not in a git repository", match: "Parent" },
    ];

    for (const { error, match } of rejectionReasons) {
      vi.clearAllMocks();
      mockValidateWorktreePath.mockResolvedValue({ ok: false, error });

      const result = await executeAgentTool(
        "tc-err",
        makeParams({ worktree_path: "/some/path" }),
        undefined,
        undefined,
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(match);
    }
  });

  it("returns a successful result when worktree_path is valid", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });
    // Foreground spawn completes immediately
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      result: "Agent completed successfully",
      display: { type: "general-purpose", description: "Test agent", worktreeLabel: "feature" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("Agent completed successfully") },
      stats: {
        lifetimeUsage: { input: 100, output: 50, cacheWrite: 0, cost: 0.01 },
        compactionCount: 0,
      },
    });

    const result = await executeAgentTool(
      "tc-ok",
      makeParams({ worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Agent ID: agent-id-123\n\nResponse:\nAgent completed successfully");
    expect(result.details.agentId).toBe("agent-id-123");
  });

  it("does not crash the parent when validator throws unexpectedly", async () => {
    mockValidateWorktreePath.mockRejectedValue(new Error("Unexpected filesystem error"));

    const result = await executeAgentTool(
      "tc-crash",
      makeParams({ worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    // Should return an error result, not throw
    expect(result.isError).toBe(true);
  });
});

describe("executeAgentTool — worktree_path with background spawn", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockGetRecord.mockReturnValue({
      id: "agent-id-bg",
      display: { type: "general-purpose", description: "Test agent", worktreeLabel: "feature" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: {},
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
      },
    });
  });

  it("validates worktree_path for background spawns too", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });

    const result = await executeAgentTool(
      "tc-bg",
      makeParams({ worktree_path: "/wt/feature", run_in_background: true }),
      undefined,
      undefined,
      ctx,
    );

    expect(mockValidateWorktreePath).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("running");
  });

  it("reports an already terminal background record instead of saying it is running", async () => {
    mockGetRecord.mockReturnValue({
      id: "agent-id-stopped",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "stopped", startedAt: Date.now(), completedAt: Date.now() },
      execution: {},
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
      },
    });

    const result = await executeAgentTool(
      "tc-bg-stopped",
      makeParams({ run_in_background: true }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("[Agent stopped]");
    expect(result.content[0].text).not.toContain("Agent running");
    expect(result.content[0].text).not.toContain("A notification will arrive");
  });

  it("returns error for invalid worktree_path in background spawn", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "Path does not exist",
    });

    const result = await executeAgentTool(
      "tc-bg-err",
      makeParams({ worktree_path: "/nonexistent", run_in_background: true }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("executeAgentTool — worktree_path discovery integration", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockGetRecord.mockReturnValue({
      id: "agent-id-disc",
      result: "Agent completed successfully",
      display: { type: "feature-reviewer", description: "Reviews feature" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("Agent completed successfully") },
      stats: {
        lifetimeUsage: { input: 100, output: 50, cacheWrite: 0, cost: 0.01 },
        compactionCount: 0,
      },
    });
  });

  it("resolves a worktree type locally before spawning", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });
    ctx.isProjectTrusted = () => true;
    mockResolveAgentCatalog.mockResolvedValueOnce(new Map([[
      "feature-reviewer", { thinkingLevel: undefined },
    ]]));

    await executeAgentTool(
      "tc-disc",
      makeParams({ agent: "feature-reviewer", worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    // Worktree resolution uses an invocation-local catalog and never refreshes the parent registry.
    expect(mockResolveAgentCatalog).toHaveBeenCalledWith(
      "/wt/feature/.pi/agents",
      { disableDefaultAgents: undefined },
    );
    expect(mockDiscoverNewAgents).not.toHaveBeenCalled();
  });

  it("refreshes discovery without a worktree dir before resolving the type", async () => {
    const resolveTypeSpy = vi.spyOn(agentTypes, "resolveType");
    resolveTypeSpy.mockReturnValueOnce(undefined).mockReturnValueOnce("feature-reviewer");

    await executeAgentTool(
      "tc-disc-no-wt",
      makeParams({ agent: "feature-reviewer" }),
      undefined,
      undefined,
      ctx,
    );

    // Non-worktree discovery refreshes the parent registry.
    expect(mockDiscoverNewAgents).toHaveBeenCalledTimes(1);
    expect(mockDiscoverNewAgents).toHaveBeenCalledWith({ disableDefaultAgents: undefined });
  });
});
