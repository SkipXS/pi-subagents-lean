import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { join } from "node:path";

const { mockGetAgentDir, mockMkdirSync, mockWriteFileSync, mockRenameSync, mockUnlinkSync, mockReadFileSync, mockRmSync, mockOpenSync, mockFsyncSync, mockCloseSync } = vi.hoisted(() => ({
  mockGetAgentDir: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockOpenSync: vi.fn(() => 1),
  mockFsyncSync: vi.fn(),
  mockCloseSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: mockGetAgentDir,
}));

vi.mock("node:fs", () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  unlinkSync: mockUnlinkSync,
  readFileSync: mockReadFileSync,
  rmSync: mockRmSync,
  openSync: mockOpenSync,
  fsyncSync: mockFsyncSync,
  closeSync: mockCloseSync,
}));

beforeEach(() => {
  mockReadFileSync.mockImplementation(() => {
    const err = new Error("missing") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("config I/O paths", () => {
  it("normalizes nesting depth to 1 or 2", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    vi.resetModules();
    const { normalizeMaxNestingDepth } = await import("../../src/config/config-io.ts");
    expect(normalizeMaxNestingDepth(undefined)).toBe(2);
    expect(normalizeMaxNestingDepth("invalid")).toBe(2);
    expect(normalizeMaxNestingDepth("")).toBe(2);
    expect(normalizeMaxNestingDepth(0)).toBe(1);
    expect(normalizeMaxNestingDepth(1.9)).toBe(1);
    expect(normalizeMaxNestingDepth(2)).toBe(2);
    expect(normalizeMaxNestingDepth(3)).toBe(2);
    expect(normalizeMaxNestingDepth(4)).toBe(2);
  });
  it.each([
    ["is absent", {}, "legacy/model"],
    ["is explicitly null", { scout: null }, null],
    ["is explicitly empty", { scout: "" }, ""],
    ["has another explicit value", { scout: "new/model" }, "new/model"],
  ])("migrates legacy Explore only when scout %s", async (_, scout, expected) => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { Explore: "legacy/model", ...scout },
      concurrency: { default: 4 },
    }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().config.agent.scout).toBe(expected);
  });

  it("defaults global concurrency to four", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({ agent: { default: null, forceBackground: false } }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().config.concurrency).toEqual({ default: 4 });
  });

  it("normalizes legacy provider and model limits out of saved config", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { default: null, forceBackground: false },
      concurrency: {
        default: 2,
        providers: { llamacpp: 1 },
        models: { "llamacpp/4b": 1 },
      },
    }));
    vi.resetModules();

    const { loadConfig, saveConfigAtomic } = await import("../../src/config/config-io.ts");
    const config = loadConfig().config;
    expect(config.concurrency).toEqual({ default: 2 });

    saveConfigAtomic(config);
    const configWrite = mockWriteFileSync.mock.calls.find(([file]) => String(file).endsWith(".tmp") && !String(file).includes(".bak."));
    const saved = JSON.parse(String(configWrite![1]));
    expect(saved.concurrency).toEqual({ default: 2 });
  });

  it("drops an invalid global thinking value while loading config", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { defaultThinking: "invalid" },
      concurrency: { default: 4 },
    }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().config.agent.defaultThinking).toBeUndefined();
  });

  it("defaults and preserves widget visibility and orchestration settings", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { default: null, forceBackground: false },
      concurrency: { default: 4 },
    }));
    vi.resetModules();
    let { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().config.agent).toMatchObject({
      widgetShowModelThinking: true,
      widgetShowStartTime: true,
      orchestrationPrompt: true,
    });

    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { default: null, forceBackground: false, widgetShowModelThinking: false, widgetShowStartTime: false, orchestrationPrompt: false },
      concurrency: { default: 4 },
    }));
    vi.resetModules();
    ({ loadConfig } = await import("../../src/config/config-io.ts"));
    expect(loadConfig().config.agent).toMatchObject({
      widgetShowModelThinking: false,
      widgetShowStartTime: false,
      orchestrationPrompt: false,
    });
  });

  it("uses Pi's agent directory for renamed config and custom prompts when HOME is unset", async () => {
    const agentDir = "C:\\Users\\Pi User\\.pi\\agent";
    vi.stubEnv("HOME", "");
    mockGetAgentDir.mockReturnValue(agentDir);
    vi.resetModules();

    const { CUSTOM_PROMPT_PATH, saveConfigAtomic } = await import("../../src/config/config-io.ts");
    saveConfigAtomic({ agent: {} as any, concurrency: {} as any });

    const configPath = join(agentDir, "subagents-lean.json");
    expect(mockGetAgentDir).toHaveBeenCalledOnce();
    expect(CUSTOM_PROMPT_PATH).toBe(join(agentDir, "subagents-lean-prompt.md"));
    expect(mockMkdirSync).toHaveBeenCalledWith(agentDir, { recursive: true });
    const tmpPath = mockWriteFileSync.mock.calls.find(([file]) => String(file).endsWith(".tmp") && !String(file).includes(".bak."))![0] as string;
    expect(tmpPath.startsWith(`${configPath}.`)).toBe(true);
    expect(tmpPath.endsWith(".tmp")).toBe(true);
    expect(mockRenameSync).toHaveBeenCalledWith(tmpPath, configPath);
  });

  it("uses a distinct temporary file for each save", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    vi.resetModules();

    const { saveConfigAtomic } = await import("../../src/config/config-io.ts");
    saveConfigAtomic({ agent: {} as any, concurrency: {} as any });
    saveConfigAtomic({ agent: {} as any, concurrency: {} as any });

    const tempWrites = mockWriteFileSync.mock.calls.filter(([file]) => String(file).endsWith(".tmp") && !String(file).includes(".bak."));
    expect(tempWrites[0]![0]).not.toBe(tempWrites[1]![0]);
  });

  it("reports rename failures and removes the temporary config file", async () => {
    const agentDir = "/tmp/pi-agent";
    const renameError = new Error("simulated rename failure");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const configPath = join(agentDir, "subagents-lean.json");
    mockGetAgentDir.mockReturnValue(agentDir);
    mockRenameSync.mockImplementation((_source, target) => {
      if (target === configPath) throw renameError;
    });
    vi.resetModules();

    try {
      const { saveConfigAtomic } = await import("../../src/config/config-io.ts");
      expect(() => saveConfigAtomic({ agent: {} as any, concurrency: {} as any })).toThrow(renameError);
      const tmpPath = mockWriteFileSync.mock.calls.find(([file]) => String(file).endsWith(".tmp") && !String(file).includes(".bak."))![0];
      expect(mockUnlinkSync).toHaveBeenCalledWith(tmpPath);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("simulated rename failure"));
    } finally {
      error.mockRestore();
    }
  });

  it("classifies Bun's EPERM pending-lock publish collision as contention after the destination disappears", async () => {
    const agentDir = "/tmp/pi-agent";
    const configPath = join(agentDir, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    const eperm = Object.assign(new Error("destination exists"), { code: "EPERM" });
    mockGetAgentDir.mockReturnValue(agentDir);
    mockRenameSync.mockImplementation((_source, target) => {
      if (target === lockPath) throw eperm;
    });
    vi.resetModules();

    const { ConfigLockTimeoutError, createConfigFileIO } = await import("../../src/config/config-io.ts");
    expect(() => createConfigFileIO(agentDir, {
      lockTimeoutMs: 0,
      now: () => 0,
      hostname: () => "local-host",
    }).update(() => undefined)).toThrow(ConfigLockTimeoutError);

    const pendingPath = mockMkdirSync.mock.calls.find(([candidate]) => String(candidate).startsWith(`${lockPath}.pending-`))![0];
    expect(mockRmSync).toHaveBeenCalledWith(pendingPath, { recursive: true, force: true });
    expect(mockRmSync).not.toHaveBeenCalledWith(lockPath, expect.anything());
  });

  it("propagates EPERM from the final config publish rename after acquiring the lock", async () => {
    const agentDir = "/tmp/pi-agent";
    const configPath = join(agentDir, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    const eperm = Object.assign(new Error("config destination is protected"), { code: "EPERM" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetAgentDir.mockReturnValue(agentDir);
    mockRenameSync.mockImplementation((_source, target) => {
      if (target === configPath) throw eperm;
    });
    vi.resetModules();

    try {
      const { ConfigLockTimeoutError, createConfigFileIO } = await import("../../src/config/config-io.ts");
      let thrown: unknown;
      try {
        createConfigFileIO(agentDir, { lockTimeoutMs: 0 }).update(() => undefined);
      } catch (err) {
        thrown = err;
      }
      expect(mockRenameSync.mock.calls.some(([, target]) => target === lockPath)).toBe(true);
      expect(thrown).toBe(eperm);
      expect(thrown).not.toBeInstanceOf(ConfigLockTimeoutError);
    } finally {
      error.mockRestore();
    }
  });

  it.each(["{broken", "null", "42", "[]", JSON.stringify({ agent: "not-an-object" })])("uses defaults and blocks saves for corrupt primary config %j", async (contents) => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(contents);
    vi.resetModules();

    const { loadConfig, saveConfigAtomic } = await import("../../src/config/config-io.ts");
    expect(loadConfig().config).toMatchObject({ concurrency: { default: 4 }, thinkingOverrides: {} });
    expect(() => saveConfigAtomic({ agent: {} as any, concurrency: {} as any }))
      .toThrow("primary config is corrupt");
    expect(mockWriteFileSync.mock.calls.some(([file]) => String(file).endsWith(".tmp") && !String(file).includes(".bak."))).toBe(false);
  });
});
