import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { canCreateSymlinks } from "./fixtures.ts";

const mocks = vi.hoisted(() => ({
  loadSkills: vi.fn(),
  loadSkillsFromDir: vi.fn(),
  getAgentDir: vi.fn(),
  workerRun: vi.fn(),
  workerClose: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  loadSkills: mocks.loadSkills,
  loadSkillsFromDir: mocks.loadSkillsFromDir,
  getAgentDir: mocks.getAgentDir,
}));

vi.mock("../src/prompt/skill-loader-worker.ts", () => ({
  createPiSkillLoaderWorkerAdapter: () => ({
    run: mocks.workerRun,
    close: mocks.workerClose,
  }),
}));

import {
  createSkillCatalogBudget,
  loadPiDefaultSkillsCached,
  loadPiDefaultSkillsCachedAsync,
  loadSkillsFromDirCached,
  loadSkillsFromDirCachedAsync,
} from "../src/prompt/skill-cache.ts";
import {
  filterRootMdFiles,
  loadAllSkills,
  loadAllSkillsAsync,
} from "../src/prompt/skill-catalog.ts";
import {
  fingerprintResourceTree,
  fingerprintResourceTreeAsync,
} from "../src/prompt/skill-fingerprint.js";
import { walkResourceTreeAsync } from "../src/prompt/skill-fingerprint-walk.js";

let root = "";

function makeSkill(name: string, filePath: string): Skill {
  return {
    name,
    description: name,
    filePath,
    baseDir: join(filePath, ".."),
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
}

function writeSkill(rootDir: string, name: string): string {
  const filePath = join(rootDir, name, "SKILL.md");
  mkdirSync(join(rootDir, name), { recursive: true });
  writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n`);
  return filePath;
}

beforeEach(() => {
  root = join(tmpdir(), `skill-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  mocks.loadSkills.mockReturnValue({ skills: [], diagnostics: [] });
  mocks.loadSkillsFromDir.mockReturnValue({ skills: [], diagnostics: [] });
  mocks.getAgentDir.mockReturnValue(join(root, "agent"));
  mocks.workerRun.mockResolvedValue([]);
  mocks.workerClose.mockResolvedValue(undefined);
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* fixture cleanup is best effort */ }
  vi.clearAllMocks();
});

