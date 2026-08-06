/**
 * agent-runner.test.ts — Tests for the agent execution engine.
 *
 * Tests focus on:
 *   - isolated parameter handling (overrides extensions/skills)
 *   - tool filtering (selection, exclusions, and extension expansion)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.ts";
import type { AgentConfig } from "../../src/agents/types.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { acceptResolvedSpawn, snapshotResolvedSpawn } from "../../src/spawn/spawn-contract.js";

const fakePi = makeFakePi();

// --- Mock module-level dependencies ---

const _loaderOpts: any[] = [];
const _loaderGetExtensionsResult: any = { extensions: [], errors: [], runtime: {} };

// DefaultResourceLoader must be a regular function (not arrow) to support `new`
function MockDefaultResourceLoader(this: any, opts: any) {
  this._opts = opts;
  this.reload = vi.fn(async () => {
    if (mockModules.loaderReloadFailure) throw mockModules.loaderReloadFailure;
  });
  this.getExtensions = vi.fn(() => {
    if (mockModules.loaderExtensionsFailure) throw mockModules.loaderExtensionsFailure;
    return _loaderGetExtensionsResult;
  });
  _loaderOpts.push(opts);
}

const mockModules = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockBuildAgentPrompt: vi.fn(),
  mockExtractText: vi.fn(),
  mockLoadSkillMeta: vi.fn().mockReturnValue([]),
  mockCreateAgentSession: vi.fn(),
  mockDefaultResourceLoader: MockDefaultResourceLoader,
  mockGetAgentDir: vi.fn(() => "/home/test/.pi/agent"),
  mockSettingsManager: { id: "shared-settings-manager" },
  mockLoadProjectContextFiles: vi.fn().mockReturnValue([]),
  mockIncludeContextFiles: true as boolean,
  loaderReloadFailure: undefined as Error | undefined,
  loaderExtensionsFailure: undefined as Error | undefined,
  getLoaderOpts: () => _loaderOpts[_loaderOpts.length - 1] ?? null,
  clearLoaderOpts: () => { _loaderOpts.length = 0; },
  setLoaderExtensions: (exts: any) => { _loaderGetExtensionsResult.extensions = exts; },
  clearLoaderExtensions: () => { _loaderGetExtensionsResult.extensions = []; },
  mockEnterSubagentSpawn: vi.fn(),
  mockExitSubagentSpawn: vi.fn(),
  mockManager: null as any,
  mockCoordinator: null as any,
  mockRevalidateWorktreePath: vi.fn(),
}));

vi.mock("../../src/agents/agent-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agents/agent-types.js")>();
  return {
    ...actual,
    getConfig: mockModules.mockGetConfig,
    getAgentConfig: mockModules.mockGetAgentConfig,
  };
});

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  revalidateWorktreePath: mockModules.mockRevalidateWorktreePath,
}));

vi.mock("../../src/prompt/prompts.js", () => ({
  buildAgentPrompt: mockModules.mockBuildAgentPrompt,
}));

vi.mock("../../src/prompt/context.js", () => ({
  extractText: mockModules.mockExtractText,
}));

vi.mock("../../src/prompt/skill-loader.js", () => ({
  loadSkillMeta: mockModules.mockLoadSkillMeta,
}));

vi.mock("../../src/shell.js", () => ({
  createSubagentRuntimeContext: () => Object.freeze({ isChildRuntime: true as const }),
  getStore: () => {
    const agent = {
      includeContextFiles: mockModules.mockIncludeContextFiles,
      disableDefaultAgents: false,
      orchestrationPrompt: true,
    };
    return {
      agent,
      createSubagentRuntimeSettings: () => ({ agent }),
    };
  },
  getSubagentRuntimeContext: () => undefined,
  getManager: () => mockModules.mockManager,
  getCoordinator: () => mockModules.mockCoordinator,
  runWithSubagentRuntime: (_context: unknown, work: () => Promise<unknown>) => work(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mockModules.mockCreateAgentSession,
  DefaultResourceLoader: mockModules.mockDefaultResourceLoader,
  SessionManager: { inMemory: vi.fn() },
  SettingsManager: { create: vi.fn(() => mockModules.mockSettingsManager) },
  getAgentDir: mockModules.mockGetAgentDir,
  loadProjectContextFiles: mockModules.mockLoadProjectContextFiles,
}));

// --- Import the module under test ---

import {
  buildSkillsOverride,
  executeAgentTurn,
  runAgent,
  subscribeToSessionEvents,
} from "../../src/agents/agent-runner.js";

const defaultConfig = {
  description: "Test agent",
  registeredTools: ["read", "bash", "edit"],
  extensions: true,
  skills: true,
};

const defaultAgentConfig = {
  name: "test-agent",
  description: "Test agent",
  extensions: true,
  skills: true,
  systemPrompt: "You are a test agent.",
  tools: undefined as (true | string[] | false | undefined),
};

/**
 * Reset all mocks to their default state.
 */
