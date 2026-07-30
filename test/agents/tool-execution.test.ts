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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

// Use vi.hoisted so mock factories can reference these at hoisting time
const {
  mockValidateWorktreePath,
  mockSpawn,
  mockGetRecord,
  mockDiscoverNewAgents,
  mockResolveWorktreeAgent,
  mockResolveAgentCatalog,
  mockModelFor,
  mockModelSettingFor,
  mockThinkingSettingFor,
  mockCoordinatorSpawn,
  mockCoordinatorSpawnNested,
  mockNestedPreflight,
} = vi.hoisted(() => ({
  mockValidateWorktreePath: vi.fn(),
  mockSpawn: vi.fn().mockReturnValue("agent-id-123"),
  mockGetRecord: vi.fn(),
  mockDiscoverNewAgents: vi.fn(),
  mockResolveWorktreeAgent: vi.fn((type: string) => ({
    type,
    config: { maxTurns: 25, thinkingLevel: undefined },
  })),
  mockResolveAgentCatalog: vi.fn(async () => new Map<string, any>([["general-purpose", { maxTurns: 25, thinkingLevel: undefined }]])),
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
      maxTurns: intent.maxTurns,
      thinkingLevel: intent.thinkingLevel,
      modelKey: intent.modelKey,
      graceTurns: intent.graceTurns,
      worktreePath: intent.worktreePath,
      worktreeLabel: intent.worktreeLabel,
      isBackground: intent.runInBackground,
      signal: intent.signal,
    });
    const record = mockGetRecord(id);
    if (!intent.runInBackground && record?.execution?.promise) {
      await record.execution.promise;
    }
    return { agentId: id, record };
  }),
  mockCoordinatorSpawnNested: vi.fn(),
  mockNestedPreflight: vi.fn(),
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mockValidateWorktreePath,
  computeLabel: vi.fn((resolved: string, root: string) => {
    if (resolved === root) return root.split("/").pop() || root;
    const rel = resolved.slice(root.length + 1);
    return `${root.split("/").pop()}/${rel}`;
  }),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((type: string) => type),
  getAgentConfig: vi.fn(() => ({ maxTurns: 25, thinkingLevel: undefined })),
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
    spawnNested: mockCoordinatorSpawnNested,
    isBackground: vi.fn(() => false),
    scheduleNudge: vi.fn(),
    onAgentComplete: vi.fn(),
    dispose: vi.fn(),
  };
  return {
  createSubagentRuntimeContext: (executeNestedAgent: any, settings: any) => Object.freeze({
    isChildRuntime: true as const,
    executeNestedAgent,
    settings,
  }),
  runWithSubagentRuntime: (_runtime: unknown, work: () => Promise<unknown>) => work(),
  getStore: () => ({
    get agent() {
      return { graceTurns: 5, forceBackground: false, maxNestingDepth: 2 };
    },
    modelFor: mockModelFor,
    modelSettingFor: mockModelSettingFor,
    thinkingSettingFor: mockThinkingSettingFor,
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
  getWidget: () => ({
    ensureTimer: vi.fn(),
    update: vi.fn(),
  }),
  getCoordinator: () => coordinator,
};
});

vi.mock("../../src/agents/usage.js", () => ({
  getSessionUsageSnapshot: vi.fn(() => undefined),
  addUsage: vi.fn(),
  getLifetimeTotal: vi.fn(() => 0),
  getSessionContextPercent: vi.fn(() => null),
}));

// Import after mocks are in place
import { createNestedAgentExecutor, executeAgentTool, executeNestedAgentTool, toolCallListener } from "../../src/agents/tool-execution.js";
import { createSubagentRuntimeContext } from "../../src/shell.js";
import * as agentTypes from "../../src/agents/agent-types.js";
import * as utils from "../../src/utils.js";

const nestedRuntimeSettings = {
  agent: { graceTurns: 5 },
  modelFor: mockModelFor,
  thinkingSettingFor: mockThinkingSettingFor,
} as any;

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

  it("keeps listener-injected settings distinct from explicit tool values at execution", async () => {
    const record = {
      id: "agent-settings", result: "done",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: 0, completedAt: 1 }, execution: {},
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, compactionCount: 0 },
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
});

