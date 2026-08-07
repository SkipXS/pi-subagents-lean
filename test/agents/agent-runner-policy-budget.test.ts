import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../../src/agents/types.js";
import type { EnvInfo } from "../../src/types.js";
import type { ResolvedAgentConfig } from "../../src/agents/agent-tool-policy.js";

const { loadSkillMetaAsync } = vi.hoisted(() => ({
  loadSkillMetaAsync: vi.fn(),
}));

vi.mock("../../src/prompt/skill-loader.js", () => ({ loadSkillMetaAsync }));

import { buildAgentSystemPrompt } from "../../src/agents/agent-runner-policy.js";

const agentConfig: AgentConfig = {
  name: "budget-agent",
  description: "Budget agent",
  systemPrompt: "Instructions",
};
const env: EnvInfo = {
  isGitRepo: false,
  branch: null,
  platform: "win32",
};
const baseConfig: ResolvedAgentConfig = {
  name: agentConfig.name,
  description: agentConfig.description,
  registeredTools: [],
  extensions: false,
  skills: true,
};
const metadata = [{
  name: "selected",
  description: "Selected skill",
  location: "/skills/selected/SKILL.md",
  disableModelInvocation: false,
}];

describe("child skill prompt budget policy", () => {
  it.each([
    [true, true],
    [["selected"], false],
  ] as Array<[true | string[], boolean]>)
  ("uses the bounded async metadata path for skills=%j", async (selection, allSkills) => {
    loadSkillMetaAsync.mockResolvedValueOnce(metadata);
    const config = { ...baseConfig, skills: selection };

    await expect(buildAgentSystemPrompt(
      "budget-agent",
      agentConfig,
      config,
      "/worktree",
      env,
    )).resolves.toContain("<name>selected</name>");
    expect(loadSkillMetaAsync).toHaveBeenLastCalledWith(
      selection,
      "/worktree",
      undefined,
    );
    expect(allSkills).toBe(selection === true);
  });

  it.each([true, ["selected"] as string[]])(
    "fails deterministically for an over-budget %j metadata selection",
    async (selection) => {
      loadSkillMetaAsync.mockResolvedValueOnce(Array.from({ length: 10_000 }, (_, index) => ({
        name: `skill-${index}`,
        description: "metadata",
        location: `/skills/skill-${index}/SKILL.md`,
        disableModelInvocation: false,
      })));

      await expect(buildAgentSystemPrompt(
        "budget-agent",
        agentConfig,
        { ...baseConfig, skills: selection },
        "/worktree",
        env,
      )).rejects.toThrow("Skill metadata prompt exceeds the maximum");
    },
  );
});
