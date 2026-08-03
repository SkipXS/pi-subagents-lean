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
  mockModelFor,
  mockModelSettingFor,
  mockThinkingSettingFor,
  mockCoordinatorSpawn,
  runtimeSettingsSnapshot,
  liveStoreAgent,
} = vi.hoisted(() => ({
  runtimeSettingsSnapshot: { current: undefined as any },
  liveStoreAgent: { current: { forceBackground: false } },
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
  mockModelFor: vi.fn((_: string, parentModelId: string, agentConfig?: any) => agentConfig?.model ?? parentModelId),
  mockModelSettingFor: vi.fn((_: string, parentModelId: string, agentConfig?: any, explicitModel?: string) => ({
    value: explicitModel ?? agentConfig?.model ?? parentModelId,
    source: explicitModel ? "spawn" : "parent",
  })),
  mockThinkingSettingFor: vi.fn((_: string, parentThinking: any, agentConfig?: any, explicitThinking?: any) => ({
    value: explicitThinking ?? agentConfig?.thinkingLevel ?? parentThinking,
    source: explicitThinking ? "spawn" : "parent",
  })),
  mockCoordinatorSpawn: vi.fn(async (_pi: any, _ctx: any, intent: any) => {
    const id = mockSpawn(_pi, _ctx, intent.type, intent.prompt, {
      description: intent.description,
      agentConfig: intent.agentConfig,
      model: intent.model,
      invocation: intent.invocation,
      thinkingLevel: intent.thinkingLevel,
      modelKey: intent.modelKey,
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

vi.mock("../../src/models/model-precedence.js", () => ({
  resolveModel: vi.fn(() => undefined),
  resolveModelSetting: vi.fn(() => ({ value: "", source: "parent" })),
  resolveThinkingSetting: vi.fn(() => ({ value: undefined, source: "parent" })),
}));

vi.mock("../../src/utils.js", () => ({
  parseModelKey: vi.fn(() => null),
  findModelInRegistry: vi.fn(() => null),
  parseThinkingLevel: vi.fn((value?: string) => value),
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
    modelFor: mockModelFor,
    modelSettingFor: mockModelSettingFor,
    thinkingSettingFor: mockThinkingSettingFor,
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
import { executeAgentTool, toolCallListener } from "../../src/agents/tool-execution.js";
import { AGENT_RENDER_DETAILS_KEY } from "../../src/agents/agent-renderer.js";
import * as agentTypes from "../../src/agents/agent-types.js";
import * as utils from "../../src/utils.js";

afterEach(() => {
  runtimeSettingsSnapshot.current = undefined;
  liveStoreAgent.current = { forceBackground: false };
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

describe("toolCallListener — canonical agent settings", () => {
  it("shows a model resolved from agent settings in invocation metadata", async () => {
    vi.clearAllMocks();
    mockModelFor.mockReturnValueOnce("openai/gpt-4o");
    (utils.parseModelKey as any).mockReturnValueOnce({ provider: "openai", modelId: "gpt-4o" });
    const input: Record<string, unknown> = { agent: "reviewer", prompt: "inspect" };

    await toolCallListener({ toolName: "Agent", input } as any, fakeCtx() as any);

    expect(input.model).toBe("openai/gpt-4o");
    expect(input._modelOverride).toBe("gpt-4o");
  });

  it("uses the canonical type for case-insensitive agent names", async () => {
    vi.clearAllMocks();
    (agentTypes.resolveType as any).mockReturnValueOnce("explorer");

    await toolCallListener(
      { toolName: "Agent", input: { agent: "Explorer", prompt: "inspect" } } as any,
      fakeCtx() as any,
    );

    expect(mockModelFor).toHaveBeenCalledWith(
      "explorer",
      expect.any(String),
      expect.any(Object),
    );
    expect(mockThinkingSettingFor).toHaveBeenCalledWith(
      "explorer",
      undefined,
      expect.any(Object),
      undefined,
    );
  });

  it("does not inject parent model or thinking for a worktree call", async () => {
    vi.clearAllMocks();
    const input: Record<string, unknown> = {
      agent: "reviewer", prompt: "inspect", worktree_path: "/wt/feature",
    };

    await toolCallListener({ toolName: "Agent", input } as any, fakeCtx() as any);

    expect(input.model).toBeUndefined();
    expect(input.thinking).toBeUndefined();
    expect(mockModelFor).not.toHaveBeenCalled();
    expect(mockThinkingSettingFor).not.toHaveBeenCalled();
  });

  it("keeps an explicit worktree model in the invocation display metadata", async () => {
    vi.clearAllMocks();
    (utils.parseModelKey as any).mockReturnValueOnce({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
    const input: Record<string, unknown> = {
      agent: "reviewer",
      prompt: "inspect",
      worktree_path: "/wt/feature",
      model: "anthropic/claude-sonnet-4-20250514",
    };

    await toolCallListener({ toolName: "Agent", input } as any, fakeCtx() as any);

    expect(input._modelOverride).toBe("claude-sonnet-4-20250514");
    expect(mockModelFor).not.toHaveBeenCalled();
    expect(mockThinkingSettingFor).not.toHaveBeenCalled();
  });
});

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

  it("uses a detached runtime snapshot for model and thinking resolution", async () => {
    runtimeSettingsSnapshot.current = {
      agent: {},
      modelFor: vi.fn(() => "legacy/model"),
      thinkingSettingFor: vi.fn(() => ({ value: "low", source: "config-global" })),
    };
    (utils.findModelInRegistry as any).mockReturnValueOnce({ provider: "legacy", id: "model", reasoning: true });
    mockGetRecord.mockReturnValueOnce({
      id: "legacy-snapshot", result: "done",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: 0, completedAt: 1 }, execution: {},
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, compactionCount: 0 },
    });

    const result = await executeAgentTool("legacy-snapshot", makeParams(), undefined, undefined, ctx);

    expect(result.isError).toBeUndefined();
    expect(runtimeSettingsSnapshot.current.modelFor).toHaveBeenCalled();
    expect(runtimeSettingsSnapshot.current.thinkingSettingFor).toHaveBeenCalled();
    expect(mockCoordinatorSpawn).toHaveBeenCalledOnce();
  });

  it("publishes resolved renderer metadata in partial and final results", async () => {
    const model = { provider: "openai", id: "gpt-4o", reasoning: true };
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
      makeParams({ prompt, thinking: "high" }),
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
        },
      },
    });
    expect(result.content[0].text).toBe("done");
    expect(result.details[AGENT_RENDER_DETAILS_KEY]).toEqual({
      role: "general-purpose",
      model: "openai/gpt-4o",
      thinking: "low",
      prompt,
    });
  });

  it("keeps listener-injected settings distinct from explicit tool values at execution", async () => {
    const record = {
      id: "agent-settings", result: "done",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: 0, completedAt: 1 }, execution: {},
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, compactionCount: 0 },
    };
    mockGetRecord.mockReturnValueOnce(record);
    mockModelFor.mockReturnValueOnce("settings/model");
    mockThinkingSettingFor.mockReturnValueOnce({ value: "low", source: "config-global" });
    (utils.parseModelKey as any).mockReturnValueOnce({ provider: "settings", modelId: "model" });

    const injected = makeParams();
    await toolCallListener({ toolName: "Agent", input: injected } as any, ctx);
    expect(injected).toMatchObject({
      model: "settings/model", thinking: "low", _modelFromSettings: true, _thinkingFromSettings: true,
    });

    await executeAgentTool("injected-settings", injected, undefined, undefined, ctx);
    expect(mockModelSettingFor).toHaveBeenLastCalledWith(
      "general-purpose", expect.any(String), expect.any(Object), undefined,
    );
    expect(mockThinkingSettingFor).toHaveBeenLastCalledWith(
      "general-purpose", undefined, expect.any(Object), undefined,
    );

    vi.clearAllMocks();
    mockGetRecord.mockReturnValueOnce(record);
    (utils.parseModelKey as any)
      .mockReturnValueOnce({ provider: "explicit", modelId: "model" })
      .mockReturnValueOnce({ provider: "explicit", modelId: "model" })
      .mockReturnValueOnce({ provider: "explicit", modelId: "model" });
    ctx.modelRegistry.find.mockReturnValueOnce({ provider: "explicit", id: "model" });
    const explicit = makeParams({ model: "explicit/model", thinking: "high" });
    await toolCallListener({ toolName: "Agent", input: explicit } as any, ctx);
    expect(explicit._modelFromSettings).toBeUndefined();
    expect(explicit._thinkingFromSettings).toBeUndefined();

    await executeAgentTool("explicit-settings", explicit, undefined, undefined, ctx);
    expect(mockModelSettingFor).toHaveBeenLastCalledWith(
      "general-purpose", expect.any(String), expect.any(Object), "explicit/model",
    );
    expect(mockThinkingSettingFor).toHaveBeenLastCalledWith(
      "general-purpose", undefined, expect.any(Object), "high",
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

  it("applies internally supplied model and thinking settings", async () => {
    (utils.parseModelKey as any).mockReturnValueOnce({ provider: "openai", modelId: "gpt-4o" });
    ctx.modelRegistry.find.mockReturnValueOnce({ provider: "openai", id: "gpt-4o", reasoning: true });
    await executeAgentTool(
      "tc-explicit-settings",
      makeParams({ model: "openai/gpt-4o", thinking: "high" }),
      undefined,
      undefined,
      ctx,
    );

    expect(mockModelSettingFor).toHaveBeenCalledWith(
      "general-purpose",
      expect.any(String),
      expect.any(Object),
      "openai/gpt-4o",
    );
    expect(mockThinkingSettingFor).toHaveBeenCalledWith(
      "general-purpose",
      undefined,
      expect.any(Object),
      "high",
    );
    expect(mockSpawn.mock.calls[0][4].thinkingLevel).toBe("high");
    expect(mockSpawn.mock.calls[0][4].invocation).toMatchObject({
      thinkingLevel: "high",
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

  it("rejects an unknown explicit model instead of silently using the parent", async () => {
    (utils.parseModelKey as any).mockReturnValueOnce({ provider: "unknown", modelId: "model" });
    ctx.modelRegistry.find.mockReturnValueOnce(undefined);

    const result = await executeAgentTool(
      "tc-unknown-model",
      makeParams({ model: "unknown/model" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0]).toMatchObject({ type: "text", text: "Model not found: unknown/model" });
    expect(mockSpawn).not.toHaveBeenCalled();
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
    expect(result.content[0].text).toBe("Agent completed successfully");
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
