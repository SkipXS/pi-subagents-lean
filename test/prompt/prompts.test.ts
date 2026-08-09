import { describe, it, expect, vi } from "vitest";
import {
  buildAgentPrompt,
  MAX_CHILD_SYSTEM_PROMPT_BYTES,
  MAX_SKILL_METADATA_PROMPT_BYTES,
  SHARED_CHILD_CONTEXT_GUIDANCE,
} from "../../src/prompt/prompts.ts";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.ts";
import type { AgentConfig, EnvInfo } from "../../src/types.ts";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    formatSkillsForPrompt: vi.fn((skills: any[]) => skills
      .filter((skill: any) => !skill.disableModelInvocation)
      .map((skill: any) => `<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><location>${escapeXml(skill.filePath)}</location></skill>`)
      .join("\n")),
  };
});

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

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

const EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE = `You do not have the parent's full conversation context. If additional context, clarification, evidence, or a decision from the parent would materially help you continue correctly, you may stop and ask for it instead of guessing.

Ask only for information you cannot reasonably obtain from your delegated prompt, existing session context, repository, or available tools. State clearly what you need and why.

The parent may resume this same session with AgentContinue. When resumed, continue from your existing work instead of restarting or repeating completed investigation.`;
const IDENTITY = "You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously.";

function expectPromptSectionsInOrder(prompt: string, sections: readonly string[]): void {
  const positions = sections.map((section) => prompt.indexOf(section));
  expect(positions.every((position) => position >= 0)).toBe(true);
  for (let index = 1; index < positions.length; index += 1) {
    expect(positions[index]).toBeGreaterThan(positions[index - 1]!);
  }
}

function firstDifference(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : limit;
}

describe("buildAgentPrompt", () => {
  it("injects one exact shared context block at the same stable position for every role", () => {
    expect(SHARED_CHILD_CONTEXT_GUIDANCE).toBe(EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE);
    const configs = [
      ...DEFAULT_AGENTS.values(),
      { ...baseConfig, name: "custom-agent" },
    ];
    const prompts = configs.map((config) => buildAgentPrompt(config, "/test/cwd", env));
    const positions = prompts.map((prompt) => prompt.indexOf(EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(new Set(positions).size).toBe(1);
    for (const [index, prompt] of prompts.entries()) {
      const start = positions[index]!;
      expect(prompt.slice(start, start + EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE.length))
        .toBe(EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE);
      expect(prompt.indexOf(EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE, start + 1)).toBe(-1);
      expect(start).toBeLessThan(prompt.indexOf("# Environment"));
      expect(start).toBeLessThan(prompt.indexOf(`<active_agent name="${configs[index]!.name}"/>`));
      expect(prompt.indexOf("<active_agent")).toBeLessThan(prompt.indexOf("<agent_instructions>"));
      for (const marker of ["BLOCKED", "QUESTION", "NEEDS_CONTEXT", "WAITING_FOR_PARENT"]) {
        expect(prompt).not.toContain(marker);
      }
    }
  });
  it("orders the no-context prompt and ends after role instructions without skills", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env);

    expectPromptSectionsInOrder(result, [
      IDENTITY,
      EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE,
      "# Environment",
      `<active_agent name="${baseConfig.name}"/>`,
      "<agent_instructions>",
    ]);
    expect(result).toContain("Working directory: /test/cwd");
    expect(result).toContain("Git repository: yes");
    expect(result).toContain("Branch: main");
    expect(result).toContain("Platform: linux");
    expect(result).toContain(baseConfig.systemPrompt);
    expect(result.endsWith("</agent_instructions>")).toBe(true);
  });

  it("keeps the prefix through guidance stable while environment values differ", () => {
    const first = buildAgentPrompt(baseConfig, "/test/cwd-one", env);
    const second = buildAgentPrompt(baseConfig, "/test/cwd-two", { ...env, branch: "feature" });
    const guidanceEnd = first.indexOf(EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE) + EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE.length;
    const environmentStart = first.indexOf("# Environment");
    const divergence = firstDifference(first, second);

    expect(first.slice(0, guidanceEnd)).toBe(second.slice(0, guidanceEnd));
    expect(divergence).toBeGreaterThanOrEqual(environmentStart);
    expect(divergence).toBeLessThan(first.indexOf(`<active_agent name="${baseConfig.name}"/>`));
  });

  it("renders skill metadata in the available_skills block", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [
        { name: "tdd", description: "TDD workflow", location: "/skills/tdd/SKILL.md", disableModelInvocation: false },
        { name: "debug", description: "Debugging workflow", location: "/skills/debug/SKILL.md", disableModelInvocation: false },
      ],
    });

    expect(result).toContain("<available_skills>");
    expect(result).toContain("<name>tdd</name>");
    expect(result).toContain("<location>/skills/tdd/SKILL.md</location>");
    expect(result).toContain("<name>debug</name>");
    expect(result).toContain("</available_skills>");
  });

  it("keeps metadata and excludes blocked skills", () => {
    const result = buildAgentPrompt({ ...baseConfig, excludeSkills: ["blocked"] }, "/test/cwd", env, {
      skillMetas: [
        { name: "visible", description: "Visible", location: "/skills/visible", disableModelInvocation: false },
        { name: "blocked", description: "Blocked", location: "/skills/blocked", disableModelInvocation: false },
      ],
    });

    expect(result).toContain("<name>visible</name>");
    expect(result).not.toContain("<name>blocked</name>");
  });

  it("honors Pi's invocation-disabled skill filtering", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [
        { name: "visible", description: "Visible", location: "/skills/visible", disableModelInvocation: false },
        { name: "hidden", description: "Hidden", location: "/skills/hidden", disableModelInvocation: true },
      ],
    });
    expect(result).toContain("<name>visible</name>");
    expect(result).not.toContain("<name>hidden</name>");
  });

  it("escapes skill metadata and omits skill sections without extras", () => {
    const escaped = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [{ name: "test", description: 'Use <code> & "quotes"', location: "/path", disableModelInvocation: false }],
    });
    expect(escaped).toContain("&lt;code&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&quot;quotes&quot;");

    const plain = buildAgentPrompt(baseConfig, "/test/cwd", env);
    expect(plain).not.toContain("<available_skills>");
  });

  it("rejects the complete 10,000-entry metadata prompt instead of selecting a prefix", () => {
    const metadata = Array.from({ length: 10_000 }, (_, index) => ({
      name: `skill-${index}`,
      description: "metadata",
      location: `/skills/skill-${index}/SKILL.md`,
      disableModelInvocation: false,
    }));

    expect(() => buildAgentPrompt(baseConfig, "/test/cwd", env, { skillMetas: metadata }))
      .toThrow(`Skill metadata prompt exceeds the maximum of ${MAX_SKILL_METADATA_PROMPT_BYTES} UTF-8 bytes`);
  });

  it("charges multibyte metadata and rejects an over-budget final child prompt", () => {
    const unicodeMetadata = [{
      name: "unicode",
      description: "😀漢字".repeat(200),
      location: "/skills/unicode/SKILL.md",
      disableModelInvocation: false,
    }];
    const prompt = buildAgentPrompt(baseConfig, "/test/cwd", env, { skillMetas: unicodeMetadata });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_CHILD_SYSTEM_PROMPT_BYTES);
    expect(prompt).not.toContain("\uFFFD");

    expect(() => buildAgentPrompt(
      { ...baseConfig, systemPrompt: "😀".repeat(MAX_CHILD_SYSTEM_PROMPT_BYTES / 4) },
      "/test/cwd",
      env,
    )).toThrow(`Child system prompt exceeds the maximum of ${MAX_CHILD_SYSTEM_PROMPT_BYTES} UTF-8 bytes`);
  });
});

