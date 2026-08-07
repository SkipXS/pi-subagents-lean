import { describe, it, expect, vi } from "vitest";
import {
  buildAgentPrompt,
  MAX_CHILD_SYSTEM_PROMPT_BYTES,
  MAX_SKILL_METADATA_PROMPT_BYTES,
} from "../../src/prompt/prompts.ts";
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

describe("buildAgentPrompt", () => {
  it("always uses the replacement base and includes role instructions", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env);

    expect(result).toContain("You are a Pi, an expert coding sub-agent.");
    expect(result).toContain("You have been invoked to handle a specific task autonomously.");
    expect(result).toContain(`<active_agent name="${baseConfig.name}"/>`);
    expect(result).toContain("# Environment");
    expect(result).toContain("Working directory: /test/cwd");
    expect(result).toContain("Git repository: yes");
    expect(result).toContain("Branch: main");
    expect(result).toContain("Platform: linux");
    expect(result).toContain("<agent_instructions>");
    expect(result).toContain(baseConfig.systemPrompt);
    expect(result).toContain("</agent_instructions>");
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

  it("places context before role instructions and skills after them", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [{ path: "/test/cwd/AGENTS.md", content: "Context" }],
      skillMetas: [{ name: "tdd", description: "TDD", location: "/skills/tdd", disableModelInvocation: false }],
    });
    expect(result.indexOf("<project_context>")).toBeLessThan(result.indexOf("<agent_instructions>"));
    expect(result.indexOf("<available_skills>")).toBeGreaterThan(result.indexOf("<agent_instructions>"));
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
