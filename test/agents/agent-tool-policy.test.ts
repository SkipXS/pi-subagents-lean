/**
 * agent-tool-policy.test.ts — Tests for tool and config policy.
 *
 * The unit tests target the policy boundary directly. Facade getConfig tests
 * below retain coverage for the public registry-facing compatibility API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Import the module under test
import {
  resolveVisibleTools,
  resolveSessionAllowedTools,
  EXCLUDED_TOOL_NAMES,
  BUILTIN_TOOL_NAMES,
  resolveAgentConfig,
} from "../../src/agents/agent-tool-policy.js";
import * as agentTypesFacade from "../../src/agents/agent-types.js";
import { getConfig, registerAgents } from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";

/* ------------------------------------------------------------------ */
/*  Sanity: constants                                                 */
/* ------------------------------------------------------------------ */

describe("EXCLUDED_TOOL_NAMES", () => {
  it("contains every root control and keeps them out regardless of activeTools", () => {
    expect(EXCLUDED_TOOL_NAMES).toEqual(["Agent", "AgentContinue"]);
    const controls = [...EXCLUDED_TOOL_NAMES];
    expect(resolveVisibleTools({ activeTools: ["read", ...controls], tools: ["read", ...controls] })).toEqual(["read"]);
    expect(resolveSessionAllowedTools({ registeredTools: ["read", ...controls], tools: undefined })).toEqual(["read"]);
  });
});

describe("BUILTIN_TOOL_NAMES", () => {
  it("is exported and non-empty", () => {
    expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("includes core built-in tools", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("read");
    expect(BUILTIN_TOOL_NAMES).toContain("bash");
    expect(BUILTIN_TOOL_NAMES).toContain("edit");
    expect(BUILTIN_TOOL_NAMES).toContain("write");
  });
});

describe("agent-types facade compatibility", () => {
  it("re-exports the extracted policy symbols", () => {
    expect(agentTypesFacade.BUILTIN_TOOL_NAMES).toBe(BUILTIN_TOOL_NAMES);
    expect(agentTypesFacade.EXCLUDED_TOOL_NAMES).toBe(EXCLUDED_TOOL_NAMES);
    expect(agentTypesFacade.resolveAgentConfig).toBe(resolveAgentConfig);
    expect(agentTypesFacade.resolveSessionAllowedTools).toBe(resolveSessionAllowedTools);
    expect(agentTypesFacade.resolveVisibleTools).toBe(resolveVisibleTools);
  });
});

/* ------------------------------------------------------------------ */
/*  Allowlist mode (tools: string[])                                  */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — allowlist mode", () => {
  it("returns only allowed tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write", "grep"],
      tools: ["read", "bash", "edit"],
    });
    expect(result).toEqual(["read", "bash", "edit"]);
  });

  it("always excludes EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "Agent"],
      tools: ["read", "bash", "edit", "Agent"],
    });
    expect(result).not.toContain("Agent");
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
  });

  it("returns [] when all active tools are excluded", () => {
    const result = resolveVisibleTools({
      activeTools: ["Agent"],
      tools: ["Agent"],
    });
    expect(result).toEqual([]);
  });

  it("ext/* expands to all tools from extension", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract", "web_crawl"],
      tools: ["read", "tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).toContain("web_extract");
    expect(result).toContain("web_crawl");
    expect(result).not.toContain("bash");
  });

  it("ext/* with non-loaded extension: warns and resolves to nothing", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();

    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "tavily/*"],
      extToolMap,
      notify,
    });
    expect(result).toEqual(["read"]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is not loaded, "tavily/*" will have no effect'),
    );
  });

  it("ext/tool syntax: extracts tool name from entry", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search"],
      tools: ["read", "tavily/web_search"],
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).not.toContain("bash");
  });

  it("warns about unknown bare tool name not in builtins or extensions", () => {
    const notify = vi.fn();

    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "foobar"],
      notify,
    });
    expect(result).toEqual(["read"]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('tool "foobar" not found in any loaded extension'),
    );
  });

  it("warns when extension is loaded but none of its tools are in tools", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract"],
      tools: ["read", "bash"],
      extToolMap,
      notify,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("web_search");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );
  });

  it("does not warn when ext/* covers the extension", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    resolveVisibleTools({
      activeTools: ["read", "web_search", "web_extract"],
      tools: ["read", "tavily/*"],
      extToolMap,
      notify,
    });
    // Should NOT warn about tavily having no tools in tools (ext/* covers it)
    expect(notify).not.toHaveBeenCalled();
  });

  it("ext/* combined with named extension tool", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);
    extToolMap.set("exa", ["exa_search"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "web_search", "web_extract", "web_crawl", "exa_search"],
      tools: ["read", "tavily/*", "exa_search"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).toContain("web_extract");
    expect(result).toContain("web_crawl");
    expect(result).toContain("exa_search");
  });
});

