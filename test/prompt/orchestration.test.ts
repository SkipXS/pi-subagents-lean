import { describe, expect, it } from "vitest";
import { getAvailableAgents, registerAgents } from "../../src/agents/agent-types.ts";
import {
  MAX_ORCHESTRATION_AGENTS,
  MAX_ORCHESTRATION_CATALOG_LENGTH,
  MAX_ORCHESTRATION_DESCRIPTION_LENGTH,
  MAX_ORCHESTRATION_NAME_LENGTH,
  MAX_ORCHESTRATION_PROMPT_LENGTH,
  ORCHESTRATION_PROMPT_END_MARKER,
  ORCHESTRATION_PROMPT_MARKER,
  buildOrchestrationPrompt,
  getOrchestrationPromptUpdate,
} from "../../src/prompt/orchestration.ts";
import type { AgentConfig } from "../../src/agents/types.ts";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.ts";

const EXPECTED_PARENT_CONTEXT_GUIDANCE = `Agents may ask for additional context, clarification, evidence, or decisions that are not available in their session.

Resolve the request from your conversation context, tools, repository evidence, or peer-agent results when possible. Ask the user only when their input is genuinely needed.

Then resume the same agent with AgentContinue, providing the requested information and any newly relevant evidence. Do not replace an agent merely because it asked for information.`;

const EXPECTED_AGENT_CONTINUE_GUIDANCE = `AgentContinue resumes the same retained session. Provide the requested answer or new instructions plus any relevant parent or peer evidence the agent has not seen. Do not repeat context already available in that session unless needed.`;

function agent(name: string, description: string, hidden = false): AgentConfig {
  return { name, description, hidden, systemPrompt: "" };
}

