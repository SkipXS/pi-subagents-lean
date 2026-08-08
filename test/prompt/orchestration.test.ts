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
    expect(prompt).toBe(`${ORCHESTRATION_PROMPT_MARKER}
Delegate substantive work; handle small, obvious, low-risk tasks directly when scope is known and a few focused tool calls suffice. Direct work may include targeted reads, simple fact checks, minor single-location edits, synthesis, and bounded follow-ups.

Delegate broad discovery, root-cause investigation, cross-component design, uncertain or multiple changes, independent review, or substantial verification. If scope or risk is unclear, use the matching role. Use only roles that add value; never force a full pipeline.

Own planning, decomposition, sequencing, decisions, result reconciliation, integration, validation, and the final response. For large tasks, investigate first, then split work into bounded, non-overlapping stages instead of handing one agent the whole request.

New agents lack parent history/tool results and peer output. For substantive spawns, use concise, decision-relevant sections: Goal; State/evidence/decisions; Scope/files/symbols; Constraints/non-goals; Acceptance criteria; Expected result.

Do not duplicate delegated work. Re-enter the same area only for incomplete or conflicting results or a bounded follow-up. Never run concurrent writers or overlapping changes. Give the same writer at most one focused correction per subsystem; then take over or re-plan with a new owner.

Run dependent stages sequentially. Parallelize independent read-only work by issuing multiple foreground Agent calls in the same turn; Pi submits the batch concurrently and the configured root limit controls execution.

AgentContinue reuses a finished session; send new instructions plus unseen parent/peer evidence. Running, queued, stopped, aborted, or failed agents cannot be continued.

For external APIs, lifecycle/concurrency ordering, and integrations, require installed or upstream evidence and a representative real sequence; synthetic mocks alone are insufficient for critical paths.

Do not repeat broad review by default. If repeated review is justified, set acceptance criteria and a blocker bar, and validate findings without scope expansion. After two independent no-blocker reviews and no material change, stop unless checks fail or new evidence appears.
Agents: \`reviewer\` — Review changes carefully.; \`shipper\` — Prepare release notes
${ORCHESTRATION_PROMPT_END_MARKER}`);

    registerAgents(new Map([["reviewer", agent("reviewer", "Review changes carefully.")]]), { disableDefaultAgents: true });
    expect(buildOrchestrationPrompt(getAvailableAgents())).not.toContain("shipper");
  });

  it("keeps every bundled role visible within the parent prompt budget", () => {
    const prompt = buildOrchestrationPrompt(DEFAULT_AGENTS.values())!;

    for (const name of DEFAULT_AGENTS.keys()) expect(prompt).toContain(`\`${name}\` —`);
    expect(prompt).not.toContain("omitted");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH - 1024);
  });

  it("keeps bundled and custom roles visible within the expanded catalog capacity", () => {
    const customAgents = Array.from({ length: 10 }, (_, i) =>
      agent(`custom-${i.toString().padStart(2, "0")}`, `Specialized role ${i} for bounded project work.`),
    );
    const agents = [...DEFAULT_AGENTS.values(), ...customAgents];
    const prompt = buildOrchestrationPrompt(agents)!;

    for (const { name } of agents) expect(prompt).toContain(`\`${name}\` —`);
    expect(prompt).not.toContain("omitted");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
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
    const updated = getOrchestrationPromptUpdate(base, true, agents)!;
    expect(updated).toContain(`${ORCHESTRATION_PROMPT_MARKER}\nuser text`);
    expect(updated.match(new RegExp(ORCHESTRATION_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(2);

    const withUnmatchedEnd = `Base\n${ORCHESTRATION_PROMPT_END_MARKER}`;
    expect(getOrchestrationPromptUpdate(withUnmatchedEnd, true, agents)).toContain(withUnmatchedEnd);

    const generated = buildOrchestrationPrompt(agents)!;
    expect(getOrchestrationPromptUpdate(`Base\n\n${generated}`, false, agents)).toBe("Base");
    const replaced = getOrchestrationPromptUpdate(`Base\n\n${generated}`, true, agents);
    expect(replaced).toBeUndefined();
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
    expect(getOrchestrationPromptUpdate(`Inherited\n\n${changedRulesBlock}`, false, [])).toBe("Inherited");
  });
});