/* ------------------------------------------------------------------ */
/*  Selection-minus-exclusion modes                                   */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — exclusions", () => {
  it("excludes tools listed in excludeTools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("write");
  });

  it("always excludes EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "Agent"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("Agent");
  });

  it("ext/* syntax in excludeTools", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract", "web_crawl"],
      tools: undefined,
      excludeTools: ["tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("web_extract");
    expect(result).not.toContain("web_crawl");
  });

  it("mixed ext/* and bare names in excludeTools", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "write", "web_search", "web_extract"],
      tools: undefined,
      excludeTools: ["write", "tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("write");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("web_extract");
  });

  it("subtracts excludeTools after a tools whitelist", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write", "grep"],
      tools: ["read", "bash"],
      excludeTools: ["bash"],
    });
    expect(result).toEqual(["read"]);
  });

  it("returns null when no filtering needed (excludeTools doesn't match any active)", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toBeNull();
  });

  it("returns [] when excludeTools removes all non-excluded active tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["Agent", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  tools: true / false / undefined                                   */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — tools: true/false/undefined", () => {
  it("tools: true — all tools visible except EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "Agent"],
      tools: true,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("Agent");
  });

  it("tools: true, no excluded tools in active — returns null", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: true,
    });
    expect(result).toBeNull();
  });

  it("tools: true subtracts excludeTools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: true,
      excludeTools: ["bash"],
    });
    expect(result).toEqual(["read", "edit"]);
  });

  it("tools: false — returns []", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: false,
    });
    expect(result).toEqual([]);
  });

  it("tools: undefined, no excluded tools — returns null", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: undefined,
    });
    expect(result).toBeNull();
  });

  it("tools: undefined with Agent in activeTools — returns filtered list", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "Agent"],
      tools: undefined,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("Agent");
  });

  it("tools: undefined with excludeTools — subtracts from all active tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("write");
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                        */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — edge cases", () => {
  it("empty activeTools with whitelist returns []", () => {
    const result = resolveVisibleTools({
      activeTools: [],
      tools: ["read"],
    });
    expect(result).toEqual([]);
  });

  it("notify is optional (no crash when omitted)", () => {
    expect(() => {
      resolveVisibleTools({
        activeTools: ["read"],
        tools: ["foobar"],
      });
    }).not.toThrow();
  });

  it("extToolMap is optional (no crash when omitted)", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read"],
    });
    expect(result).toEqual(["read"]);
  });
});

/* ------------------------------------------------------------------ */
/*  getConfig with fixed missing selections                            */
/* ------------------------------------------------------------------ */

