import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { createToolHtmlRenderer } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import {
  AGENT_RENDER_DETAILS_KEY,
  renderAgentCall,
  renderAgentResult,
} from "../../src/agents/agent-renderer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Agent renderer with Pi's ToolExecutionComponent", () => {
  it("does not start a timer for Pi's historical HTML call without a result", () => {
    vi.useFakeTimers();
    const toolDefinition = {
      name: "Agent",
      label: "Agent",
      description: "test",
      parameters: {},
      renderCall: renderAgentCall,
      renderResult: renderAgentResult,
    } as any;
    const renderer = createToolHtmlRenderer({
      getToolDefinition: (name: string) => name === "Agent" ? toolDefinition : undefined,
      theme: {} as any,
      cwd: process.cwd(),
    });

    expect(renderer.renderCall("historical-call", "Agent", {
      agent: "scout",
      prompt: "inspect",
    })).toContain("Role: scout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hydrates HTML safely through its no-op invalidation", () => {
    const toolDefinition = {
      name: "Agent",
      label: "Agent",
      description: "test",
      parameters: {},
      renderCall: renderAgentCall,
      renderResult: renderAgentResult,
    } as any;
    const renderer = createToolHtmlRenderer({
      getToolDefinition: (name: string) => name === "Agent" ? toolDefinition : undefined,
      theme: {} as any,
      cwd: process.cwd(),
    });

    renderer.renderCall("html-call", "Agent", { agent: "alias", prompt: "inspect" });
    const rendered = renderer.renderResult(
      "html-call",
      "Agent",
      [{ type: "text", text: "complete response" }],
      {
        [AGENT_RENDER_DETAILS_KEY]: {
          role: "reviewer",
          agentId: "canonical-full-id",
          model: "provider/model",
          thinking: "high",
          prompt: "inspect",
          kind: "new",
        },
      },
      false,
    );

    const expanded = rendered?.expanded ?? "";
    expect(expanded).toContain("complete response");
    expect(expanded.match(/complete response/gu)).toHaveLength(1);
  });

  it("uses Pi's real pending, success, and error shell without row timers", () => {
    vi.useFakeTimers();
    initTheme();
    const ui = { requestRender: vi.fn() };
    const toolDefinition = {
      name: "Agent",
      label: "Agent",
      description: "test",
      parameters: {},
      renderCall: renderAgentCall,
      renderResult: renderAgentResult,
    } as any;
    const component = new ToolExecutionComponent(
      "Agent",
      "real-call",
      { agent: "scout", prompt: "inspect" },
      {},
      toolDefinition,
      ui as any,
      process.cwd(),
    );

    component.markExecutionStarted();
    const pending = component.render(200).join("\n");
    expect(pending).toContain("Role: scout");
    expect(pending).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
    expect(pending).not.toMatch(/[\u25f7\u2713\u2717]/u);
    expect(vi.getTimerCount()).toBe(0);

    component.updateResult({
      content: [{ type: "text", text: "partial" }],
      details: undefined,
      isError: false,
    }, true);
    expect(component.render(200).join("\n")).toContain("partial");
    expect(vi.getTimerCount()).toBe(0);

    component.updateResult({
      content: [{ type: "text", text: "done" }],
      details: {
        [AGENT_RENDER_DETAILS_KEY]: {
          role: "reviewer",
          agentId: "canonical-full-id",
          model: "provider/model",
          thinking: "high",
          prompt: "inspect",
          kind: "new",
        },
      },
      isError: false,
    }, false);
    const success = component.render(200).join("\n");
    expect(success).toContain("Role: reviewer | Agent ID: canonical-full-id");
    expect(success).not.toMatch(/[\u25f7\u2713\u2717]/u);
    expect(success.match(/done/gu)).toHaveLength(1);
    expect(success).not.toBe(pending);
    expect(vi.getTimerCount()).toBe(0);

    component.updateResult({
      content: [{ type: "text", text: "failed" }],
      details: { status: "aborted" },
      isError: true,
    }, false);
    const error = component.render(200).join("\n");
    expect(error).toContain("Role: reviewer | Agent ID: canonical-full-id");
    expect(error).not.toMatch(/[\u25f7\u2713\u2717]/u);
    expect(error).not.toBe(success);
    expect(vi.getTimerCount()).toBe(0);
  });
});
