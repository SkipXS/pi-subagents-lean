import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RENDER_DETAILS_KEY,
  AgentCallDetailsComponent,
  renderAgentCall,
  renderAgentContinueCall,
  renderAgentResult,
} from "../../src/agents/agent-renderer.js";

const theme = { fg: (_name: string, text: string) => text };

function context(args: unknown = {}, lifecycle: { isError?: boolean } = {}): any {
  return { args, state: {}, lastComponent: undefined, invalidate: vi.fn(), ...lifecycle };
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

  it("uses only authoritative queued status and keeps the four-argument result seam", () => {
    const ctx = context({ agent: "scout", prompt: "queued" });
    const call = renderAgentCall(ctx.args, theme, ctx);
    renderAgentResult(
      { content: [{ type: "text", text: "queued" }], details: { status: "queued" } },
      { isPartial: false }, theme, { ...ctx, lastComponent: undefined },
    );
    expect(lines(call)[0]).toContain("◷");
    expect(lines(call)[0]).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
  });

  it("keeps open rows static and uses terminal markers for success, error, and abort", () => {
    vi.useFakeTimers();
    const ctx = context({ agent: "scout", prompt: "inspect" });
    const call = renderAgentCall(ctx.args, theme, ctx);
    expect(lines(call)[0]).toBe("Role: scout | Model: — | Thinking: — | Run: New");
    expect(vi.getTimerCount()).toBe(0);

    renderAgentResult(
      { content: [{ type: "text", text: "done" }] },
      { isPartial: false }, theme, { ...ctx, lastComponent: undefined }, "Agent",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(lines(call)[0]).toContain("✓ Role: scout");

    const errorContext = context({ agent: "reviewer", prompt: "stop" });
    const errorCall = renderAgentCall(errorContext.args, theme, errorContext);
    renderAgentResult(
      { content: [{ type: "text", text: "cancelled" }], details: { status: "aborted" } },
      { isPartial: false }, theme, { ...errorContext, lastComponent: undefined, isError: true }, "Agent",
    );
    expect(lines(errorCall)[0]).toContain("✗ Role: reviewer");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores the authoritative static marker on a later row render", () => {
    const ctx = context({ agent_id: "agent-full-id", prompt: "continue" });
    const call = renderAgentContinueCall(ctx.args, theme, ctx);
    renderAgentResult(
      { content: [], details: { currentExecution: { status: "queued" } } },
      { isPartial: false }, theme, { ...ctx, lastComponent: undefined }, "AgentContinue",
    );

    const restored = renderAgentContinueCall(ctx.args, theme, {
      ...ctx,
      lastComponent: undefined,
    });
    expect(restored).toBeInstanceOf(AgentCallDetailsComponent);
    expect(lines(call)[0]).toContain("◷ Role: — | Agent ID: agent-full-id");
    expect(lines(restored)[0]).toContain("◷ Role: — | Agent ID: agent-full-id");
  });

  it("hydrates metadata once with synchronous, asynchronous, no-op, and throwing invalidation", async () => {
    const modes = ["sync", "async", "noop", "throwing"] as const;
    const details = {
      [AGENT_RENDER_DETAILS_KEY]: {
        role: "reviewer",
        agentId: "canonical-full-id",
        model: "provider/model",
        thinking: "medium",
        prompt: "hydrated prompt",
        kind: "new",
      },
    };

    for (const mode of modes) {
      const ctx = context({ agent: "alias", prompt: "initial" });
      if (mode === "sync") {
        ctx.invalidate = vi.fn(() => {
          renderAgentCall(ctx.args, theme, ctx);
        });
      } else if (mode === "async") {
        ctx.invalidate = vi.fn(() => {
          queueMicrotask(() => renderAgentCall(ctx.args, theme, ctx));
        });
      } else if (mode === "throwing") {
        ctx.invalidate = vi.fn(() => {
          throw new Error("detached");
        });
      } else {
        ctx.invalidate = vi.fn();
      }

      const first = renderAgentResult(
        { content: [{ type: "text", text: "result" }], details },
        { isPartial: false }, theme, ctx, "Agent",
      );
      const second = renderAgentResult(
        { content: [{ type: "text", text: "result" }], details },
        { isPartial: false }, theme, ctx, "Agent",
      );
      await Promise.resolve();

      expect(ctx.invalidate, mode).toHaveBeenCalledOnce();
      expect(lines(second), mode).toEqual(["result"]);
      expect(lines(renderAgentCall(ctx.args, theme, { ...ctx, lastComponent: undefined }))[0], mode)
        .toContain("✓ Role: reviewer | Agent ID: canonical-full-id | Model: provider/model | Thinking: medium | Run: New");
      expect(lines(first).join("\n").match(/result/g) ?? []).toHaveLength(mode === "sync" ? 0 : 1);
    }
  });

  it("keeps row state isolated and terminal errors do not affect another row", () => {
    const first = context({ agent: "first", prompt: "one" });
    const second = context({ agent: "second", prompt: "two" });
    const firstCall = renderAgentCall(first.args, theme, first);
    const secondCall = renderAgentCall(second.args, theme, second);
    expect(firstCall).toBeInstanceOf(AgentCallDetailsComponent);
    expect(lines(secondCall)[0]).toContain("Role: second");

    renderAgentResult(
      { content: [{ type: "text", text: "cancelled" }], details: { status: "aborted" } },
      { isPartial: false }, theme, { ...first, lastComponent: undefined }, "Agent",
    );
    expect(lines(firstCall)[0]).toContain("✗ Role: first");
    expect(lines(secondCall)[0]).not.toContain("✗");
  });
});
