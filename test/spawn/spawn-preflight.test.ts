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
  resolveProjectFreeAgentCatalog: vi.fn(),
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
  resolveProjectFreeAgentCatalog: mocks.resolveProjectFreeAgentCatalog,
  resolveTypeInCatalog: mocks.resolveTypeInCatalog,
}));

vi.mock("../../src/models/agent-resolution.js", () => ({
  resolveAgentTunables: mocks.resolveAgentTunables,
}));

import { runSpawnPreflight } from "../../src/spawn/spawn-preflight.js";
import {
  MAX_AGENT_NAME_BYTES,
  MAX_AGENT_PROMPT_BYTES,
  MAX_AGENT_SYSTEM_PROMPT_BYTES,
} from "../../src/agents/agent-string-limits.js";

const runtimeSettings: SubagentRuntimeSettings = {
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
  mocks.resolveProjectFreeAgentCatalog.mockResolvedValue(new Map([["known", agentConfig]]));
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
    expect(result.resolvedSpawn).not.toHaveProperty("runtimeSettings");
    expect(input.store.createSubagentRuntimeSettings).toHaveBeenCalledOnce();
    expect(mocks.resolveAgentTunables).toHaveBeenCalledWith(expect.objectContaining({
      overrides: runtimeSettings.agents,
    }));
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
    expect(mocks.resolveProjectFreeAgentCatalog).toHaveBeenCalledWith({ disableDefaultAgents: false });
    expect(mocks.resolveType).not.toHaveBeenCalled();
  });

  it("does not reuse a trusted project role for a later untrusted preflight", async () => {
    const projectConfig = {
      name: "project-only",
      description: "Project instructions",
      systemPrompt: "Project body",
    };
    mocks.resolveType.mockImplementation((type: string) => type === "project-only" ? type : undefined);
    mocks.getAgentConfig.mockReturnValue(projectConfig);

    const trusted = await runSpawnPreflight({
      ...makeInput({ agent: "project-only" }),
      projectTrusted: true,
    });
    expect(trusted.kind).toBe("ready");

    mocks.resolveProjectFreeAgentCatalog.mockResolvedValueOnce(new Map([
      ["known", agentConfig],
      ["project-only", { ...agentConfig, description: "User definition" }],
    ]));
    const untrusted = await runSpawnPreflight(makeInput({ agent: "project-only" }));
    expect(untrusted.kind).toBe("ready");
    if (untrusted.kind === "ready") {
      expect(untrusted.resolvedSpawn.agentConfig.description).toBe("User definition");
    }
    expect(mocks.resolveType).toHaveBeenCalledTimes(1);
    expect(mocks.resolveProjectFreeAgentCatalog).toHaveBeenCalledWith({ disableDefaultAgents: false });

    mocks.resolveProjectFreeAgentCatalog.mockResolvedValueOnce(new Map([["known", agentConfig]]));
    const unknown = await runSpawnPreflight(makeInput({ agent: "project-only" }));
    expect(unknown).toEqual({
      kind: "error",
      error: "Unknown agent type: project-only",
      warnings: [],
    });
  });

  it("refreshes the bounded trusted parent catalog when a role was added after the last turn", async () => {
    const input = { ...makeInput(), projectTrusted: true };
    let resolveCalls = 0;
    mocks.resolveType.mockImplementation((type: string) => {
      resolveCalls++;
      return resolveCalls === 1 ? undefined : type;
    });
    mocks.getAgentConfig.mockReturnValue({ ...agentConfig, name: "added-after-turn" });
    mocks.discoverNewAgents.mockResolvedValueOnce(1);
    input.params.agent = "added-after-turn";

    const result = await runSpawnPreflight(input);

    expect(result.kind).toBe("ready");
    expect(mocks.discoverNewAgents).toHaveBeenCalledWith({ disableDefaultAgents: false });
    expect(mocks.resolveProjectFreeAgentCatalog).not.toHaveBeenCalled();
    expect(resolveCalls).toBe(2);
  });

  it("does not refresh the trusted registry for an untrusted unknown role", async () => {
    const input = makeInput({ agent: "project-only" });
    mocks.resolveProjectFreeAgentCatalog.mockResolvedValueOnce(new Map());

    const result = await runSpawnPreflight(input);

    expect(result.kind).toBe("error");
    expect(mocks.discoverNewAgents).not.toHaveBeenCalled();
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

  it("rejects an oversized agent name before worktree/catalog", async () => {
    const result = await runSpawnPreflight(makeInput({ agent: "a".repeat(MAX_AGENT_NAME_BYTES + 1) }));

    expect(result).toEqual({
      kind: "error",
      error: expect.stringContaining("Agent type exceeds"),
      warnings: [],
    });
    expect(mocks.validateWorktreePath).not.toHaveBeenCalled();
    expect(mocks.resolveProjectFreeAgentCatalog).not.toHaveBeenCalled();
  });

  it("accepts the exact ASCII prompt boundary and rejects one byte over before worktree/catalog", async () => {
    const exact = await runSpawnPreflight(makeInput({ prompt: "a".repeat(MAX_AGENT_PROMPT_BYTES) }));
    expect(exact.kind).toBe("ready");
    vi.clearAllMocks();

    const result = await runSpawnPreflight(makeInput({ prompt: "a".repeat(MAX_AGENT_PROMPT_BYTES + 1) }));

    expect(result).toEqual({
      kind: "error",
      error: expect.stringContaining("Agent prompt exceeds"),
      warnings: [],
    });
    expect(mocks.validateWorktreePath).not.toHaveBeenCalled();
    expect(mocks.resolveType).not.toHaveBeenCalled();
  });

  it("uses UTF-8 bytes for the exact multibyte prompt boundary", async () => {
    const exact = "😀".repeat(MAX_AGENT_PROMPT_BYTES / 4);
    const accepted = await runSpawnPreflight(makeInput({ prompt: exact }));
    expect(accepted.kind).toBe("ready");

    const rejected = await runSpawnPreflight(makeInput({ prompt: `${exact}😀` }));
    expect(rejected.kind).toBe("error");
    if (rejected.kind === "error") expect(rejected.error).toContain("UTF-8 bytes");
  });

  it("rejects an oversized systemPrompt after resolution but before accepted snapshot", async () => {
    mocks.resolveProjectFreeAgentCatalog.mockResolvedValueOnce(new Map([[
      "known",
      { ...agentConfig, systemPrompt: "界".repeat(MAX_AGENT_SYSTEM_PROMPT_BYTES / 3 + 1) },
    ]]));

    const result = await runSpawnPreflight(makeInput());

    expect(result).toEqual({
      kind: "error",
      error: expect.stringContaining("AgentConfig systemPrompt exceeds"),
      warnings: [],
    });
    expect(mocks.resolveAgentTunables).not.toHaveBeenCalled();
  });

  it("returns cancelled after an asynchronous discovery boundary", async () => {
    const controller = new AbortController();
    const input = { ...makeInput(), signal: controller.signal };
    mocks.resolveType.mockReturnValue(undefined);
    mocks.resolveProjectFreeAgentCatalog.mockImplementationOnce(async () => {
      controller.abort();
      return new Map();
    });

    const result = await runSpawnPreflight(input);

    expect(result).toEqual({ kind: "cancelled", warnings: [] });
    expect(mocks.getAgentConfig).not.toHaveBeenCalled();
  });
});
