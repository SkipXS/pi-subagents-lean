/**
 * skill-loader.test.ts — Tests for skill loading and prompt integration.
 *
 * Covers:
 *   - loadSkillMeta: loads metadata only (name, description, location)
 *   - buildAgentPrompt: correct metadata format
 *   - Integration proof with secret token verification
 *
 * Pi's loadSkills/loadSkillsFromDir are mocked to isolate from system skills.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillMeta } from "../../src/prompt/skill-loader.ts";
import { buildAgentPrompt } from "../../src/prompt/prompts.ts";
import type { AgentConfig, EnvInfo } from "../../src/types.ts";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { createSkillDir, createFlatSkill } from "../fixtures.ts";

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
  vi.unstubAllEnvs();
  vi.clearAllMocks();
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
