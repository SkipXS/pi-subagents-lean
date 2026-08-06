import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntimeSettings } from "../../src/config/config-store.js";

const mocks = vi.hoisted(() => ({
  validateWorktreePath: vi.fn(),
  revalidateWorktreePath: vi.fn(),
  resolveType: vi.fn(),
  getAgentConfig: vi.fn(),
  discoverNewAgents: vi.fn(),
  resolveAgentCatalog: vi.fn(),
  resolveTypeInCatalog: vi.fn(),
  resolveAgentTunables: vi.fn(),
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mocks.validateWorktreePath,
  revalidateWorktreePath: mocks.revalidateWorktreePath,
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: mocks.resolveType,
  getAgentConfig: mocks.getAgentConfig,
  discoverNewAgents: mocks.discoverNewAgents,
  resolveAgentCatalog: mocks.resolveAgentCatalog,
  resolveTypeInCatalog: mocks.resolveTypeInCatalog,
}));

vi.mock("../../src/models/agent-resolution.js", () => ({
  resolveAgentTunables: mocks.resolveAgentTunables,
}));

import { runSpawnPreflight } from "../../src/spawn/spawn-preflight.js";

const runtimeSettings: SubagentRuntimeSettings = {
  agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
  agents: { known: { model: "settings/model" } },
};
const agentConfig = {
  name: "known",
  description: "Known agent",
  systemPrompt: "Instructions",
};
const model = { provider: "provider", id: "model", reasoning: true } as any;

function makeInput(overrides: Record<string, unknown> = {}) {
  const store = {
    agent: { disableDefaultAgents: false },
    createSubagentRuntimeSettings: vi.fn(() => runtimeSettings),
  };
  return {
    params: {
      agent: "known",
      prompt: "complete the task",
      description: "Complete it",
      ...overrides,
    },
    signal: undefined as AbortSignal | undefined,
    pi: { exec: vi.fn() } as unknown as ExtensionAPI,
    ctx: {
      cwd: "/parent",
      model: { provider: "parent", id: "parent-model" },
      modelRegistry: { find: vi.fn() },
      thinkingLevel: "medium",
    } as unknown as ExtensionContext,
    store,
    parentCwd: "/parent",
    projectTrusted: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateWorktreePath.mockResolvedValue({ ok: true, resolvedPath: "/wt/feature", label: "feature" });
  mocks.revalidateWorktreePath.mockResolvedValue({ ok: true, resolvedPath: "/wt/feature", label: "feature" });
  mocks.resolveType.mockImplementation((type: string) => type === "known" ? type : undefined);
  mocks.getAgentConfig.mockReturnValue(agentConfig);
  mocks.discoverNewAgents.mockResolvedValue(0);
  mocks.resolveAgentCatalog.mockResolvedValue(new Map([["local", agentConfig]]));
  mocks.resolveTypeInCatalog.mockImplementation((catalog: Map<string, unknown>, type: string) => catalog.has(type) ? type : undefined);
  mocks.resolveAgentTunables.mockReturnValue({ model, modelKey: "provider/model", thinkingLevel: "high" });
});

describe("runSpawnPreflight", () => {
  it("returns an immutable resolved snapshot with explicit dependencies", async () => {
    const input = makeInput();

    const result = await runSpawnPreflight(input);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready preflight");
    expect(result.resolvedSpawn).toMatchObject({
      type: "known",
      prompt: "complete the task",
      description: "Complete it",
      model,
      modelKey: "provider/model",
      thinkingLevel: "high",
      projectTrusted: false,
    });
    expect(Object.isFrozen(result.resolvedSpawn)).toBe(true);
    expect(input.store.createSubagentRuntimeSettings).toHaveBeenCalledOnce();
    expect(mocks.revalidateWorktreePath).not.toHaveBeenCalled();
    expect(mocks.resolveAgentCatalog).not.toHaveBeenCalled();
  });

  it("revalidates before resolving a trusted worktree catalog", async () => {
    const input = { ...makeInput({ agent: "local", worktree_path: "/selected" }), projectTrusted: true };
    mocks.resolveType.mockReturnValue(undefined);
    mocks.resolveTypeInCatalog.mockReturnValue("local");

    const result = await runSpawnPreflight(input);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready preflight");
    expect(result.resolvedSpawn).toMatchObject({
      type: "local",
      projectTrusted: true,
      worktreePath: "/wt/feature",
      worktreeParentCwd: "/parent",
      worktreeSelectionPath: "/selected",
    });
    expect(mocks.revalidateWorktreePath).toHaveBeenCalledWith(
      input.pi,
      "/selected",
      "/parent",
      "/wt/feature",
    );
    expect(mocks.resolveAgentCatalog).toHaveBeenCalledWith(
      "/wt/feature/.pi/agents",
      { disableDefaultAgents: false },
    );
  });

  it("keeps project catalog loading closed for an untrusted worktree", async () => {
    const input = makeInput({ worktree_path: "/selected" });

    const result = await runSpawnPreflight(input);

    expect(result.kind).toBe("ready");
    expect(mocks.revalidateWorktreePath).not.toHaveBeenCalled();
    expect(mocks.resolveAgentCatalog).not.toHaveBeenCalled();
    expect(mocks.resolveType).toHaveBeenCalledWith("known");
  });

  it("returns validation warnings and the existing domain error", async () => {
    mocks.validateWorktreePath.mockImplementationOnce(async (
      _pi: unknown,
      _path: string,
      _cwd: string,
      onWarning?: (message: string) => void,
    ) => {
      onWarning?.("git warning");
      return { ok: false, error: "worktree_path is not a worktree of the parent's repository" };
    });
    const input = makeInput({ worktree_path: "/selected" });

    const result = await runSpawnPreflight(input);

    expect(result).toEqual({
      kind: "error",
      error: "worktree_path is not a worktree of the parent's repository",
      warnings: ["git warning"],
    });
    expect(mocks.resolveType).not.toHaveBeenCalled();
  });

  it("returns cancelled after an asynchronous discovery boundary", async () => {
    const controller = new AbortController();
    const input = { ...makeInput(), signal: controller.signal };
    mocks.resolveType.mockReturnValue(undefined);
    mocks.discoverNewAgents.mockImplementationOnce(async () => {
      controller.abort();
      return 0;
    });

    const result = await runSpawnPreflight(input);

    expect(result).toEqual({ kind: "cancelled", warnings: [] });
    expect(mocks.getAgentConfig).not.toHaveBeenCalled();
  });
});
