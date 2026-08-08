import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAgentCallText, formatAgentContinueCallText } from "../../src/agents/agent-render-format.js";
import {
  getAgentRendererState,
  renderCallWithFormatter,
  runtimeFor,
  type AgentRendererContext,
} from "../../src/agents/agent-render-runtime.js";

function context(args: unknown = {}): AgentRendererContext {
  return {
    args,
    state: {},
    lastComponent: undefined,
    invalidate: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Agent render runtime boundary", () => {
  it("keeps one row runtime per state object and no state across rows", () => {
    const first = context({ agent: "first", prompt: "one" });
    const second = context({ agent: "second", prompt: "two" });

    expect(runtimeFor(first)).toBe(runtimeFor(first));
    expect(runtimeFor(first)).not.toBe(runtimeFor(second));
    expect(getAgentRendererState(first)).toEqual({ version: 0, callVersion: -1, indicator: "" });
    expect(getAgentRendererState(second)).toEqual({ version: 0, callVersion: -1, indicator: "" });
  });

  it("keeps Agent and AgentContinue calls static and timer-free", () => {
    vi.useFakeTimers();
    const rows: Array<[
      "Agent" | "AgentContinue",
      unknown,
      (metadata: any, args: unknown) => string,
    ]> = [
      ["Agent", { agent: "scout", prompt: "inspect" }, formatAgentCallText],
      ["AgentContinue", { agent_id: "agent-full-id", prompt: "continue" }, formatAgentContinueCallText],
    ];

    for (const [toolName, args, format] of rows) {
      const row = context(args);
      const component = renderCallWithFormatter(toolName, args, row, format);
      expect(component.render(200)[0]).toContain(toolName === "Agent" ? "Role: scout" : "Agent ID: agent-full-id");
      expect(component.render(200).join("\n")).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
      expect(vi.getTimerCount()).toBe(0);
      expect(runtimeFor(row)).toEqual({ callComponent: component });
    }
  });
});
