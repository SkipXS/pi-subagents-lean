/**
 * Async skill metadata and prompt integration tests.
 *
 * Catalog discovery is mocked at its boundary here; the real worker-backed
 * catalog is exercised by the integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { loadSkillMetaAsync } from "../../src/prompt/skill-loader.ts";
import { buildAgentPrompt } from "../../src/prompt/prompts.ts";
import type { AgentConfig, EnvInfo } from "../../src/types.ts";

const { mockLoadAllSkillsAsync } = vi.hoisted(() => ({
  mockLoadAllSkillsAsync: vi.fn(),
}));

vi.mock("../../src/prompt/skill-catalog.ts", () => ({
  loadAllSkillsAsync: mockLoadAllSkillsAsync,
}));

let tmpDir: string;

function makeSkill(
  name: string,
  description: string,
  filePath: string,
  disableModelInvocation = false,
): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: join(filePath, ".."),
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  mockLoadAllSkillsAsync.mockResolvedValue([]);
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

describe("loadSkillMetaAsync", () => {
  it("returns metadata only, preserving explicit order", async () => {
    const tdd = makeSkill("tdd", "Test-driven development workflow", join(tmpDir, "tdd", "SKILL.md"));
    const debug = makeSkill("debug", "Debugging workflow", join(tmpDir, "debug.md"));
    mockLoadAllSkillsAsync.mockResolvedValueOnce([tdd, debug]);

    await expect(loadSkillMetaAsync(["debug", "tdd"], tmpDir)).resolves.toEqual([
      {
        name: "debug",
        description: "Debugging workflow",
        location: debug.filePath,
        disableModelInvocation: false,
      },
      {
        name: "tdd",
        description: "Test-driven development workflow",
        location: tdd.filePath,
        disableModelInvocation: false,
      },
    ]);
  });

  it("returns a not-found entry for an explicitly missing skill", async () => {
    await expect(loadSkillMetaAsync(["nonexistent"], tmpDir)).resolves.toEqual([{
      name: "nonexistent",
      description: '(Skill "nonexistent" not found)',
      location: "",
      disableModelInvocation: false,
    }]);
  });

  it("applies exclusions and preserves invocation-disabled metadata", async () => {
    const internal = makeSkill("internal", "Internal tool", join(tmpDir, "internal", "SKILL.md"), true);
    const visible = makeSkill("visible", "Visible workflow", join(tmpDir, "visible", "SKILL.md"));
    mockLoadAllSkillsAsync.mockResolvedValueOnce([internal, visible]);

    await expect(loadSkillMetaAsync(["internal", "visible"], tmpDir, ["visible"])).resolves.toEqual([{
      name: "internal",
      description: "Internal tool",
      location: internal.filePath,
      disableModelInvocation: true,
    }]);
  });
});

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

describe("Prompt integration: metadata excludes body", () => {
  it("advertises metadata without loading the skill body", async () => {
    const skillPath = join(tmpDir, ".pi", "skills", "proof-skill", "SKILL.md");
    const skill = makeSkill("proof-skill", "Skill with secret token", skillPath);
    mockLoadAllSkillsAsync.mockResolvedValueOnce([skill]);

    const metas = await loadSkillMetaAsync(["proof-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillMetas: metas });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>proof-skill</name>");
    expect(prompt).toContain("<description>Skill with secret token</description>");
    expect(prompt).toContain(`<location>${skillPath}</location>`);
    expect(prompt).toContain("Use the read tool to load a skill's file");

    expect(prompt).not.toContain(SECRET_TOKEN);
    expect(prompt).not.toContain(BODY_MARKER);
  });
});