describe("buildAgentPrompt — project context", () => {
  it("includes supplied AGENTS.md context", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [{ path: "/test/cwd/AGENTS.md", content: "Always use TDD." }],
    });
    expect(result).toContain("<project_context>");
    expect(result).toContain("<project_instructions path=\"/test/cwd/AGENTS.md\">");
    expect(result).toContain("Always use TDD.");
    expect(result).toContain("</project_context>");
  });

  it("orders context and skills after the shared prefix and role sections", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [{ path: "/test/cwd/AGENTS.md", content: "Context" }],
      skillMetas: [{ name: "tdd", description: "TDD", location: "/skills/tdd", disableModelInvocation: false }],
    });

    expectPromptSectionsInOrder(result, [
      IDENTITY,
      EXPECTED_SHARED_CHILD_CONTEXT_GUIDANCE,
      "# Environment",
      "<project_context>",
      `<active_agent name="${baseConfig.name}"/>`,
      "<agent_instructions>",
      "</agent_instructions>",
      "<available_skills>",
    ]);
  });

  it("keeps the complete project context prefix stable across roles", () => {
    const contextFiles = [{ path: "/test/cwd/AGENTS.md", content: "Context" }];
    const first = buildAgentPrompt({ ...baseConfig, name: "role-one" }, "/test/cwd", env, { contextFiles });
    const second = buildAgentPrompt({ ...baseConfig, name: "role-two" }, "/test/cwd", env, { contextFiles });
    const projectContextEndMarker = "</project_context>";
    const projectContextEnd = first.indexOf(projectContextEndMarker) + projectContextEndMarker.length;
    const activeAgentStart = first.indexOf("<active_agent");

    expect(first.slice(0, projectContextEnd)).toBe(second.slice(0, projectContextEnd));
    expect(first.slice(0, activeAgentStart)).toBe(second.slice(0, activeAgentStart));
    expect(firstDifference(first, second)).toBeGreaterThanOrEqual(activeAgentStart);
    expect(firstDifference(first, second)).toBeLessThan(first.indexOf("<agent_instructions>"));
  });

  it("omits empty context and escapes paths but not file content", () => {
    expect(buildAgentPrompt(baseConfig, "/test/cwd", env, { contextFiles: [] })).not.toContain("<project_context>");
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [{ path: "/path/<with>/special.md", content: "Use <tag> syntax." }],
    });
    expect(result).toContain("&lt;with&gt;");
    expect(result).toContain("Use <tag> syntax.");
  });
});
