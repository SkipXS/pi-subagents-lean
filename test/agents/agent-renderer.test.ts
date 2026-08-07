import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RENDER_DETAILS_KEY,
  AgentCallDetailsComponent,
  renderAgentCall,
  renderAgentContinueCall,
  AGENT_WORKING_SPINNER_FRAMES,
  AGENT_WORKING_SPINNER_INTERVAL_MS,
  renderAgentResult,
  renderStopAgentCall,
  renderSubagentResult,
  stopAgentRendererTimers,
} from "../../src/agents/agent-renderer.js";

const theme = { fg: (_name: string, text: string) => text };

function context(
  args: unknown = {},
  lifecycle: { executionStarted?: boolean; isPartial?: boolean; isError?: boolean } = {},
): any {
  return {
    args,
    state: {},
    lastComponent: undefined,
    invalidate: vi.fn(),
    ...lifecycle,
  };
}

function interactiveContext(
  args: unknown,
  render: (args: unknown, theme: unknown, context: any) => unknown = renderAgentCall,
): any {
  const ctx = context(args, { executionStarted: false, isPartial: true });
  ctx.invalidate = vi.fn(() => render(ctx.args, theme, ctx));
  return ctx;
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

afterEach(() => {
  stopAgentRendererTimers();
  vi.useRealTimers();
});

describe("Agent call renderer", () => {
  it("formats AgentContinue with the requested ID before hydration", () => {
    const prompt = "First line\nSecond line with Unicode: 日本語 🚀\nFinal line";
    const ctx = context({ agent_id: "abc12345", prompt });

    const component = renderAgentContinueCall(ctx.args, theme, ctx);

    expect(visibleLines(component)).toEqual([
      "Role: — | Agent ID: abc12345 | Model: — | Thinking: — | Mode: Foreground | Run: Continued",
      "",
      "Prompt:",
      "First line",
      "Second line with Unicode: 日本語 🚀",
      "Final line",
    ]);
  });

  it("formats StopAgent without a prompt line", () => {
    const ctx = context({ agent_id: "prefix" });
    const component = renderStopAgentCall(ctx.args, theme, ctx);

    expect(visibleLines(component)).toEqual([
      "Role: — | Agent ID: prefix | Model: — | Thinking: — | Mode: — | Run: —",
    ]);
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
      "Role: reviewer | Agent ID: abc1234567890full | Model: anthropic/claude-sonnet-4 | Thinking: high | Mode: Foreground | Run: Continued",
      "",
      "Prompt:",
      prompt,
    ]);
  });

  it("omits a new Agent ID initially and hydrates its canonical ID after acceptance", () => {
    const prompt = "start the task";
    const ctx = context({ agent: "scout", prompt });
    const initial = renderAgentCall(ctx.args, theme, ctx);

    expect(visibleLines(initial)[0]).toBe(
      "Role: scout | Model: — | Thinking: — | Mode: Foreground | Run: New",
    );
    expect(visibleLines(initial)[0]).not.toContain("Agent ID:");
    expect(visibleLines(initial)[0]).not.toContain("pending");

    renderAgentResult(
      {
        content: [{ type: "text", text: "accepted" }],
        details: {
          [AGENT_RENDER_DETAILS_KEY]: {
            role: "scout",
            agentId: "1234567890abcdef",
            model: "openai/gpt-4o",
            thinking: "high",
            prompt,
            mode: "foreground",
            kind: "new",
          },
        },
      },
      { isPartial: true, expanded: false },
      theme,
      { ...ctx, lastComponent: undefined },
    );

    const hydrated = renderAgentCall(ctx.args, theme, { ...ctx, lastComponent: initial });
    expect(visibleLines(hydrated)[0]).toBe(
      "Role: scout | Agent ID: 1234567890abcdef | Model: openai/gpt-4o | Thinking: high | Mode: Foreground | Run: New",
    );
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

  it("uses Pi's exact working spinner frames and interval only for open foreground executions", () => {
    vi.useFakeTimers();
    expect(AGENT_WORKING_SPINNER_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
    expect(AGENT_WORKING_SPINNER_INTERVAL_MS).toBe(80);

    const ctx = interactiveContext({ agent: "scout", prompt: "inspect" });
    const unopened = renderAgentCall(ctx.args, theme, ctx);
    ctx.lastComponent = unopened;
    ctx.executionStarted = true;
    const call = renderAgentCall(ctx.args, theme, ctx);
    ctx.invalidate.mockClear();
    expect(visibleLines(call)[0]).toBe("⠋ Role: scout | Model: — | Thinking: — | Mode: Foreground | Run: New");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(AGENT_WORKING_SPINNER_INTERVAL_MS);
    expect(ctx.invalidate).toHaveBeenCalledOnce();
    const secondFrame = renderAgentCall(ctx.args, theme, { ...ctx, lastComponent: call });
    expect(visibleLines(secondFrame)[0]).toBe("⠙ Role: scout | Model: — | Thinking: — | Mode: Foreground | Run: New");

    renderAgentResult(
      { content: [{ type: "text", text: "done" }] },
      { isPartial: false },
      theme,
      { ...ctx, lastComponent: undefined, isPartial: false },
      "Agent",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(visibleLines(call)[0]).toBe("✓ Role: scout | Model: — | Thinking: — | Mode: Foreground | Run: New");
  });

  it("does not animate background acknowledgements or pre-execution rows", () => {
    vi.useFakeTimers();
    const background = context(
      { agent: "scout", prompt: "inspect", run_in_background: true },
      { executionStarted: true, isPartial: true },
    );
    const backgroundCall = renderAgentCall(background.args, theme, background);
    expect(visibleLines(backgroundCall)[0]).toBe("Role: scout | Model: — | Thinking: — | Mode: Background | Run: New");
    expect(vi.getTimerCount()).toBe(0);

    renderAgentResult(
      { content: [{ type: "text", text: "ack" }] },
      { isPartial: false },
      theme,
      { ...background, lastComponent: undefined, isPartial: false },
      "Agent",
    );
    expect(visibleLines(backgroundCall)[0]).toBe("● Role: scout | Model: — | Thinking: — | Mode: Background | Run: New");
    expect(visibleLines(backgroundCall)[0]).not.toContain("◷");

    renderAgentResult(
      { content: [{ type: "text", text: "queued" }], details: { status: "queued" } },
      { isPartial: false },
      theme,
      { ...background, lastComponent: undefined, isPartial: false },
      "Agent",
    );
    expect(visibleLines(backgroundCall)[0]).toBe("◷ Role: scout | Model: — | Thinking: — | Mode: Background | Run: New");
    expect(vi.getTimerCount()).toBe(0);

    const beforeStart = context(
      { agent: "scout", prompt: "inspect" },
      { executionStarted: false, isPartial: true },
    );
    const beforeStartCall = renderAgentCall(beforeStart.args, theme, beforeStart);
    expect(visibleLines(beforeStartCall)[0]).toBe("Role: scout | Model: — | Thinking: — | Mode: Foreground | Run: New");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a static error marker and stops on abort, including component replacement", () => {
    vi.useFakeTimers();
    const ctx = interactiveContext(
      { agent_id: "agent", prompt: "continue", run_in_background: false },
      renderAgentContinueCall,
    );
    const unopened = renderAgentContinueCall(ctx.args, theme, ctx);
    ctx.lastComponent = unopened;
    ctx.executionStarted = true;
    const call = renderAgentContinueCall(ctx.args, theme, ctx);
    expect(vi.getTimerCount()).toBe(1);

    const replacement = renderAgentContinueCall(ctx.args, theme, {
      ...ctx,
      lastComponent: new AgentCallDetailsComponent(),
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(visibleLines(replacement)[0]).toBe("Role: — | Agent ID: agent | Model: — | Thinking: — | Mode: Foreground | Run: Continued");

    // A fresh row proves the terminal error path independently of the
    // component-replacement cleanup above.
    const aborted = interactiveContext({ agent: "scout", prompt: "abort me" });
    const unopenedAborted = renderAgentCall(aborted.args, theme, aborted);
    aborted.lastComponent = unopenedAborted;
    aborted.executionStarted = true;
    const abortedCall = renderAgentCall(aborted.args, theme, aborted);
    renderAgentResult(
      { content: [{ type: "text", text: "cancelled" }], details: { status: "aborted" } },
      { isPartial: false },
      theme,
      { ...aborted, lastComponent: undefined, isPartial: false, isError: false },
      "Agent",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(visibleLines(abortedCall)[0]).toBe("✗ Role: scout | Model: — | Thinking: — | Mode: Foreground | Run: New");
    expect(call).toBeInstanceOf(AgentCallDetailsComponent);
  });

  it("keeps contexts row-local and remains defensive for early/error results", () => {
    const first = context({ agent: "first", prompt: "one" });
    const second = context({ agent: "second", prompt: "two" });
    const firstCall = renderAgentCall(first.args, theme, first);
    const secondCall = renderAgentCall(second.args, theme, second);

    renderAgentResult({ content: [], details: undefined }, { isPartial: false }, theme, first);

    expect(visibleLines(firstCall)[0]).toBe("✓ Role: first | Model: — | Thinking: — | Mode: Foreground | Run: New");
    expect(visibleLines(secondCall)[0]).toBe("Role: second | Model: — | Thinking: — | Mode: Foreground | Run: New");
    expect(first.state[AGENT_RENDER_DETAILS_KEY]).toBeUndefined();
    expect(second.state[AGENT_RENDER_DETAILS_KEY]).toBeUndefined();
  });
});
