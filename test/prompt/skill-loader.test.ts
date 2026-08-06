/**
 * skill-loader.test.ts — Tests for skill loading and prompt integration.
 *
 * Covers:
 *   - loadSkillMeta: loads metadata only (name, description, location)
 *   - loadAllSkills: correct precedence, filtering, dedup
 *   - buildAgentPrompt: correct metadata format
 *   - Integration proof with secret token verification
 *
 * Pi's loadSkills/loadSkillsFromDir are mocked to isolate from system skills.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillMeta, loadAllSkills } from "../../src/prompt/skill-loader.ts";
import { buildAgentPrompt } from "../../src/prompt/prompts.ts";
import type { AgentConfig, EnvInfo } from "../../src/types.ts";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { canCreateDirectoryLinks, canCreateSymlinks, createDirectoryLink, createSkillDir, createFlatSkill } from "../fixtures.ts";

const { mockLoadSkills, mockLoadSkillsFromDir, mockFormatSkillsForPrompt, mockGetAgentDir } = vi.hoisted(() => ({
  mockLoadSkills: vi.fn(),
  mockLoadSkillsFromDir: vi.fn(),
  mockFormatSkillsForPrompt: vi.fn(),
  mockGetAgentDir: vi.fn(() => "C:\\Users\\Pi User\\.pi\\agent"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  loadSkills: mockLoadSkills,
  loadSkillsFromDir: mockLoadSkillsFromDir,
  formatSkillsForPrompt: mockFormatSkillsForPrompt,
  getAgentDir: mockGetAgentDir,
}));

let tmpDir: string;

/** Build a minimal Skill object for mocking. */
function makeSkill(
  name: string,
  description: string,
  filePath: string,
  opts: { disableModelInvocation?: boolean } = {},
): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: join(filePath, ".."),
    sourceInfo: {} as any,
    disableModelInvocation: opts.disableModelInvocation ?? false,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  // Default: no skills from any source
  mockLoadSkills.mockReturnValue({ skills: [], diagnostics: [] });
  mockLoadSkillsFromDir.mockReturnValue({ skills: [], diagnostics: [] });
  mockFormatSkillsForPrompt.mockReturnValue("");
  mockGetAgentDir.mockReturnValue("C:\\Users\\Pi User\\.pi\\agent");
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Unit: loadAllSkills                                               */
/* ------------------------------------------------------------------ */

