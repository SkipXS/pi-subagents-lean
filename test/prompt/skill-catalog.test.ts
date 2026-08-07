import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Skill } from "@earendil-works/pi-coding-agent";
const { mockWorkerRun, mockWorkerClose } = vi.hoisted(() => ({
  mockWorkerRun: vi.fn(),
  mockWorkerClose: vi.fn(async () => undefined),
}));

vi.mock("../../src/prompt/skill-loader-worker.ts", () => ({
  createPiSkillLoaderWorkerAdapter: () => ({ run: mockWorkerRun, close: mockWorkerClose }),
}));

import {
  loadAllSkills,
  loadAllSkillsAsync,
  MAX_ANCESTOR_SKILL_ROOTS,
} from "../../src/prompt/skill-catalog.ts";
import { canCreateSymlinks } from "../fixtures.ts";

const { mockLoadSkills, mockLoadSkillsFromDir, mockGetAgentDir } = vi.hoisted(() => ({
  mockLoadSkills: vi.fn(),
  mockLoadSkillsFromDir: vi.fn(),
  mockGetAgentDir: vi.fn(() => "C:\\Users\\Pi User\\.pi\\agent"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  loadSkills: mockLoadSkills,
  loadSkillsFromDir: mockLoadSkillsFromDir,
  getAgentDir: mockGetAgentDir,
}));

let tmpDir = "";

function makeSkill(name: string, description: string, filePath: string): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: join(filePath, ".."),
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `skill-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  mockLoadSkills.mockReturnValue({ skills: [], diagnostics: [] });
  mockLoadSkillsFromDir.mockReturnValue({ skills: [], diagnostics: [] });
  mockWorkerRun.mockResolvedValue([]);
  mockWorkerClose.mockClear();
  mockGetAgentDir.mockReturnValue("C:\\Users\\Pi User\\.pi\\agent");
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

describe("skill catalog composition", () => {
  it("keeps Pi defaults and passes the complete default request", () => {
    const skill = makeSkill("tdd", "TDD workflow", join(tmpDir, ".pi", "skills", "tdd", "SKILL.md"));
    mockLoadSkills.mockReturnValue({ skills: [skill], diagnostics: [] });

    expect(loadAllSkills(tmpDir)).toEqual([skill]);
    expect(mockLoadSkills).toHaveBeenCalledWith(expect.objectContaining({
      cwd: tmpDir,
      includeDefaults: true,
      skillPaths: [],
    }));
  });

  it("does not call Pi's combined loader for an untrusted project", () => {
    const userSkill = makeSkill("user-only", "Global user skill", "C:\\Users\\Pi User\\.pi\\agent\\skills\\user-only\\SKILL.md");
    const projectSkill = makeSkill("project-only", "Project skill", join(tmpDir, ".pi", "skills", "project-only", "SKILL.md"));
    mockLoadSkillsFromDir.mockImplementation(({ dir }: { dir: string }) =>
      dir.includes("agent") && !dir.includes(".agents")
        ? { skills: [userSkill], diagnostics: [] }
        : { skills: [], diagnostics: [] });
    mockLoadSkills.mockReturnValue({ skills: [projectSkill], diagnostics: [] });

    expect(loadAllSkills(tmpDir, false).map(({ name }) => name)).toEqual(["user-only"]);
    expect(mockLoadSkills).not.toHaveBeenCalled();
  });

  it("uses Pi's agent directory even when the process home is unset", () => {
    vi.stubEnv("HOME", "");
    const agentDir = "C:\\Users\\Pi User\\.pi\\agent";
    try {
      loadAllSkills(tmpDir);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mockGetAgentDir).toHaveBeenCalledOnce();
    expect(mockLoadSkills).toHaveBeenCalledWith(expect.objectContaining({ agentDir }));
  });

  it("walks ancestor .agents/skills and excludes root Markdown files", () => {
    const rootSkill = makeSkill("root-skill", "Root level", join(tmpDir, ".agents", "skills", "root-skill.md"));
    const dirSkill = makeSkill("dir-skill", "Dir level", join(tmpDir, ".agents", "skills", "dir-skill", "SKILL.md"));
    const agentsSkillsDir = join(tmpDir, ".agents", "skills");
    mockLoadSkillsFromDir.mockImplementation(({ dir }: { dir: string }) => {
      if (dir === agentsSkillsDir) return { skills: [rootSkill, dirSkill], diagnostics: [] };
      return { skills: [], diagnostics: [] };
    });

    const result = loadAllSkills(tmpDir);
    expect(result.map(({ name }) => name)).toEqual(["dir-skill"]);
    expect(mockLoadSkillsFromDir).toHaveBeenCalledWith({ dir: agentsSkillsDir, source: "agents" });
  });

  it("gives nearer ancestors precedence over defaults by name", () => {
    const defaultSkill = makeSkill("tdd", "Default TDD", join(tmpDir, ".pi", "skills", "tdd", "SKILL.md"));
    const agentsSkill = makeSkill("tdd", "Agents TDD", join(tmpDir, ".agents", "skills", "tdd", "SKILL.md"));
    mockLoadSkills.mockReturnValue({ skills: [defaultSkill], diagnostics: [] });
    mockLoadSkillsFromDir.mockReturnValue({ skills: [agentsSkill], diagnostics: [] });

    expect(loadAllSkills(tmpDir)).toEqual([agentsSkill]);
  });

  it("caps the synchronous ancestor skill-root walk", () => {
    let cwd = tmpDir;
    for (let index = 0; index < MAX_ANCESTOR_SKILL_ROOTS + 1; index++) {
      cwd = join(cwd, `nested-${index}`);
      mkdirSync(cwd);
    }

    loadAllSkills(cwd, true);
    const ancestorCalls = mockLoadSkillsFromDir.mock.calls.filter(([input]) => {
      const candidate = input as { source?: string; dir?: string };
      return candidate.source === "agents"
        && candidate.dir?.startsWith(tmpDir) === true
        && candidate.dir.endsWith(join(".agents", "skills"));
    });
    expect(ancestorCalls).toHaveLength(MAX_ANCESTOR_SKILL_ROOTS);
  });

  it("loads trusted ancestor and default skills through the async catalog worker", async () => {
    mkdirSync(join(tmpDir, ".git"));
    const agentDir = join(tmpDir, "agent");
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    mockGetAgentDir.mockReturnValue(agentDir);
    const ancestorRoot = join(tmpDir, ".agents", "skills");
    const ancestor = makeSkill("ancestor", "Ancestor skill", join(ancestorRoot, "ancestor", "SKILL.md"));
    const defaults = makeSkill("default", "Default skill", join(agentDir, "skills", "default", "SKILL.md"));
    mkdirSync(join(ancestorRoot, "ancestor"), { recursive: true });
    writeFileSync(ancestor.filePath, "ancestor");
    mockWorkerRun.mockImplementation(async (operation: string, input: { dir?: string }) => {
      if (operation === "loadSkillsFromDir" && input.dir === ancestorRoot) return [ancestor];
      if (operation === "loadSkills") return [defaults];
      return [];
    });

    await expect(loadAllSkillsAsync(tmpDir, true)).resolves.toEqual([ancestor, defaults]);
    expect(mockWorkerClose).toHaveBeenCalledOnce();
    expect(mockWorkerRun).toHaveBeenCalledWith("loadSkillsFromDir", expect.objectContaining({ dir: ancestorRoot }));
    expect(mockWorkerRun).toHaveBeenCalledWith("loadSkills", expect.objectContaining({ cwd: tmpDir }));
  });

  it("keeps the async untrusted catalog project-free", async () => {
    const agentDir = join(tmpDir, "agent");
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    mockGetAgentDir.mockReturnValue(agentDir);
    mkdirSync(join(tmpDir, ".agents", "skills", "project"), { recursive: true });
    writeFileSync(join(tmpDir, ".agents", "skills", "project", "SKILL.md"), "project");
    const global = makeSkill("global", "Global skill", join(agentDir, "skills", "global", "SKILL.md"));
    mockWorkerRun.mockImplementation(async (operation: string) => operation === "loadSkillsFromDir" ? [global] : []);

    await expect(loadAllSkillsAsync(tmpDir, false)).resolves.toEqual([global]);
    expect(mockWorkerRun).not.toHaveBeenCalledWith("loadSkills", expect.anything());
  });

  it("rejects an aggregate async catalog above the merged skill limit", async () => {
    mkdirSync(join(tmpDir, ".git"));
    const agentDir = join(tmpDir, "agent");
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    mockGetAgentDir.mockReturnValue(agentDir);
    const ancestorRoot = join(tmpDir, ".agents", "skills");
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) =>
      makeSkill(`${prefix}-${index}`, "bounded", join(tmpDir, prefix, `${index}.md`)));
    const ancestorSkills = many("ancestor", 5_000);
    const defaultSkills = many("default", 5_001);
    mockWorkerRun.mockImplementation(async (operation: string, input: { dir?: string }) => {
      if (operation === "loadSkillsFromDir" && input.dir === ancestorRoot) return ancestorSkills;
      if (operation === "loadSkills") return defaultSkills;
      return [];
    });

    await expect(loadAllSkillsAsync(tmpDir, true))
      .rejects.toThrow("Skill catalog exceeds the maximum of 10000 skills");
  });

  it("deduplicates a canonical path as well as a duplicate name", () => {
    if (!canCreateSymlinks()) return;
    const target = join(tmpDir, "target.md");
    const link = join(tmpDir, ".pi", "skills", "link.md");
    mkdirSync(join(tmpDir, ".pi", "skills"), { recursive: true });
    writeFileSync(target, "skill");
    symlinkSync(target, link, "file");
    const first = makeSkill("same-path", "first", target);
    const second = makeSkill("different-name", "second", link);
    mockLoadSkills.mockReturnValue({ skills: [first, second], diagnostics: [] });

    expect(loadAllSkills(tmpDir).map(({ name }) => name)).toEqual(["same-path"]);
  });
});
