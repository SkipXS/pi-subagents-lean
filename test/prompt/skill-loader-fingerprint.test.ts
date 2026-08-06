import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  realpathSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  cwd: "",
  home: "",
  agentDir: "",
  loadSkills: vi.fn(),
  loadSkillsFromDir: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    lstatSync: mocks.lstatSync,
    realpathSync: mocks.realpathSync,
    readdirSync: mocks.readdirSync,
    statSync: mocks.statSync,
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => mocks.home };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mocks.agentDir,
  loadSkills: mocks.loadSkills,
  loadSkillsFromDir: mocks.loadSkillsFromDir,
}));

import { loadAllSkills } from "../../src/prompt/skill-loader.ts";

function stats(kind: "directory" | "file" | "symlink" | "other") {
  return {
    size: 1,
    mtimeMs: 1,
    ctimeMs: 1,
    mode: 0,
    ino: 1,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

function missingError(): NodeJS.ErrnoException {
  const error = new Error("missing") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

describe("skill fingerprint edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const root = join(tmpdir(), `skill-fingerprint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mocks.home = join(root, "home");
    mocks.agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const ancestorRoot = join(cwd, ".agents", "skills");
    const projectRoot = join(cwd, ".pi", "skills");
    const sharedDirectory = join(root, "shared-target");
    const badDirectory = join(projectRoot, "bad-directory");
    const fileLink = join(projectRoot, "linked.md");
    const directoryLinkA = join(projectRoot, "linked-a");
    const directoryLinkB = join(projectRoot, "linked-b");
    const brokenLink = join(projectRoot, "broken");
    const disappearing = join(ancestorRoot, "disappearing");
    const entries = new Map<string, string[]>([
      [ancestorRoot, ["disappearing"]],
      [projectRoot, ["z-file", "a-file", "bad-directory", "linked.md", "linked-a", "linked-b", "broken"]],
      [sharedDirectory, []],
    ]);
    const directories = new Set([ancestorRoot, projectRoot, sharedDirectory, badDirectory]);
    const files = new Set([join(projectRoot, "z-file"), join(projectRoot, "a-file")]);
    const symlinks = new Set([fileLink, directoryLinkA, directoryLinkB, brokenLink]);
    const targets = new Map<string, string>([
      [fileLink, join(root, "target.md")],
      [directoryLinkA, sharedDirectory],
      [directoryLinkB, sharedDirectory],
    ]);

    mocks.readdirSync.mockImplementation((directory: string, options?: { withFileTypes?: boolean }) => {
      if (!options?.withFileTypes) return directory === cwd ? [".git"] : [];
      return (entries.get(directory) ?? []).map((name) => ({ name }));
    });
    mocks.lstatSync.mockImplementation((filePath: string) => {
      if (filePath === disappearing) throw missingError();
      if (directories.has(filePath)) return stats("directory");
      if (files.has(filePath)) return stats("file");
      if (symlinks.has(filePath)) return stats("symlink");
      throw missingError();
    });
    mocks.realpathSync.mockImplementation((filePath: string) => {
      if (filePath === badDirectory) throw new Error("directory race");
      if (filePath === brokenLink) throw missingError();
      return targets.get(filePath) ?? filePath;
    });
    mocks.statSync.mockImplementation((filePath: string) => {
      return filePath === targets.get(fileLink) ? stats("file") : stats("directory");
    });
    mocks.loadSkills.mockReturnValue({ skills: [], diagnostics: [] });
    mocks.loadSkillsFromDir.mockReturnValue({ skills: [], diagnostics: [] });

    mocks.cwd = cwd;
  });

  it("does not cache uncertain snapshots and handles metadata-only edge cases", () => {
    const cwd = mocks.cwd;

    expect(loadAllSkills(cwd)).toEqual([]);
    expect(loadAllSkills(cwd)).toEqual([]);

    // The disappearing child and broken/retargeted entries make both the
    // ancestor and project sources unstable, so both Pi loaders retry.
    expect(mocks.loadSkills).toHaveBeenCalledTimes(2);
    expect(mocks.loadSkillsFromDir).toHaveBeenCalledTimes(3);
  });
});
