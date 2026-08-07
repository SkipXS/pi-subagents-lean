/**
 * agent-discovery.test.ts — Tests for catalog merging and precedence.
 *
 * Parser and filesystem-boundary tests live in agent-frontmatter.test.ts and
 * agent-directory-scan.test.ts. This file keeps the public facade's merge
 * behavior and its parser re-export coverage.
 */

import { describe, it, expect } from "vitest";
import {
  parseAgentFile,
  mergeAgents,
  toAgentConfig,
} from "../../src/agents/agent-discovery.ts";
import type { AgentConfigFromMd } from "../../src/agents/agent-discovery.ts";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.ts";

describe("mergeAgents", () => {
  it("returns empty map when no agents", () => {
    const result = mergeAgents(new Map(), [], [], []);
    expect(result instanceof Map).toBe(true);
    expect(result.size).toBe(0);
  });

  it("includes default agents when no user/project agents", () => {
    const defaults = new Map([
      [
        "explorer",
        {
          name: "explorer",
          description: "Explorer agent",
          model: "model/a",
          extensions: true,
          skills: true,
          systemPrompt: "",
        },
      ],
    ]);
    const result = mergeAgents(defaults, [], [], []);
    expect(result.size).toBe(1);
    expect(result.get("explorer")?.model).toBe("model/a");
  });

  it("carries exclusion fields through a merged definition", () => {
    const override = parseAgentFile(`---
name: reviewer
tools: [read, bash]
exclude_tools: [bash]
extensions: [quality-monitor, telemetry]
exclude_extensions: [telemetry]
skills: [tdd, debug]
exclude_skills: [debug]
---
`, "project");

    const result = mergeAgents(new Map(), [], [], [override]).get("reviewer")!;
    expect(result).toMatchObject({
      tools: ["read", "bash"],
      registeredTools: ["read", "bash"],
      excludeTools: ["bash"],
      extensions: ["quality-monitor", "telemetry"],
      excludeExtensions: ["telemetry"],
      skills: ["tdd", "debug"],
      excludeSkills: ["debug"],
    });

    override.exclude_skills!.push("mutated");
    expect(result.excludeSkills).toEqual(["debug"]);
  });

  it("keeps the default reviewer prompt for a bodyless partial override", () => {
    const defaultReviewer = DEFAULT_AGENTS.get("reviewer")!;
    const override = parseAgentFile(`---
name: reviewer
model: test/reviewer
---
`, "project");

    const result = mergeAgents(DEFAULT_AGENTS, [], [], [override]);
    const reviewer = result.get("reviewer")!;
    expect(override.systemPrompt).toBeUndefined();
    expect(reviewer.model).toBe("test/reviewer");
    expect(reviewer.systemPrompt).toBe(defaultReviewer.systemPrompt);
  });

  it("replaces the default reviewer prompt when an override has a body", () => {
    const override = parseAgentFile(`---
name: reviewer
model: test/reviewer
---
Use this reviewer prompt instead.
`, "project");

    const result = mergeAgents(DEFAULT_AGENTS, [], [], [override]);
    const reviewer = result.get("reviewer")!;
    expect(reviewer.model).toBe("test/reviewer");
    expect(reviewer.systemPrompt).toBe("Use this reviewer prompt instead.");
  });

  it("merges role names case-insensitively without a display alias", () => {
    const defaults = new Map<string, any>([["reviewer", {
      name: "reviewer", description: "Default", extensions: true, skills: true, systemPrompt: "default",
    }]]);
    const result = mergeAgents(defaults, [{
      name: "REVIEWER", description: "Override", source: "user", systemPrompt: "override",
    }], [], []);

    expect([...result.keys()]).toEqual(["reviewer"]);
    expect(result.get("reviewer")).toMatchObject({
      name: "REVIEWER", description: "Override", extensions: true, skills: true,
    });
  });

  it("resolves missing selections to false after merging", () => {
    const result = mergeAgents(new Map(), [], [], [{
      name: "minimal", source: "project", systemPrompt: "prompt",
    }]);
    expect(result.get("minimal")).toMatchObject({ skills: false, extensions: false });
  });

  it("rejects oversized direct merge fields instead of caching unbounded values", () => {
    const defaults = new Map<string, any>([["valid", {
      name: "valid",
      description: "Default",
      model: "provider/default",
      tools: ["read"],
      systemPrompt: "Default prompt",
    }]]);
    const oversizedSelection = Array.from({ length: 257 }, (_, index) => `tool-${index}`);
    const result = mergeAgents(defaults, [
      {
        name: "x".repeat(129),
        source: "user",
        systemPrompt: "ignored",
      },
      {
        name: "valid",
        model: "m".repeat(257),
        tools: oversizedSelection,
        systemPrompt: "p".repeat(512 * 1024 + 1),
        source: "user",
      },
    ], [], []);

    expect(result.has("x".repeat(129))).toBe(false);
    expect(result.get("valid")).toMatchObject({
      model: "provider/default",
      tools: ["read"],
      systemPrompt: "Default prompt",
    });
  });

  it("bounds scalar and list fields for direct AgentConfig conversion", () => {
    const config = toAgentConfig({
      name: "x".repeat(129),
      description: "Description",
      model: "m".repeat(257),
      tools: true,
      exclude_tools: [""],
      extensions: false,
      skills: false,
      systemPrompt: "p".repeat(512 * 1024 + 1),
      source: "user",
    });
    expect(config).toMatchObject({
      name: "unknown",
      tools: true,
      extensions: false,
      skills: false,
      systemPrompt: "",
    });
    expect(config.model).toBeUndefined();
    expect(config.excludeTools).toBeUndefined();
  });

  it("user agents override defaults by name with per-field merge", () => {
    const defaults = new Map([
      [
        "explorer",
        {
          name: "explorer",
          description: "Explorer agent",
          model: "model/a",
          extensions: true,
          skills: true,
          systemPrompt: "default prompt",
        },
      ],
    ]);
    // User agent only overrides model and description
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        description: "User explorer",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const result = mergeAgents(defaults, userAgents, [], []);
    const agent = result.get("explorer")!;
    // User fields override defaults
    expect(agent.description).toBe("User explorer");
    expect(agent.systemPrompt).toBe("user prompt");
    // Default fields preserved when user doesn't override
    expect(agent.model).toBe("model/a");
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("project agents override user and default by name", () => {
    const defaults = new Map([
      [
        "explorer",
        {
          name: "explorer",
          description: "Default explorer",
          model: "model/a",
          extensions: true,
          skills: true,
          systemPrompt: "default prompt",
        },
      ],
    ]);
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        description: "User explorer",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        model: "model/project",
        source: "project",
        systemPrompt: "project prompt",
      },
    ];
    const result = mergeAgents(defaults, userAgents, [], projectAgents);
    const agent = result.get("explorer")!;
    // Project overrides
    expect(agent.model).toBe("model/project");
    expect(agent.systemPrompt).toBe("project prompt");
    // User overrides preserved where project doesn't override
    expect(agent.description).toBe("User explorer");
    // Default preserved where neither user nor project overrides
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("adds user-only agent types not in defaults", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "custom-agent",
        description: "A custom agent",
        source: "user",
        systemPrompt: "custom",
      },
    ];
    const result = mergeAgents(defaults, userAgents, [], []);
    expect(result.size).toBe(1);
    expect(result.get("custom-agent")?.description).toBe("A custom agent");
  });

  it("handles empty inputs gracefully", () => {
    const result = mergeAgents(new Map(), [], [], []);
    expect(result.size).toBe(0);
  });

  it("returns a Map with string keys", () => {
    const defaults = new Map([
      [
        "agent1",
        {
          name: "agent1",
          description: "Agent One",
          extensions: true,
          skills: false,
          systemPrompt: "",
          promptMode: "append" as const,
        },
      ],
    ]);
    const result = mergeAgents(defaults, [], [], []);
    expect(result.has("agent1")).toBe(true);
    expect(typeof [...result.keys()][0]).toBe("string");
  });

  it("shared agents override user and default, project overrides shared", () => {
    const defaults = new Map([
      [
        "explorer",
        {
          name: "explorer",
          description: "Default explorer",
          model: "model/a",
          extensions: true,
          skills: true,
          systemPrompt: "default prompt",
        },
      ],
    ]);
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        description: "User explorer",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        model: "model/shared",
        source: "project",
        systemPrompt: "shared prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        description: "Project explorer",
        source: "project",
      },
    ];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    const agent = result.get("explorer")!;
    // Project overrides shared and user
    expect(agent.description).toBe("Project explorer");
    // Shared overrides user and default
    expect(agent.model).toBe("model/shared");
    expect(agent.systemPrompt).toBe("shared prompt"); // project didn't override this
    // Default preserved where nothing overrides
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("shared-only agents are discovered when not in defaults/user/project", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "shared-only",
        description: "Only in shared",
        source: "project",
        systemPrompt: "shared body",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    expect(result.size).toBe(1);
    expect(result.get("shared-only")?.description).toBe("Only in shared");
  });

  it("shared agents get source 'project' in merged result", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "shared-agent",
        description: "Shared",
        source: "project",
        systemPrompt: "shared",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    expect(result.get("shared-agent")?.source).toBe("project");
  });

  it("backward compat: works without shared agents argument (empty shared)", () => {
    const defaults = new Map([
      [
        "agent1",
        {
          name: "agent1",
          description: "Default",
          extensions: true,
          skills: false,
          systemPrompt: "",
        },
      ],
    ]);
    const result = mergeAgents(defaults, [], [], []);
    expect(result.size).toBe(1);
    expect(result.get("agent1")?.description).toBe("Default");
  });

  it("name clash between shared and project resolves in favor of project", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "clash",
        description: "From shared",
        model: "model/shared",
        source: "project",
        systemPrompt: "shared prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [
      {
        name: "clash",
        description: "From project",
        model: "model/project",
        source: "project",
        systemPrompt: "project prompt",
      },
    ];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    const agent = result.get("clash")!;
    // All project fields win over shared
    expect(agent.description).toBe("From project");
    expect(agent.model).toBe("model/project");
    expect(agent.systemPrompt).toBe("project prompt");
  });

  it("name clash between shared and user resolves in favor of shared", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "clash",
        description: "From user",
        model: "model/user",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "clash",
        description: "From shared",
        model: "model/shared",
        source: "project",
        systemPrompt: "shared prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    const agent = result.get("clash")!;
    // Shared wins over user
    expect(agent.description).toBe("From shared");
    expect(agent.model).toBe("model/shared");
    expect(agent.systemPrompt).toBe("shared prompt");
  });
});
