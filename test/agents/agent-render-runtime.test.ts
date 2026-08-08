import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RENDER_DETAILS_KEY,
  formatAgentCallText,
  formatAgentContinueCallText,
} from "../../src/agents/agent-render-format.js";
import {
  AGENT_RENDER_CALL_VERSION_KEY,
  AGENT_RENDER_VERSION_KEY,
  getAgentRendererState,
  renderCallWithFormatter,
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
  it("keeps metadata versions in each row's persisted state", () => {
    const first = context({ agent: "first", prompt: "one" });
    const second = context({ agent: "second", prompt: "two" });
    first.state[AGENT_RENDER_DETAILS_KEY] = {
      role: "reviewer",
      prompt: "hydrated",
      kind: "new",
    };

    expect(getAgentRendererState(first)).toEqual({
      metadata: { role: "reviewer", prompt: "hydrated", kind: "new" },
      version: 0,
      callVersion: -1,
    });
    expect(getAgentRendererState(second)).toEqual({ version: 0, callVersion: -1 });
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
      const component = renderCallWithFormatter(args, row, format);
      expect(component.render(200)[0]).toContain(toolName === "Agent" ? "Role: scout" : "Agent ID: agent-full-id");
      expect(component.render(200).join("\n")).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
      expect(component.render(200).join("\n")).not.toMatch(/[\u25f7\u2713\u2717]/u);
      expect(vi.getTimerCount()).toBe(0);
      expect(row.state).toMatchObject({
        [AGENT_RENDER_VERSION_KEY]: 0,
        [AGENT_RENDER_CALL_VERSION_KEY]: 0,
      });
    }
  });
});
