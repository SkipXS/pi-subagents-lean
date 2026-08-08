import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { MAX_SUBAGENTS_CONFIG_BYTES } from "../../src/config/types.ts";

const {
  mockGetAgentDir,
  mockLstatSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockRenameSync,
  mockUnlinkSync,
  mockRmSync,
  mockMkdirSync,
} = vi.hoisted(() => ({
  mockGetAgentDir: vi.fn(),
  mockLstatSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: mockGetAgentDir,
}));

vi.mock("node:fs", () => ({
  lstatSync: mockLstatSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  unlinkSync: mockUnlinkSync,
  rmSync: mockRmSync,
  mkdirSync: mockMkdirSync,
}));

const configDir = "/tmp/pi-agent";
const primaryPath = join(configDir, "subagents-lean.json");
const backupPath = `${primaryPath}.bak`;
const files = new Map<string, string | Buffer | Error>();

function missingError(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function setFile(filePath: string, contents: string | Buffer | Error): void {
  files.set(filePath, contents);
}

function fileBytes(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}

beforeEach(() => {
  files.clear();
  mockGetAgentDir.mockReturnValue(configDir);
  mockLstatSync.mockImplementation((filePath: string) => {
    const value = files.get(filePath);
    if (value === undefined) throw missingError();
    if (value instanceof Error) throw value;
    const bytes = fileBytes(value);
    return { isFile: () => true, size: bytes.byteLength };
  });
  mockReadFileSync.mockImplementation((filePath: string) => {
    const value = files.get(filePath);
    if (value === undefined) throw missingError();
    if (value instanceof Error) throw value;
    return value;
  });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/config/config-io.ts");
}

describe("read-only config I/O", () => {
  it("loads a valid primary with scalar and per-agent normalization", async () => {
    setFile(primaryPath, JSON.stringify({
      agent: {
        includeContextFiles: false,
        disableDefaultAgents: true,
        orchestrationPrompt: false,
        ignoredRole: "provider/model",
      },
      agents: {
        Scout: { model: "provider/first", thinking: "high", ignored: true },
        scout: { thinking: "low" },
        reviewer: { model: "provider/reviewer", thinking: "invalid" },
      },
      concurrency: { default: 2 },
    }));
    const { createConfigFileIO, loadConfig } = await loadModule();

    const expected = {
      agent: { includeContextFiles: false, disableDefaultAgents: true, orchestrationPrompt: false },
      agents: {
        scout: { thinking: "low" },
        reviewer: { model: "provider/reviewer" },
      },
      concurrency: { default: 2 },
    };
    expect(loadConfig()).toEqual(expected);
    expect(createConfigFileIO(configDir).load()).toEqual(expected);
  });

  it("returns defaults for a missing primary without consulting a valid backup", async () => {
    setFile(backupPath, JSON.stringify({ concurrency: { default: 9 } }));
    const { loadConfig } = await loadModule();

    expect(loadConfig()).toEqual({
      agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      concurrency: { default: 4 },
    });
    expect(mockLstatSync).not.toHaveBeenCalledWith(backupPath);
    expect(mockReadFileSync).not.toHaveBeenCalledWith(backupPath);
  });

  it.each(["{broken", "null", "42", "[]", JSON.stringify({ agent: "not-an-object" })])(
    "returns defaults for an invalid primary without changing its bytes (%j)",
    async (contents) => {
      setFile(primaryPath, contents);
      const { loadConfig } = await loadModule();

      expect(loadConfig()).toEqual({
        agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
        concurrency: { default: 4 },
      });
      expect(files.get(primaryPath)).toBe(contents);
    },
  );

  it("uses a valid backup for an invalid primary and leaves both candidates unchanged", async () => {
    setFile(primaryPath, "{broken");
    const backup = JSON.stringify({ agent: {}, concurrency: { default: 7 } });
    setFile(backupPath, backup);
    const { loadConfig } = await loadModule();

    expect(loadConfig()).toEqual({
      agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      concurrency: { default: 7 },
    });
    expect(files.get(primaryPath)).toBe("{broken");
    expect(files.get(backupPath)).toBe(backup);
  });

  it("uses a valid backup for an unreadable primary", async () => {
    setFile(primaryPath, fileError("EACCES"));
    setFile(backupPath, JSON.stringify({ concurrency: { default: 3 } }));
    const { loadConfig } = await loadModule();

    expect(loadConfig().concurrency).toEqual({ default: 3 });
    expect(mockReadFileSync).toHaveBeenCalledWith(primaryPath);
    expect(files.get(primaryPath)).toBeInstanceOf(Error);
  });

  it("rejects an oversized primary before reading or parsing it", async () => {
    setFile(primaryPath, Buffer.alloc(MAX_SUBAGENTS_CONFIG_BYTES + 1, 0x7b));
    const parse = vi.spyOn(JSON, "parse");
    const { loadConfig } = await loadModule();

    expect(loadConfig()).toEqual({
      agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      concurrency: { default: 4 },
    });
    expect(mockReadFileSync).not.toHaveBeenCalledWith(primaryPath);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("falls back from an oversized primary to a valid backup without writing", async () => {
    setFile(primaryPath, Buffer.alloc(MAX_SUBAGENTS_CONFIG_BYTES + 1, 0x7b));
    setFile(backupPath, JSON.stringify({ concurrency: { default: 6 } }));
    const { createConfigFileIO } = await loadModule();

    expect(createConfigFileIO(configDir).load().concurrency).toEqual({ default: 6 });
    expect(mockReadFileSync).not.toHaveBeenCalledWith(primaryPath);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("classifies an unreadable primary as defaults when no valid backup exists", async () => {
    setFile(primaryPath, fileError("EACCES"));
    const { loadConfig } = await loadModule();

    expect(loadConfig().concurrency).toEqual({ default: 4 });
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("exposes only a load operation and performs no filesystem writes", async () => {
    setFile(primaryPath, JSON.stringify({ agent: {}, concurrency: { default: 4 } }));
    const { createConfigFileIO } = await loadModule();
    const io = createConfigFileIO(configDir);

    expect(Object.keys(io)).toEqual(["load"]);
    io.load();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });
});
