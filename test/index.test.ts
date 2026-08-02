/**
 * index.test.ts — Tests for the extension entry point.
 *
 * Tests focus on:
 *   - Tool schema shapes (stealth schemas with description: ".", no promptSnippet/promptGuidelines)
 *   - Listener guards (only mutates event.input.model for Agent tool)
 *   - Schema field exclusion (no model, inherit_context, schedule, isolation params)
 *
 * These tests mock ExtensionAPI and verify registration behavior; headless
 * lifecycle loading is covered by the contract and background-flow smokes.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import {
  createMockExtensionAPI,
  hasParam,
  loadExtension,
  type MockExtensionAPI,
} from "./fixtures";

// Mock external dependencies before any imports
vi.mock("@sinclair/typebox", () => {
  const createType = (type: string) => (opts?: any) => ({
    type,
    ...(opts || {}),
  });
  return {
    Type: {
      Object: (properties: Record<string, any>, opts?: any) => {
        // Faithful to real TypeBox: `required` lists every property that is
        // not wrapped in Type.Optional (which the mock marks with optional: true).
        const required = Object.entries(properties)
          .filter(([, schema]) => !schema.optional)
          .map(([key]) => key);
        return {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
          ...(opts || {}),
        };
      },
      String: createType("string"),
      Number: createType("number"),
      Boolean: createType("boolean"),
      Optional: (schema: any) => ({ ...schema, optional: true }),
      Array: (items: any) => ({ type: "array", items }),
      Record: (keyType: any, valueType: any) => ({
        type: "record",
        keyType,
        valueType,
      }),
      Union: (variants: any[]) => ({ type: "union", variants }),
      Literal: (value: string | number | boolean) => ({
        type: "literal",
        const: value,
      }),
    },
  };
});
vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: class {},
  getAgentDir: vi.fn(() => "/home/test/.pi/agent"),
}));

vi.mock("../src/models/model-precedence.js", () => ({
  resolveModel: vi.fn((opts: any) => opts?.parentModelId ?? ""),
  resolveModelSetting: vi.fn((opts: any) => ({ value: opts?.parentModelId ?? "", source: "parent" })),
  resolveThinkingSetting: vi.fn((opts: any) => ({ value: opts?.parentThinking, source: "parent" })),
}));

vi.mock("../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(() => ({})),
  registerAgents: vi.fn(),
  getAvailableAgents: vi.fn(() => []),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
}));

vi.mock("../src/agents/agent-discovery.js", () => ({
  scanAgentFilesInDir: vi.fn().mockResolvedValue([]),
  mergeAgents: vi.fn().mockReturnValue(new Map()),
  AgentConfigFromMd: {},
}));

vi.mock("../src/agents/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../src/agents/default-agents.js", () => ({
  DEFAULT_AGENTS: new Map(),
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Find a tool by name from the mock API.
 */
function findTool(api: MockExtensionAPI, name: string) {
  return api.tools.find((t) => t.name === name);
}

/**
 * Verify stealth schema properties: description ".", no promptSnippet, no promptGuidelines.
 */
function expectStealthSchema(tool: any) {
  expect(tool.description).toBe(".");
  expect(tool.promptSnippet).toBeUndefined();
  expect(tool.promptGuidelines).toBeUndefined();
}

/* ------------------------------------------------------------------ */
/*  Agent tool schema — stealth                                       */
/* ------------------------------------------------------------------ */