describe("loadAllSkills", () => {
  it("loads from .pi/skills via loadSkills (Pi defaults)", () => {
    const tddSkill = makeSkill("tdd", "TDD workflow", join(tmpDir, ".pi", "skills", "tdd", "SKILL.md"));
    mockLoadSkills.mockReturnValue({ skills: [tddSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(mockLoadSkills).toHaveBeenCalledWith(expect.objectContaining({
      cwd: tmpDir,
      includeDefaults: true,
    }));
  });

  it("keeps global Pi skills but never calls the combined loader for an untrusted cwd", () => {
    const userSkill = makeSkill("user-only", "Global user skill", "C:\\Users\\Pi User\\.pi\\agent\\skills\\user-only\\SKILL.md");
    const projectSkill = makeSkill("project-only", "Project skill", join(tmpDir, ".pi", "skills", "project-only", "SKILL.md"));
    mockLoadSkillsFromDir.mockImplementation(({ dir }: { dir: string }) =>
      dir.includes("agent") && !dir.includes(".agents")
        ? { skills: [userSkill], diagnostics: [] }
        : { skills: [], diagnostics: [] });
    mockLoadSkills.mockReturnValue({ skills: [projectSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir, false);

    expect(result.map(({ name }) => name)).toEqual(["user-only"]);
    expect(mockLoadSkills).not.toHaveBeenCalled();
  });

  it("uses Pi's agent directory for default skills when HOME is unset", () => {
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

  it("loads ancestor .agents/skills via loadSkillsFromDir", () => {
    const agentsSkill = makeSkill("agents-skill", "From agents", join(tmpDir, ".agents", "skills", "agents-skill", "SKILL.md"));
    mockLoadSkillsFromDir.mockReturnValue({ skills: [agentsSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result.some((s) => s.name === "agents-skill")).toBe(true);
    expect(mockLoadSkillsFromDir).toHaveBeenCalledWith(expect.objectContaining({
      dir: join(tmpDir, ".agents", "skills"),
      source: "agents",
    }));
  });

  it("filters root .md files from .agents/skills directories", () => {
    const rootSkill = makeSkill("root-skill", "Root level", join(tmpDir, ".agents", "skills", "root-skill.md"));
    const dirSkill = makeSkill("dir-skill", "Dir level", join(tmpDir, ".agents", "skills", "dir-skill", "SKILL.md"));
    const agentsSkillsDir = join(tmpDir, ".agents", "skills");
    mockLoadSkillsFromDir.mockImplementation(({ dir }: { dir: string }) => {
      // Only return skills for the tmpDir's .agents/skills
      if (dir === agentsSkillsDir) return { skills: [rootSkill, dirSkill], diagnostics: [] };
      return { skills: [], diagnostics: [] };
    });

    const result = loadAllSkills(tmpDir);

    // Root .md file should be filtered out (parent === skillsRoot)
    expect(result.some((s) => s.name === "root-skill")).toBe(false);
    expect(result.some((s) => s.name === "dir-skill")).toBe(true);
  });

  it("gives ancestor .agents/skills higher precedence than defaults", () => {
    const defaultSkill = makeSkill("tdd", "Default TDD", join(tmpDir, ".pi", "skills", "tdd", "SKILL.md"));
    const agentsSkill = makeSkill("tdd", "Agents TDD", join(tmpDir, ".agents", "skills", "tdd", "SKILL.md"));
    mockLoadSkills.mockReturnValue({ skills: [defaultSkill], diagnostics: [] });
    mockLoadSkillsFromDir.mockReturnValue({ skills: [agentsSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Agents TDD");
  });

  it("deduplicates by name (first match wins)", () => {
    const skill1 = makeSkill("dup", "First", join(tmpDir, ".agents", "skills", "dup", "SKILL.md"));
    const skill2 = makeSkill("dup", "Second", join(tmpDir, ".pi", "skills", "dup", "SKILL.md"));
    mockLoadSkillsFromDir.mockReturnValue({ skills: [skill1], diagnostics: [] });
    mockLoadSkills.mockReturnValue({ skills: [skill2], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("First");
  });

  it("keeps symlinked file metadata in the source fingerprint", () => {
    if (!canCreateSymlinks()) return;
    const skillsRoot = join(tmpDir, ".pi", "skills");
    const target = join(tmpDir, "target.md");
    const link = join(skillsRoot, "linked.md");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(target, "target");
    symlinkSync(target, link, "file");
    mockLoadSkills.mockReturnValue({ skills: [], diagnostics: [] });

    expect(loadAllSkills(tmpDir)).toEqual([]);
    expect(loadAllSkills(tmpDir)).toEqual([]);
    expect(mockLoadSkills).toHaveBeenCalledTimes(1);
  });

  it("retries an unstable source instead of caching a broken symlink", () => {
    if (!canCreateDirectoryLinks()) return;
    const skillsRoot = join(tmpDir, ".pi", "skills");
    const target = join(tmpDir, "missing-target");
    const brokenLink = join(skillsRoot, "broken");
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(target);
    createDirectoryLink(target, brokenLink);
    rmSync(target, { recursive: true, force: true });
    mockLoadSkills.mockReturnValue({ skills: [], diagnostics: [] });

    // A broken link makes the metadata snapshot unstable. Pi is still called
    // on every lookup rather than retaining an uncertain negative result.
    expect(loadAllSkills(tmpDir)).toEqual([]);
    expect(loadAllSkills(tmpDir)).toEqual([]);
    expect(mockLoadSkills).toHaveBeenCalledTimes(2);
  });

  it("bounds default-source cache paths while retaining recent hits", () => {
    const cwdPaths = Array.from({ length: 128 }, (_, index) => join(tmpDir, `cwd-${index}`));
    for (const cwd of cwdPaths) loadAllSkills(cwd);

    const callsBeforeHit = mockLoadSkills.mock.calls.length;
    loadAllSkills(cwdPaths[0]!);
    expect(mockLoadSkills).toHaveBeenCalledTimes(callsBeforeHit);

    const extraCwd = join(tmpDir, "cwd-extra");
    loadAllSkills(extraCwd);
    loadAllSkills(cwdPaths[0]!);
    expect(mockLoadSkills).toHaveBeenCalledTimes(callsBeforeHit + 1);

    // cwd-1 was the least-recently-used entry after the cwd-0 hit.
    loadAllSkills(cwdPaths[1]!);
    expect(mockLoadSkills).toHaveBeenCalledTimes(callsBeforeHit + 2);
  });

  it("reuses unchanged Pi sources and invalidates negative, changed, deleted, and renamed skills", () => {
    const skillDir = join(tmpDir, ".pi", "skills", "cached");
    const skillPath = join(skillDir, "SKILL.md");
    const renamedDir = join(tmpDir, ".pi", "skills", "renamed");
    const renamedPath = join(renamedDir, "SKILL.md");
    let loadedSkills: Skill[] = [];
    mockLoadSkills.mockImplementation(() => ({ skills: loadedSkills, diagnostics: [] }));

    // The initial negative result is cached, but not permanently.
    expect(loadAllSkills(tmpDir)).toEqual([]);
    expect(mockLoadSkills).toHaveBeenCalledTimes(1);
    loadAllSkills(tmpDir);
    expect(mockLoadSkills).toHaveBeenCalledTimes(1);

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, "initial");
    loadedSkills = [makeSkill("cached", "Initial", skillPath)];
    expect(loadAllSkills(tmpDir).map(({ description }) => description)).toEqual(["Initial"]);
    expect(mockLoadSkills).toHaveBeenCalledTimes(2);

    // The returned cache is detached from a caller mutation.
    const cachedResult = loadAllSkills(tmpDir);
    cachedResult[0].description = "caller mutation";
    expect(loadAllSkills(tmpDir)[0]?.description).toBe("Initial");
    expect(mockLoadSkills).toHaveBeenCalledTimes(2);

    writeFileSync(skillPath, "changed");
    loadedSkills = [makeSkill("cached", "Changed", skillPath)];
    expect(loadAllSkills(tmpDir)[0]?.description).toBe("Changed");
    expect(mockLoadSkills).toHaveBeenCalledTimes(3);

    rmSync(skillDir, { recursive: true, force: true });
    loadedSkills = [];
    expect(loadAllSkills(tmpDir)).toEqual([]);
    expect(mockLoadSkills).toHaveBeenCalledTimes(4);

    mkdirSync(renamedDir, { recursive: true });
    writeFileSync(renamedPath, "renamed");
    loadedSkills = [makeSkill("renamed", "Renamed", renamedPath)];
    expect(loadAllSkills(tmpDir)[0]?.name).toBe("renamed");
    expect(mockLoadSkills).toHaveBeenCalledTimes(5);
  });
});

/* ------------------------------------------------------------------ */
/*  Unit: loadSkillMeta                                               */
/* ------------------------------------------------------------------ */

describe("loadSkillMeta", () => {
  it("returns metadata only from a skill directory", () => {
    createSkillDir(tmpDir, "tdd", "Test-driven development workflow", "## TDD Steps\n1. Red\n2. Green\n3. Refactor");
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("tdd", "Test-driven development workflow", tddPath)],
      diagnostics: [],
    });

    const result = loadSkillMeta(["tdd"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].location).toContain("SKILL.md");
    expect(result[0].location).not.toContain("TDD Steps");
  });

  it("returns metadata from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps\n1. Reproduce\n2. Isolate\n3. Fix");
    const debugPath = join(tmpDir, ".pi", "skills", "debug.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("debug", "Debugging workflow", debugPath)],
      diagnostics: [],
    });

    const result = loadSkillMeta(["debug"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("debug");
    expect(result[0].description).toBe("Debugging workflow");
    expect(result[0].location).toContain("debug.md");
  });

  it("returns not-found description for missing skill", () => {
    const result = loadSkillMeta(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].description).toContain("not found");
    expect(result[0].location).toBe("");
  });

  it("loads multiple skills metadata", () => {
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    const debugPath = join(tmpDir, ".pi", "skills", "debug", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [
        makeSkill("tdd", "TDD workflow", tddPath),
        makeSkill("debug", "Debug workflow", debugPath),
      ],
      diagnostics: [],
    });

    const result = loadSkillMeta(["tdd", "debug"], tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("TDD workflow");
    expect(result[1].name).toBe("debug");
    expect(result[1].description).toBe("Debug workflow");
  });

  it("subtracts excluded skills before loading metadata", () => {
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    const debugPath = join(tmpDir, ".pi", "skills", "debug", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [
        makeSkill("tdd", "TDD workflow", tddPath),
        makeSkill("debug", "Debug workflow", debugPath),
      ],
      diagnostics: [],
    });

    expect(loadSkillMeta(["tdd", "debug"], tmpDir, ["debug"]).map(({ name }) => name))
      .toEqual(["tdd"]);
  });

  it("threads disableModelInvocation from loaded skill", () => {
    const skillPath = join(tmpDir, ".pi", "skills", "internal", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("internal", "Internal tool", skillPath, { disableModelInvocation: true })],
      diagnostics: [],
    });

    const result = loadSkillMeta(["internal"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].disableModelInvocation).toBe(true);
  });

  it("defaults disableModelInvocation to false for missing skill", () => {
    const result = loadSkillMeta(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].disableModelInvocation).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Integration: prompt building with secret token proof              */
/* ------------------------------------------------------------------ */

const SECRET_TOKEN = "PROOF_TOKEN_ALPHA_7X9K2M";
const BODY_MARKER = "This line proves full content was loaded";

const baseConfig: AgentConfig = {
  name: "test-agent",
  description: "Test agent",
  extensions: true,
  skills: true,
  systemPrompt: "You are a test agent.",
};

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "linux",
};

function createProofSkill() {
  createSkillDir(tmpDir, "proof-skill", "Skill with secret token",
    `## Secret Token\n${SECRET_TOKEN}\n\n${BODY_MARKER}`);
}

describe("Prompt integration: whitelist excludes body", () => {
  it("available_skills has metadata but NOT secret token", () => {
    createProofSkill();
    const tddPath = join(tmpDir, ".pi", "skills", "proof-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("proof-skill", "Skill with secret token", tddPath)],
      diagnostics: [],
    });
    mockFormatSkillsForPrompt.mockReturnValue(
      `<skill><name>proof-skill</name><description>Skill with secret token</description><location>${tddPath}</location></skill>`,
    );

    const metas = loadSkillMeta(["proof-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillMetas: metas });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>proof-skill</name>");
    expect(prompt).toContain("<description>Skill with secret token</description>");
    expect(prompt).toContain("Use the read tool to load a skill's file");

    expect(prompt).not.toContain(SECRET_TOKEN);
    expect(prompt).not.toContain(BODY_MARKER);
  });
});
