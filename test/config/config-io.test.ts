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
  it("defaults global concurrency to four", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({ agent: { default: null } }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().config.concurrency).toEqual({ default: 4 });
  });

  it("accepts only current known agent settings at the file boundary", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: {
        includeContextFiles: false,
        disableDefaultAgents: true,
        orchestrationPrompt: false,
        ignoredRole: "provider/model",
        anotherIgnoredRole: "provider/reviewer",
        ignoredRoot: { reviewer: "high" },
      },
      concurrency: { default: 4 },
    }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().config).toEqual({
      agent: { includeContextFiles: false, disableDefaultAgents: true, orchestrationPrompt: false },
      concurrency: { default: 4 },
    });
  });

  it("rejects repair when neither a primary nor backup config exists", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    vi.resetModules();

    const { repairConfig } = await import("../../src/config/config-io.ts");
    expect(() => repairConfig()).toThrow("Cannot repair config");
  });

  it("uses Pi's agent directory for the renamed config when HOME is unset", async () => {
    const agentDir = "C:\\Users\\Pi User\\.pi\\agent";
    vi.stubEnv("HOME", "");
    mockGetAgentDir.mockReturnValue(agentDir);
    vi.resetModules();

    const { saveConfigAtomic } = await import("../../src/config/config-io.ts");
    saveConfigAtomic({ agent: {}, concurrency: { default: 4 } });

    const configPath = join(agentDir, "subagents-lean.json");
    expect(mockGetAgentDir).toHaveBeenCalledOnce();
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
    expect(loadConfig().config).toMatchObject({ concurrency: { default: 4 }, agent: { orchestrationPrompt: true } });
    expect(() => saveConfigAtomic({ agent: {} as any, concurrency: {} as any }))
      .toThrow("primary config is corrupt");
    expect(mockWriteFileSync.mock.calls.some(([file]) => String(file).endsWith(".tmp") && !String(file).includes(".bak."))).toBe(false);
  });
});
