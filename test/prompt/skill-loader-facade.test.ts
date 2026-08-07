import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@earendil-works/pi-coding-agent";

const { mockLoadAllSkills, mockLoadAllSkillsAsync } = vi.hoisted(() => ({
  mockLoadAllSkills: vi.fn(),
  mockLoadAllSkillsAsync: vi.fn(),
}));

vi.mock("../../src/prompt/skill-catalog.ts", () => ({
  loadAllSkills: mockLoadAllSkills,
  loadAllSkillsAsync: mockLoadAllSkillsAsync,
}));

import {
  loadSkillMeta,
  loadSkillMetaAsync,
} from "../../src/prompt/skill-loader.ts";

const skill: Skill = {
  name: "known",
  description: "Known skill",
  filePath: "/skills/known/SKILL.md",
  baseDir: "/skills/known",
  sourceInfo: {} as Skill["sourceInfo"],
  disableModelInvocation: true,
};

beforeEach(() => {
  mockLoadAllSkills.mockReturnValue([skill]);
  mockLoadAllSkillsAsync.mockResolvedValue([skill]);
  vi.clearAllMocks();
});

describe("skill loader public facade", () => {
  it("maps sync metadata and keeps the public not-found contract", () => {
    expect(loadSkillMeta(["known", "missing"], "/project")).toEqual([
      {
        name: "known",
        description: "Known skill",
        location: "/skills/known/SKILL.md",
        disableModelInvocation: true,
      },
      {
        name: "missing",
        description: '(Skill "missing" not found)',
        location: "",
        disableModelInvocation: false,
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
    expect(mockLoadAllSkills).not.toHaveBeenCalled();
  });

  it("routes all-skills metadata through the same async catalog and excludes afterward", async () => {
    await expect(loadSkillMetaAsync(true, "/project", ["known"], true)).resolves.toEqual([]);
    expect(mockLoadAllSkillsAsync).toHaveBeenCalledWith("/project", true);
    expect(mockLoadAllSkills).not.toHaveBeenCalled();
  });

  it("does not load a catalog when all requested names are excluded", async () => {
    expect(loadSkillMeta(["known"], "/project", ["known"])).toEqual([]);
    await expect(loadSkillMetaAsync(["known"], "/project", ["known"])).resolves.toEqual([]);
    expect(mockLoadAllSkills).not.toHaveBeenCalled();
    expect(mockLoadAllSkillsAsync).not.toHaveBeenCalled();
  });
});