function resetMocks() {
  vi.clearAllMocks();
  mockModules.clearLoaderOpts();
  mockModules.clearLoaderExtensions();
  mockModules.mockIncludeContextFiles = true;
  mockModules.loaderReloadFailure = undefined;
  mockModules.loaderExtensionsFailure = undefined;
  mockModules.mockLoadProjectContextFiles.mockReturnValue([]);

  mockModules.mockGetConfig.mockReturnValue({ ...defaultConfig });
  mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig });
  mockModules.mockBuildAgentPrompt.mockReturnValue("system prompt");
  mockModules.mockExtractText.mockReturnValue("");
  mockModules.mockGetAgentDir.mockReturnValue("/home/test/.pi/agent");
  mockModules.mockManager = null;
  mockModules.mockCoordinator = null;
  mockModules.mockRevalidateWorktreePath.mockResolvedValue({
    ok: true, resolvedPath: "/worktree", worktreeRoot: "/worktree", label: "worktree",
  });
}

/**
 * Create a mock session with default stubs.
 */
type MockAgentSession = Omit<AgentSession, "getActiveToolNames" | "setActiveToolsByName"> & {
  agent: any;
  getActiveToolNames: any;
  setActiveToolsByName: any;
  _getListeners: () => Array<(event: any) => void>;
};

function createMockSession(): MockAgentSession {
  const listeners: Array<(event: any) => void> = [];
  return {
    setSessionName: vi.fn(),
    getActiveToolNames: vi.fn(),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    prompt: vi.fn(),
    steer: vi.fn(),
    abort: vi.fn(),
    messages: [],
    _getListeners: () => listeners,
  } as unknown as MockAgentSession;
}

/* ------------------------------------------------------------------ */
/*  runAgent — tool filtering (excluded tools)                         */
/* ------------------------------------------------------------------ */

describe("runAgent — tool filtering", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("filters out Agent from active tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit",
      "Agent",
      "grep",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
    });

    // Verify that excluded tools are filtered out
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(
      expect.not.arrayContaining([
        "Agent",
      ]),
    );

    // Verify the remaining tools are correct
    // tools: undefined → defaults to true → all tools visible (except Agent)
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).toContain("grep");
  });

  it("tools: [read, bash, edit] — whitelist filters out other tools", async () => {
    const session = createMockSession();
    // Simulate: agent wants [read, bash, edit], but session also has write and grep active
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "write", "grep", "Agent",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash", "edit"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      tools: ["read", "bash", "edit"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
    });

    // write and grep not in tools whitelist → should be rejected
    expect(session.setActiveToolsByName).toHaveBeenCalled();
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).not.toContain("write");
    expect(activeToolsCall).not.toContain("grep");
    expect(activeToolsCall).not.toContain("Agent");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — selection-minus-exclusion tools                         */
/* ------------------------------------------------------------------ */

describe("runAgent — selection-minus-exclusion tools", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("excludeTools: [write] — all tools except write", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "write", "grep", "Agent",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["write"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(session.setActiveToolsByName).toHaveBeenCalled();
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).toContain("grep");
    expect(activeToolsCall).not.toContain("write");
    expect(activeToolsCall).not.toContain("Agent");
  });

  it("excludeTools: [write, grep] — excludes multiple tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "write", "grep", "Agent",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["write", "grep"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(session.setActiveToolsByName).toHaveBeenCalled();
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).not.toContain("write");
    expect(activeToolsCall).not.toContain("grep");
    expect(activeToolsCall).not.toContain("Agent");
  });

  it("excludeTools with no matching tools — no filtering needed", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["write"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // No filtering needed — write not in active tools
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("subtracts excludeTools after a tools whitelist", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "write", "grep",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["bash"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toEqual(["read"]);
  });

  it("excludeTools with ext/* syntax — excludes all tools from extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
          ["web_crawl", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(session.setActiveToolsByName).toHaveBeenCalled();
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).not.toContain("web_search");
    expect(activeToolsCall).not.toContain("web_extract");
    expect(activeToolsCall).not.toContain("web_crawl");
    expect(activeToolsCall).not.toContain("Agent");
    const sessionOptions = mockModules.mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).not.toEqual(expect.arrayContaining(["web_search", "web_extract", "web_crawl"]));
  });

  it("excludeTools with mixed syntax — ext/* and bare names", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "write", "web_search", "web_extract",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["write", "tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(session.setActiveToolsByName).toHaveBeenCalled();
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).not.toContain("write");
    expect(activeToolsCall).not.toContain("web_search");
    expect(activeToolsCall).not.toContain("web_extract");
    expect(activeToolsCall).not.toContain("Agent");
  });
});

