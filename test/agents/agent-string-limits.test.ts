import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_PROMPT_BYTES,
  MAX_AGENT_SYSTEM_PROMPT_BYTES,
  MAX_DESCRIPTION_BYTES,
  MAX_RETAINED_ERROR_BYTES,
  MAX_RETAINED_TEXT_BYTES,
  retainAgentDescription,
  retainAgentError,
  retainAgentText,
  validateAgentPrompt,
  validateAgentSystemPrompt,
  utf8ByteLength,
} from "../../src/agents/agent-string-limits.js";

describe("agent string byte limits", () => {
  it("accepts exact ASCII prompt/system-prompt boundaries and rejects one byte over", () => {
    expect(validateAgentPrompt("a".repeat(MAX_AGENT_PROMPT_BYTES))).toBeUndefined();
    expect(validateAgentPrompt("a".repeat(MAX_AGENT_PROMPT_BYTES + 1))).toContain("256 KiB");
    expect(validateAgentSystemPrompt("b".repeat(MAX_AGENT_SYSTEM_PROMPT_BYTES))).toBeUndefined();
    expect(validateAgentSystemPrompt("b".repeat(MAX_AGENT_SYSTEM_PROMPT_BYTES + 1))).toContain("512 KiB");
  });

  it("measures multibyte prompt boundaries in UTF-8 bytes, not UTF-16 units", () => {
    const exactPrompt = "😀".repeat(MAX_AGENT_PROMPT_BYTES / 4);
    const overPrompt = `${exactPrompt}😀`;
    expect(utf8ByteLength(exactPrompt)).toBe(MAX_AGENT_PROMPT_BYTES);
    expect(validateAgentPrompt(exactPrompt)).toBeUndefined();
    expect(validateAgentPrompt(overPrompt)).toContain("UTF-8 bytes");

    const exactSystemPrompt = `${"界".repeat(Math.floor(MAX_AGENT_SYSTEM_PROMPT_BYTES / 3))}${"a".repeat(MAX_AGENT_SYSTEM_PROMPT_BYTES % 3)}`;
    const overSystemPrompt = `${exactSystemPrompt}界`;
    expect(utf8ByteLength(exactSystemPrompt)).toBe(MAX_AGENT_SYSTEM_PROMPT_BYTES);
    expect(validateAgentSystemPrompt(exactSystemPrompt)).toBeUndefined();
    expect(validateAgentSystemPrompt(overSystemPrompt)).toContain("UTF-8 bytes");
  });

  it("retains diagnostic text with a complete marker and no split code point", () => {
    const response = retainAgentText("😀界".repeat(Math.ceil(MAX_RETAINED_TEXT_BYTES / 4) + 10));
    const error = retainAgentError("界".repeat(MAX_RETAINED_ERROR_BYTES / 3 + 10));
    const description = retainAgentDescription("é".repeat(MAX_DESCRIPTION_BYTES + 10));

    for (const [value, limit] of [
      [response, MAX_RETAINED_TEXT_BYTES],
      [error!, MAX_RETAINED_ERROR_BYTES],
      [description, MAX_DESCRIPTION_BYTES],
    ] as const) {
      expect(utf8ByteLength(value)).toBeLessThanOrEqual(limit);
      expect(value.endsWith("[TRUNCATED]")).toBe(true);
      expect(value).not.toContain("�");
    }
  });
});