describe("executeNestedAgentTool — guard matrix", () => {
  const runtime = (_parent: any, coordinator = mockCoordinatorSpawnNested) => createSubagentRuntimeContext(
    createNestedAgentExecutor(
      "parent",
      {} as any,
      { preflightNested: mockNestedPreflight } as any,
      { spawnNested: coordinator } as any,
      nestedRuntimeSettings,
    ),
    nestedRuntimeSettings,
  );
  const parent = (overrides: Record<string, unknown> = {}) => ({
    id: "parent",
    display: { type: "implementer", description: "parent" },
    lifecycle: { status: "running" },
    hierarchy: {
      depth: 1,
      childIds: [],
      delegateTo: ["scout"],
      maxChildAgents: 1,
      agentCatalog: new Map([["scout", { name: "scout", description: "Scout", systemPrompt: "" }]]),
    },
    ...overrides,
  });
  const nestedCtx = { modelRegistry: {}, model: undefined, thinkingLevel: undefined } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNestedPreflight.mockImplementation((_parentId: string, type: string) => {
      const currentParent = parent();
      const resolvedType = currentParent.hierarchy.agentCatalog.has(type) ? type : undefined;
      if (!resolvedType) return { ok: false, error: `Unknown agent type: ${type || "(missing)"}` };
      return { ok: true, parent: currentParent, type: resolvedType, agentConfig: currentParent.hierarchy.agentCatalog.get(resolvedType) };
    });
  });

  it("returns cancellation before inspecting nested input", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeNestedAgentTool(runtime(parent()), "call", {}, controller.signal, undefined, nestedCtx);

    expect(result.content[0].text).toBe("Agent execution cancelled");
    expect(mockNestedPreflight).not.toHaveBeenCalled();
  });

  it.each([
    ["background", { run_in_background: true }, "Nested agents must run in the foreground"],
    ["worktree", { worktree_path: "/other" }, "Nested agents cannot select a worktree"],
  ])("rejects nested %s requests", async (_name, params, expected) => {
    const result = await executeNestedAgentTool(runtime(parent()), "call", {
      agent: "scout", prompt: "Inspect", ...params,
    }, undefined, undefined, nestedCtx);

    expect(result.content[0].text).toBe(expected);
    expect(mockNestedPreflight).not.toHaveBeenCalled();
  });

  it("returns manager preflight errors before calling the coordinator", async () => {
    mockNestedPreflight.mockReturnValueOnce({ ok: false, error: "Nested agent parent is no longer running" });
    const invalidParent = await executeNestedAgentTool(runtime(parent()), "call", { agent: "scout", prompt: "Inspect" }, undefined, undefined, nestedCtx);
    expect(invalidParent.content[0].text).toBe("Nested agent parent is no longer running");

    // A depth-2 parent is the maximum allowed parent depth.
    mockNestedPreflight.mockReturnValueOnce({ ok: false, error: "Maximum nesting depth reached" });
    const atLimit = await executeNestedAgentTool(runtime(parent()), "call", { agent: "scout", prompt: "Inspect" }, undefined, undefined, nestedCtx);
    expect(atLimit.content[0].text).toBe("Maximum nesting depth reached");
    expect(mockCoordinatorSpawnNested).not.toHaveBeenCalled();
  });

  it("uses manager preflight for delegation-policy errors", async () => {
    mockNestedPreflight.mockReturnValueOnce({ ok: false, error: "This agent is not permitted to delegate" });
    const result = await executeNestedAgentTool(runtime(parent()), "call", { agent: "scout", prompt: "Inspect" }, undefined, undefined, nestedCtx);

    expect(result.content[0].text).toBe("This agent is not permitted to delegate");
    expect(mockCoordinatorSpawnNested).not.toHaveBeenCalled();
  });

  it("returns manager catalog permission errors without consulting the mutable registry", async () => {
    mockNestedPreflight
      .mockReturnValueOnce({ ok: false, error: "Unknown agent type: missing" })
      .mockReturnValueOnce({ ok: false, error: 'Agent "scout" is not allowed. Allowed child agents: reviewer' });
    const unknown = await executeNestedAgentTool(runtime(parent()), "call", { agent: "missing", prompt: "Inspect" }, undefined, undefined, nestedCtx);
    expect(unknown.content[0].text).toBe("Unknown agent type: missing");
    const unpermitted = await executeNestedAgentTool(runtime(parent()), "call", { agent: "scout", prompt: "Inspect" }, undefined, undefined, nestedCtx);
    expect(unpermitted.content[0].text).toBe('Agent "scout" is not allowed. Allowed child agents: reviewer');
    expect(agentTypes.resolveType).not.toHaveBeenCalled();
    expect(agentTypes.getAgentConfig).not.toHaveBeenCalled();
    expect(mockCoordinatorSpawnNested).not.toHaveBeenCalled();
  });

  it("requires a non-empty nested prompt", async () => {
    const result = await executeNestedAgentTool(runtime(parent()), "call", { agent: "scout", prompt: "  " }, undefined, undefined, nestedCtx);

    expect(result.content[0].text).toBe("Agent prompt is required");
    expect(mockCoordinatorSpawnNested).not.toHaveBeenCalled();
  });

  it("returns a compact coordinator error", async () => {
    mockCoordinatorSpawnNested.mockRejectedValueOnce(new Error("nested startup failed"));
    const result = await executeNestedAgentTool(runtime(parent()), "call", { agent: "scout", prompt: "Inspect" }, undefined, undefined, nestedCtx);

    expect(result.content[0].text).toBe("nested startup failed");
    expect(mockCoordinatorSpawnNested).toHaveBeenCalledOnce();
  });
});

