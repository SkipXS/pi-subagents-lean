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

  it("normalizes dynamic agent entries at the file boundary", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: {
        default: null,
        forceBackground: false,
        dynamicModel: "provider/model",
        dynamicNull: null,
        dynamicNumber: 42,
        dynamicBoolean: true,
      },
      concurrency: { default: 4 },
    }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    const config = loadConfig().config;
    expect(config.agent.dynamicModel).toBe("provider/model");
    expect(config.agent.dynamicNull).toBeNull();
    expect(config.agent).not.toHaveProperty("dynamicNumber");
    expect(config.agent).not.toHaveProperty("dynamicBoolean");
  });

  it.each([
    ["non-record root", "null", false],
    ["invalid agent", JSON.stringify({ agent: "not-an-object" }), false],
    ["invalid concurrency", JSON.stringify({ concurrency: "not-an-object" }), false],
    ["invalid thinking overrides", JSON.stringify({ thinkingOverrides: "not-an-object" }), false],
    ["optional sections omitted", JSON.stringify({}), true],
    ["optional sections are records", JSON.stringify({ agent: {}, concurrency: {}, thinkingOverrides: {} }), true],
  ] as const)("validates config shape when %s", async (_label, contents, valid) => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockImplementationOnce(() => contents).mockImplementation(() => {
      const err = new Error("missing") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    const result = loadConfig();
    expect(result.health).toBe(valid ? "healthy" : "unrecoverable");
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

  it("tolerates legacy mode/model/thinking keys and drops them on normalized write", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({
      mode: { legacy: true },
      ecoModelOverrides: ["legacy/model"],
      ecoThinkingOverrides: "legacy/thinking",
      agent: { default: "openai/gpt-4o" },
      concurrency: { default: 7 },
    }));
    vi.resetModules();

    const { loadConfig, saveConfigAtomic } = await import("../../src/config/config-io.ts");
    const result = loadConfig();
    expect(result.health).toBe("healthy");
    expect(result.config).not.toHaveProperty("mode");
    expect(result.config).not.toHaveProperty("ecoModelOverrides");
    expect(result.config).not.toHaveProperty("ecoThinkingOverrides");
    expect(result.config.agent.default).toBe("openai/gpt-4o");
    expect(result.config.concurrency.default).toBe(7);

    saveConfigAtomic(result.config);
    const configWrite = mockWriteFileSync.mock.calls.find(([file]) => String(file).endsWith(".tmp") && !String(file).includes(".bak."));
    const saved = JSON.parse(String(configWrite![1]));
    expect(saved).not.toHaveProperty("mode");
    expect(saved).not.toHaveProperty("ecoModelOverrides");
    expect(saved).not.toHaveProperty("ecoThinkingOverrides");
  });

  it("tolerates and drops legacy presentation fields while retaining functional settings", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: {
        default: null,
        forceBackground: false,
        widgetShowModelThinking: false,
        widgetShowStartTime: false,
        showCost: true,
        delegate_to: ["scout"],
        max_child_agents: 2,
        maxNestingDepth: 2,
        orchestrationPrompt: false,
      },
      concurrency: { default: 4 },
    }));
    vi.resetModules();
    const { loadConfig } = await import("../../src/config/config-io.ts");
    const config = loadConfig().config;
    expect(config.agent).not.toHaveProperty("widgetShowModelThinking");
    expect(config.agent).not.toHaveProperty("widgetShowStartTime");
    expect(config.agent).not.toHaveProperty("showCost");
    expect(config.agent).not.toHaveProperty("delegate_to");
    expect(config.agent).not.toHaveProperty("max_child_agents");
    expect(config.agent).not.toHaveProperty("maxNestingDepth");
    expect(config.agent.orchestrationPrompt).toBe(false);
  });

  it("does not recreate removed presentation keys when a write callback touches them", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { default: null, forceBackground: false },
      concurrency: { default: 4 },
    }));
    vi.resetModules();

    const { updateConfigAtomic } = await import("../../src/config/config-io.ts");
    const result = updateConfigAtomic((config) => {
      (config.agent as Record<string, unknown>).widgetCompact = true;
      (config.agent as Record<string, unknown>).delegate_to = ["scout"];
      (config.agent as Record<string, unknown>).max_child_agents = 2;
      (config.agent as Record<string, unknown>).maxNestingDepth = 2;
      (config.agent as Record<string, unknown>).dynamicModel = "provider/model";
      (config.agent as Record<string, unknown>).dynamicNull = null;
      (config.agent as Record<string, unknown>).dynamicNumber = 42;
      (config.agent as Record<string, unknown>).dynamicBoolean = true;
      config.agent.forceBackground = true;
    });
    expect(result.config.agent.forceBackground).toBe(true);
    expect(result.config.agent).not.toHaveProperty("widgetCompact");
    expect(result.config.agent).not.toHaveProperty("delegate_to");
    expect(result.config.agent).not.toHaveProperty("max_child_agents");
    expect(result.config.agent).not.toHaveProperty("maxNestingDepth");
    expect(result.config.agent.dynamicModel).toBe("provider/model");
    expect(result.config.agent.dynamicNull).toBeNull();
    expect(result.config.agent).not.toHaveProperty("dynamicNumber");
    expect(result.config.agent).not.toHaveProperty("dynamicBoolean");
    const configWrite = mockWriteFileSync.mock.calls.find(([file]) => String(file).endsWith(".tmp") && !String(file).includes(".bak."));
    expect(JSON.parse(String(configWrite![1])).agent).not.toHaveProperty("widgetCompact");
    expect(JSON.parse(String(configWrite![1])).agent).not.toHaveProperty("delegate_to");
    expect(JSON.parse(String(configWrite![1])).agent).not.toHaveProperty("max_child_agents");
    expect(JSON.parse(String(configWrite![1])).agent).not.toHaveProperty("maxNestingDepth");
    expect(JSON.parse(String(configWrite![1])).agent).toMatchObject({ dynamicModel: "provider/model", dynamicNull: null });
    expect(JSON.parse(String(configWrite![1])).agent).not.toHaveProperty("dynamicNumber");
    expect(JSON.parse(String(configWrite![1])).agent).not.toHaveProperty("dynamicBoolean");
  });

  it("rejects repair when neither a primary nor backup config exists", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    vi.resetModules();

    const { repairConfig } = await import("../../src/config/config-io.ts");
    expect(() => repairConfig()).toThrow("Cannot repair config");
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

  it.each([
    ["write", mockWriteFileSync],
    ["open", mockOpenSync],
    ["fsync", mockFsyncSync],
  ])("preserves a %s failure, cleans its temp file, and releases the lock", async (_stage, failingCall) => {
    const agentDir = "/tmp/pi-agent";
    const configPath = join(agentDir, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    const failure = new Error(`${_stage} failed`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetAgentDir.mockReturnValue(agentDir);
    if (_stage === "write") {
      failingCall.mockImplementation((file) => {
        if (String(file).endsWith(".tmp")) throw failure;
      });
    } else {
      failingCall.mockImplementationOnce(() => { throw failure; });
    }
    mockReadFileSync.mockImplementation((file) => {
      if (String(file) === join(lockPath, "owner.json")) {
        const ownerWrite = mockWriteFileSync.mock.calls.find(([candidate]) => String(candidate).endsWith("owner.json"));
        return ownerWrite?.[1] ?? "{}";
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    vi.resetModules();

    try {
      const { createConfigFileIO } = await import("../../src/config/config-io.ts");
      expect(() => createConfigFileIO(agentDir).update(() => undefined)).toThrow(failure);
      const tempWrite = mockWriteFileSync.mock.calls.find(([file]) => String(file).includes("subagents-lean.json.") && String(file).endsWith(".tmp"));
      if (tempWrite) expect(mockUnlinkSync).toHaveBeenCalledWith(tempWrite[0]);
      expect(mockRmSync).toHaveBeenCalledWith(lockPath, { recursive: true, force: true });
    } finally {
      error.mockRestore();
    }
  });

  it("preserves a close-only failure, cleans its temp file, releases the lock, and permits a retry", async () => {
    const agentDir = "/tmp/pi-agent";
    const configPath = join(agentDir, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    const closeFailure = new Error("close failed");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetAgentDir.mockReturnValue(agentDir);
    mockCloseSync.mockImplementationOnce(() => { throw closeFailure; });
    mockReadFileSync.mockImplementation((file) => {
      if (String(file) === join(lockPath, "owner.json")) {
        const ownerWrites = mockWriteFileSync.mock.calls.filter(([candidate]) => String(candidate).endsWith("owner.json"));
        return ownerWrites.at(-1)?.[1] ?? "{}";
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    vi.resetModules();

    try {
      const { createConfigFileIO } = await import("../../src/config/config-io.ts");
      const io = createConfigFileIO(agentDir);
      let thrown: unknown;
      try {
        io.update(() => undefined);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBe(closeFailure);
      const failedTemp = mockWriteFileSync.mock.calls.find(([file]) => String(file).includes("subagents-lean.json.") && String(file).endsWith(".tmp"))![0];
      expect(mockUnlinkSync).toHaveBeenCalledWith(failedTemp);
      expect(mockRmSync).toHaveBeenCalledWith(lockPath, { recursive: true, force: true });

      expect(() => io.update((config) => { config.concurrency.default = 3; })).not.toThrow();
      expect(mockRenameSync.mock.calls.filter(([, target]) => target === configPath)).toHaveLength(1);
      expect(mockRmSync.mock.calls.filter(([file]) => file === lockPath)).toHaveLength(2);
    } finally {
      error.mockRestore();
    }
  });

  it("preserves the fsync error when close and cleanup also fail", async () => {
    const agentDir = "/tmp/pi-agent";
    const syncFailure = new Error("fsync primary");
    mockGetAgentDir.mockReturnValue(agentDir);
    mockFsyncSync.mockImplementationOnce(() => { throw syncFailure; });
    mockCloseSync.mockImplementationOnce(() => { throw new Error("close secondary"); });
    mockUnlinkSync.mockImplementationOnce(() => { throw new Error("cleanup secondary"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();

    const { createConfigFileIO } = await import("../../src/config/config-io.ts");
    expect(() => createConfigFileIO(agentDir).update(() => undefined)).toThrow(syncFailure);
  });

  it("releases the lock when the mutator throws and permits a retry", async () => {
    const agentDir = "/tmp/pi-agent";
    const configPath = join(agentDir, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    mockGetAgentDir.mockReturnValue(agentDir);
    mockReadFileSync.mockImplementation((file) => {
      if (String(file) === join(lockPath, "owner.json")) {
        const ownerWrites = mockWriteFileSync.mock.calls.filter(([candidate]) => String(candidate).endsWith("owner.json"));
        return ownerWrites.at(-1)?.[1] ?? "{}";
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    vi.resetModules();

    const { createConfigFileIO } = await import("../../src/config/config-io.ts");
    const io = createConfigFileIO(agentDir);
    const mutationFailure = new Error("mutation failed");
    expect(() => io.update(() => { throw mutationFailure; })).toThrow(mutationFailure);
    expect(() => io.update((config) => { config.concurrency.default = 3; })).not.toThrow();
    expect(mockRmSync.mock.calls.filter(([file]) => file === lockPath)).toHaveLength(2);
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

  it("reclaims a stale lock and retries entirely within the mocked process", async () => {
    const agentDir = "/tmp/pi-agent";
    const configPath = join(agentDir, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    const staleOwner = { token: "stale-owner", pid: 321, hostname: "local-host", createdAt: 0 };
    let staleOwnerRead = true;
    let lockPublishAttempts = 0;
    const kill = vi.fn(() => {
      throw Object.assign(new Error("stale owner is gone"), { code: "ESRCH" });
    });
    mockGetAgentDir.mockReturnValue(agentDir);
    mockReadFileSync.mockImplementation((file) => {
      if (String(file) === join(lockPath, "owner.json")) {
        if (staleOwnerRead) {
          staleOwnerRead = false;
          return JSON.stringify(staleOwner);
        }
        const ownerWrites = mockWriteFileSync.mock.calls.filter(([candidate]) => String(candidate).endsWith("owner.json"));
        return String(ownerWrites.at(-1)?.[1] ?? "{}");
      }
      const err = new Error("missing") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    mockRenameSync.mockImplementation((_source, target) => {
      if (String(target) === lockPath && lockPublishAttempts++ === 0) {
        throw Object.assign(new Error("pending publish raced"), { code: "EEXIST" });
      }
    });
    vi.resetModules();

    const { createConfigFileIO } = await import("../../src/config/config-io.ts");
    const result = createConfigFileIO(agentDir, {
      lockTimeoutMs: 0,
      staleLockMs: 10,
      now: () => 100_000,
      hostname: () => "local-host",
      kill,
    }).update(() => undefined);

    expect(result.health).toBe("healthy");
    expect(kill).toHaveBeenCalledWith(321, 0);
    expect(mockRenameSync.mock.calls.filter(([, target]) => target === lockPath)).toHaveLength(2);
    expect(mockRenameSync.mock.calls.some(([source, target]) => (
      source === lockPath && String(target).startsWith(`${lockPath}.stale-`)
    ))).toBe(true);
    expect(mockRmSync.mock.calls.some(([file]) => String(file).startsWith(`${lockPath}.stale-`))).toBe(true);
    expect(mockRmSync).toHaveBeenCalledWith(lockPath, { recursive: true, force: true });
    expect(staleOwnerRead).toBe(false);
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
