/**
 * output-file.test.ts — Tests for output-file.ts.
 *
 * Covers the AgentOutputLog lifecycle class and transcript functions
 * (writeInitialEntry, streamToOutputFile). Root/path security contracts live
 * in output-log-store.test.ts; queue ordering lives in output-log-writer.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createMockSession, tempDirFixture } from "../fixtures.ts";
import {
  createOutputFilePath,
  writeInitialEntry,
  streamToOutputFile,
  AgentOutputLog,
  whenOutputLogsIdle,
} from "../../src/agents/output-file.js";

const testAgentId = "test-agent-123";
const fixture = tempDirFixture();

async function readLog(path: string): Promise<string> {
  await whenOutputLogsIdle();
  return readFileSync(path, "utf-8");
}

beforeEach(() => fixture.setup());
afterEach(async () => {
  await whenOutputLogsIdle();
  fixture.teardown();
});

// ------------------------------------------------------------------
// writeInitialEntry
// ------------------------------------------------------------------

describe("writeInitialEntry", () => {
  it("writes a [USER] line with ISO timestamp and prompt text", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "explore auth module");

    const content = await readLog(path);
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(content).toContain("[USER]");
    expect(content).toContain("explore auth module");
  });
});

// ------------------------------------------------------------------
// streamToOutputFile
// ------------------------------------------------------------------

describe("streamToOutputFile", () => {
  function setupSession(messages: any[]) {
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", { get: () => messages, configurable: true });
    return session;
  }

  it("appends TOOL lines when session events fire", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "explore auth module");

    const session = setupSession([
      { role: "user", content: "explore auth module" },
      { role: "assistant", content: [{ type: "toolUse", name: "read", input: { path: "src/auth.ts" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toMatch(/\[TOOL\] read\("src\/auth\.ts"\)/);
    cleanup();
  });

  it("writes TOOL lines with pi-ai ToolCall format (arguments key)", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "check imports");

    const session = setupSession([
      { role: "user", content: "check imports" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_123", name: "grep", arguments: { pattern: "import", path: "./src" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toContain('[TOOL] grep("import", "' + "./src" + '")');
    cleanup();
  });

  it("appends DONE line on cleanup", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "explore auth module");

    const session = setupSession([]);
    const cleanup = streamToOutputFile(session, path, {
      totalTokens: 12400,
      cost: 0.024,
    });
    cleanup();

    const lastLine = (await readLog(path)).trim().split("\n").at(-1)!;
    expect(lastLine).toMatch(/\[DONE\]/);
    expect(lastLine).toContain("12k tokens");
    expect(lastLine).toContain("$0.024");
  });

  it("formats cost as $X.XXX with three decimal places", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "check cost format");

    const session = setupSession([]);
    const cleanup = streamToOutputFile(session, path, {
      totalTokens: 15000, cost: 0.123456,
    });
    cleanup();

    const lastLine = (await readLog(path)).trim().split("\n").at(-1)!;
    expect(lastLine).toContain("$0.123");
    expect(lastLine).not.toContain("$0.123456");
  });

  it("appends [ASSISTANT] lines for text messages", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "text", text: "Hello, I am ready." }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = await readLog(path);
    expect(content).toContain("[ASSISTANT]");
    expect(content).toContain("Hello, I am ready.");
    cleanup();
  });

  it("logs thinking blocks as [THINKING] lines", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "think about this");

    const session = setupSession([
      { role: "user", content: "think about this" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason step by step..." },
          { type: "text", text: "Here is the answer." },
        ],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = await readLog(path);
    expect(content).toMatch(/\[THINKING\]/);
    expect(content).toContain("Let me reason step by step...");
    expect(content).toMatch(/\[ASSISTANT\]/);
    cleanup();
  });

  it("marks redacted thinking blocks", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "sensitive");

    const session = setupSession([
      { role: "user", content: "sensitive" },
      { role: "assistant", content: [{ type: "thinking", thinking: "REDACTED", redacted: true }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = await readLog(path);
    expect(content).toContain("[redacted]");
    expect(content).not.toContain("REDACTED");
    cleanup();
  });

  it("returns a cleanup function that unsubscribes", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([{ role: "user", content: "test" }]);
    const cleanup = streamToOutputFile(session, path);
    cleanup();

    expect(session._getListeners().length).toBe(0);
  });

  // Tool argument summarization

  it("summarizes write tool with path and content size", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "create file");

    const session = setupSession([
      { role: "user", content: "create file" },
      { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { file_path: "/tmp/test.txt", content: "hello world\nline2" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toContain('[TOOL] write("/tmp/test.txt", 17 chars)');
    cleanup();
  });

  it("summarizes edit tool with path and edit count", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "edit file");

    const session = setupSession([
      { role: "user", content: "edit file" },
      { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts", edits: [{ oldText: "foo", newText: "bar" }, { oldText: "x", newText: "y" }] } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toContain('[TOOL] edit("src/file.ts", 2 edits)');
    cleanup();
  });

  it("summarizes bash tool without heredoc", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "run command");

    const session = setupSession([
      { role: "user", content: "run command" },
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm run build" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toContain('[TOOL] bash("npm run build")');
    cleanup();
  });

  it("summarizes bash tool stripping heredoc", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "run heredoc");

    const session = setupSession([
      { role: "user", content: "run heredoc" },
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "cat <<EOF\nline1\nline2\nEOF" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toContain('[TOOL] bash("cat")');
    cleanup();
  });

  it("truncates long bash commands", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "long command");

    const session = setupSession([
      { role: "user", content: "long command" },
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "a".repeat(400) } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = await readLog(path);
    expect(content).toContain('[TOOL] bash("');
    expect(content).toContain("…");
    cleanup();
  });

  it("summarizes rg tool like grep", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "search with rg");

    const session = setupSession([
      { role: "user", content: "search with rg" },
      { role: "assistant", content: [{ type: "toolCall", name: "rg", arguments: { pattern: "function", path: "./src" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = await readLog(path);
    expect(content).toContain('[TOOL] rg("function", "');
    cleanup();
  });

  it("uses default formatting for unknown tools", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "custom tool");

    const session = setupSession([
      { role: "user", content: "custom tool" },
      { role: "assistant", content: [{ type: "toolCall", name: "customTool", arguments: { key1: "value1", key2: "value2" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toContain('[TOOL] customTool {"key1":"value1","key2":"value2"}');
    cleanup();
  });

  // Tool result handling

  it("logs short tool results as [TOOL_RESULT] lines", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "run read");

    const session = setupSession([
      { role: "user", content: "run read" },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file content here" }], isError: false, timestamp: Date.now() },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = await readLog(path);
    expect(content).toContain("[TOOL_RESULT]");
    expect(content).toContain("file content here");
    cleanup();
  });

  it("truncates long tool results with summary line", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "big output");

    const session = setupSession([
      { role: "user", content: "big output" },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(600) }], isError: false, timestamp: Date.now() },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = await readLog(path);
    expect(content).toContain("[TOOL_RESULT] bash: 600 chars");
    expect(content).not.toContain("x".repeat(600));
    cleanup();
  });

  it("handles tool result with exactly 500 chars as short (no truncation)", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "exactly 500");

    const exactContent = "y".repeat(500);
    const session = setupSession([
      { role: "user", content: "exactly 500" },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: exactContent }], isError: false, timestamp: Date.now() },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toContain(exactContent);
    cleanup();
  });

  it("handles tool result with 501 chars as long (truncated)", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "501 chars");

    const session = setupSession([
      { role: "user", content: "501 chars" },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "z".repeat(501) }], isError: false, timestamp: Date.now() },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(await readLog(path)).toContain("[TOOL_RESULT] bash: 501 chars");
    cleanup();
  });

  it("skips tool result with empty content", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "empty result");

    const session = setupSession([
      { role: "user", content: "empty result" },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "   " }], isError: false, timestamp: Date.now() },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect((await readLog(path)).trim().split("\n").length).toBe(1);
    cleanup();
  });
});

// ------------------------------------------------------------------
// AgentOutputLog
// ------------------------------------------------------------------

describe("AgentOutputLog", () => {
  it("creates the output file path and writes initial [USER] entry", async () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "explore auth", dir);
    expect(log.path).toBe(join(dir, `${testAgentId}.log`));
    expect(await readLog(log.path)).toMatch(/\[USER\]\s+explore auth/);
  });

  it("uses an absolute private temp root when baseDir is omitted", async () => {
    const log = new AgentOutputLog(testAgentId, "test prompt");
    expect(isAbsolute(log.path)).toBe(true);
    expect(log.path).toContain("pi-subagents-outputs-");
    expect(log.path).not.toBe(join(tmpdir(), "pi-agent-outputs", `${testAgentId}.log`));
  });

  it("subscribes to session events on attach", async () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    const session = createMockSession() as any;
    log.attach(session);
    expect(session.subscribe).toHaveBeenCalledTimes(1);
  });

  it("streams messages on turn_end events", async () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", {
      get: () => [
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "text", text: "Hello, I am ready." }] },
      ],
      configurable: true,
    });
    log.attach(session);
    session._fireTurnEnd();

    const content = await readLog(log.path);
    expect(content).toContain("[ASSISTANT]");
    expect(content).toContain("Hello, I am ready.");
  });

  it("writes DONE line with final stats on finalize", async () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", { get: () => [], configurable: true });
    log.attach(session);
    log.finalize({ totalTokens: 12400, cost: 0.024 });

    const lastLine = (await readLog(log.path)).trim().split("\n").at(-1)!;
    expect(lastLine).toMatch(/\[DONE\]/);
    expect(lastLine).toContain("12k tokens");
    expect(lastLine).toContain("$0.024");
  });

  it("flushes remaining messages before writing DONE", async () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", {
      get: () => [
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "text", text: "Final answer." }] },
      ],
      configurable: true,
    });
    log.attach(session);
    log.finalize({ totalTokens: 500, cost: 0 });

    const content = await readLog(log.path);
    expect(content).toContain("Final answer.");
    expect(content.trim().split("\n").at(-1)!).toContain("[DONE]");
  });

  it("unsubscribes from session on finalize", async () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", { get: () => [], configurable: true });
    log.attach(session);
    log.finalize({ totalTokens: 0, cost: 0 });
    expect(session._getListeners().length).toBe(0);
  });

  it("does not throw when finalize is called without attach", async () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    expect(() => log.finalize({ totalTokens: 0, cost: 0 })).not.toThrow();
  });

  it("exposes the output file path as a readonly property", async () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    expect(log.path).toBe(join(dir, `${testAgentId}.log`));
  });

  it("makes finalize idempotent and swallows filesystem failures", async () => {
    const dir = fixture.getDir();
    const blockedParent = join(dir, "blocked-parent");
    writeFileSync(blockedParent, "not a directory");
    const log = new AgentOutputLog(testAgentId, "unwritable", blockedParent);
    const session = createMockSession() as any;

    expect(() => {
      log.attach(session);
      log.finalize({ totalTokens: 0, cost: 0 });
      log.finalize({ totalTokens: 1, cost: 1 });
    }).not.toThrow();
    await expect(log.whenIdle()).resolves.toBeUndefined();
  });
});
