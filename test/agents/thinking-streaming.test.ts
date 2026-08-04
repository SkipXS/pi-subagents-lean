/**
 * thinking-streaming.test.ts — Tests for turn-end thinking output.
 *
 * Thinking is deliberately written to the append-only output log when a turn
 * ends, matching the fixed logging behavior of the extension.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createMockSession, tempDirFixture } from "../fixtures.ts";
import {
  createOutputFilePath,
  writeInitialEntry,
  streamToOutputFile,
} from "../../src/agents/output-file.js";

const testAgentId = "test-thinking-streaming";
const fixture = tempDirFixture();

beforeEach(() => fixture.setup());
afterEach(() => fixture.teardown());

function setupSession(messages: any[]) {
  const session = createMockSession() as any;
  Object.defineProperty(session, "messages", { get: () => messages, configurable: true });
  return session;
}

describe("turn-end thinking output", () => {
  it("does not write thinking deltas before turn_end", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "thinking", thinking: "Let me think..." }] },
    ]);
    const cleanup = streamToOutputFile(session, path);

    session._fireThinkingStart();
    session._fireThinkingDelta("Let me think...");
    session._fireThinkingEnd("Let me think...");

    expect(readFileSync(path, "utf-8")).not.toContain("Let me think...");

    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("[THINKING]");
    expect(content).toContain("Let me think...");
    cleanup();
  });

  it("writes every thinking block once at turn_end", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "First block" },
          { type: "text", text: "Response" },
          { type: "thinking", thinking: "Second block" },
        ],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);

    session._fireThinkingDelta("First block");
    session._fireThinkingEnd("First block");
    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("[THINKING] First block");
    expect(content).toContain("[THINKING] Second block");
    expect(content).toContain("[ASSISTANT] Response");
    expect(content.match(/\[THINKING\] First block/g)).toHaveLength(1);
    cleanup();
  });
});