describe("parent orchestration prompt", () => {
  it("lists visible dynamic agents with canonical names and frontmatter descriptions", () => {
    registerAgents(new Map([
      ["reviewer", agent("reviewer", "  Review\n  changes carefully.  ")],
      ["shipper", agent("shipper", "Prepare release notes")],
      ["internal", agent("internal", "Must not be shown", true)],
    ]), { disableDefaultAgents: true });

    const prompt = buildOrchestrationPrompt(getAvailableAgents())!;
    expect(prompt).toContain("`reviewer` — Review changes carefully.");
    expect(prompt).toContain("`shipper` — Prepare release notes");
    expect(prompt).not.toContain("internal");
    expect(prompt).toContain(EXPECTED_PARENT_CONTEXT_GUIDANCE);
    expect(prompt).toContain(EXPECTED_AGENT_CONTINUE_GUIDANCE);
    expect(prompt).toContain("Fresh agents lack parent history/tool results/peer output.");
    expect(prompt).toContain("Self-contained handoffs: Goal; Current state/evidence/decisions; Scope; Constraints/non-goals; Acceptance criteria; Expected result.");
    expect(prompt).toContain("direct known-scope, low-risk work: targeted reads/simple checks, minor focused edits, synthesis/bounded follow-ups.");
    expect(prompt).toContain("unclear scope/risk calls for matching roles");
    expect(prompt).toContain("Own planning/decomposition/sequencing, decisions/result reconciliation");
    expect(prompt).toContain("never hand an agent the whole task");
    expect(prompt).toContain("Batch independent read-only foreground Agent calls in one turn; Pi submits under configured root concurrency limit.");
    expect(prompt).toContain("Same writer: one focused correction/subsystem");
    expect(prompt).toContain("two independent no-blocker reviews with no material change");
    expect(prompt).toContain("Agents: `reviewer` — Review changes carefully.; `shipper` — Prepare release notes");
    expect(prompt.indexOf(EXPECTED_PARENT_CONTEXT_GUIDANCE)).toBeLessThan(prompt.indexOf("Agents: "));
    expect(prompt.indexOf(EXPECTED_AGENT_CONTINUE_GUIDANCE)).toBeLessThan(prompt.indexOf("Agents: "));
    expect(prompt).not.toContain("AgentContinue reuses a finished session;");

    registerAgents(new Map([["reviewer", agent("reviewer", "Review changes carefully.")]]), { disableDefaultAgents: true });
    expect(buildOrchestrationPrompt(getAvailableAgents())).not.toContain("shipper");
  });

  it("keeps stable guidance before dynamic catalogs without introducing state markers", () => {
    const prompts = [
      buildOrchestrationPrompt(DEFAULT_AGENTS.values())!,
      buildOrchestrationPrompt([
        ...DEFAULT_AGENTS.values(),
        agent("custom", "A custom role"),
      ])!,
    ];
    const parentStart = prompts.map((prompt) => prompt.indexOf(EXPECTED_PARENT_CONTEXT_GUIDANCE));

    expect(new Set(parentStart).size).toBe(1);
    for (const prompt of prompts) {
      const continueStart = prompt.indexOf(EXPECTED_AGENT_CONTINUE_GUIDANCE);
      const catalogStart = prompt.indexOf("Agents: ");
      const start = prompt.indexOf(EXPECTED_PARENT_CONTEXT_GUIDANCE);
      expect(prompt.slice(start, start + EXPECTED_PARENT_CONTEXT_GUIDANCE.length))
        .toBe(EXPECTED_PARENT_CONTEXT_GUIDANCE);
      expect(prompt.indexOf(ORCHESTRATION_PROMPT_MARKER)).toBeLessThan(start);
      expect(start).toBeLessThan(continueStart);
      expect(continueStart).toBeLessThan(catalogStart);
      expect(prompt).not.toMatch(/\b(BLOCKED|QUESTION|NEEDS_CONTEXT|WAITING_FOR_PARENT)\b/);
    }
  });

  it("keeps every bundled role visible within the parent prompt budget", () => {
    const prompt = buildOrchestrationPrompt(DEFAULT_AGENTS.values())!;

    for (const name of DEFAULT_AGENTS.keys()) expect(prompt).toContain(`\`${name}\` —`);
    expect(prompt).not.toContain("omitted");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH - 1024);
  });

  it("keeps bundled and custom roles visible within the expanded catalog capacity", () => {
    const customAgents = Array.from({ length: 17 }, (_, i) =>
      agent(`custom-${i.toString().padStart(2, "0")}`, `Specialized role ${i} for bounded project work.`),
    );
    const agents = [...DEFAULT_AGENTS.values(), ...customAgents];
    const prompt = buildOrchestrationPrompt(agents)!;

    for (const { name } of agents) expect(prompt).toContain(`\`${name}\` —`);
    expect(prompt).not.toContain("omitted");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
    expect(buildOrchestrationPrompt([
      ...agents,
      agent("custom-17", "Specialized role 17 for bounded project work."),
    ])).toContain("omitted");
    expect(MAX_ORCHESTRATION_CATALOG_LENGTH).toBeGreaterThanOrEqual(1824);
  });

  it("bounds names, descriptions, catalog, agents, and total prompt with deterministic overflow", () => {
    const huge = "x".repeat(1000);
    const agents = Array.from({ length: MAX_ORCHESTRATION_AGENTS + 30 }, (_, i) => agent(`${i.toString().padStart(3, "0")}-agent`, huge));
    const prompt = buildOrchestrationPrompt(agents)!;

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
    expect(prompt).toContain("… +");
    expect(prompt).toContain("omitted");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
    expect(prompt.match(/`[^`]*`/g)?.every(name => name.length - 2 <= MAX_ORCHESTRATION_NAME_LENGTH)).toBe(true);
    expect(prompt.match(/— ([^;\n]+)/g)?.every(description => description.slice(2).length <= MAX_ORCHESTRATION_DESCRIPTION_LENGTH)).toBe(true);
    expect(prompt.length - ORCHESTRATION_PROMPT_MARKER.length - ORCHESTRATION_PROMPT_END_MARKER.length).toBeGreaterThan(0);
    expect(MAX_ORCHESTRATION_CATALOG_LENGTH).toBeLessThan(MAX_ORCHESTRATION_PROMPT_LENGTH);
  });

  it("never truncates advertised identifiers at the catalog boundary", () => {
    const agents = Array.from({ length: 30 }, (_, i) =>
      agent(`${i.toString().padStart(2, "0")}-${"n".repeat(55)}`, "description ".repeat(30)),
    );
    const prompt = buildOrchestrationPrompt(agents)!;
    const advertised = [...prompt.matchAll(/`([^`]*)` —/g)].map(match => match[1]);
    const omitted = Number(prompt.match(/\+(\d+) omitted/)?.[1] ?? 0);

    expect(advertised.every(name => agents.some(candidate => candidate.name === name))).toBe(true);
    expect((prompt.match(/`/g) ?? [])).toHaveLength(advertised.length * 2);
    expect(advertised.length + omitted).toBe(agents.length);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
  });

  it("keeps catalog backticks balanced when descriptions contain backticks", () => {
    const prompt = buildOrchestrationPrompt([agent("reader", "Uses `read` first, then `bash")])!;
    expect(prompt).toContain("Uses 'read' first, then 'bash");
    expect((prompt.match(/`/g) ?? [])).toHaveLength(2);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
  });

  it("enforces UTF-8 byte budgets without splitting CJK or astral code points", () => {
    const prompt = buildOrchestrationPrompt([agent("unicode-agent", "漢字😀".repeat(100))])!;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
    expect(prompt).not.toContain("\uFFFD");
    expect([...prompt].some(point => point.length === 1 && point.charCodeAt(0) >= 0xD800 && point.charCodeAt(0) <= 0xDFFF)).toBe(false);
  });

  it("preserves built-in and registry insertion order while sorting only the catalog", () => {
    registerAgents(new Map([["reviewer", agent("reviewer", "Reviews")]]));
    expect(getAvailableAgents().map(({ name }) => name)).toEqual(["architect", "scout", "implementer", "reviewer", "verifier"]);

    // The catalog itself is sorted below for prompt cache stability.

    const firstRegistry = new Map([
      ["zebra", agent("zebra", "Last alphabetically")],
      ["alpha", agent("alpha", "First alphabetically")],
    ]);
    const secondRegistry = new Map([...firstRegistry.entries()].reverse());

    registerAgents(firstRegistry, { disableDefaultAgents: true });
    const firstPrompt = buildOrchestrationPrompt(getAvailableAgents());
    expect(getAvailableAgents().map(({ name }) => name)).toEqual(["zebra", "alpha"]);

    registerAgents(secondRegistry, { disableDefaultAgents: true });
    expect(buildOrchestrationPrompt(getAvailableAgents())).toBe(firstPrompt);
    expect(getAvailableAgents().map(({ name }) => name)).toEqual(["alpha", "zebra"]);
  });

  it("replaces only complete extension blocks and ignores marker collisions", () => {
    const agents = [agent("custom", "Custom role")];
    const base = `Base\n${ORCHESTRATION_PROMPT_MARKER}\nuser text`;
    const updated = getOrchestrationPromptUpdate(base, agents)!;
    expect(updated).toContain(`${ORCHESTRATION_PROMPT_MARKER}\nuser text`);
    expect(updated.match(new RegExp(ORCHESTRATION_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(2);

    const withUnmatchedEnd = `Base\n${ORCHESTRATION_PROMPT_END_MARKER}`;
    expect(getOrchestrationPromptUpdate(withUnmatchedEnd, agents)).toContain(withUnmatchedEnd);

    const generated = buildOrchestrationPrompt([agent("old", "Old role")])!;
    const refreshed = getOrchestrationPromptUpdate(`Base\n\n${generated}`, agents)!;
    expect(refreshed).toContain("Base");
    expect(refreshed).toContain("`custom` — Custom role");
    const replaced = getOrchestrationPromptUpdate(refreshed, agents);
    expect(replaced).toBeUndefined();
  });

  it("removes the owned block when the live catalog is empty", () => {
    const generated = buildOrchestrationPrompt([agent("custom", "Custom role")])!;

    expect(getOrchestrationPromptUpdate(`Base\n\n${generated}`, [])).toBe("Base");
    expect(getOrchestrationPromptUpdate("Base", [])).toBeUndefined();
  });

  it("omits unrepresentable names rather than changing their callable identifier", () => {
    const names = [
      "x".repeat(65),
      "two  spaces",
      "tab\tname",
      "line\nname",
      "back`tick",
      `marker${ORCHESTRATION_PROMPT_END_MARKER}`,
      "ordinary name",
    ];
    const prompt = buildOrchestrationPrompt(names.map(name => agent(name, "Description")))!;

    expect(prompt).toContain("`two  spaces`");
    expect(prompt).toContain("`ordinary name`");
    for (const name of [names[0], names[2], names[3], names[4], names[5]]) {
      expect(prompt).not.toContain(name);
    }
    expect(prompt).toContain("+5 omitted");
    expect(buildOrchestrationPrompt([agent("bad`name", "Description")])).toContain("+1 omitted");
  });

  it("strips versioned blocks after rules change", () => {
    const changedRulesBlock = `${ORCHESTRATION_PROMPT_MARKER}\nNew future rules\nAgents: \`reviewer\` — Review\n${ORCHESTRATION_PROMPT_END_MARKER}`;
    expect(getOrchestrationPromptUpdate(`Inherited\n\n${changedRulesBlock}`, [])).toBe("Inherited");
  });
});