describe("Agent tool schema — stealth", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  const agentTool = () => findTool(api, "Agent");

  it("has Pi's required description without extra prompt metadata", () => {
    expect(agentTool()).toBeDefined();
    expect(agentTool()!.description).toBe("Delegate a task to a specialized agent.");
  });

  it("has no promptSnippet", () => {
    expect(agentTool()!.promptSnippet).toBeUndefined();
  });

  it("has no promptGuidelines", () => {
    expect(agentTool()!.promptGuidelines).toBeUndefined();
  });

  it("keeps model and thinking overrides out of the LLM-visible schema", () => {
    expect(hasParam(agentTool()!.parameters, "model")).toBe(false);
    expect(hasParam(agentTool()!.parameters, "thinking")).toBe(false);
  });

  it("excludes inherit_context param", () => {
    expect(hasParam(agentTool()!.parameters, "inherit_context")).toBe(false);
  });

  it("excludes schedule param", () => {
    expect(hasParam(agentTool()!.parameters, "schedule")).toBe(false);
  });

  it("excludes isolation param", () => {
    expect(hasParam(agentTool()!.parameters, "isolation")).toBe(false);
  });

  it("includes prompt param (no .description())", () => {
    expect(hasParam(agentTool()!.parameters, "prompt")).toBe(true);
    const promptSchema = agentTool()!.parameters?.properties?.prompt;
    expect(promptSchema?.description).toBeUndefined();
  });

  it("includes description param", () => {
    expect(hasParam(agentTool()!.parameters, "description")).toBe(true);
  });

  it("includes agent param", () => {
    expect(hasParam(agentTool()!.parameters, "agent")).toBe(true);
  });

  it("excludes max_turns from schema (config-only, not LLM-controlled)", () => {
    expect(hasParam(agentTool()!.parameters, "max_turns")).toBe(false);
  });

  it("excludes max_tokens from schema (config-only, not LLM-controlled)", () => {
    expect(hasParam(agentTool()!.parameters, "max_tokens")).toBe(false);
  });

  it("includes run_in_background param (optional)", () => {
    expect(hasParam(agentTool()!.parameters, "run_in_background")).toBe(true);
  });

  it("includes worktree_path param (optional, no .description())", () => {
    expect(hasParam(agentTool()!.parameters, "worktree_path")).toBe(true);
    const wtSchema = agentTool()!.parameters?.properties?.worktree_path;
    expect(wtSchema?.description).toBeUndefined();
  });

  it("requires an explicit agent type while keeping other arguments optional", () => {
    const properties = agentTool()!.parameters.properties;
    expect(properties.agent.optional).toBeUndefined();
    for (const name of ["description", "run_in_background", "worktree_path"]) {
      expect(properties[name].optional).toBe(true);
    }
  });

  it("excludes isolated from schema (config-only, not LLM-controlled)", () => {
    expect(hasParam(agentTool()!.parameters, "isolated")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Tool Registration Count                                           */
/* ------------------------------------------------------------------ */

describe("tool registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  it("registers exactly 4 tools", () => {
    expect(api.tools).toHaveLength(4);
  });

  it("registers Agent, AgentContinue, StopAgent, and AgentStatus tools", () => {
    const names = api.tools.map((t) => t.name);
    expect(names).toEqual(["Agent", "AgentContinue", "StopAgent", "AgentStatus"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Listener Guards                                                   */
/* ------------------------------------------------------------------ */

describe("tool_call listener — guards", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  const toolCallHandler = () =>
    api.listeners.find((l) => l.event === "tool_call")?.handler;

  it("does not mutate event.input.model for non-Agent tools", async () => {
    expect(toolCallHandler()).toBeDefined();
    const event = {
      toolName: "bash",
      toolCallId: "call_123",
      input: { command: "echo hello" } as Record<string, unknown>,
    };
    const result = await toolCallHandler()!(event, {});

    expect(event.input.model).toBeUndefined();
    expect(result).toBeUndefined();
  });

  it("sets event.input.model for Agent tool calls", async () => {
    const ctx = {
      model: { provider: "test", id: "parent-model" },
      modelRegistry: {
        find: vi.fn((p: string, i: string) => ({ provider: p, id: i })),
        getAvailable: vi.fn(() => []),
      },
    };

    const event = {
      toolName: "Agent",
      toolCallId: "call_789",
      input: {
        prompt: "do something",
        description: "test",
        agent: "Explore",
      } as Record<string, unknown>,
    };

    const result = await toolCallHandler()!(event, ctx);

    expect(event.input.model).toBeDefined();
    expect(typeof event.input.model).toBe("string");
    expect(result).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Event Listener Registration                                       */
/* ------------------------------------------------------------------ */

describe("event listener registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  it("registers tool_call listener", () => {
    expect(api.listeners.some((l) => l.event === "tool_call")).toBe(true);
  });

  it("registers session_start listener", () => {
    expect(api.listeners.some((l) => l.event === "session_start")).toBe(true);
  });

  it("registers the parent orchestration prompt hook", () => {
    expect(api.listeners.some((l) => l.event === "before_agent_start")).toBe(true);
  });

  it("registers session_shutdown listener", () => {
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(
      true,
    );
  });
});


// worktree_path schema tests (merged from worktree-schema-briefing)
describe("Agent tool schema — worktree_path", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  it("worktree_path is optional in the schema", () => {
    const tool = api.tools.find((t) => t.name === "Agent")!;
    const required = tool.parameters.required ?? [];
    expect(required).not.toContain("worktree_path");
  });

  it("worktree_path is a string type in the schema", () => {
    const tool = api.tools.find((t) => t.name === "Agent")!;
    const prop = tool.parameters.properties?.worktree_path;
    expect(prop).toBeDefined();
    expect(prop.type).toBe("string");
  });
});


/* ------------------------------------------------------------------ */
/*  Subagent spawn guard (prevents shell clobbering)                  */
/* ------------------------------------------------------------------ */

describe("subagent runtime context", () => {
  // The real shell module carries context through AsyncLocalStorage, so
  // concurrent child setup cannot affect a parent extension runtime.
  let shell: typeof import("../src/shell.js");

  beforeEach(async () => {
    shell = await import("../src/shell.js");
  });

  it("registers tools and listeners for the parent session", async () => {
    const api = createMockExtensionAPI();
    await loadExtension(api.api);

    expect(api.tools.length).toBeGreaterThan(0);
    expect(api.listeners.some((l) => l.event === "session_start")).toBe(true);
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(true);
  });

  it("stays inert in a child runtime because root tools never enter agent sessions", async () => {
    const api = createMockExtensionAPI();
    await shell.runWithSubagentRuntime(shell.createSubagentRuntimeContext(), async () => {
      await loadExtension(api.api);
    });
    expect(api.tools).toHaveLength(0);
    expect(api.listeners).toHaveLength(0);
  });

  it("keeps deprecated spawn hooks as inert-registration compatibility", async () => {
    shell.enterSubagentSpawn();
    shell.enterSubagentSpawn();
    try {
      expect(shell.isInsideSubagentSpawn()).toBe(true);
      const childApi = createMockExtensionAPI();
      await loadExtension(childApi.api);
      expect(childApi.tools).toHaveLength(0);
      expect(childApi.listeners).toHaveLength(0);

      shell.exitSubagentSpawn();
      expect(shell.isInsideSubagentSpawn()).toBe(true);
    } finally {
      shell.exitSubagentSpawn();
    }

    expect(shell.isInsideSubagentSpawn()).toBe(false);
    const rootApi = createMockExtensionAPI();
    await loadExtension(rootApi.api);
    expect(rootApi.tools.length).toBeGreaterThan(0);
  });

});

/* ------------------------------------------------------------------ */
/*  Constrained Sampling                                              */
/* ------------------------------------------------------------------ */

describe("constrained sampling", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  it("omits constrainedSampling from Agent so providers can accept its optional arguments", () => {
    expect(findTool(api, "Agent")!.constrainedSampling).toBeUndefined();
  });

  for (const toolName of ["StopAgent", "AgentStatus", "AgentContinue"]) {
    it(`${toolName} has constrainedSampling with json_schema and strict: prefer`, () => {
      const tool = findTool(api, toolName);
      expect(tool).toBeDefined();
      expect(tool!.constrainedSampling).toEqual({
        type: "json_schema",
        strict: "prefer",
      });
    });
  }

  for (const toolName of ["Agent", "AgentContinue", "StopAgent", "AgentStatus"]) {
    it(`${toolName} schema has additionalProperties: false`, () => {
      const tool = findTool(api, toolName);
      expect(tool).toBeDefined();
      expect(tool!.parameters.additionalProperties).toBe(false);
    });
  }

  it("AgentContinue schema requires agent_id, prompt, and run_in_background (strict-mode compatible)", () => {
    const tool = findTool(api, "AgentContinue");
    expect(tool!.parameters.required).toEqual(["agent_id", "prompt", "run_in_background"]);
    expect(tool!.parameters.properties).toMatchObject({
      agent_id: { type: "string" },
      prompt: { type: "string" },
      run_in_background: { type: "boolean" },
    });
    expect(tool!.parameters.properties.run_in_background.optional).toBeUndefined();
  });
});
