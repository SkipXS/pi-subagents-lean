import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Skill } from "@earendil-works/pi-coding-agent";

const { mockLoadAllSkillsAsync } = vi.hoisted(() => ({
  mockLoadAllSkillsAsync: vi.fn(),
}));

vi.mock("../../src/prompt/skill-catalog.ts", () => ({
  loadAllSkillsAsync: mockLoadAllSkillsAsync,
}));

import { loadSkillMetaAsync } from "../../src/prompt/skill-loader.ts";

const skill: Skill = {
  name: "known",
  description: "Known skill",
  filePath: "/skills/known/SKILL.md",
  baseDir: "/skills/known",
  sourceInfo: {} as Skill["sourceInfo"],
  disableModelInvocation: true,
};

beforeEach(() => {
  mockLoadAllSkillsAsync.mockResolvedValue([skill]);
  vi.clearAllMocks();
});

describe("async skill metadata facade", () => {
  it("preserves explicit order and the public not-found contract", async () => {
    const other: Skill = {
      ...skill,
      name: "other",
      disableModelInvocation: false,
      description: "Other skill",
      filePath: "/skills/other/SKILL.md",
    };
    mockLoadAllSkillsAsync.mockResolvedValueOnce([skill, other]);

    await expect(loadSkillMetaAsync(["other", "missing", "known"], "/project"))
      .resolves.toEqual([
        {
          name: "other",
          description: "Other skill",
          location: "/skills/other/SKILL.md",
          disableModelInvocation: false,
        },
        {
          name: "missing",
          description: '(Skill "missing" not found)',
          location: "",
          disableModelInvocation: false,
        },
        {
          name: "known",
          description: "Known skill",
          location: "/skills/known/SKILL.md",
          disableModelInvocation: true,
        },
      ]);
  });

  it("maps async metadata without changing exclusion or trust arguments", async () => {
    await expect(loadSkillMetaAsync(["known", "missing"], "/project", ["missing"], false))
      .resolves.toEqual([{
        name: "known",
        description: "Known skill",
        location: "/skills/known/SKILL.md",
        disableModelInvocation: true,
      }]);
    expect(mockLoadAllSkillsAsync).toHaveBeenCalledWith("/project", false);
  });

  it("routes all-skills metadata through the async catalog and excludes afterward", async () => {
    await expect(loadSkillMetaAsync(true, "/project", ["known"], true)).resolves.toEqual([]);
    expect(mockLoadAllSkillsAsync).toHaveBeenCalledWith("/project", true);
  });

  it("does not load a catalog when all requested names are excluded", async () => {
    await expect(loadSkillMetaAsync(["known"], "/project", ["known"])).resolves.toEqual([]);
    expect(mockLoadAllSkillsAsync).not.toHaveBeenCalled();
  });

  it("keeps removed synchronous symbols out of internal Skills sources", () => {
    const sourceNames = [
      "skill-loader.ts",
      "skill-catalog.ts",
      "skill-cache.ts",
      "skill-fingerprint.ts",
      "skill-fingerprint-walk.ts",
    ];
    const source = sourceNames
      .map((name) => readFileSync(new URL(`../../src/prompt/${name}`, import.meta.url), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/\b(?:loadSkillMeta|loadAllSkills|mergeSkills|loadAncestorAgentsSkills|directoryContainsGitSync|canonicalizePath|loadSkillsFromDirCached|loadPiDefaultSkillsCached|fingerprintResourceTree|targetFileStatsSync|recordRelevantSync|walkResourceTree)\b/);
    expect(source).not.toMatch(/\b(?:lstatSync|opendirSync|realpathSync|statSync)\b/);
    expect(source).toMatch(/export async function loadSkillMetaAsync/);
    expect(source).toMatch(/export async function loadAllSkillsAsync/);
    expect(source).toMatch(/export async function fingerprintResourceTreeAsync/);
    expect(source).toMatch(/export async function walkResourceTreeAsync/);
  });
});
