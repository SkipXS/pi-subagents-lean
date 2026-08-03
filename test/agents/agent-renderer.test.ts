import { describe, expect, it, vi } from "vitest";
import {
  AGENT_RENDER_DETAILS_KEY,
  AgentCallDetailsComponent,
  formatAgentCallText,
  renderAgentCall,
  renderAgentResult,
  visibleWidth,
} from "../../src/agents/agent-renderer.js";

const theme = { fg: (_name: string, text: string) => text };

function context(args: unknown = {}): any {
  return {
    args,
    state: {},
    lastComponent: undefined,
    invalidate: vi.fn(),
  };
}

function visibleLines(component: { render(width: number): string[] }, width = 200): string[] {
  return component.render(width).map((line) => line.replace(/\s+$/u, ""));
}

describe("Agent call renderer", () => {
  it("uses the exact two-part format and preserves the full multiline prompt", () => {
    const prompt = "First line\nSecond line with Unicode: 日本語 🚀\nFinal line";
    const ctx = context({ agent: "reviewer", prompt });

    const component = renderAgentCall(ctx.args, theme, ctx);

    expect(component).toBeInstanceOf(AgentCallDetailsComponent);
    expect(visibleLines(component)).toEqual([
      "Rolle: reviewer | Modell: — | Thinking: —",
      "First line",
      "Second line with Unicode: 日本語 🚀",
      "Final line",
    ]);
    expect(formatAgentCallText(undefined, ctx.args)).toBe(
      `Rolle: reviewer | Modell: — | Thinking: —\n${prompt}`,
    );
  });

  it("wraps long Unicode/plaintext without truncating it", () => {
    const prompt = "A very long prompt with 日本語 and 👩‍💻 that must remain complete";
    const ctx = context({ agent: "scout", prompt });
    const component = renderAgentCall(ctx.args, theme, ctx);
    const lines = visibleLines(component, 24);
    const renderedPrompt = lines.slice(1).join(" ").replace(/\s+/gu, " ").trim();

    expect(renderedPrompt).toContain(prompt.replace(/\s+/gu, " "));
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("conservatively counts flags and keycaps as two cells at wrap boundaries", () => {
    expect(visibleWidth("🇩🇪")).toBe(2);
    expect(visibleWidth("1️⃣")).toBe(2);

    const component = new AgentCallDetailsComponent();
    component.setText("abc🇩🇪x\nabc1️⃣x");
    const lines = component.render(4);
    expect(lines).toEqual(["abc", "🇩🇪x", "abc", "1️⃣x"]);
    expect(lines.every((line) => visibleWidth(line) <= 4)).toBe(true);
  });

  it("escapes C0, DEL, OSC, and CSI controls while retaining Unicode and visible escapes", () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const c1Csi = String.fromCharCode(0x9b);
    const cr = String.fromCharCode(0x0d);
    const tab = String.fromCharCode(0x09);
    const nul = String.fromCharCode(0x00);
    const del = String.fromCharCode(0x7f);
    const text = formatAgentCallText({
      role: `role${esc}]52;c;secret${bel}`,
      model: `provider/${esc}[31mmodel`,
      thinking: `high${c1Csi}31m`,
      prompt: `before${esc}]52;c;secret${bel}${cr}${tab}${nul}${del}\n日本語`,
    });

    expect(text).not.toContain(esc);
    expect(text).not.toContain(bel);
    expect(text).not.toContain(c1Csi);
    expect(text).toContain("\\x1b");
    expect(text).toContain("\\x07");
    expect(text).toContain("\\x9b");
    expect(text).toContain("\\r");
    expect(text).toContain("\\t");
    expect(text).toContain("\\x00");
    expect(text).toContain("\\x7f");
    expect(text).toContain("日本語");
    expect([...text].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0x0a || (codePoint > 0x1f && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f));
    })).toBe(true);
  });

  it("hydrates canonical role, actual provider/id, normalized thinking, and prompt from result details", () => {
    const prompt = "inspect\nall files";
    const ctx = context({ agent: "Review Alias", prompt: "raw" });
    const initial = renderAgentCall(ctx.args, theme, ctx);
    ctx.lastComponent = initial;

    const resultComponent = renderAgentResult(
      {
        content: [{ type: "text", text: "agent output" }],
        details: {
          [AGENT_RENDER_DETAILS_KEY]: {
            role: "reviewer",
            model: "anthropic/claude-sonnet-4",
            thinking: "high",
            prompt,
          },
        },
      },
      { isPartial: true, expanded: false },
      theme,
      { ...ctx, lastComponent: undefined },
    );

    const hydrated = renderAgentCall(ctx.args, theme, { ...ctx, lastComponent: initial });
    expect(visibleLines(hydrated)).toEqual([
      "Rolle: reviewer | Modell: anthropic/claude-sonnet-4 | Thinking: high",
      "inspect",
      "all files",
    ]);
    expect(visibleLines(resultComponent)).toEqual(["agent output"]);
    expect(ctx.state[AGENT_RENDER_DETAILS_KEY]).toMatchObject({ role: "reviewer", model: "anthropic/claude-sonnet-4", thinking: "high", prompt });
  });

  it("invalidates once for a metadata change and not for repeated partial/final updates", () => {
    const ctx = context({ agent: "scout", prompt: "do it" });
    const details = {
      [AGENT_RENDER_DETAILS_KEY]: {
        role: "scout",
        model: "openai/gpt-4o",
        thinking: "medium",
        prompt: "do it",
      },
    };

    renderAgentResult({ content: [], details }, { isPartial: true }, theme, ctx);
    renderAgentResult({ content: [], details }, { isPartial: false }, theme, ctx);

    expect(ctx.invalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps contexts row-local and remains defensive for early/error results", () => {
    const first = context({ agent: "first", prompt: "one" });
    const second = context({ agent: "second", prompt: "two" });
    const firstCall = renderAgentCall(first.args, theme, first);
    const secondCall = renderAgentCall(second.args, theme, second);

    renderAgentResult({ content: [], details: undefined }, { isPartial: false }, theme, first);

    expect(visibleLines(firstCall)[0]).toBe("Rolle: first | Modell: — | Thinking: —");
    expect(visibleLines(secondCall)[0]).toBe("Rolle: second | Modell: — | Thinking: —");
    expect(first.state[AGENT_RENDER_DETAILS_KEY]).toBeUndefined();
    expect(second.state[AGENT_RENDER_DETAILS_KEY]).toBeUndefined();
  });
});
