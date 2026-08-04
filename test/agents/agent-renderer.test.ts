import { describe, expect, it, vi } from "vitest";
import {
  AGENT_RENDER_DETAILS_KEY,
  AgentCallDetailsComponent,
  formatAgentCallText,
  formatAgentContinueCallText,
  formatAgentUsageLine,
  formatStopAgentCallText,
  renderAgentCall,
  renderAgentContinueCall,
  renderAgentResult,
  renderStopAgentCall,
  renderSubagentResult,
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

const completeUsageDetails = {
  input: 6_800,
  output: 487,
  cacheRead: 8_200,
  cacheWrite: 0,
  latestCacheHitRate: 83.4,
  cost: 0.053,
  contextPercent: 2.1,
  contextWindow: 272_000,
  autoCompactionEnabled: true,
  usingSubscription: true,
};

describe("Agent call renderer", () => {
  it("formats AgentContinue with the requested ID before hydration", () => {
    const prompt = "First line\nSecond line with Unicode: 日本語 🚀\nFinal line";
    const ctx = context({ agent_id: "abc12345", prompt });

    const component = renderAgentContinueCall(ctx.args, theme, ctx);

    expect(visibleLines(component)).toEqual([
      "Agent ID: abc12345 | Role: — | Model: — | Thinking: — | Mode: Foreground | Run: Continued",
      "",
      "Prompt:",
      "First line",
      "Second line with Unicode: 日本語 🚀",
      "Final line",
    ]);
    expect(formatAgentContinueCallText(undefined, ctx.args)).toBe(
      `Agent ID: abc12345 | Role: — | Model: — | Thinking: — | Mode: Foreground | Run: Continued\n\nPrompt:\n${prompt}`,
    );
  });

  it("formats background Agent and AgentContinue calls consistently", () => {
    expect(formatAgentCallText(undefined, {
      agent: "scout",
      prompt: "inspect",
      run_in_background: true,
    })).toBe(
      "Role: scout | Model: — | Thinking: — | Mode: Background | Run: New\n\nPrompt:\ninspect",
    );
    expect(formatAgentContinueCallText(undefined, {
      agent_id: "abc12345",
      prompt: "continue",
      run_in_background: true,
    })).toBe(
      "Agent ID: abc12345 | Role: — | Model: — | Thinking: — | Mode: Background | Run: Continued\n\nPrompt:\ncontinue",
    );
  });

  it("formats StopAgent without a prompt line", () => {
    const ctx = context({ agent_id: "prefix" });
    const component = renderStopAgentCall(ctx.args, theme, ctx);

    expect(visibleLines(component)).toEqual([
      "Agent ID: prefix | Role: — | Model: — | Thinking: —",
    ]);
    expect(formatStopAgentCallText(undefined, ctx.args)).toBe(
      "Agent ID: prefix | Role: — | Model: — | Thinking: —",
    );
  });

  it("uses the canonical full ID and record metadata after control-row hydration", () => {
    const prompt = "continue with all findings";
    const ctx = context({ agent_id: "abc12345", prompt });
    const initial = renderAgentContinueCall(ctx.args, theme, ctx);
    ctx.lastComponent = initial;

    renderAgentResult(
      {
        content: [{ type: "text", text: "continued" }],
        details: {
          [AGENT_RENDER_DETAILS_KEY]: {
            agentId: "abc1234567890full",
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

    const hydrated = renderAgentContinueCall(ctx.args, theme, { ...ctx, lastComponent: initial });
    expect(visibleLines(hydrated)).toEqual([
      "Agent ID: abc1234567890full | Role: reviewer | Model: anthropic/claude-sonnet-4 | Thinking: high | Mode: Foreground | Run: Continued",
      "",
      "Prompt:",
      prompt,
    ]);
  });

  it("uses the metadata/prompt format and preserves the full multiline prompt", () => {
    const prompt = "First line\nSecond line with Unicode: 日本語 🚀\nFinal line";
    const ctx = context({ agent: "reviewer", prompt });

    const component = renderAgentCall(ctx.args, theme, ctx);

    expect(component).toBeInstanceOf(AgentCallDetailsComponent);
    expect(visibleLines(component)).toEqual([
      "Role: reviewer | Model: — | Thinking: — | Mode: Foreground | Run: New",
      "",
      "Prompt:",
      "First line",
      "Second line with Unicode: 日本語 🚀",
      "Final line",
    ]);
    expect(formatAgentCallText(undefined, ctx.args)).toBe(
      `Role: reviewer | Model: — | Thinking: — | Mode: Foreground | Run: New\n\nPrompt:\n${prompt}`,
    );
  });

  it("wraps long Unicode/plaintext without truncating it", () => {
    const prompt = "A very long prompt with 日本語 and 👩‍💻 that must remain complete";
    const ctx = context({ agent: "scout", prompt });
    const component = renderAgentCall(ctx.args, theme, ctx);
    const lines = visibleLines(component, 24);
    const renderedPrompt = lines.slice(3).join(" ").replace(/\s+/gu, " ").trim();

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

  it("renders the compact Pi usage line after a completed foreground result", () => {
    const result = {
      content: [{ type: "text", text: "agent output" }],
      details: completeUsageDetails,
    };
    const component = renderAgentResult(result, { isPartial: false }, theme, context());

    expect(visibleLines(component)).toEqual([
      "agent output",
      "",
      "↑6.8k ↓487 R8.2k CH83.4% $0.053 (sub) 2.1%/272k (auto)",
    ]);
    expect(result.content).toEqual([{ type: "text", text: "agent output" }]);
    expect(formatAgentUsageLine({ ...completeUsageDetails, cacheWrite: 1_536 }))
      .toBe("↑6.8k ↓487 R8.2k W1.5k CH83.4% $0.053 (sub) 2.1%/272k (auto)");
  });

  it("normalizes footer spacing without adding a gap when no footer exists", () => {
    const withFooter = renderAgentResult(
      { content: [{ type: "text", text: "answer\n" }], details: completeUsageDetails },
      { isPartial: false },
      theme,
      context(),
    );
    expect(visibleLines(withFooter)).toEqual([
      "answer",
      "",
      "↑6.8k ↓487 R8.2k CH83.4% $0.053 (sub) 2.1%/272k (auto)",
    ]);

    const withoutFooter = renderAgentResult(
      { content: [{ type: "text", text: "answer" }], details: undefined },
      { isPartial: false },
      theme,
      context(),
    );
    expect(visibleLines(withoutFooter)).toEqual(["answer"]);
  });

  it("uses ? for a null context sample and waits for the completed result", () => {
    const details = { ...completeUsageDetails, contextPercent: null, autoCompactionEnabled: false };
    const ctx = context();
    const partial = renderAgentResult(
      { content: [{ type: "text", text: "streaming" }], details },
      { isPartial: true },
      theme,
      ctx,
    );
    expect(visibleLines(partial)).toEqual(["streaming"]);

    const complete = renderAgentResult(
      { content: [{ type: "text", text: "done" }], details },
      { isPartial: false },
      theme,
      ctx,
    );
    expect(visibleLines(complete)).toEqual([
      "done",
      "",
      "↑6.8k ↓487 R8.2k CH83.4% $0.053 (sub) ?/272k",
    ]);
  });

  it("does not render usage for start/control results without stats", () => {
    const component = renderAgentResult(
      {
        content: [{ type: "text", text: "Agent running" }],
        details: {
          [AGENT_RENDER_DETAILS_KEY]: {
            role: "scout",
            prompt: "search",
          },
        },
      },
      { isPartial: false },
      theme,
      context(),
    );

    expect(visibleLines(component)).toEqual(["Agent running"]);
    expect(formatAgentUsageLine(undefined)).toBeUndefined();
    expect(formatAgentUsageLine({ role: "scout", prompt: "search" })).toBeUndefined();
  });

  it("uses the same footer renderer for background subagent-result messages", () => {
    const content = "[Subagent \"scout\" abc completed]\n\nResponse:\nbackground output";
    const message = {
      customType: "subagent-result",
      content,
      display: true,
      details: completeUsageDetails,
    };
    const component = renderSubagentResult(message, { expanded: false, outputPad: 1 }, theme);

    expect(visibleLines(component)).toEqual([
      "[Subagent \"scout\" abc completed]",
      "",
      "Response:",
      "background output",
      "",
      "↑6.8k ↓487 R8.2k CH83.4% $0.053 (sub) 2.1%/272k (auto)",
    ]);
    expect(message.content).toBe(content);
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
      "Role: reviewer | Model: anthropic/claude-sonnet-4 | Thinking: high | Mode: Foreground | Run: New",
      "",
      "Prompt:",
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

    expect(visibleLines(firstCall)[0]).toBe("Role: first | Model: — | Thinking: — | Mode: Foreground | Run: New");
    expect(visibleLines(secondCall)[0]).toBe("Role: second | Model: — | Thinking: — | Mode: Foreground | Run: New");
    expect(first.state[AGENT_RENDER_DETAILS_KEY]).toBeUndefined();
    expect(second.state[AGENT_RENDER_DETAILS_KEY]).toBeUndefined();
  });
});