describe("late skill cache and catalog boundaries", () => {
  it("executes the async walker and keeps symlink target identity semantic", async () => {
    const source = join(root, "fingerprint");
    const target = writeSkill(source, "target");
    if (canCreateSymlinks()) symlinkSync(target, join(source, "linked.md"), "file");

    const sync = fingerprintResourceTree(source);
    const asyncResult = await fingerprintResourceTreeAsync(source);
    expect(asyncResult).toEqual(sync);
    expect(asyncResult.value).not.toContain(source);
  });

  it("keeps async link resolution promise-based at the file and directory boundary", async () => {
    const source = mkdtempSync(join(root, "async-link-"));
    const linkStats = {
      size: 1, mtimeMs: 1, ctimeMs: 1, mode: 0, dev: 1, ino: 2, nlink: 1,
      isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true,
    };
    const fileStats = {
      size: 1, mtimeMs: 1, ctimeMs: 1, mode: 0, dev: 1, ino: 3, nlink: 1,
      isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false,
    };
    const directoryStats = {
      size: 0, mtimeMs: 1, ctimeMs: 1, mode: 0, dev: 1, ino: 4, nlink: 1,
      isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
    };
    const lstat = vi.spyOn(fs.promises, "lstat").mockResolvedValue(linkStats as any);
    const stat = vi.spyOn(fs.promises, "stat").mockResolvedValue(fileStats as any);
    const realpath = vi.spyOn(fs.promises, "realpath").mockResolvedValue("C:\\alias\\target" as any);
    try {
      await expect(walkResourceTreeAsync(source, { allowRootMarkdown: true })).resolves.toMatchObject({ stable: true });
      stat.mockResolvedValue(directoryStats as any);
      const opendir = vi.spyOn(fs.promises, "opendir").mockResolvedValue({
        next: async () => ({ value: undefined, done: true }),
        return: async () => ({ value: undefined, done: true }),
        [Symbol.asyncIterator]() { return this; },
        close: async () => undefined,
      } as any);
      await expect(walkResourceTreeAsync(source, { allowRootMarkdown: true })).resolves.toMatchObject({ stable: true });
      opendir.mockRestore();
      realpath.mockRejectedValue(new Error("retargeted"));
      await expect(walkResourceTreeAsync(source, { allowRootMarkdown: true })).resolves.toMatchObject({ stable: false });
    } finally {
      lstat.mockRestore();
      stat.mockRestore();
      realpath.mockRestore();
    }
  });

  it("shares stable entries, charges filtered roots, and invalidates changed trees", async () => {
    const source = join(root, "source");
    const skillPath = writeSkill(source, "cached");
    const skill = makeSkill("cached", skillPath);
    mocks.loadSkillsFromDir.mockReturnValue({ skills: [skill], diagnostics: [] });

    expect(loadSkillsFromDirCached(source, "user")).toEqual([skill]);
    expect(loadSkillsFromDirCached(source, "user")).toEqual([skill]);
    await expect(loadSkillsFromDirCachedAsync(source, "user", mocks.workerRun)).resolves.toEqual([skill]);
    expect(mocks.loadSkillsFromDir).toHaveBeenCalledOnce();
    expect(mocks.workerRun).not.toHaveBeenCalled();

    writeFileSync(skillPath, "changed");
    const changedAt = new Date(Date.now() + 2_000);
    utimesSync(skillPath, changedAt, changedAt);
    const changed = makeSkill("cached", skillPath);
    mocks.workerRun.mockResolvedValue([changed]);
    await expect(loadSkillsFromDirCachedAsync(source, "user", mocks.workerRun)).resolves.toEqual([changed]);
    expect(mocks.workerRun).toHaveBeenCalledOnce();

    const agentsRoot = join(root, "agents");
    const directPath = join(agentsRoot, "root.md");
    const nestedPath = writeSkill(agentsRoot, "nested");
    writeFileSync(directPath, "root");
    const direct = makeSkill("root", directPath);
    const nested = makeSkill("nested", nestedPath);
    mocks.loadSkillsFromDir.mockReturnValue({ skills: [direct, nested], diagnostics: [] });
    expect(loadSkillsFromDirCached(agentsRoot, "agents")).toEqual([direct, nested]);
    const budget = createSkillCatalogBudget();
    budget.remaining = 1;
    await expect(loadSkillsFromDirCachedAsync(agentsRoot, "agents", mocks.workerRun, budget))
      .resolves.toEqual([direct, nested]);
    expect(budget.remaining).toBe(0);
  });

  it("fails closed for sync races, worker errors, and exhausted async budgets", async () => {
    const raceRoot = join(root, "race");
    const raceFile = writeSkill(raceRoot, "race");
    mocks.loadSkillsFromDir.mockImplementation(() => {
      writeFileSync(raceFile, "after");
      const changedAt = new Date(Date.now() + 2_000);
      utimesSync(raceFile, changedAt, changedAt);
      return { skills: [], diagnostics: [] };
    });
    expect(() => loadSkillsFromDirCached(raceRoot, "user")).toThrow("changed during Pi discovery");
    mocks.loadSkillsFromDir.mockReturnValue({ skills: [], diagnostics: [] });
    expect(loadSkillsFromDirCached(raceRoot, "user")).toEqual([]);
    expect(mocks.loadSkillsFromDir).toHaveBeenCalledTimes(2);

    const workerRoot = join(root, "worker-error");
    writeSkill(workerRoot, "worker");
    mocks.workerRun.mockRejectedValueOnce(new Error("worker failed"));
    await expect(loadSkillsFromDirCachedAsync(workerRoot, "user", mocks.workerRun)).rejects.toThrow("worker failed");
    mocks.workerRun.mockResolvedValueOnce([]);
    await expect(loadSkillsFromDirCachedAsync(workerRoot, "user", mocks.workerRun)).resolves.toEqual([]);
    expect(mocks.workerRun).toHaveBeenCalledTimes(2);

    const budgetRoot = join(root, "budget");
    writeSkill(budgetRoot, "budget");
    const exhausted = { remaining: 0 };
    await expect(loadSkillsFromDirCachedAsync(budgetRoot, "user", mocks.workerRun, exhausted))
      .rejects.toThrow("maximum of 10000 skills");
    expect(mocks.workerRun).toHaveBeenCalledTimes(2);
  });

  it("keeps trusted and untrusted default paths separate in sync and async caches", async () => {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
    const defaultSkill = makeSkill("default", writeSkill(join(agentDir, "skills"), "default"));
    const userSkill = makeSkill("user", writeSkill(join(agentDir, "skills"), "user"));
    mocks.getAgentDir.mockReturnValue(agentDir);
    mocks.loadSkills.mockReturnValue({ skills: [defaultSkill], diagnostics: [] });
    mocks.loadSkillsFromDir.mockReturnValue({ skills: [userSkill], diagnostics: [] });

    expect(loadPiDefaultSkillsCached(cwd, agentDir, true)).toEqual([defaultSkill]);
    expect(loadPiDefaultSkillsCached(cwd, agentDir, false)).toEqual([userSkill]);
    expect(mocks.loadSkills).toHaveBeenCalledOnce();
    expect(mocks.loadSkillsFromDir).toHaveBeenCalledOnce();

    const asyncCwd = join(root, "async-project");
    mkdirSync(join(asyncCwd, ".pi", "skills"), { recursive: true });
    const asyncDefault = makeSkill("async-default", writeSkill(join(agentDir, "skills"), "async-default"));
    const asyncUser = makeSkill("async-user", writeSkill(join(agentDir, "skills"), "async-user"));
    mocks.workerRun.mockImplementation(async (operation: string) =>
      operation === "loadSkills" ? [asyncDefault] : [asyncUser]);

    await expect(loadPiDefaultSkillsCachedAsync(asyncCwd, agentDir, true, mocks.workerRun))
      .resolves.toEqual([asyncDefault]);
    const callsAfterTrusted = mocks.workerRun.mock.calls.length;
    await expect(loadPiDefaultSkillsCachedAsync(asyncCwd, agentDir, true, mocks.workerRun))
      .resolves.toEqual([asyncDefault]);
    expect(mocks.workerRun).toHaveBeenCalledTimes(callsAfterTrusted);
    await expect(loadPiDefaultSkillsCachedAsync(asyncCwd, agentDir, false, mocks.workerRun))
      .resolves.toEqual([asyncUser]);
  });

  it("enforces the synchronous merged catalog bound before publishing results", () => {
    const project = join(root, "overflow-project");
    const ancestorRoot = join(project, ".agents", "skills");
    mkdirSync(join(project, ".git"), { recursive: true });
    const ancestorSkills = Array.from({ length: 5_000 }, (_, index) =>
      makeSkill(`ancestor-${index}`, join(ancestorRoot, `${index}`, "SKILL.md")));
    const defaults = Array.from({ length: 5_001 }, (_, index) =>
      makeSkill(`default-${index}`, join(root, "agent", "skills", `${index}.md`)));
    mocks.loadSkillsFromDir.mockImplementation(({ dir }: { dir: string }) =>
      dir === ancestorRoot ? { skills: ancestorSkills, diagnostics: [] } : { skills: [], diagnostics: [] });
    mocks.loadSkills.mockReturnValue({ skills: defaults, diagnostics: [] });

    expect(() => loadAllSkills(project, true)).toThrow("Skill catalog exceeds the maximum of 10000 skills");
  });

  it("walks a git-bounded ancestor chain and closes the async worker on errors", async () => {
    const project = join(root, "git-project");
    const cwd = join(project, "child");
    const agentDir = join(root, "agent");
    const ancestorRoot = join(project, ".agents", "skills");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    const ancestor = makeSkill("ancestor", writeSkill(ancestorRoot, "ancestor"));
    const defaultSkill = makeSkill("default", writeSkill(join(agentDir, "skills"), "default"));
    mocks.getAgentDir.mockReturnValue(agentDir);
    mocks.loadSkills.mockReturnValue({ skills: [defaultSkill], diagnostics: [] });
    mocks.loadSkillsFromDir.mockImplementation(({ dir }: { dir: string }) =>
      dir === ancestorRoot ? { skills: [ancestor], diagnostics: [] } : { skills: [], diagnostics: [] });

    expect(loadAllSkills(cwd, true).map(({ name }) => name)).toEqual(["ancestor", "default"]);
    expect(filterRootMdFiles([
      makeSkill("root", join(ancestorRoot, "root.md")),
      ancestor,
    ], ancestorRoot).map(({ name }) => name)).toEqual(["ancestor"]);

    mocks.workerRun.mockImplementation(async (operation: string, input: { dir?: string }) => {
      if (operation === "loadSkillsFromDir" && input.dir === ancestorRoot) return [ancestor];
      if (operation === "loadSkills") return [defaultSkill];
      return [];
    });
    await expect(loadAllSkillsAsync(cwd, true)).resolves.toEqual([ancestor, defaultSkill]);
    expect(mocks.workerClose).toHaveBeenCalledOnce();

    mocks.workerRun.mockRejectedValueOnce(new Error("catalog worker failed"));
    await expect(loadAllSkillsAsync(join(root, "error-project"), true)).rejects.toThrow("catalog worker failed");
    expect(mocks.workerClose).toHaveBeenCalledTimes(2);
  });
});
