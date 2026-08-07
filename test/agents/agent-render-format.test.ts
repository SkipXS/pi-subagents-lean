import { describe, expect, it } from "vitest";
import {
  AGENT_RENDER_DETAILS_KEY,
  agentCallRenderMetadataEqual,
  formatAgentCallText,
  formatAgentContinueCallText,
  formatAgentControlCallText,
  formatAgentResultText,
  formatAgentUsageLine,
  formatStopAgentCallText,
  getAgentCallRenderMetadata,
  mergeAgentCallRenderMetadata,
  parseAgentCallRenderMetadata,
  withAgentCallRenderMetadata,
} from "../../src/agents/agent-render-format.js";

const usageDetails = {
  input: 6_800,
  output: 487,
  cacheRead: 8_200,
  cacheWrite: 1_536,
  latestCacheHitRate: 83.4,
  cost: 0.053,
  contextPercent: 2.1,
  contextWindow: 272_000,
  autoCompactionEnabled: true,
  usingSubscription: true,
};

describe("Agent render format boundary", () => {
  it("formats new, continued, background, and stop call text consistently", () => {
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
    })).toBe(
      "Role: — | Agent ID: abc12345 | Model: — | Thinking: — | Mode: Foreground | Run: Continued\n\nPrompt:\ncontinue",
    );
    expect(formatAgentControlCallText("AgentContinue", undefined, {
      agent_id: "abc12345",
      prompt: "continue",
      run_in_background: true,
    })).toContain("Mode: Background | Run: Continued");
    expect(formatStopAgentCallText(undefined, { agent_id: "prefix" })).toBe(
      "Role: — | Agent ID: prefix | Model: — | Thinking: — | Mode: — | Run: —",
    );
  });

  it("parses, merges, and wraps renderer metadata without trusting unrelated details", () => {
    const previous = parseAgentCallRenderMetadata({
      role: "scout",
      model: "openai/gpt-4o",
      thinking: "medium",
      prompt: "old",
      agentId: "full-id",
      mode: "foreground",
      kind: "new",
      ignored: "value",
    });
    const incoming = parseAgentCallRenderMetadata({
      role: "scout",
      prompt: "new",
      thinking: "high",
      kind: "new",
    });
    expect(previous).toBeDefined();
    expect(incoming).toBeDefined();

    const merged = mergeAgentCallRenderMetadata(previous, incoming!);
    expect(merged).toEqual({
      role: "scout",
      model: "openai/gpt-4o",
      thinking: "high",
      prompt: "new",
      agentId: "full-id",
      mode: "foreground",
      kind: "new",
    });
    expect(agentCallRenderMetadataEqual(merged, { ...merged })).toBe(true);
    expect(parseAgentCallRenderMetadata({ role: "scout" })).toBeUndefined();

    const details = withAgentCallRenderMetadata({ preserved: true }, merged);
    expect(details).toMatchObject({ preserved: true, [AGENT_RENDER_DETAILS_KEY]: merged });
    expect(getAgentCallRenderMetadata(details)).toEqual(merged);
  });

  it("formats usage and completed result text with stable footer spacing", () => {
    expect(formatAgentUsageLine(usageDetails)).toBe(
      "↑6.8k ↓487 R8.2k W1.5k CH83.4% $0.053 (sub) 2.1%/272k (auto)",
    );
    expect(formatAgentUsageLine({ role: "scout", prompt: "search" })).toBeUndefined();
    expect(formatAgentResultText(
      [{ type: "text", text: "answer\n" }],
      usageDetails,
      true,
    )).toBe(
      "answer\n\n↑6.8k ↓487 R8.2k W1.5k CH83.4% $0.053 (sub) 2.1%/272k (auto)",
    );
    expect(formatAgentResultText(
      [{ type: "text", text: "streaming" }],
      usageDetails,
      false,
    )).toBe("streaming");
  });

  it("escapes all control-bearing metadata and prompts before formatting", () => {
    const esc = String.fromCharCode(0x1b);
    const text = formatAgentCallText({
      role: `role${esc}]52;c;secret`,
      model: `provider/${esc}[31mmodel`,
      thinking: `high${String.fromCharCode(0x9b)}31m`,
      prompt: `before${esc}]52;c;secret\n日本語`,
    });

    expect(text).not.toContain(esc);
    expect(text).not.toContain(String.fromCharCode(0x9b));
    expect(text).toContain("\\x1b");
    expect(text).toContain("\\x9b");
    expect(text).toContain("日本語");
  });
});
