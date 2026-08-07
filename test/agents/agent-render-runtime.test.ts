import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAgentCallText } from "../../src/agents/agent-render-format.js";
import {
  AGENT_WORKING_SPINNER_FRAMES,
  AGENT_WORKING_SPINNER_INTERVAL_MS,
  getAgentRendererState,
  renderCallWithFormatter,
  runtimeFor,
  stopAgentRendererTimers,
  type AgentRendererContext,
} from "../../src/agents/agent-render-runtime.js";

function context(
  args: unknown = {},
  lifecycle: Pick<AgentRendererContext, "executionStarted" | "isPartial" | "isError"> = {},
): AgentRendererContext {
  return {
    args,
    state: {},
    lastComponent: undefined,
    invalidate: vi.fn(),
    ...lifecycle,
  };
}

afterEach(() => {
  stopAgentRendererTimers();
  vi.useRealTimers();
});

describe("Agent render runtime boundary", () => {
  it("keeps one WeakMap runtime per row state and no state across rows", () => {
    const first = context({ agent: "first", prompt: "one" });
    const second = context({ agent: "second", prompt: "two" });

    expect(runtimeFor(first)).toBe(runtimeFor(first));
    expect(runtimeFor(first)).not.toBe(runtimeFor(second));
    expect(getAgentRendererState(first)).toEqual({ version: 0, callVersion: -1, indicator: "" });
    expect(getAgentRendererState(second)).toEqual({ version: 0, callVersion: -1, indicator: "" });
  });

  it("keeps noninteractive/direct rows timer-free after capability probing", () => {
    vi.useFakeTimers();
    const row = context(
      { agent: "scout", prompt: "inspect" },
      { executionStarted: false, isPartial: true },
    );

    const component = renderCallWithFormatter("Agent", row.args, row, formatAgentCallText);
    expect(component.render(200)[0]).toContain("Role: scout");
    expect(vi.getTimerCount()).toBe(0);
    expect(runtimeFor(row).capability).toBe("noninteractive");
  });

  it("starts, advances, and shuts down only the interactive spinner", () => {
    vi.useFakeTimers();
    expect(AGENT_WORKING_SPINNER_FRAMES[0]).toBe("⠋");
    expect(AGENT_WORKING_SPINNER_INTERVAL_MS).toBe(80);

    const row = context(
      { agent: "scout", prompt: "inspect" },
      { executionStarted: false, isPartial: true },
    );
    row.invalidate = vi.fn(() => {
      renderCallWithFormatter("Agent", row.args, row, formatAgentCallText);
    });

    const unopened = renderCallWithFormatter("Agent", row.args, row, formatAgentCallText);
    row.lastComponent = unopened;
    row.executionStarted = true;
    const call = renderCallWithFormatter("Agent", row.args, row, formatAgentCallText);

    expect(call.render(200)[0]).toContain("⠋ Role: scout");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(AGENT_WORKING_SPINNER_INTERVAL_MS);
    expect(row.invalidate).toHaveBeenCalled();
    expect(call.render(200)[0]).toContain("⠙ Role: scout");

    stopAgentRendererTimers();
    expect(vi.getTimerCount()).toBe(0);
    expect(call.render(200)[0]).toContain("Role: scout");
    expect(call.render(200)[0]).not.toContain("⠙");
  });
});
