/**
 * agent-discovery.test.ts — Tests for agent file parsing, merging, and config.
 *
 * Covers:
 *   - parseAgentFile: parses all frontmatter fields into AgentConfigFromMd
 *   - parseExtensions: handles false/'false'/'none' → false, true/'true'/'all' → true, string → array
 *   - scanAgentFilesInDir: scans directory for .md files
 *   - mergeAgents: per-field merge default < user < project, returns Map<string, AgentConfig>
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  parseAgentFile,
  scanAgentFilesInDir,
  mergeAgents,
  parseExtensions,
} from "../../src/agents/agent-discovery.ts";
import type { AgentConfigFromMd } from "../../src/agents/agent-discovery.ts";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.ts";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  parseExtensions                                                    */
/* ------------------------------------------------------------------ */

describe("parseExtensions", () => {
  it("returns false when raw is false (boolean)", () => {
    expect(parseExtensions(false)).toBe(false);
  });

  it("returns false when raw is 'false'", () => {
    expect(parseExtensions("false")).toBe(false);
  });

  it("returns false when raw is 'none'", () => {
    expect(parseExtensions("none")).toBe(false);
  });

  it("returns true when raw is true (boolean)", () => {
    expect(parseExtensions(true)).toBe(true);
  });

  it("returns true when raw is 'true'", () => {
    expect(parseExtensions("true")).toBe(true);
  });

  it("returns true when raw is 'all'", () => {
    expect(parseExtensions("all")).toBe(true);
  });

  it("splits comma-separated string into array", () => {
    const result = parseExtensions("a, b, c");
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("splits comma-separated string without spaces", () => {
    const result = parseExtensions("a,b,c");
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("returns undefined for undefined input", () => {
    expect(parseExtensions(undefined)).toBeUndefined();
  });

  it("trims whitespace from each entry", () => {
    const result = parseExtensions("  foo , bar , baz  ");
    expect(result).toEqual(["foo", "bar", "baz"]);
  });

  it("returns single-element array for single value", () => {
    const result = parseExtensions("read");
    expect(result).toEqual(["read"]);
  });

  it("strips brackets from inline YAML array syntax", () => {
    const result = parseExtensions("[a, b, c]");
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("strips brackets from single-element inline array", () => {
    const result = parseExtensions("[read]");
    expect(result).toEqual(["read"]);
  });
});

/* ------------------------------------------------------------------ */
/*  parseAgentFile                                                     */
/* ------------------------------------------------------------------ */

describe("parseAgentFile", () => {
  it("parses supported frontmatter", () => {
    const content = `---
name: explorer
description: A fast exploration agent
model: anthropic/claude-haiku-4-5-20251001
tools: read, bash, grep
exclude_tools: [write]
extensions: none
exclude_extensions: [telemetry]
skills: all
exclude_skills: [secret-skill]
thinking: high
hidden: "false"
---

This is the system prompt body.
`;
    const result = parseAgentFile(content, "user");
    expect(result.name).toBe("explorer");
    expect(result.description).toBe("A fast exploration agent");
    expect(result.model).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(result.tools).toEqual(["read", "bash", "grep"]);
    expect(result.exclude_tools).toEqual(["write"]);
    expect(result.extensions).toBe(false); // "none" → false
    expect(result.exclude_extensions).toEqual(["telemetry"]);
    expect(result.skills).toBe(true); // "all" → true
    expect(result.exclude_skills).toEqual(["secret-skill"]);
    expect(result.thinking).toBe("high");
    expect(result.hidden).toBe(false);
    expect(result.systemPrompt).toBe("This is the system prompt body.");
    expect(result.source).toBe("user");
  });

  it("parses minimal frontmatter with defaults", () => {
    const content = `---
name: minimal
---
Just a body.
`;
    const result = parseAgentFile(content, "project");
    expect(result.name).toBe("minimal");
    expect(result.description).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.tools).toBeUndefined();
    expect(result.extensions).toBeUndefined();
    expect(result.exclude_extensions).toBeUndefined();
    expect(result.skills).toBeUndefined();
    expect(result.exclude_skills).toBeUndefined();
    expect(result.thinking).toBeUndefined();
    expect(result.hidden).toBeUndefined();
    expect(result.systemPrompt).toBe("Just a body.");
    expect(result.source).toBe("project");
  });

  it("parses CRLF frontmatter", () => {
    const content = "---\r\nname: windows-agent\r\ntools: [read, bash]\r\nextensions: false\r\n---\r\nWindows body\r\n";
    const result = parseAgentFile(content, "project");
    expect(result).toMatchObject({
      name: "windows-agent",
      tools: ["read", "bash"],
      extensions: false,
      systemPrompt: "Windows body",
    });
  });

  it("parses content with no frontmatter", () => {
    const content = "# Just a markdown file\n\nNo frontmatter here.";
    const result = parseAgentFile(content, "user");
    expect(result.name).toBeUndefined();
    expect(result.systemPrompt).toBe(content);
    expect(result.source).toBe("user");
  });

  it("parses empty content without a prompt body", () => {
    const result = parseAgentFile("", "user");
    expect(result.name).toBeUndefined();
    expect(result.systemPrompt).toBeUndefined();
    expect(result.source).toBe("user");
  });

  it("handles tools as string array in yaml", () => {
    const content = `---
name: agent
tools:
  - read
  - bash
---
body
`;
    const result = parseAgentFile(content, "user");
    expect(result.tools).toEqual(["read", "bash"]);
  });

  it.each([
    ["tools", "[read, write, edit, grep, bash]", ["read", "write", "edit", "grep", "bash"]],
    ["exclude_tools", "[agent]", ["agent"]],
    ["exclude_extensions", "[rpiv-todo, pi-fff]", ["rpiv-todo", "pi-fff"]],
    ["exclude_skills", "[skill-a, skill-b]", ["skill-a", "skill-b"]],
    ["extensions", "[ext-a, ext-b]", ["ext-a", "ext-b"]],
  ] as const)("parses inline YAML array for %s", (field, value, expected) => {
    const content = `---\nname: agent\n${field}: ${value}\n---\nbody\n`;
    const result = parseAgentFile(content, "user");
    expect((result as unknown as Record<string, unknown>)[field]).toEqual(expected);
  });

  it.each([
    ["true", true],
    ["false", false],
    ["all", true],
    ["none", false],
  ] as const)("parses tools boolean selection %s", (value, expected) => {
    const content = `---\nname: agent\ntools: ${value}\n---\nbody\n`;
    expect(parseAgentFile(content, "user").tools).toBe(expected);
  });

  it("parses extensions as boolean true", () => {
    const content = makeAgentMd({ extensions: "true" });
    const result = parseAgentFile(content, "user");
    expect(result.extensions).toBe(true);
  });

  it("parses extensions as 'all'", () => {
    const content = makeAgentMd({ extensions: "all" });
    const result = parseAgentFile(content, "user");
    expect(result.extensions).toBe(true);
  });

  it("parses extensions as comma list", () => {
    const content = makeAgentMd({ extensions: "read, bash, write" });
    const result = parseAgentFile(content, "user");
    expect(result.extensions).toEqual(["read", "bash", "write"]);
  });

  it("parses hidden as boolean false from 'false' string", () => {
    const content = makeAgentMd({ hidden: "false" });
    const result = parseAgentFile(content, "user");
    expect(result.hidden).toBe(false);
  });

  it("ignores unknown frontmatter fields", () => {
    const content = `---
name: agent
unknown_field: should be ignored
another_unknown: 42
---
body
`;
    const result = parseAgentFile(content, "user");
    expect(result.name).toBe("agent");
    // Should not error on unknown fields
  });

  it("rejects invalid thinking values", () => {
    const content = `---
name: agent
thinking: ultra
---
body
`;
    const result = parseAgentFile(content, "user");
    expect(result.thinking).toBeUndefined();
  });


});

/* ------------------------------------------------------------------ */
/*  scanAgentFilesInDir                                                */
/* ------------------------------------------------------------------ */

describe("scanAgentFilesInDir", () => {
  it("reuses unchanged files and notices create, change, delete, and rename", async () => {
    const { dir, cleanup } = tempDirWithFiles([], "agent-discovery-cache");
    const readFile = vi.spyOn(fs.promises, "readFile");
    const firstPath = join(dir, "first.md");
    const renamedPath = join(dir, "renamed.md");

    try {
      // A cached negative directory result must not hide a later creation.
      expect(await scanAgentFilesInDir(dir)).toEqual([]);
      expect(readFile).not.toHaveBeenCalled();

      fs.writeFileSync(firstPath, makeAgentMd({ name: "first", description: "Initial" }));
      expect((await scanAgentFilesInDir(dir)).map(({ description }) => description)).toEqual(["Initial"]);
      expect(readFile).toHaveBeenCalledTimes(1);

      // An unchanged fingerprint reuses the parsed definition.
      await scanAgentFilesInDir(dir);
      expect(readFile).toHaveBeenCalledTimes(1);

      fs.writeFileSync(firstPath, makeAgentMd({ name: "first", description: "Changed" }));
      expect((await scanAgentFilesInDir(dir))[0]?.description).toBe("Changed");
      expect(readFile).toHaveBeenCalledTimes(2);

      fs.unlinkSync(firstPath);
      expect(await scanAgentFilesInDir(dir)).toEqual([]);

      fs.writeFileSync(renamedPath, makeAgentMd({ description: "Renamed", _skip: ["name"] }));
      expect((await scanAgentFilesInDir(dir))[0]).toMatchObject({
        name: "renamed",
        description: "Renamed",
      });
      expect(readFile).toHaveBeenCalledTimes(3);
      await scanAgentFilesInDir(dir);
      expect(readFile).toHaveBeenCalledTimes(3);
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("bounds path caches while retaining recent entries", async () => {
    const { dir, cleanup } = tempDirWithFiles([], "agent-discovery-lru");
    const readFile = vi.spyOn(fs.promises, "readFile");
    const directories = Array.from({ length: 256 }, (_, index) => join(dir, `agent-${index}`));

    try {
      for (const [index, child] of directories.entries()) {
        fs.mkdirSync(child);
        fs.writeFileSync(join(child, "agent.md"), makeAgentMd({ name: `agent-${index}` }));
        await scanAgentFilesInDir(child);
      }

      // A hit refreshes recency, so adding one more path evicts agent-1 rather
      // than the recently used agent-0 entry.
      const readsBeforeHit = readFile.mock.calls.length;
      await scanAgentFilesInDir(directories[0]!);
      expect(readFile).toHaveBeenCalledTimes(readsBeforeHit);
      const readsBeforeEviction = readFile.mock.calls.length;
      const extra = join(dir, "agent-extra");
      fs.mkdirSync(extra);
      fs.writeFileSync(join(extra, "agent.md"), makeAgentMd({ name: "agent-extra" }));
      await scanAgentFilesInDir(extra);
      await scanAgentFilesInDir(directories[0]!);
      expect(readFile).toHaveBeenCalledTimes(readsBeforeEviction + 1);
      await scanAgentFilesInDir(directories[1]!);
      expect(readFile).toHaveBeenCalledTimes(readsBeforeEviction + 2);
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("returns empty array for non-existent directory", async () => {
    const result = await scanAgentFilesInDir("/tmp/nonexistent-sdf9asdf", "user");
    expect(result).toEqual([]);
  });

  it("treats a readable but unlistable directory as empty", async () => {
    const { dir, cleanup } = tempDirWithFiles([{ name: "agent.md", content: makeAgentMd({ name: "agent" }) }]);
    const readdir = vi.spyOn(fs.promises, "readdir").mockRejectedValueOnce(new Error("EACCES"));
    try {
      await expect(scanAgentFilesInDir(dir, "user")).resolves.toEqual([]);
    } finally {
      readdir.mockRestore();
      cleanup();
    }
  });

  it("parses all .md files in a directory", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "alpha.md", content: makeAgentMd({ name: "alpha", model: "model/a" }) },
      { name: "beta.md", content: makeAgentMd({ name: "beta", model: "model/b" }) },
      { name: "gamma.md", content: makeAgentMd({ name: "gamma", _skip: ["model"] }) },
      { name: "readme.txt", content: "not an agent file" },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toHaveLength(3);
      expect(agents.find((a) => a.name === "alpha")?.model).toBe("model/a");
      expect(agents.find((a) => a.name === "beta")?.model).toBe("model/b");
      expect(agents.find((a) => a.name === "gamma")?.model).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("processes Markdown files in deterministic filename order", async () => {
    const firstContent = makeAgentMd({ name: "same", description: "First" });
    const lastContent = makeAgentMd({ name: "same", description: "Last" });
    const { dir, cleanup } = tempDirWithFiles([
      { name: "a-first.md", content: firstContent },
      { name: "z-last.md", content: lastContent },
    ]);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const readdir = vi.spyOn(fs.promises, "readdir").mockResolvedValue([...entries].reverse() as never);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      // Later filenames win same-layer merges, regardless of filesystem order.
      expect(agents.map((agent) => agent.description)).toEqual(["First", "Last"]);
      const merged = mergeAgents(new Map(), agents, [], []);
      expect(merged.get("same")?.description).toBe("Last");
    } finally {
      readdir.mockRestore();
      cleanup();
    }
  });

  it("uses the filename when frontmatter omits name", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "reviewer.md", content: "---\ndescription: Reviews changes\n---\nInstructions" },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe("reviewer");
      expect(agents[0]?.description).toBe("Reviews changes");
    } finally {
      cleanup();
    }
  });

  it("skips an unreadable agent file while discovering readable filename-fallback agents", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "broken.md", content: makeAgentMd({ name: "broken" }) },
      { name: "reviewer.md", content: "---\ndescription: Reviews changes\n---\nInstructions" },
    ]);
    const brokenPath = join(dir, "broken.md");
    const originalReadFile = fs.promises.readFile;
    const readFile = vi.spyOn(fs.promises, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === brokenPath) throw new Error("simulated read failure");
      return originalReadFile(filePath, options as "utf-8");
    });

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toEqual([expect.objectContaining({ name: "reviewer", description: "Reviews changes" })]);
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("returns empty array when no .md files", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "data.json", content: "{}" },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("assigns source to all parsed agents", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "agent1.md", content: makeAgentMd({ name: "agent1" }) },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "project");
      expect(agents).toHaveLength(1);
      expect(agents[0]?.source).toBe("project");
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  mergeAgents                                                        */
/* ------------------------------------------------------------------ */

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
    // Default preserved where neither user nor project override
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

