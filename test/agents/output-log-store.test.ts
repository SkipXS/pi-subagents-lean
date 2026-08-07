/**
 * output-log-store.test.ts — output-root, path, and descriptor security contracts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fsPromisesHooks = vi.hoisted(() => ({
  lstat: undefined as ((...args: any[]) => Promise<any>) | undefined,
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const fallbackLstat = actual.lstat as unknown as (...args: any[]) => Promise<any>;
  return {
    ...actual,
    lstat: (...args: any[]) => fsPromisesHooks.lstat?.(...args) ?? fallbackLstat(...args),
  };
});

import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { canCreateSymlinks, tempDirFixture } from "../fixtures.ts";
import {
  assertWindowsOpenedFileIdentity,
  cleanupOutputRoots,
  createOutputFilePath,
  createOutputRoot,
  getOutputLogAccounting,
  MAX_OUTPUT_PARENT_ENTRIES,
  MAX_OUTPUT_GLOBAL_PASS_ENTRIES,
  MAX_OUTPUT_ROOT_DEPTH,
  MAX_OUTPUT_ROOTS,
  OUTPUT_ROOT_MAX_AGE_MS,
  releaseOutputRoot,
  writeInitialEntry,
  AgentOutputLog,
  whenOutputLogsIdle,
} from "../../src/agents/output-file.js";

const testAgentId = "test-agent-123";
const fixture = tempDirFixture();
const canRunPosixLinkTests = process.platform !== "win32" && canCreateSymlinks();

function privilegeRestrictedLinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && ["EACCES", "EPERM", "ENOSYS", "ENOTSUP"].includes(code ?? "");
}

function makeJanitorRoot(name: string, modifiedAt: number, content = "log"): string {
  const root = join(fixture.getDir(), name);
  mkdirSync(root);
  chmodSync(root, 0o700);
  const file = join(root, "agent.log");
  writeFileSync(file, content);
  chmodSync(file, 0o600);
  utimesSync(root, new Date(modifiedAt), new Date(modifiedAt));
  return root;
}

beforeEach(() => fixture.setup());
afterEach(async () => {
  await whenOutputLogsIdle();
  fixture.teardown();
});

describe("createOutputFilePath", () => {
  it("returns <baseDir>/<agentId>.log", () => {
    const dir = fixture.getDir();
    const result = createOutputFilePath(testAgentId, dir);
    expect(result).toBe(join(dir, `${testAgentId}.log`));
  });

  it.skipIf(process.platform === "win32")("creates private directories and files with explicit modes", async () => {
    const dir = fixture.getDir() + "/sub";
    const outputPath = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(outputPath, "mode check");
    await whenOutputLogsIdle();
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
  });

  it("returns consistent path for same agentId", () => {
    const dir = fixture.getDir();
    expect(createOutputFilePath("same-id", dir)).toBe(createOutputFilePath("same-id", dir));
  });

  it.skipIf(!canRunPosixLinkTests)("fails closed when a log path is replaced by a symlink", async () => {
    const dir = fixture.getDir();
    const outputPath = createOutputFilePath(testAgentId, dir);
    await whenOutputLogsIdle();

    const outside = join(dir, "outside.log");
    writeFileSync(outside, "sentinel");
    symlinkSync(outside, outputPath, "file");

    await writeInitialEntry(outputPath, "must not escape");
    expect(readFileSync(outside, "utf8")).toBe("sentinel");
  });

  it.skipIf(!canRunPosixLinkTests)("fails closed when an append log path is replaced by a symlink", async () => {
    const dir = fixture.getDir();
    const outputPath = createOutputFilePath(testAgentId, dir);
    await writeInitialEntry(outputPath, "initial");
    await whenOutputLogsIdle();

    const outside = join(dir, "append-outside.log");
    writeFileSync(outside, "sentinel");
    unlinkSync(outputPath);
    symlinkSync(outside, outputPath, "file");

    const continuation = new AgentOutputLog(testAgentId, "must not escape", dir, true);
    await continuation.whenIdle();
    expect(readFileSync(outside, "utf8")).toBe("sentinel");
  });

  it("fails closed for a hardlink sentinel swap on every host that supports hardlinks", async ({ skip }) => {
    const dir = fixture.getDir();
    const outputPath = createOutputFilePath(testAgentId, dir);
    await writeInitialEntry(outputPath, "initial");
    await whenOutputLogsIdle();

    const sentinel = join(dir, "hardlink-sentinel.log");
    writeFileSync(sentinel, "sentinel");
    unlinkSync(outputPath);
    try {
      linkSync(sentinel, outputPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "UV_FS_O_FILEMAP"].includes(code ?? "")) {
        skip();
        return;
      }
      throw error;
    }

    const continuation = new AgentOutputLog(testAgentId, "must not reach sentinel", dir, true);
    await continuation.whenIdle();
    expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
  });

  it("rejects an original log whose nlink became greater than one", async ({ skip }) => {
    const dir = fixture.getDir();
    const outputPath = createOutputFilePath(testAgentId, dir);
    await writeInitialEntry(outputPath, "initial");
    await whenOutputLogsIdle();
    const secondName = join(dir, "original-hardlink.log");
    try {
      linkSync(outputPath, secondName);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "UV_FS_O_FILEMAP"].includes(code ?? "")) {
        skip();
        return;
      }
      throw error;
    }

    const before = readFileSync(outputPath, "utf8");
    const continuation = new AgentOutputLog(testAgentId, "must not append", dir, true);
    await continuation.whenIdle();
    expect(readFileSync(outputPath, "utf8")).toBe(before);
    expect(readFileSync(secondName, "utf8")).toBe(before);
  });

  it.skipIf(!canRunPosixLinkTests)("fails closed when the private root is exchanged for a symlink", async () => {
    const root = createOutputRoot(fixture.getDir());
    const outputPath = createOutputFilePath(testAgentId, root);
    await whenOutputLogsIdle();

    const outsideDir = join(fixture.getDir(), "outside-root");
    const outside = join(outsideDir, `${testAgentId}.log`);
    mkdirSync(outsideDir);
    writeFileSync(outside, "sentinel");
    const movedRoot = `${root}-moved`;
    renameSync(root, movedRoot);
    symlinkSync(outsideDir, root, "dir");
    try {
      await writeInitialEntry(outputPath, "must not escape");
    } finally {
      unlinkSync(root);
      renameSync(movedRoot, root);
    }

    expect(readFileSync(outside, "utf8")).toBe("sentinel");
  });

  it.skipIf(!canRunPosixLinkTests)("keeps concurrent writes inside when the root is repeatedly exchanged", async () => {
    const root = createOutputRoot(fixture.getDir());
    const log = new AgentOutputLog(testAgentId, "initial", root);
    await whenOutputLogsIdle();

    const outsideDir = join(fixture.getDir(), "race-outside");
    const outside = join(outsideDir, `${testAgentId}.log`);
    mkdirSync(outsideDir);
    writeFileSync(outside, "sentinel");
    const movedRoot = `${root}-moved`;
    for (let index = 0; index < 96; index++) log.append(`race-${index}`);
    const racer = (async () => {
      for (let attempt = 0; attempt < 24; attempt++) {
        let moved = false;
        try {
          renameSync(root, movedRoot);
          moved = true;
          symlinkSync(outsideDir, root, "dir");
          await new Promise<void>((resolveNext) => setImmediate(resolveNext));
        } finally {
          try { unlinkSync(root); } catch { /* root may already be absent */ }
          if (moved) renameSync(movedRoot, root);
        }
      }
    })();

    await racer;
    await whenOutputLogsIdle();
    expect(readFileSync(outside, "utf8")).toBe("sentinel");
  });

  it.each(["../escape", "nested/agent", "", ".", "agent\\\\name"])("rejects unsafe agent id %j", (agentId) => {
    expect(() => createOutputFilePath(agentId, fixture.getDir())).toThrow("Invalid agent id");
  });

  it("uses a fresh absolute private temp root when baseDir is omitted", () => {
    const outputPath = createOutputFilePath("test");
    expect(isAbsolute(outputPath)).toBe(true);
    expect(outputPath).not.toBe(join(tmpdir(), "pi-agent-outputs", "test.log"));
    expect(outputPath).toContain("pi-subagents-outputs-");
  });

  it("fails closed for a simulated Windows post-open root identity exchange", () => {
    const regular = (dev: number, ino: number, linked = false) => ({
      dev,
      ino,
      isFile: () => true,
      isSymbolicLink: () => linked,
    });
    expect(() => assertWindowsOpenedFileIdentity(
      regular(1, 2),
      regular(1, 2),
      { dev: 9, ino: 9, isDirectory: () => true, isSymbolicLink: () => false },
      { dev: 1, ino: 2 },
    )).toThrow("Output log root was exchanged");
    expect(() => assertWindowsOpenedFileIdentity(
      regular(1, 2),
      regular(1, 2, true),
      { dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false },
      { dev: 1, ino: 2 },
    )).toThrow("Output log file was exchanged");
  });

  it("closes an over-wide candidate-parent iterator without consuming the rest", async () => {
    const entries = Array.from({ length: MAX_OUTPUT_PARENT_ENTRIES + 40 }, (_, index) => ({
      name: `unrelated-${index}`,
    }));
    let cursor = 0;
    let consumed = 0;
    let returned = false;
    let closed = false;
    const directory = {
      next: async () => {
        if (cursor >= entries.length) return { value: undefined, done: true };
        consumed++;
        return { value: entries[cursor++], done: false };
      },
      return: async () => {
        returned = true;
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return this; },
      close: async () => { closed = true; },
    };
    const opendir = vi.spyOn(fs.promises, "opendir").mockResolvedValueOnce(directory as any);
    try {
      const result = await cleanupOutputRoots({ parentDir: fixture.getDir() });
      expect(result).toEqual({ scannedRoots: 0, skippedRoots: 0, deletedRoots: [] });
      expect(consumed).toBe(MAX_OUTPUT_PARENT_ENTRIES + 1);
      expect(consumed).toBeLessThan(entries.length);
      expect(returned || closed).toBe(true);
      expect(closed).toBe(true);
    } finally {
      opendir.mockRestore();
    }
  });

  it("uses one deterministic global janitor budget across all roots", async () => {
    const parent = fixture.getDir();
    const names = Array.from({ length: 10_000 }, (_, index) =>
      `pi-subagents-outputs-global-${String(index).padStart(5, "0")}`,
    );
    const nameSet = new Set(names);
    const now = Date.now();
    const directoryStats = (filePath: string, directory: boolean) => ({
      size: directory ? 0 : 1,
      mtimeMs: now,
      ctimeMs: now,
      mode: directory ? 0o700 : 0o600,
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      dev: 1,
      ino: directory ? Number(filePath.length) + 1 : Number(filePath.length) + 2,
      nlink: 1,
      isDirectory: () => directory,
      isFile: () => !directory,
      isSymbolicLink: () => false,
    });
    const fakeIterator = (entries: Array<{ name: string }>) => {
      let cursor = 0;
      return {
        next: async () => cursor < entries.length
          ? { value: entries[cursor++], done: false }
          : { value: undefined, done: true },
        return: async () => ({ value: undefined, done: true }),
        [Symbol.asyncIterator]() { return this; },
        close: async () => undefined,
      };
    };
    let openedParent = false;
    const opendir = vi.spyOn(fs.promises, "opendir").mockImplementation(async (_directory: any) => {
      if (!openedParent) {
        openedParent = true;
        return fakeIterator(names.map((name) => ({ name }))) as any;
      }
      return fakeIterator([{ name: "agent.log" }, { name: "second.log" }]) as any;
    });
    fsPromisesHooks.lstat = async (filePath: any, ...args: any[]) => {
      const value = String(filePath);
      const rootName = /pi-subagents-outputs-global-[0-9]{5}/u.exec(value)?.[0];
      if (rootName && nameSet.has(rootName)) {
        if (value.endsWith(".pi-subagents-active")) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return directoryStats(value, !value.endsWith(".log")) as any;
      }
      return fs.promises.lstat(filePath, ...args) as any;
    };
    try {
      const result = await cleanupOutputRoots({ parentDir: parent, now: () => now });
      expect(result.scannedRoots).toBe(names.length);
      expect(result.deletedRoots).toEqual([]);
      expect(MAX_OUTPUT_GLOBAL_PASS_ENTRIES).toBe(50_000);
      // Parent entries (10k), root inspections (10k), and each root's three
      // tree entries consume the pass exactly. Deletion is deterministically
      // skipped because no budget remains for a complete second validation.
      expect(result.skippedRoots).toBe(0);
    } finally {
      opendir.mockRestore();
      fsPromisesHooks.lstat = undefined;
    }
  });

  // Native Windows opendir canonicalizes 8.3 aliases before Vitest's method
  // spy sees the handle. Real Windows junction/identity/retention paths are
  // covered below; this synthetic iterator-close boundary is POSIX-specific.
  it.skipIf(process.platform === "win32")("closes a root iterator at the entry limit and skips that root", async () => {
    const now = Date.now();
    const root = makeJanitorRoot("pi-subagents-outputs-wide-root", now - OUTPUT_ROOT_MAX_AGE_MS - 1);
    const entries = Array.from({ length: 10_000 + 40 }, () => ({
      name: "agent.log",
    }));
    let cursor = 0;
    let consumed = 0;
    let returned = false;
    let closed = false;
    const directory = {
      next: async () => {
        if (cursor >= entries.length) return { value: undefined, done: true };
        consumed++;
        return { value: entries[cursor++], done: false };
      },
      return: async () => {
        returned = true;
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return this; },
      close: async () => { closed = true; },
    };
    const originalOpendir = fs.promises.opendir;
    const opendir = vi.spyOn(fs.promises, "opendir").mockImplementation(async (candidate: any, ...args: any[]) => {
      // Windows CI may canonicalize an 8.3 temp-parent alias before opening.
      if (basename(String(candidate)) === basename(root)) return directory as any;
      return originalOpendir(candidate, ...args) as any;
    });
    try {
      const result = await cleanupOutputRoots({ parentDir: fixture.getDir(), now: () => now });
      expect(result.deletedRoots).not.toContain(root);
      expect(result.skippedRoots).toBe(1);
      expect(existsSync(root)).toBe(true);
      // The root itself consumes one budget entry, so the violating child is
      // the 10,000th yielded directory entry.
      expect(consumed).toBe(10_000);
      expect(consumed).toBeLessThan(entries.length);
      expect(returned || closed).toBe(true);
      expect(closed).toBe(true);
    } finally {
      opendir.mockRestore();
    }
  });

  it("skips a root whose visible tree exceeds the depth bound", async () => {
    const now = Date.now();
    const root = makeJanitorRoot("pi-subagents-outputs-depth", now - OUTPUT_ROOT_MAX_AGE_MS - 1);
    let current = root;
    for (let depth = 1; depth <= MAX_OUTPUT_ROOT_DEPTH + 1; depth++) {
      current = join(current, `d${depth}`);
      mkdirSync(current);
    }
    writeFileSync(join(current, "deep.log"), "deep");
    utimesSync(root, new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1), new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1));

    const result = await cleanupOutputRoots({ parentDir: fixture.getDir(), now: () => now });
    expect(result.deletedRoots).not.toContain(root);
    expect(existsSync(root)).toBe(true);
  });

  it("retains the current root while enforcing the global root count", async () => {
    const now = Date.now();
    const roots = Array.from({ length: MAX_OUTPUT_ROOTS + 2 }, (_, index) =>
      makeJanitorRoot(`pi-subagents-outputs-retention-${index}`, now - index * 1_000),
    );
    const result = await cleanupOutputRoots({
      parentDir: fixture.getDir(),
      now: () => now,
      currentRoot: roots[0],
    });

    expect(result.deletedRoots).toHaveLength(2);
    expect(result.deletedRoots).not.toContain(roots[0]);
    expect(existsSync(roots[0])).toBe(true);
    expect(roots.slice(2).some((root) => existsSync(root))).toBe(true);
  });

  it("removes verified roots older than seven days but skips unclear roots", async ({ skip }) => {
    const now = Date.now();
    const oldRoot = makeJanitorRoot(
      "pi-subagents-outputs-retention-old",
      now - OUTPUT_ROOT_MAX_AGE_MS - 1,
    );
    const unclearRoot = join(fixture.getDir(), "pi-subagents-outputs-retention-unclear");
    mkdirSync(unclearRoot);
    chmodSync(unclearRoot, 0o700);
    const outside = join(fixture.getDir(), "janitor-outside.log");
    writeFileSync(outside, "sentinel");
    try {
      symlinkSync(outside, join(unclearRoot, "linked.log"), "file");
    } catch (error) {
      if (privilegeRestrictedLinkError(error) || (!canRunPosixLinkTests && process.platform !== "win32")) {
        skip();
        return;
      }
      throw error;
    }
    utimesSync(unclearRoot, new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1), new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1));

    const result = await cleanupOutputRoots({ parentDir: fixture.getDir(), now: () => now });
    expect(result.deletedRoots).toContain(oldRoot);
    expect(existsSync(unclearRoot)).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("sentinel");
  });

  it("protects a live root across janitor instances and removes it after explicit release", async () => {
    const now = Date.now();
    const root = createOutputRoot(fixture.getDir());
    utimesSync(root, new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1), new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1));

    const whileLive = await cleanupOutputRoots({
      parentDir: fixture.getDir(),
      now: () => now,
    });
    expect(whileLive.deletedRoots).not.toContain(root);
    expect(existsSync(root)).toBe(true);

    await releaseOutputRoot(root);
    // Removing the marker updates the directory mtime; make the retained-root
    // age deterministic for the second janitor pass.
    utimesSync(root, new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1), new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1));
    const afterRelease = await cleanupOutputRoots({
      parentDir: fixture.getDir(),
      now: () => now,
    });
    expect(afterRelease.deletedRoots).toContain(root);
    expect(existsSync(root)).toBe(false);
  });

  it("enforces the global byte bound for verified persistent roots", async () => {
    const now = Date.now();
    const oversized = makeJanitorRoot("pi-subagents-outputs-retention-oversized", now);
    const file = join(oversized, "agent.log");
    truncateSync(file, 256 * 1024 * 1024 + 1);

    const result = await cleanupOutputRoots({ parentDir: fixture.getDir(), now: () => now });
    expect(result.deletedRoots).toContain(oversized);
    expect(existsSync(oversized)).toBe(false);
  });

  it("skips a root containing a hardlinked file", async ({ skip }) => {
    const now = Date.now();
    const root = makeJanitorRoot("pi-subagents-outputs-retention-hardlink", now - OUTPUT_ROOT_MAX_AGE_MS - 1);
    const file = join(root, "agent.log");
    const outside = join(fixture.getDir(), "hardlink-outside.log");
    try {
      linkSync(file, outside);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "UV_FS_O_FILEMAP"].includes(code ?? "")) {
        skip();
        return;
      }
      throw error;
    }

    const result = await cleanupOutputRoots({
      parentDir: fixture.getDir(),
      now: () => now,
    });
    expect(result.deletedRoots).not.toContain(root);
    expect(existsSync(root)).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("log");
  });

  it.skipIf(process.platform === "win32")("skips a root with a non-private POSIX mode", async () => {
    const now = Date.now();
    const insecure = makeJanitorRoot("pi-subagents-outputs-retention-insecure", now);
    chmodSync(insecure, 0o755);

    const result = await cleanupOutputRoots({
      parentDir: fixture.getDir(),
      now: () => now + OUTPUT_ROOT_MAX_AGE_MS + 1,
    });
    expect(result.deletedRoots).not.toContain(insecure);
    expect(existsSync(insecure)).toBe(true);
  });

  it("releases accounting after queued writes drain without losing the queued entry", async () => {
    const root = createOutputRoot(fixture.getDir());
    const outputPath = createOutputFilePath(testAgentId, root);
    const write = writeInitialEntry(outputPath, "queued before release");
    const release = releaseOutputRoot(root);
    await Promise.all([write, release]);
    await whenOutputLogsIdle();

    expect(readFileSync(outputPath, "utf8")).toContain("queued before release");
    expect(getOutputLogAccounting(outputPath)).toEqual({
      fileBytes: 0,
      rootBytes: 0,
      fileTruncated: false,
      rootTruncated: false,
    });
  });
});