describe("getConfig — fixed missing selections", () => {
  beforeEach(() => {
    const agents = new Map<string, AgentConfig>();
    agents.set("explicit-agent", {
      name: "explicit-agent", description: "Test agent", extensions: true, skills: true, systemPrompt: "test",
    });
    agents.set("minimal-agent", {
      name: "minimal-agent", description: "Minimal agent", systemPrompt: "test",
    });
    agents.set("explicit-list", {
      name: "explicit-list", description: "List agent", skills: ["tdd"], systemPrompt: "test",
    });
    agents.set("no-skills", {
      name: "no-skills", description: "Disabled agent", extensions: false, skills: false, systemPrompt: "test",
    });
    registerAgents(agents, { disableDefaultAgents: true });
  });

  it("preserves explicit true values", () => {
    expect(getConfig("explicit-agent")).toMatchObject({ skills: true, extensions: true });
  });

  it("resolves omitted skills and extensions to false", () => {
    expect(getConfig("minimal-agent")).toMatchObject({ skills: false, extensions: false });
  });

  it("preserves explicit lists and false values", () => {
    expect(getConfig("explicit-list")).toMatchObject({ skills: ["tdd"], extensions: false });
    expect(getConfig("no-skills")).toMatchObject({ skills: false, extensions: false });
  });

  it("unknown agent type fails instead of falling back", () => {
    expect(() => getConfig("nonexistent")).toThrow("Unknown agent type: nonexistent");
  });
});

/* ------------------------------------------------------------------ */
/*  resolveSessionAllowedTools                                         */
/* ------------------------------------------------------------------ */

describe("resolveSessionAllowedTools", () => {
  const builtins = ["read", "bash", "edit"];
  const extToolMap = new Map<string, string[]>([
    ["tavily", ["web_search", "web_extract", "web_crawl"]],
    ["exa", ["exa_search"]],
  ]);

  it("tools: false — no tools allowed", () => {
    expect(resolveSessionAllowedTools({ registeredTools: builtins, tools: false, extToolMap }))
      .toEqual([]);
  });

  it("tools: string[] — only whitelisted builtins and extension tools register (no leak)", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: ["read", "tavily/*", "exa_search"],
      extToolMap,
    });
    expect(result).toEqual(expect.arrayContaining([
      "read", "web_search", "web_extract", "web_crawl", "exa_search",
    ]));
    expect(result).toHaveLength(5);
    // Builtins not in the whitelist must NOT leak into the registry gate.
    expect(result).not.toContain("bash");
    expect(result).not.toContain("edit");
  });

  it("tools: string[] with ext/tool entry — expands to the bare tool name", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: ["read", "tavily/web_search"],
      extToolMap,
    });
    expect(result).toContain("web_search");
    expect(result).not.toContain("web_extract");
  });

  it("tools: string[] with ext/* for an unloaded extension — resolves to nothing (silent)", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: ["read", "ghost/*"],
      extToolMap,
    });
    // Only the bare "read" survives; "ghost/*" finds no extension.
    expect(result).toEqual(["read"]);
  });

  it("tools: true — builtins plus every loaded extension tool", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: true,
      extToolMap,
    });
    expect(result).toEqual(expect.arrayContaining([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl", "exa_search",
    ]));
    expect(result).toHaveLength(7);
  });

  it("tools: undefined — behaves like tools: true", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: undefined,
      extToolMap,
    });
    expect(result).toEqual(expect.arrayContaining([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl", "exa_search",
    ]));
  });

  it.each([
    [undefined, "bash"],
    [true, "web_search"],
    [["read", "bash"], "bash"],
  ] as const)("subtracts exclusions from registry seeding for tools=%j", (tools, excluded) => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: (Array.isArray(tools) ? [...tools] : tools) as true | string[] | undefined,
      excludeTools: [excluded],
      extToolMap,
    });
    expect(result).not.toContain(excluded);
  });

  it("excludes EXCLUDED_TOOL_NAMES so the Agent tool never enters the registry", () => {
    const withAgent = new Map(extToolMap);
    withAgent.set("subagents", ["Agent"]);
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: true,
      extToolMap: withAgent,
    });
    expect(result).not.toContain("Agent");
  });

  it("tools: string[] with no extToolMap — bare whitelisted builtins only", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: ["read", "tavily/*"],
    });
    // No extToolMap means "tavily/*" can't expand; only the bare "read" registers.
    expect(result).toEqual(["read"]);
  });

  it("raw wildcard literals never reach pi as bogus allowedToolNames", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: ["read", "tavily/*"],
      tools: ["read", "tavily/*"],
      extToolMap,
    });
    expect(result).not.toContain("tavily/*");
    expect(result).toContain("web_search");
  });
});
