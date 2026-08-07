/**
 * output-log-writer.test.ts — ordering and idle behavior at the writer boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMockSession, tempDirFixture } from "../fixtures.ts";
import {
  AgentOutputLog,
  MAX_OUTPUT_LOG_BYTES,
  MAX_OUTPUT_ROOT_BYTES,
  getOutputLogAccounting,
  whenOutputLogsIdle,
} from "../../src/agents/output-file.js";
import { enqueueOutputWrite } from "../../src/agents/output-log-writer.js";

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

describe("serialized output-log writes", () => {
  it("orders immediate continuation entries after the prior DONE line", async () => {
    const dir = fixture.getDir();
    const first = new AgentOutputLog(testAgentId, "first prompt", dir);
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", {
      get: () => [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      ],
      configurable: true,
    });
    first.attach(session);
    session._fireTurnEnd();
    first.finalize({ totalTokens: 1, cost: 0 });

    // This is deliberately created immediately, before the first queue drains.
    // It must share the path writer rather than racing the prior DONE append.
    const second = new AgentOutputLog(testAgentId, "second prompt", dir, true);
    second.finalize({ totalTokens: 2, cost: 0 });

    const lines = (await readLog(first.path)).trim().split("\n");
    expect(lines.filter((line) => line.includes("[DONE]")).length).toBe(2);
    expect(lines.findIndex((line) => line.includes("[DONE]"))).toBeGreaterThan(-1);
    expect(lines.findIndex((line) => line.includes("second prompt")))
      .toBeGreaterThan(lines.findIndex((line) => line.includes("[DONE]")));
  });

  it("caps one log in UTF-8 bytes and emits one marker before ignoring later content", async () => {
    const dir = fixture.getDir();
    const oversizedPrompt = "🙂".repeat(Math.ceil((MAX_OUTPUT_LOG_BYTES + 4096) / 4));
    const log = new AgentOutputLog(testAgentId, oversizedPrompt, dir);
    log.append("content after the cap");

    await log.whenIdle();
    const content = await readFile(log.path, "utf8");
    const accounting = getOutputLogAccounting(log.path);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_LOG_BYTES);
    expect((content.match(/\[TRUNCATED\]/g) ?? [])).toHaveLength(1);
    expect(content).not.toContain("content after the cap");
    expect(accounting.fileBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(accounting.fileTruncated).toBe(true);
  });

  it("reserves a shared root budget across parallel path writers", async () => {
    const dir = fixture.getDir();
    const paths = Array.from({ length: 9 }, (_, index) =>
      join(dir, `parallel-${index}.log`),
    );
    const fullFile = "x".repeat(MAX_OUTPUT_LOG_BYTES);
    const sevenMiB = "y".repeat(7 * 1024 * 1024);

    // Seven full files plus one 7 MiB file leave exactly 1 MiB for the ninth
    // writer. All reservations happen before any of the independent writers
    // get a chance to drain.
    const writes = [
      ...paths.slice(0, 7).map((path) => enqueueOutputWrite(path, false, fullFile)),
      enqueueOutputWrite(paths[7]!, false, sevenMiB),
      enqueueOutputWrite(paths[8]!, false, "z".repeat(2 * 1024 * 1024)),
    ];
    await Promise.all(writes);
    await whenOutputLogsIdle();

    const existing = await Promise.all(paths.map(async (path) => {
      try { return await readFile(path); } catch { return Buffer.alloc(0); }
    }));
    const totalBytes = existing.reduce((sum, value) => sum + value.byteLength, 0);
    const accounting = getOutputLogAccounting(paths[8]!);
    expect(totalBytes).toBeLessThanOrEqual(MAX_OUTPUT_ROOT_BYTES);
    expect(accounting.rootBytes).toBe(totalBytes);
    expect(accounting.rootTruncated).toBe(true);
    expect(existing[8]!.toString("utf8")).toContain("[TRUNCATED]");
  });
});
