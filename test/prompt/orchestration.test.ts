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

const EXPECTED_PARENT_CONTEXT_GUIDANCE = `If an agent lacks context, evidence, or a decision, resolve it from the parent conversation, tools, repository evidence, or peer results when possible. Ask the user only when their input is required.

Then continue the same agent with AgentContinue, providing the missing information and new evidence. Do not replace an agent merely because it requested context.`;

const EXPECTED_AGENT_CONTINUE_GUIDANCE = `AgentContinue resumes the same retained child session. Send the new answer or instruction plus relevant parent/peer evidence the agent has not seen. Do not resend context already present in that session unless needed.`;

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
    expect(prompt).toContain("Fresh agents lack parent history/tool results/peer output. Self-contained handoffs: Goal; Current state/evidence/decisions; Scope; Constraints/non-goals; Acceptance criteria; Expected result.");
    expect(prompt).toContain("do known-scope, low-risk work directly: targeted reads/simple checks, minor focused edits, synthesis/bounded follow-ups.");
    expect(prompt).toContain("match roles to scope/risk");
    expect(prompt).toContain("Own planning/decomposition/sequencing, decisions/reconciliation");
    expect(prompt).toContain("never hand one agent the whole task");
    expect(prompt).toContain("Dependent stages sequential. Batch independent read-only foreground Agent calls in one parent turn; Pi submits them under the configured root concurrency limit. Never run overlapping writers concurrently.");
    expect(prompt).toContain("Use the same writer for a focused correction within its subsystem");
    expect(prompt).toContain("stop after two independent no-blocker reviews with no material change unless checks fail or new evidence appears.");
    expect(prompt).toContain("Agents: `reviewer` — Review changes carefully.; `shipper` — Prepare release notes");
    expect(prompt.indexOf(EXPECTED_PARENT_CONTEXT_GUIDANCE)).toBeLessThan(prompt.indexOf("Agents: "));
    expect(prompt.indexOf(EXPECTED_AGENT_CONTINUE_GUIDANCE)).toBeLessThan(prompt.indexOf("Agents: "));
    expect(prompt.endsWith(ORCHESTRATION_PROMPT_END_MARKER)).toBe(true);

    registerAgents(new Map([["reviewer", agent("reviewer", "Review changes carefully.")]]), { disableDefaultAgents: true });
    expect(buildOrchestrationPrompt(getAvailableAgents())).not.toContain("shipper");
  });

  it("keeps stable guidance in operational order before the dynamic catalog", () => {
    const prompts = [
      buildOrchestrationPrompt(DEFAULT_AGENTS.values())!,
      buildOrchestrationPrompt([
        ...DEFAULT_AGENTS.values(),
        agent("custom", "A custom role"),
      ])!,
    ];
    const parentStart = prompts.map((prompt) => prompt.indexOf(EXPECTED_PARENT_CONTEXT_GUIDANCE));
    const orderedRules = [
      "Delegate substantive work; do known-scope, low-risk work directly",
      "Own planning/decomposition/sequencing, decisions/reconciliation",
      "Dependent stages sequential. Batch independent read-only foreground Agent calls",
      "Fresh agents lack parent history/tool results/peer output. Self-contained handoffs:",
      EXPECTED_PARENT_CONTEXT_GUIDANCE,
      "Reuse an existing agent only for missing information",
      "Only successfully completed retained sessions can continue",
      EXPECTED_AGENT_CONTINUE_GUIDANCE,
      "External APIs/lifecycle/concurrency/integration require",
      "Avoid review loops. When independent review is justified",
      "Agents: ",
    ];
    const expectedContextHandoffSequence = `Own planning/decomposition/sequencing, decisions/reconciliation, integration/validation, final answer. Large tasks: investigate first; split bounded non-overlapping stages; never hand one agent the whole task.

Dependent stages sequential. Batch independent read-only foreground Agent calls in one parent turn; Pi submits them under the configured root concurrency limit. Never run overlapping writers concurrently.

Fresh agents lack parent history/tool results/peer output. Self-contained handoffs: Goal; Current state/evidence/decisions; Scope; Constraints/non-goals; Acceptance criteria; Expected result.

${EXPECTED_PARENT_CONTEXT_GUIDANCE}`;

    expect(new Set(parentStart).size).toBe(1);
    for (const prompt of prompts) {
      const positions = orderedRules.map((rule) => prompt.indexOf(rule));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      const start = prompt.indexOf(EXPECTED_PARENT_CONTEXT_GUIDANCE);
      expect(prompt.slice(start, start + EXPECTED_PARENT_CONTEXT_GUIDANCE.length))
        .toBe(EXPECTED_PARENT_CONTEXT_GUIDANCE);
      expect(prompt).toContain(expectedContextHandoffSequence);
      expect(prompt.indexOf(ORCHESTRATION_PROMPT_MARKER)).toBeLessThan(positions[0]!);
      expect(prompt.slice(0, positions.at(-1))).not.toContain("`custom` — A custom role");
      expect(prompt.endsWith(ORCHESTRATION_PROMPT_END_MARKER)).toBe(true);
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
    const customAgents = Array.from({ length: 16 }, (_, i) =>
      agent(`custom-${i.toString().padStart(2, "0")}`, `Specialized role ${i} for bounded project work.`),
    );
    const agents = [...DEFAULT_AGENTS.values(), ...customAgents];
    const prompt = buildOrchestrationPrompt(agents)!;

    for (const { name } of agents) expect(prompt).toContain(`\`${name}\` —`);
    expect(prompt).not.toContain("omitted");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
    expect(buildOrchestrationPrompt([
      ...agents,
      agent("custom-16", "Specialized role 16 for bounded project work."),
    ])).toContain("omitted");
    expect(MAX_ORCHESTRATION_CATALOG_LENGTH).toBe(1788);
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
