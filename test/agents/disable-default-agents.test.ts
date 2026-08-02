/**
 * disable-default-agents.test.ts — Tests for the disableDefaultAgents setting.
 *
 * Verifies:
 *   - When disableDefaultAgents is true, registerAgents skips DEFAULT_AGENTS
 *   - When disableDefaultAgents is false (default), DEFAULT_AGENTS are included
 *   - discoverNewAgents respects the setting
 *   - User agents overriding a default by name still work when setting is on
 *   - Unknown types fail when defaults are disabled and no user agents exist
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAgents,
  getAvailableAgents,
  resolveType,
  getAgentConfig,
  setAgentScanDirs,
  discoverNewAgents,
  resolveWorktreeAgent,
  getConfig,
} from "../../src/agents/agent-types.js";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.js";
import type { AgentConfig } from "../../src/agents/types.js";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";

const availableNames = () => getAvailableAgents().map(({ name }) => name);

/* ------------------------------------------------------------------ */
/*  registerAgents with disableDefaultAgents                          */
/* ------------------------------------------------------------------ */

describe("registerAgents — disableDefaultAgents", () => {
  beforeEach(() => {
    registerAgents(new Map());
    setAgentScanDirs("", "");
  });

  it("includes exactly the five bundled Markdown defaults by default", () => {
    registerAgents(new Map());
    const defaultNames = ["architect", "scout", "implementer", "reviewer", "verifier"];
    expect(availableNames()).toEqual(defaultNames);
    expect([...DEFAULT_AGENTS.keys()]).toEqual(defaultNames);
    for (const config of DEFAULT_AGENTS.values()) {
      expect(config.source).toBe("default");
      expect(config.model).toBeUndefined();
      expect(config.thinkingLevel).toBeUndefined();
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(false);
    }
    expect(DEFAULT_AGENTS.get("architect")).toMatchObject({
      displayName: "Architect",
      registeredTools: ["read", "grep", "bash"],
      systemPrompt: expect.stringContaining("Design only the delegated change or decision."),
    });
    expect(DEFAULT_AGENTS.get("scout")).toMatchObject({
      displayName: "Scout",
      registeredTools: ["read", "grep", "bash"],
      systemPrompt: expect.stringContaining("Investigate only the delegated question."),
    });
    expect(DEFAULT_AGENTS.get("implementer")).toMatchObject({
      registeredTools: ["read", "grep", "bash", "edit", "write"],
      systemPrompt: expect.stringContaining("Implement only the delegated bounded change."),
    });
  });

  it("hardens Bash-enabled read-only defaults against repository mutation", () => {
    for (const name of ["reviewer", "verifier"]) {
      const prompt = DEFAULT_AGENTS.get(name)!.systemPrompt;
      expect(prompt).toContain("Do not intentionally change tracked source or configuration");
      expect(prompt).toContain("install anything");
      expect(prompt).toContain("shell redirects");
      expect(prompt).toContain("state-changing or destructive Git or shell commands");
      expect(prompt).toContain("git status --short");
    }
    expect(DEFAULT_AGENTS.get("architect")!.systemPrompt).not.toContain("nested");
    expect(DEFAULT_AGENTS.get("architect")!.systemPrompt).not.toContain("Delegate to");
    expect(DEFAULT_AGENTS.get("scout")!.systemPrompt).toContain("Do not edit tracked files.");
    expect(DEFAULT_AGENTS.get("verifier")!.systemPrompt).toContain("run existing tests, checks, or builds");
  });

  it("skips the five bundled defaults when disableDefaultAgents is true", () => {
    registerAgents(new Map(), { disableDefaultAgents: true });
    expect(availableNames()).toEqual([]);
  });

  it("still includes user-defined agents when disableDefaultAgents is true", () => {
    const userAgents = new Map<string, AgentConfig>();
    userAgents.set("my-agent", {
      name: "my-agent",
      description: "Custom agent",
      systemPrompt: "test",
    });
    registerAgents(userAgents, { disableDefaultAgents: true });
    const types = availableNames();
    expect(types).toContain("my-agent");
    expect(types).not.toContain("explorer");
  });

  it("user agent named like a default is still registered when setting is on", () => {
    const userAgents = new Map<string, AgentConfig>();
    userAgents.set("scout", {
      name: "scout",
      description: "My custom scout agent",
      systemPrompt: "custom prompt",
    });
    registerAgents(userAgents, { disableDefaultAgents: true });
    const config = getAgentConfig("scout");
    expect(config).toBeDefined();
    expect(config!.description).toBe("My custom scout agent");
  });

  it("returns empty types when defaults disabled and no user agents", () => {
    registerAgents(new Map(), { disableDefaultAgents: true });
    expect(availableNames()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  discoverNewAgents with disableDefaultAgents                       */
/* ------------------------------------------------------------------ */

describe("discoverNewAgents — disableDefaultAgents", () => {
  beforeEach(() => {
    registerAgents(new Map());
    setAgentScanDirs("", "");
  });

  it("refreshes an existing bundled type when a higher-precedence file appears", async () => {
    const { dir: projectDir, cleanup } = tempDirWithFiles([
      { name: "scout.md", content: makeAgentMd({ name: "scout", description: "Project scout" }) },
    ], "project-agents");

    try {
      setAgentScanDirs("", projectDir);
      expect(getAgentConfig("scout")?.source).toBe("default");

      await discoverNewAgents();

      expect(getAgentConfig("scout")).toMatchObject({
        description: "Project scout",
        source: "project",
      });
    } finally {
      cleanup();
    }
  });

  it("resolves a worktree definition locally without overriding the bundled registry", async () => {
    const { dir: worktreeDir, cleanup } = tempDirWithFiles([
      { name: "scout.md", content: "---\nname: scout\ndescription: Worktree scout\n---\nWorktree prompt" },
    ], "worktree-agents");

    try {
      const local = await resolveWorktreeAgent("scout", worktreeDir);
      expect(local?.config).toMatchObject({
        description: "Worktree scout",
        source: "project",
        registeredTools: ["read", "grep", "bash"],
      });
      expect(getAgentConfig("scout")?.source).toBe("default");
    } finally {
      cleanup();
    }
  });

  it("skips defaults when discovering with disableDefaultAgents", async () => {
    const { dir: projectDir, cleanup } = tempDirWithFiles([
      { name: "custom.md", content: makeAgentMd({ name: "custom", description: "Custom" }) },
    ], "project-agents");

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map(), { disableDefaultAgents: true });

      await discoverNewAgents({ disableDefaultAgents: true });

      const types = availableNames();
      expect(types).toContain("custom");
      expect(types).not.toContain("explorer");
      expect(types).not.toContain("implementer");
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  getConfig failure when defaults are disabled                      */
/* ------------------------------------------------------------------ */

describe("getConfig — unknown type when defaults are disabled", () => {
  beforeEach(() => {
    registerAgents(new Map());
    setAgentScanDirs("", "");
  });

  it("fails clearly when defaults are disabled and no configured type exists", () => {
    registerAgents(new Map(), { disableDefaultAgents: true });
    expect(() => getConfig("some-unknown-type")).toThrow("Unknown agent type: some-unknown-type");
  });
});
