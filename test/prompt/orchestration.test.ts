import { describe, expect, it } from "vitest";
import { getAvailableAgents, getAvailableTypes, registerAgents } from "../../src/agents/agent-types.ts";
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
Prefer delegation for substantive work, but handle small, obvious, low-risk tasks directly when that is clearly more efficient.

You may work directly when the relevant scope is already known, no meaningful design decision or investigation is required, and the task can be completed safely in a few focused tool calls. This includes targeted reads, simple fact checks, minor single-location edits, result synthesis, and small follow-up adjustments.

Delegate when work requires broad repository discovery, focused root-cause investigation, cross-component design, multiple or uncertain changes, independent review, or substantial verification. If the scope or risk is unclear, delegate to the matching agent.

Your responsibilities are routing, sequencing dependent work, running independent read-only work in parallel, reconciling results, resolving decisions, completing small remaining steps, and producing the final response.

Use bounded, outcome-focused briefs. Give each agent the relevant goal, scope, constraints, known evidence, and expected result without prescribing unnecessary implementation details.

The orchestrator owns planning and decomposition. For large or complex tasks, do not pass the whole request to one agent as an unbounded package. Use appropriate agents to investigate scope and dependencies, then split the work into bounded, cohesive stages with clear outcomes. The orchestrator sequences handoffs, prevents overlap, and remains responsible for integration and validation.

Do not duplicate work already delegated. Inspect or modify the same area yourself only when an agent result is incomplete, conflicting, or leaves a clearly bounded follow-up.

Treat writer delegation as a bounded trial. Allow the same writer at most one focused correction in a subsystem. If a material issue remains, needs redesign, or you understand the fix better, take over directly or re-plan with a new owner.

For external APIs, lifecycle or concurrency ordering, and integration behavior, require installed or upstream evidence plus a representative real sequence; critical paths cannot rely only on synthetic mocks.

Before repeated reviews, set acceptance criteria and the blocker bar. Validate findings without automatic scope expansion. After two independent no-blocker reviews and no material code change, stop broad re-review unless checks fail or new evidence appears.

Use only the roles required for the task. Do not force an unnecessary full agent pipeline.

Run dependent work in the foreground. Independent read-only work may run in the background. Never run concurrent writers or allow overlapping repository changes.

After starting a background agent, continue only with independent useful work; never poll its status or run sleep/no-op commands to wait. Resume dependent work only after its automatic completion notification.

Continue finished agents with AgentContinue to reuse their session; run_in_background returns immediately, while running, queued, stopped, aborted, or failed agents cannot be continued.

Retain responsibility for the overall task and final answer. Delegate the substantial specialist work, but directly complete trivial or tightly bounded work when delegation would add more overhead than value.
Agents: \`reviewer\` — Review changes carefully.; \`shipper\` — Prepare release notes
${ORCHESTRATION_PROMPT_END_MARKER}`);

    registerAgents(new Map([["reviewer", agent("reviewer", "Review changes carefully.")]]), { disableDefaultAgents: true });
    expect(buildOrchestrationPrompt(getAvailableAgents())).not.toContain("shipper");
  });

  it("keeps every bundled role visible within the parent prompt budget", () => {
    const prompt = buildOrchestrationPrompt(DEFAULT_AGENTS.values())!;

    for (const name of DEFAULT_AGENTS.keys()) expect(prompt).toContain(`\`${name}\` —`);
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

  it("preserves built-in and registry/UI insertion order while sorting only the catalog", () => {
    registerAgents(new Map([["reviewer", agent("reviewer", "Reviews")]]));
    expect(getAvailableTypes()).toEqual(["architect", "scout", "implementer", "reviewer", "verifier"]);

    // The catalog itself is sorted below for prompt cache stability.

    const firstRegistry = new Map([
      ["zebra", agent("zebra", "Last alphabetically")],
      ["alpha", agent("alpha", "First alphabetically")],
    ]);
    const secondRegistry = new Map([...firstRegistry.entries()].reverse());

    registerAgents(firstRegistry, { disableDefaultAgents: true });
    const firstPrompt = buildOrchestrationPrompt(getAvailableAgents());
    expect(getAvailableTypes()).toEqual(["zebra", "alpha"]);

    registerAgents(secondRegistry, { disableDefaultAgents: true });
    expect(buildOrchestrationPrompt(getAvailableAgents())).toBe(firstPrompt);
    expect(getAvailableTypes()).toEqual(["alpha", "zebra"]);
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