// These tests deliberately run on Windows rather than skipping the complete
// security suite. Only the operation that needs a privileged link is skipped.
describe("Windows output-log identity boundary", () => {
  it.skipIf(process.platform !== "win32")("rejects a root junction exchange after open", async ({ skip }) => {
    const root = createOutputRoot(fixture.getDir());
    const outputPath = createOutputFilePath(testAgentId, root);
    await whenOutputLogsIdle();
    const outsideDir = join(fixture.getDir(), "windows-outside-root");
    const outside = join(outsideDir, `${testAgentId}.log`);
    mkdirSync(outsideDir);
    writeFileSync(outside, "sentinel");
    const movedRoot = `${root}-moved`;
    renameSync(root, movedRoot);
    try {
      try {
        symlinkSync(outsideDir, root, "junction");
      } catch (error) {
        if (privilegeRestrictedLinkError(error)) {
          skip();
          return;
        }
        throw error;
      }
      await writeInitialEntry(outputPath, "must not escape junction");
      expect(readFileSync(outside, "utf8")).toBe("sentinel");
    } finally {
      try { unlinkSync(root); } catch { /* link creation may have failed */ }
      renameSync(movedRoot, root);
      await releaseOutputRoot(root);
    }
  });

  it.skipIf(process.platform !== "win32")("rejects a file symlink before writing", async ({ skip }) => {
    const root = createOutputRoot(fixture.getDir());
    const outputPath = createOutputFilePath(testAgentId, root);
    await writeInitialEntry(outputPath, "initial");
    await whenOutputLogsIdle();
    const outside = join(fixture.getDir(), "windows-file-outside.log");
    writeFileSync(outside, "sentinel");
    unlinkSync(outputPath);
    try {
      try {
        symlinkSync(outside, outputPath, "file");
      } catch (error) {
        if (privilegeRestrictedLinkError(error)) {
          skip();
          return;
        }
        throw error;
      }
      await writeInitialEntry(outputPath, "must not escape file link");
      expect(readFileSync(outside, "utf8")).toBe("sentinel");
    } finally {
      try { unlinkSync(outputPath); } catch { /* link creation may have failed */ }
      await releaseOutputRoot(root);
    }
  });
});
