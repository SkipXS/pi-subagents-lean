/**
 * agent-frontmatter.test.ts — Tests for agent Markdown frontmatter parsing.
 */

import { describe, it, expect } from "vitest";
import { parseAgentFile, parseExtensions } from "../../src/agents/agent-frontmatter.ts";
import {
  MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES,
  MAX_AGENT_MODEL_BYTES,
  MAX_DESCRIPTION_BYTES,
  MAX_AGENT_NAME_BYTES,
  utf8ByteLength,
} from "../../src/agents/agent-string-limits.ts";
import { makeAgentMd } from "../fixtures.ts";

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
    // Unknown fields must not affect the parsed public shape.
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

  it("retains oversized descriptions with a bounded UTF-8 marker", () => {
    const result = parseAgentFile(`---\nname: agent\ndescription: ${"界".repeat(MAX_DESCRIPTION_BYTES / 3 + 100)}\n---\nbody`, "user");

    expect(result.description).toBeDefined();
    expect(utf8ByteLength(result.description!)).toBeLessThanOrEqual(MAX_DESCRIPTION_BYTES);
    expect(result.description).toMatch(/\[TRUNCATED\]$/);
  });

  it("bounds identifier bytes and selection metadata before cache publication", () => {
    const exactName = `${"界".repeat(42)}aa`;
    const exactModel = `${"界".repeat(85)}a`;
    expect(utf8ByteLength(exactName)).toBe(MAX_AGENT_NAME_BYTES);
    expect(utf8ByteLength(exactModel)).toBe(MAX_AGENT_MODEL_BYTES);

    const exact = parseAgentFile(
      `---\nname: ${exactName}\nmodel: ${exactModel}\ntools: ${Array.from({ length: MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES }, (_, i) => `tool-${i}`).join(",")}\n---\nbody`,
      "user",
    );
    expect(exact.name).toBe(exactName);
    expect(exact.model).toBe(exactModel);
    expect(exact.tools).toHaveLength(MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES);

    const rejected = parseAgentFile(
      `---\nname: ${exactName}a\nmodel: ${exactModel}界\ntools: ${Array.from({ length: MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES + 1 }, (_, i) => `tool-${i}`).join(",")}\n---\nbody`,
      "user",
    );
    expect(rejected.name).toBeUndefined();
    expect(rejected.model).toBeUndefined();
    expect(rejected.tools).toBeUndefined();
  });
});
