import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RENDER_DETAILS_KEY,
  AgentCallDetailsComponent,
  AGENT_WORKING_SPINNER_FRAMES,
  AGENT_WORKING_SPINNER_INTERVAL_MS,
  renderAgentCall,
  renderAgentContinueCall,
  renderAgentResult,
  stopAgentRendererTimers,
} from "../../src/agents/agent-renderer.js";

const theme = { fg: (_name: string, text: string) => text };

function context(
  args: unknown = {},
  lifecycle: { executionStarted?: boolean; isPartial?: boolean; isError?: boolean } = {},
): any {
  return { args, state: {}, lastComponent: undefined, invalidate: vi.fn(), ...lifecycle };
}

function interactiveContext(args: unknown, render: (args: unknown, theme: unknown, context: any) => unknown = renderAgentCall): any {
  const ctx = context(args, { executionStarted: false, isPartial: true });
  ctx.invalidate = vi.fn(() => render(ctx.args, theme, ctx));
  return ctx;
}

function lines(component: { render(width: number): string[] }, width = 240): string[] {
  return component.render(width).map((line) => line.replace(/\s+$/u, ""));
}

const usage = {
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

describe("Agent and AgentContinue row renderer", () => {
  it("renders New and Continued headers with canonical IDs and no mode field", () => {
    const continueContext = context({ agent_id: "abc12345", prompt: "continue" });
    expect(lines(renderAgentContinueCall(continueContext.args, theme, continueContext))).toEqual([
      "Role: — | Agent ID: abc12345 | Model: — | Thinking: — | Run: Continued",
      "",
      "Prompt:",
      "continue",
    ]);

    const newContext = context({ agent: "scout", prompt: "inspect" });
    expect(lines(renderAgentCall(newContext.args, theme, newContext))[0]).toBe(
      "Role: scout | Model: — | Thinking: — | Run: New",
    );

    renderAgentResult({
      content: [],
      details: { [AGENT_RENDER_DETAILS_KEY]: {
        role: "reviewer",
        agentId: "canonical-full-id",
        model: "provider/model",
        thinking: "high",
        prompt: "inspect",
        kind: "new",
      } },
    }, { isPartial: true }, theme, { ...newContext, lastComponent: undefined });
    expect(lines(renderAgentCall(newContext.args, theme, { ...newContext, lastComponent: undefined }))[0]).toBe(
      "Role: reviewer | Agent ID: canonical-full-id | Model: provider/model | Thinking: high | Run: New",
    );
  });

  it("preserves escaped prompts and renders complete usage results", () => {
    const esc = String.fromCharCode(0x1b);
    const ctx = context({ agent: "scout", prompt: `before${esc}\n日本語` });
    const call = renderAgentCall(ctx.args, theme, ctx);
    expect(lines(call).join("\n")).toContain("\\x1b");
    expect(lines(call).join("\n")).toContain("日本語");

    const result = renderAgentResult(
      { content: [{ type: "text", text: "answer\n" }], details: usage },
      { isPartial: false }, theme, context(),
    );
    expect(lines(result)).toEqual([
      "answer",
      "",
      "↑6.8k ↓487 R8.2k CH83.4% $0.053 (sub) 2.1%/272k (auto)",
    ]);
  });

  it("uses authoritative queued status and the four-argument result seam", () => {
    const ctx = context({ agent: "scout", prompt: "queued" });
    const call = renderAgentCall(ctx.args, theme, ctx);
    renderAgentResult(
      { content: [{ type: "text", text: "queued" }], details: { status: "queued" } },
      { isPartial: false }, theme, { ...ctx, lastComponent: undefined },
    );
    expect(lines(call)[0]).toContain("◷");
  });

  it("animates only an interactive open Agent row and stops safely on completion", () => {
    vi.useFakeTimers();
    expect(AGENT_WORKING_SPINNER_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
    expect(AGENT_WORKING_SPINNER_INTERVAL_MS).toBe(80);

    const ctx = interactiveContext({ agent: "scout", prompt: "inspect" });
    const unopened = renderAgentCall(ctx.args, theme, ctx);
    ctx.lastComponent = unopened;
    ctx.executionStarted = true;
    const call = renderAgentCall(ctx.args, theme, ctx);
    ctx.invalidate.mockClear();
    expect(lines(call)[0]).toContain("⠋ Role: scout");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(AGENT_WORKING_SPINNER_INTERVAL_MS);
    expect(ctx.invalidate).toHaveBeenCalledOnce();
    expect(lines(renderAgentCall(ctx.args, theme, { ...ctx, lastComponent: call }))[0]).toContain("⠙ Role: scout");

    renderAgentResult(
      { content: [{ type: "text", text: "done" }] },
      { isPartial: false }, theme, { ...ctx, lastComponent: undefined, isPartial: false }, "Agent",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(lines(call)[0]).toContain("✓ Role: scout");
  });

  it("stops a spinner when Pi replaces the active row component", () => {
    vi.useFakeTimers();
    const ctx = interactiveContext({ agent_id: "agent", prompt: "continue" }, renderAgentContinueCall);
    const unopened = renderAgentContinueCall(ctx.args, theme, ctx);
    ctx.lastComponent = unopened;
    ctx.executionStarted = true;
    const active = renderAgentContinueCall(ctx.args, theme, ctx);
    expect(vi.getTimerCount()).toBe(1);

    const replacement = renderAgentContinueCall(ctx.args, theme, {
      ...ctx,
      lastComponent: new AgentCallDetailsComponent(),
    });
    expect(replacement).toBeInstanceOf(AgentCallDetailsComponent);
    expect(vi.getTimerCount()).toBe(0);
    expect(lines(active)[0]).toContain("Role: — | Agent ID: agent");
  });

  it("never starts timers for headless rows and invalidates once per metadata generation", () => {
    vi.useFakeTimers();
    const headless = context({ agent: "scout", prompt: "headless" }, { executionStarted: true, isPartial: true });
    renderAgentCall(headless.args, theme, headless);
    expect(vi.getTimerCount()).toBe(0);

    headless.invalidate.mockClear();
    const details = {
      [AGENT_RENDER_DETAILS_KEY]: {
        role: "scout", model: "provider/model", thinking: "medium", prompt: "headless", kind: "new",
      },
    };
    renderAgentResult({ content: [], details }, { isPartial: true }, theme, headless);
    renderAgentResult({ content: [], details }, { isPartial: false }, theme, headless);
    expect(headless.invalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps row state isolated and handles terminal errors without a live timer", () => {
    vi.useFakeTimers();
    const first = interactiveContext({ agent: "first", prompt: "one" });
    const second = interactiveContext({ agent: "second", prompt: "two" });
    const firstCall = renderAgentCall(first.args, theme, first);
    const secondCall = renderAgentCall(second.args, theme, second);
    expect(firstCall).toBeInstanceOf(AgentCallDetailsComponent);
    expect(lines(secondCall)[0]).toContain("Role: second");

    first.lastComponent = firstCall;
    first.executionStarted = true;
    renderAgentCall(first.args, theme, first);
    renderAgentResult(
      { content: [{ type: "text", text: "cancelled" }], details: { status: "aborted" } },
      { isPartial: false }, theme, { ...first, lastComponent: undefined, isPartial: false }, "Agent",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(lines(firstCall)[0]).toContain("✗ Role: first");
    expect(lines(secondCall)[0]).not.toContain("✗");
  });
});
