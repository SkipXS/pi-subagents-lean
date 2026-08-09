import { describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  validateWorktreePath: vi.fn(),
  resolveType: vi.fn(() => "general-purpose"),
  discoverNewAgents: vi.fn(),
  coordinatorSpawn: vi.fn(),
}));

vi.mock("../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: boundary.validateWorktreePath,
}));

vi.mock("../src/agents/agent-types.js", () => ({
  resolveType: boundary.resolveType,
  getAgentConfig: vi.fn(() => ({})),
  discoverNewAgents: boundary.discoverNewAgents,
  resolveAgentCatalog: vi.fn(),
  resolveTypeInCatalog: vi.fn(),
}));

vi.mock("../src/shell.js", () => ({
  getPiInstance: () => ({ exec: vi.fn() }),
  getSessionCtx: () => ({ cwd: "/project" }),
  getStore: () => ({ agent: { disableDefaultAgents: false }, createSubagentRuntimeSettings: () => ({}) }),
  getCoordinator: () => ({ spawn: boundary.coordinatorSpawn }),
  getManager: () => ({ getRecord: vi.fn(), listAgents: vi.fn(() => []) }),
}));

vi.mock("../src/utils.js", () => ({
  findModelInRegistry: vi.fn(),
}));

vi.mock("../src/agents/usage.js", () => ({
  getSessionUsageSnapshot: vi.fn(),
}));


import { registerTools } from "../src/registration.js";

describe("registered Agent cancellation contract", () => {
  it("throws cancellation without preflight or spawn for a pre-aborted public callback", async () => {
    const tools: Array<Record<string, any>> = [];
    const pi = {
      registerTool: vi.fn((tool: Record<string, any>) => tools.push(tool)),
    };
    registerTools(pi as any);
    const execute = tools.find((tool) => tool.name === "Agent")?.execute;
    expect(execute).toBeTypeOf("function");

    const controller = new AbortController();
    controller.abort();
    await expect(execute!(
      "cancelled-call",
      { agent: "general-purpose", prompt: "do not start", worktree_path: "/project/worktree" },
      controller.signal,
      undefined,
      { cwd: "/project", modelRegistry: { find: vi.fn() } },
    )).rejects.toThrow("Agent execution cancelled");

    expect(boundary.validateWorktreePath).not.toHaveBeenCalled();
    expect(boundary.resolveType).not.toHaveBeenCalled();
    expect(boundary.coordinatorSpawn).not.toHaveBeenCalled();
  });
});
