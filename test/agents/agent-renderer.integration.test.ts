import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { createToolHtmlRenderer } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import {
  renderAgentCall,
  renderAgentResult,
  stopAgentRendererTimers,
} from "../../src/agents/agent-renderer.js";

afterEach(() => {
  stopAgentRendererTimers();
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
      renderResult: (result: any, options: any, actualTheme: any, context: any) =>
        renderAgentResult(result, options, actualTheme, context, "Agent"),
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

  it("animates through the real row lifecycle and ends on the final result", () => {
    vi.useFakeTimers();
    initTheme();
    const ui = { requestRender: vi.fn() };
    const toolDefinition = {
      name: "Agent",
      label: "Agent",
      description: "test",
      parameters: {},
      renderCall: renderAgentCall,
      renderResult: (result: any, options: any, actualTheme: any, context: any) =>
        renderAgentResult(result, options, actualTheme, context, "Agent"),
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

    // ToolExecutionComponent first renders an unopened call, then marks the
    // execution started exactly as Pi does after dispatching the tool.
    component.markExecutionStarted();
    expect(component.render(200).join("\n")).toContain("⠋ Role: scout");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(80);
    expect(ui.requestRender).toHaveBeenCalled();
    expect(component.render(200).join("\n")).toContain("⠙ Role: scout");

    component.updateResult({
      content: [{ type: "text", text: "partial" }],
      details: undefined,
      isError: false,
    }, true);
    expect(vi.getTimerCount()).toBe(1);

    component.updateResult({
      content: [{ type: "text", text: "done" }],
      details: undefined,
      isError: false,
    }, false);
    expect(vi.getTimerCount()).toBe(0);
    expect(component.render(200).join("\n")).toContain("✓ Role: scout");
  });
});