/* ------------------------------------------------------------------ */
/*  subscribeToSessionEvents — cost extraction                         */
/* ------------------------------------------------------------------ */

describe("subscribeToSessionEvents — cost extraction", () => {
  it("extracts u.cost?.total from assistant message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    // Fire assistant message_end with cost data on event.message.usage
    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: 2.5 } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 0,
      cost: 2.5,
    });

    unsub();
  });

  it("defaults cost to 0 when message.usage has no cost field", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    // Fire message_end with message.usage but no cost
    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10 },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 0,
      cost: 0,
    });

    unsub();
  });

  it("defaults cost to 0 when cost.total is null", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: null } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 0,
      cost: 0,
    });

    unsub();
  });

  it("extracts nonzero cacheRead from usage", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 200, cost: { total: 1.5 } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 200,
      cost: 1.5,
    });

    unsub();
  });

  it("reports successful compaction usage separately from assistant usage", () => {
    const onAssistantUsage = vi.fn();
    const onSupplementalUsage = vi.fn();
    const onCompaction = vi.fn();
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(session, { onAssistantUsage, onSupplementalUsage, onCompaction });

    session._getListeners()[0]({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: {
        summary: "summary",
        firstKeptEntryId: "kept-1",
        tokensBefore: 1000,
        usage: { input: 400, output: 50, cacheRead: 300, cacheWrite: 25, cost: { total: 0.12 } },
      },
    });

    expect(onSupplementalUsage).toHaveBeenCalledWith({
      input: 400,
      output: 50,
      cacheRead: 300,
      cacheWrite: 25,
      cost: 0.12,
    });
    expect(onAssistantUsage).not.toHaveBeenCalled();
    expect(onCompaction).toHaveBeenCalledWith({
      reason: "threshold",
      tokensBefore: 1000,
      summary: "summary",
      firstKeptEntryId: "kept-1",
    });

    unsub();
  });

  it("reports typed tool-result usage separately from assistant usage", () => {
    const onAssistantUsage = vi.fn();
    const onSupplementalUsage = vi.fn();
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(session, { onAssistantUsage, onSupplementalUsage });

    session._getListeners()[0]({
      type: "message_end",
      message: {
        role: "toolResult",
        usage: { input: 30, output: 5, cacheRead: 20, cacheWrite: 10, cost: { total: 0.03 } },
      },
    });

    expect(onSupplementalUsage).toHaveBeenCalledWith({
      input: 30,
      output: 5,
      cacheRead: 20,
      cacheWrite: 10,
      cost: 0.03,
    });
    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("does not fire onAssistantUsage for user message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    // Fire user message_end (should be ignored)
    listeners[0]({
      type: "message_end",
      message: {
        role: "user",
        content: "Hello",
        usage: { input: 0, output: 0, cacheWrite: 0, cost: { total: 100 } },
      },
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("does not fire onAssistantUsage for other event types", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    // Fire non-message_end event
    listeners[0]({
      type: "turn_end",
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("does not fire onAssistantUsage when usage is missing", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    // Fire message_end without usage at all
    listeners[0]({
      type: "message_end",
      message: { role: "assistant", content: "Hello" },
      // no usage field
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("returns a noop unsubscribe when no callbacks are provided", () => {
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(session, {});
    expect(typeof unsub).toBe("function");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — skill selection and exclusion                           */
/* ------------------------------------------------------------------ */

describe("runAgent — skill selection and exclusion", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("subtracts excludeSkills from explicit skill metadata", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const excludeSkills = ["blocked"];
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      skills: ["visible", "blocked"],
      excludeSkills,
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      skills: ["visible", "blocked"],
      excludeSkills,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, projectTrusted: true });

    expect(mockModules.mockLoadSkillMeta).toHaveBeenCalledWith(
      ["visible", "blocked"], expect.any(String), excludeSkills,
    );
    const loader = mockModules.getLoaderOpts();
    expect(loader.noSkills).toBe(true);
    expect(loader.skillsOverride({
      skills: [{ name: "visible" }, { name: "blocked" }],
      diagnostics: ["kept"],
    })).toEqual({ skills: [{ name: "visible" }], diagnostics: ["kept"] });
  });

  it("keeps skills=false empty while filtering excluded names", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      skills: false,
      excludeSkills: ["blocked"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      skills: false,
      excludeSkills: ["blocked"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadSkillMeta).not.toHaveBeenCalled();
    const loader = mockModules.getLoaderOpts();
    expect(loader.noSkills).toBe(true);
    expect(loader.skillsOverride({
      skills: [{ name: "blocked" }, { name: "other" }],
      diagnostics: ["kept"],
    })).toEqual({ skills: [], diagnostics: ["kept"] });
  });

  it("keeps skills=true as metadata while excluding selected names", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      skills: true,
      excludeSkills: ["blocked"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      skills: true,
      excludeSkills: ["blocked"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadSkillMeta).not.toHaveBeenCalled();
    const loader = mockModules.getLoaderOpts();
    expect(loader.noSkills).toBe(false);
    expect(loader.skillsOverride({
      skills: [{ name: "allowed" }, { name: "blocked" }],
      diagnostics: ["kept"],
    })).toEqual({ skills: [{ name: "allowed" }], diagnostics: ["kept"] });
  });

  it("applies the complete metadata policy to skills added after reload", () => {
    const resources = {
      skills: [{ name: "allowed" }, { name: "blocked" }, { name: "other" }],
      diagnostics: ["kept"],
    } as any;

    expect(buildSkillsOverride(false, ["blocked"])(resources).skills).toEqual([]);
    expect(buildSkillsOverride(["allowed", "blocked"], ["blocked"])(resources).skills)
      .toEqual([{ name: "allowed" }]);
    expect(buildSkillsOverride(true, ["blocked"])(resources).skills)
      .toEqual([{ name: "allowed" }, { name: "other" }]);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — extension name-based filtering                          */
/* ------------------------------------------------------------------ */

describe("runAgent — extension name-based filtering", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("passes extensionsOverride that filters to listed extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "glob",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });
    // Don't pre-set loader extensions — the override should filter them
    mockModules.clearLoaderExtensions();

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // Verify the override filters correctly
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        { path: "/home/test/.pi/agent/extensions/extra-tools/glob.ts", tools: new Map([["glob", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("extensionsOverride extracts extension name from ext/tool syntax", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily/web_search"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // The override should resolve "tavily/web_search" → "tavily" for extension loading
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        { path: "/home/test/.pi/agent/extensions/other/index.ts", tools: new Map([["other_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("extensionsOverride filters hook-only extensions not in the list", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/confirm-edits/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    // confirm-edits not in list → filtered out by override
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("no extensionsOverride when extensions=true", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(loaderCall.extensionsOverride).toBeUndefined();
  });

  it("no extensionsOverride when extensions=false", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(true);
    expect(loaderCall.extensionsOverride).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — selection-minus-exclusion extensions                    */
/* ------------------------------------------------------------------ */
describe("runAgent — selection-minus-exclusion extensions", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("excludeExtensions filters out listed extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      excludeExtensions: ["quality-monitor"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // Verify the override filters correctly
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("excludeExtensions filters multiple extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      excludeExtensions: ["quality-monitor", "confirm-edits"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/confirm-edits/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("subtracts excludeExtensions after an extensions whitelist", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["quality-monitor", "tavily"],
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["quality-monitor", "tavily"],
      excludeExtensions: ["quality-monitor"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    // The selected quality-monitor extension is removed after selection.
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });
});

/* ------------------------------------------------------------------ */
/*  tools field — extension tool names and ext/all syntax              */
/* ------------------------------------------------------------------ */

describe("tools field — extension tool names and ext/all syntax", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("tools: [read, web_search] allows extension tool by name", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "web_search"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "web_search"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("web_search");
    // web_extract not in tools list -> filtered out
    expect(activeTools).not.toContain("web_extract");
    // bash not in tools list -> filtered out
    expect(activeTools).not.toContain("bash");
    expect(activeTools).not.toContain("Agent");
  });

  it("ext/all syntax: tavily/* expands to all tavily tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
          ["web_crawl", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    expect(activeTools).toContain("web_crawl");
    expect(activeTools).not.toContain("bash");
  });

  it("seeds createAgentSession tools allowlist with expanded extension tools", async () => {
    // Regression: pi treats createAgentSession({ tools }) as a registry gate.
    // A builtins-only allowlist silently drops every extension tool, so the
    // agent never sees web_search/web_extract/web_crawl even though the
    // extension is loaded. The allowlist must contain the concrete names.
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
          ["web_crawl", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const sessionOpts = mockModules.mockCreateAgentSession.mock.calls[0][0];
    // Whitelist semantics: only "read" + the expanded tavily tools register.
    // bash/edit are NOT in the whitelist, so they must not leak into the gate.
    expect(sessionOpts.tools).toEqual(expect.arrayContaining([
      "read", "web_search", "web_extract", "web_crawl",
    ]));
    expect(sessionOpts.tools).not.toContain("bash");
    expect(sessionOpts.tools).not.toContain("edit");
    expect(sessionOpts.tools).not.toContain("tavily/*");
    expect(sessionOpts.tools).not.toContain("Agent");
  });

  it("warning: tool name not found in any loaded extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "foobar"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "foobar"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([["web_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('tool "foobar" not found in any loaded extension'),
    );

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).not.toContain("foobar");
    expect(activeTools).not.toContain("web_search");
  });

  it("warning: extension loaded but none of its tools in tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "bash"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "bash"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
  });

  it("warning: ext/all references non-loaded extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["exa"],
      tools: ["read", "tavily/*"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["exa"],
      tools: ["read", "tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/exa/index.ts",
        tools: new Map([["exa_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is not loaded, "tavily/*" will have no effect'),
    );

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).not.toContain("web_search");
  });

  it("tools: true allows all tools (no filtering)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "glob",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      tools: true,
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
      tools: true,
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([["web_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // tools: true -> no filtering (except excluded tools)
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("tools: false hides all tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      tools: false,
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
      tools: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toEqual([]);
  });

  it("loads extensions while tools=false keeps extension and root tools out of the session", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "web_search", "Agent", "StopAgent", "AgentStatus",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      tools: false,
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
      tools: false,
    });
    mockModules.setLoaderExtensions([{
      path: "/home/test/.pi/agent/extensions/tavily/index.ts",
      tools: new Map([["web_search", {}]]),
    }]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loader = mockModules.getLoaderOpts();
    const sessionOptions = mockModules.mockCreateAgentSession.mock.calls[0][0];
    expect(loader.noExtensions).toBe(false);
    expect(loader.extensionsOverride).toBeUndefined();
    expect(session.bindExtensions).toHaveBeenCalledOnce();
    expect(sessionOptions.tools).toEqual([]);
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([]);
  });

  it("ext/all combined with named extension tool", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl", "exa_search",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily", "exa"],
      tools: ["read", "tavily/*", "exa_search"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily", "exa"],
      tools: ["read", "tavily/*", "exa_search"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
          ["web_crawl", {}],
        ]),
      },
      {
        path: "/home/test/.pi/agent/extensions/exa/index.ts",
        tools: new Map([["exa_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    expect(activeTools).toContain("web_crawl");
    expect(activeTools).toContain("exa_search");
    expect(activeTools).not.toContain("bash");
  });

  it("tools field overrides extensions for visibility", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    // extensions: [tavily] loads tavily, but tools: [read] hides its tools
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
    expect(activeTools).not.toContain("bash");

    // Also warns that tavily is loaded but none of its tools are in tools
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );
  });

  it("no warning when tools is undefined (falls back to extensions-based filtering)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract", "Agent",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: undefined,
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: undefined,
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // No warnings when tools is not set
    expect(warnSpy).not.toHaveBeenCalled();

    // Falls back to extensions-based filtering: all tavily tools allowed, Agent filtered out
    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    expect(activeTools).not.toContain("Agent");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — context file gating (includeContextFiles)              */
/* ------------------------------------------------------------------ */

describe("runAgent — context file gating", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("loads context files when includeContextFiles is true", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = true;
    mockModules.mockLoadProjectContextFiles.mockReturnValue([
      { path: "AGENTS.md", content: "project instructions" },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, projectTrusted: true });

    expect(mockModules.mockLoadProjectContextFiles).toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        contextFiles: [{ path: "AGENTS.md", content: "project instructions" }],
      }),
    );
  });

  it("does NOT load context files when includeContextFiles is false", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = false;

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, projectTrusted: true });

    expect(mockModules.mockLoadProjectContextFiles).not.toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ contextFiles: expect.anything() }),
    );
  });

  it("context file loading failure is non-fatal", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = true;
    mockModules.mockLoadProjectContextFiles.mockImplementation(() => {
      throw new Error("permission denied");
    });

    // Should not throw
    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, projectTrusted: true });

    expect(mockModules.mockLoadProjectContextFiles).toHaveBeenCalled();
    // buildAgentPrompt still called (without contextFiles)
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalled();
  });

  it("does not load project context for a legacy run without trust", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = true;
    mockModules.mockLoadProjectContextFiles.mockReturnValue([
      { path: "AGENTS.md", content: "must stay out" },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadProjectContextFiles).not.toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ contextFiles: expect.anything() }),
    );
  });

  it("keeps the user-global context file available without project trust", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-user-context-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "AGENTS.md"), "global user instructions", "utf8");
      const session = createMockSession();
      session.getActiveToolNames.mockReturnValue(["read"]);
      mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
      mockModules.mockGetAgentDir.mockReturnValue(root);

      await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

      expect(mockModules.mockLoadProjectContextFiles).not.toHaveBeenCalled();
      expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          contextFiles: [{ path: join(root, "AGENTS.md"), content: "global user instructions" }],
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes one trusted Pi SettingsManager to the loader and session", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const config: AgentConfig = {
      name: "trusted",
      description: "Trusted",
      systemPrompt: "Trusted prompt",
      extensions: false,
      skills: false,
    };
    const acceptedSpawn = acceptResolvedSpawn(snapshotResolvedSpawn({
      type: "trusted",
      prompt: "trusted prompt",
      description: "Trusted",
      runInBackground: false,
      agentConfig: config,
      runtimeSettings: {
        agent: { includeContextFiles: false, disableDefaultAgents: false, orchestrationPrompt: true },
      },
      projectTrusted: true,
    }));

    await runAgent(fakeCtx(), "stale", "stale", { pi: fakePi, acceptedSpawn });

    expect(mockModules.mockSettingsManager).toBeDefined();
    expect(mockModules.mockCreateAgentSession).toHaveBeenCalledOnce();
    expect((await import("@earendil-works/pi-coding-agent")).SettingsManager.create).toHaveBeenCalledWith(
      "/home/test/project",
      "/home/test/.pi/agent",
      { projectTrusted: true },
    );
    const sessionOptions = mockModules.mockCreateAgentSession.mock.calls[0][0];
    expect(mockModules.getLoaderOpts().settingsManager).toBe(sessionOptions.settingsManager);
    expect(sessionOptions.settingsManager).toBe(mockModules.mockSettingsManager);
    expect(sessionOptions.settingsManager).toBeDefined();
  });
});

/*  runAgent — notify buffering (session tree corruption fix)          */
/* ------------------------------------------------------------------ */

describe("runAgent — notify buffering", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /**
   * Create a session where prompt doesn't resolve until resolvePrompt() is called.
   * This lets us check notify call ordering relative to the turn loop.
   */
  function createPendingPromptSession() {
    const session = createMockSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () => new Promise<void>((r) => {
        resolvePrompt = r;
      }),
    );
    return { session, resolvePrompt: () => resolvePrompt() };
  }

  it("does not warn for a valid selection-plus-exclusion combination", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning (tools + excludeTools both set)
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    ctx.ui = {
      notify: vi.fn(),
    };

    const promise = runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // At this point setup is done but prompt is still pending — notify should NOT have been called yet
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(ctx.ui.notify).not.toHaveBeenCalled();

    // Complete the turn loop
    resolvePrompt();
    await promise;

    // Selection/exclusion combinations are valid and remain silent.
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not emit a conflict warning when tools and excludeTools are both set", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning (tools + excludeTools)
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not use console.warn for a valid exclusion combination", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    // No ctx.ui — should fall back to console.warn

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("console.warn fallback also remains silent after turn loop", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    // No ctx.ui — console.warn fallback

    const promise = runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // Setup done, prompt pending — console.warn should NOT have been called yet
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(warnSpy).not.toHaveBeenCalled();

    // Complete the turn loop
    resolvePrompt();
    await promise;

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — queued configuration snapshots                         */
/* ------------------------------------------------------------------ */

describe("runAgent — agent config snapshot", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("uses a supplied snapshot without reading the mutable agent registry", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const snapshot: AgentConfig = {
      name: "reviewer",
      description: "Worktree A reviewer",
      systemPrompt: "A-only prompt.",
      registeredTools: ["read"],
      tools: ["read"],
      extensions: false,
      skills: false,
    };
    mockModules.mockGetConfig.mockImplementation(() => { throw new Error("registry config must not be read"); });
    mockModules.mockGetAgentConfig.mockImplementation(() => { throw new Error("registry agent must not be read"); });

    await runAgent(fakeCtx(), "reviewer", "review A", { pi: fakePi, agentConfig: snapshot });

    expect(mockModules.mockGetConfig).not.toHaveBeenCalled();
    expect(mockModules.mockGetAgentConfig).not.toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      snapshot,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockModules.mockCreateAgentSession.mock.calls[0][0].tools).toEqual(["read"]);
  });

  it("carries already-resolved internal model and thinking values into session setup", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const snapshot: AgentConfig = {
      name: "reviewer",
      description: "Review",
      systemPrompt: "Review.",
      model: "agent-md/model",
      thinkingLevel: "high",
    };
    const ctx = fakeCtx();
    const model = { provider: "resolved", id: "spawn-model" };

    await runAgent(ctx, "reviewer", "review", {
      pi: fakePi,
      agentConfig: snapshot,
      model: model as any,
      thinkingLevel: "minimal",
    });

    expect(mockModules.mockCreateAgentSession.mock.calls[0][0]).toMatchObject({
      model,
      thinkingLevel: "minimal",
    });
  });

  it("uses the accepted contract without registry or tunable re-resolution", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const config: AgentConfig = {
      name: "accepted",
      description: "Accepted",
      systemPrompt: "Accepted prompt.",
      registeredTools: ["read"],
      tools: ["read"],
      extensions: false,
      skills: false,
    };
    const model = { provider: "accepted", id: "model" };
    const runtimeSettings = {
      agent: { includeContextFiles: false, disableDefaultAgents: false, orchestrationPrompt: true },
      agents: { accepted: { model: "settings/model" } },
    } as any;
    const acceptedSpawn = acceptResolvedSpawn(snapshotResolvedSpawn({
      type: "accepted",
      prompt: "accepted prompt",
      description: "Accepted",
      runInBackground: false,
      agentConfig: config,
      runtimeSettings,
      model: model as any,
      modelKey: "accepted/model",
      thinkingLevel: "high",
    }));
    mockModules.mockGetConfig.mockImplementation(() => { throw new Error("config registry must not be read"); });
    mockModules.mockGetAgentConfig.mockImplementation(() => { throw new Error("agent registry must not be read"); });

    await runAgent(fakeCtx(), "stale", "stale prompt", {
      pi: fakePi,
      acceptedSpawn,
    });

    expect(mockModules.mockGetConfig).not.toHaveBeenCalled();
    expect(mockModules.mockGetAgentConfig).not.toHaveBeenCalled();
    expect(mockModules.mockCreateAgentSession.mock.calls[0][0]).toMatchObject({
      model,
      thinkingLevel: "high",
    });
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      config,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(session.prompt).toHaveBeenCalledWith("accepted prompt");
  });

  it("rejects an unknown type instead of applying a fallback definition", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue(undefined);

    await expect(runAgent(fakeCtx(), "unknown", "work", { pi: fakePi }))
      .rejects.toThrow("Unknown agent type: unknown");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — abort and callback event paths                         */
/* ------------------------------------------------------------------ */

describe("runAgent — abort and callback event paths", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("does not create or prompt a session when the supplied signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(mockModules.mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it("falls back to the final assistant message when no text deltas were emitted", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    (session.messages as any).push({ role: "assistant", content: [{ type: "text", text: "completed from history" }] });
    session.prompt = vi.fn().mockResolvedValue(undefined) as any;
    mockModules.mockExtractText.mockImplementation((content: any[]) => content?.find((part) => part.type === "text")?.text ?? "");
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const result = await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(result.responseText).toBe("completed from history");
  });

  it("never returns prior assistant text for an empty continuation turn", async () => {
    const session = createMockSession();
    (session.messages as any).push({ role: "assistant", content: [{ type: "text", text: "previous answer" }] });
    session.prompt = vi.fn().mockResolvedValue(undefined) as any;

    const result = await executeAgentTurn(session as any, "follow up", {});

    // The continuation emits no deltas and no new assistant message: the
    // result must be empty, never the prior execution's text.
    expect(result.responseText).toBe("");
  });

  it("keeps the opt-in history fallback for initial runs", async () => {
    const session = createMockSession();
    (session.messages as any).push({ role: "assistant", content: [{ type: "text", text: "completed from history" }] });
    session.prompt = vi.fn().mockResolvedValue(undefined) as any;
    mockModules.mockExtractText.mockImplementation((content: any[]) => content?.find((part) => part.type === "text")?.text ?? "");

    const result = await executeAgentTurn(session as any, "do something", { fallbackToLastAssistantText: true });

    expect(result.responseText).toBe("completed from history");
  });

  it.each([
    ["resource reload", "loader reload failed", () => { mockModules.loaderReloadFailure = new Error("loader reload failed"); }],
    ["extension discovery", "extension discovery failed", () => { mockModules.loaderExtensionsFailure = new Error("extension discovery failed"); }],
  ] as const)("does not create a session when %s fails", async (_phase, message, fail) => {
    fail();

    await expect(runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi }))
      .rejects.toThrow(message);

    expect(mockModules.mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it("does not publish or prompt a session when session creation fails", async () => {
    const creationFailure = new Error("session creation failed");
    const onSessionCreated = vi.fn();
    mockModules.mockCreateAgentSession.mockRejectedValueOnce(creationFailure);

    await expect(runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      onSessionCreated,
    })).rejects.toBe(creationFailure);

    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("disposes a session created after the run was aborted during setup", async () => {
    const session = createMockSession();
    session.dispose = vi.fn();
    session.getActiveToolNames.mockReturnValue(["read"]);
    let finishCreation!: (value: { session: ReturnType<typeof createMockSession>; extensionsResult: object }) => void;
    mockModules.mockCreateAgentSession.mockReturnValue(new Promise((resolve) => { finishCreation = resolve; }));
    const controller = new AbortController();
    const onSessionCreated = vi.fn();

    const run = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      signal: controller.signal,
      onSessionCreated,
    });
    await vi.waitFor(() => expect(mockModules.mockCreateAgentSession).toHaveBeenCalledOnce());
    controller.abort();
    finishCreation({ session, extensionsResult: {} });

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("disposes a created session when extension binding fails", async () => {
    const session = createMockSession();
    session.dispose = vi.fn();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("extension binding failed")) as any;
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await expect(runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi }))
      .rejects.toThrow("extension binding failed");

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("reports extension binding errors through tool activity", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    session.bindExtensions = vi.fn(async ({ onError }) => {
      onError({ extensionPath: "/extensions/failing.ts" });
    }) as any;
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const onToolActivity = vi.fn();

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, onToolActivity });

    expect(onToolActivity).toHaveBeenCalledWith({
      type: "end",
      toolName: "extension-error:/extensions/failing.ts",
    });
  });

  it("forwards abort while a prompt is running and removes the listener afterward", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve; })) as any;
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const controller = new AbortController();

    const run = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    controller.abort();
    expect(session.abort).toHaveBeenCalledOnce();

    resolvePrompt();
    await run;
    controller.abort();
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("cleans session listeners and abort forwarding when prompt fails", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    session.prompt = vi.fn().mockRejectedValue(new Error("prompt failed")) as any;
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const controller = new AbortController();

    await expect(runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      signal: controller.signal,
    })).rejects.toThrow("prompt failed");

    expect(session._getListeners()).toHaveLength(0);
    controller.abort();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("forwards session-created, text-delta, and tool activity callbacks", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve; })) as any;
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const onSessionCreated = vi.fn();
    const onTextDelta = vi.fn();
    const onToolActivity = vi.fn();

    const run = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      onSessionCreated,
      onTextDelta,
      onToolActivity,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    for (const listener of session._getListeners()) {
      listener({ type: "tool_execution_start", toolName: "read" });
      listener({ type: "message_start" });
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
      listener({ type: "tool_execution_end", toolName: "read" });
    }
    resolvePrompt();
    await run;

    expect(onSessionCreated).toHaveBeenCalledWith(session);
    expect(onTextDelta).toHaveBeenCalledWith("hello", "hello");
    expect(onToolActivity).toHaveBeenNthCalledWith(1, { type: "start", toolName: "read" });
    expect(onToolActivity).toHaveBeenNthCalledWith(2, { type: "end", toolName: "read" });
  });
});

describe("runAgent — worktree revalidation", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("does not load runner resources or create a session after a selected worktree is swapped", async () => {
    mockModules.mockRevalidateWorktreePath.mockResolvedValueOnce({
      ok: false,
      error: "worktree_path changed after validation",
    });

    await expect(runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      cwd: "/selected-worktree",
      worktreeSelectionPath: "/links/selected-worktree",
      worktreeParentCwd: "/parent-repository",
    })).rejects.toThrow("worktree_path changed after validation");

    expect(mockModules.mockRevalidateWorktreePath).toHaveBeenCalledWith(
      fakePi,
      "/links/selected-worktree",
      "/parent-repository",
      "/selected-worktree",
    );
    expect(mockModules.getLoaderOpts()).toBeNull();
    expect(mockModules.mockCreateAgentSession).not.toHaveBeenCalled();
  });
});