describe("executeNestedAgentTool — worktree overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModelFor.mockImplementation((_: string, parentModelId: string, agentConfig?: any) => agentConfig?.model ?? parentModelId);
    mockThinkingSettingFor.mockImplementation((_: string, parentThinking: any, agentConfig?: any, explicitThinking?: any) => ({
      value: explicitThinking ?? agentConfig?.thinkingLevel ?? parentThinking,
      source: explicitThinking ? "spawn" : "parent",
    }));
  });

  it("uses detached preflight config for nested model and thinking", async () => {
    const localConfig = {
      name: "local-reviewer",
      description: "Local reviewer",
      systemPrompt: "Use local instructions.",
      model: "local/local-model",
      thinkingLevel: "high",
      maxTurns: 7,
    };
    mockNestedPreflight.mockReturnValue({ ok: true, type: "local-reviewer", agentConfig: localConfig });
    (utils.findModelInRegistry as any).mockReturnValue({ provider: "local", id: "local-model" });
    const completed = {
      id: "child", result: "done",
      display: { type: "local-reviewer", description: "Local reviewer" },
      lifecycle: { status: "completed", startedAt: 0, completedAt: 1 }, execution: {},
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, compactionCount: 0 },
    };
    mockCoordinatorSpawnNested.mockResolvedValue({ agentId: "child", record: completed });

    const result = await executeNestedAgentTool(
      createSubagentRuntimeContext(
        createNestedAgentExecutor(
          "parent", {} as any, { preflightNested: mockNestedPreflight } as any,
          { spawnNested: mockCoordinatorSpawnNested } as any,
          nestedRuntimeSettings,
        ),
        nestedRuntimeSettings,
      ),
      "call", { agent: "local-reviewer", prompt: "Review this" }, undefined, undefined,
      { modelRegistry: {}, model: undefined, thinkingLevel: undefined } as any,
    );

    expect(result.isError).toBeUndefined();
    expect(mockCoordinatorSpawnNested).toHaveBeenCalledWith(
      "parent", expect.anything(), expect.anything(), expect.objectContaining({
        type: "local-reviewer",
        agentConfig: localConfig,
        model: { provider: "local", id: "local-model" },
        thinkingLevel: "high",
      }),
    );
  });

  it("reports a stopped child as cancelled while its parent remains active", async () => {
    const parent = {
      id: "parent",
      display: { type: "implementer", description: "parent" },
      lifecycle: { status: "running" },
      hierarchy: {
        depth: 1,
        childIds: ["child"],
        delegateTo: ["scout"],
        maxChildAgents: 1,
        waitingOnChildId: "child",
        agentCatalog: new Map([["scout", { name: "scout", description: "Scout", systemPrompt: "" }]]),
      },
    };
    const child = {
      id: "child", result: "partial response",
      display: { type: "scout", description: "Scout" },
      lifecycle: { status: "stopped", startedAt: 0, completedAt: 1 }, execution: {},
      hierarchy: { depth: 2, parentId: "parent", childIds: [], delegateTo: [], maxChildAgents: 0 },
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, compactionCount: 0 },
    };
    mockNestedPreflight.mockReturnValue({ ok: true, parent, type: "scout", agentConfig: parent.hierarchy.agentCatalog.get("scout") });
    mockCoordinatorSpawnNested.mockResolvedValue({ agentId: "child", record: child });

    const result = await executeNestedAgentTool(
      createSubagentRuntimeContext(
        createNestedAgentExecutor(
          "parent", {} as any, { preflightNested: mockNestedPreflight } as any,
          { spawnNested: mockCoordinatorSpawnNested } as any,
          nestedRuntimeSettings,
        ),
        nestedRuntimeSettings,
      ),
      "call", { agent: "scout", prompt: "Inspect" }, undefined, undefined,
      { modelRegistry: {}, model: undefined, thinkingLevel: undefined } as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Agent execution cancelled");
    expect(parent.lifecycle.status).toBe("running");
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
        toolUses: 0,
        compactionCount: 0,
      },
    });
  });

  it("passes Agent tool model and thinking overrides to the shared resolver", async () => {
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
      maxTurns: 25,
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
        toolUses: 0,
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
        toolUses: 0,
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
      "general-purpose", { model: "openai/gpt-4o", thinkingLevel: "high", maxTurns: 9 },
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
        toolUses: 3,
        turnCount: 2,
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
        toolUses: 0,
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
        toolUses: 0,
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
        toolUses: 3,
        turnCount: 2,
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
      "feature-reviewer", { maxTurns: 25, thinkingLevel: undefined },
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
