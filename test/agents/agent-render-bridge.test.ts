import { describe, expect, it } from "vitest";
import {
  AGENT_RENDER_DETAILS_KEY,
  type AgentCallRenderMetadata,
} from "../../src/agents/agent-renderer.js";
import { AgentRenderMetadataBridge } from "../../src/agents/agent-render-bridge.js";

const metadata: AgentCallRenderMetadata = {
  role: "reviewer",
  model: "openai/gpt-4o",
  thinking: "high",
  prompt: "inspect everything",
};

function message(toolCallId: string, details: unknown): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "Agent",
    content: [{ type: "text", text: "failure" }],
    details,
    isError: true,
  };
}

describe("Agent render metadata bridge", () => {
  it("repairs post-resolution throwing errors through tool_result and message_end", () => {
    const bridge = new AgentRenderMetadataBridge();
    bridge.startSession();
    bridge.start("error-id", "Agent");
    bridge.updateFromPartial("error-id", "Agent", {
      content: [],
      details: { [AGENT_RENDER_DETAILS_KEY]: metadata },
    });

    const hookResult = bridge.onToolResult({
      toolName: "Agent",
      toolCallId: "error-id",
      details: { existing: "preserved" },
    });
    expect(hookResult?.details).toEqual({
      existing: "preserved",
      [AGENT_RENDER_DETAILS_KEY]: metadata,
    });

    expect(bridge.pendingCount()).toBe(1);
    const persisted = bridge.onMessageEnd({
      // Simulate a later tool_result handler replacing the patched details.
      message: message("error-id", { downstream: "preserved" }),
    });
    expect(persisted?.message.details).toEqual({
      downstream: "preserved",
      [AGENT_RENDER_DETAILS_KEY]: metadata,
    });
    expect(bridge.pendingCount()).toBe(0);

    bridge.start("message-only", "Agent");
    bridge.update("message-only", metadata);
    const replacement = bridge.onMessageEnd({ message: message("message-only", undefined) });
    expect(replacement?.message.details).toEqual({ [AGENT_RENDER_DETAILS_KEY]: metadata });
    expect(bridge.pendingCount()).toBe(0);
  });

  it("keeps parallel tool-call ids isolated and cleans each id after its message", () => {
    const bridge = new AgentRenderMetadataBridge();
    bridge.startSession();
    bridge.start("a", "Agent");
    bridge.start("b", "Agent");
    bridge.update("a", { ...metadata, role: "architect" });
    bridge.update("b", { ...metadata, role: "scout" });

    expect(bridge.metadataFor("a")?.role).toBe("architect");
    expect(bridge.metadataFor("b")?.role).toBe("scout");
    const a = bridge.onToolResult({ toolName: "Agent", toolCallId: "a", details: {} });
    const b = bridge.onToolResult({ toolName: "Agent", toolCallId: "b", details: {} });
    expect(a?.details[AGENT_RENDER_DETAILS_KEY]).toMatchObject({ role: "architect" });
    expect(b?.details[AGENT_RENDER_DETAILS_KEY]).toMatchObject({ role: "scout" });

    expect(bridge.pendingCount()).toBe(2);
    bridge.onMessageEnd({ message: message("a", a?.details) });
    expect(bridge.pendingCount()).toBe(1);
    bridge.onMessageEnd({ message: message("b", b?.details) });
    expect(bridge.pendingCount()).toBe(0);
  });

  it("does not rewrite an already hydrated success and clears on session cleanup", () => {
    const bridge = new AgentRenderMetadataBridge();
    bridge.startSession();
    bridge.start("success-id", "Agent");
    bridge.update("success-id", metadata);
    const details = { [AGENT_RENDER_DETAILS_KEY]: metadata, keep: true };

    expect(bridge.onToolResult({ toolName: "Agent", toolCallId: "success-id", details })).toBeUndefined();
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.onMessageEnd({ message: message("success-id", details) })).toBeUndefined();
    expect(bridge.pendingCount()).toBe(0);

    bridge.start("stale-id", "Agent");
    bridge.update("stale-id", metadata);
    expect(bridge.pendingCount()).toBe(1);
    bridge.clear();
    expect(bridge.pendingCount()).toBe(0);
    bridge.startSession();
    bridge.update("stale-id", metadata);
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.onToolResult({ toolName: "Agent", toolCallId: "stale-id", details: {} })).toBeUndefined();
  });
});
