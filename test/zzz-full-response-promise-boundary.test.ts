import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi, resolvedSpawnFixture } from "./fixtures.ts";
import { MAX_RETAINED_TEXT_BYTES, TRUNCATED_TEXT_MARKER } from "../src/agents/agent-string-limits.ts";
import { AgentManager } from "../src/agents/agent-manager.ts";
import { SpawnCoordinator } from "../src/spawn/spawn-coordinator.ts";

const { runAgent, executeAgentTurn } = vi.hoisted(() => ({
  runAgent: vi.fn(),
  executeAgentTurn: vi.fn(),
}));

vi.mock("../src/agents/agent-runner.js", () => ({ runAgent, executeAgentTurn }));

const session = {
  messages: [],
  subscribe: vi.fn(() => () => {}),
  dispose: vi.fn(),
};

beforeEach(() => {
  runAgent.mockReset();
  executeAgentTurn.mockReset();
  runAgent.mockImplementation(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
    options.onSessionCreated?.(session);
    return { responseText: "", session, aborted: false };
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("full foreground response and promise retention boundary", () => {
  it("returns the full multi-MiB response while clearing only the consumed promise", async () => {
    const fullResponse = "response-" + "x".repeat(2 * 1024 * 1024);
    runAgent.mockImplementationOnce(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: fullResponse, session, aborted: false };
    });

    const manager = new AgentManager();
    const coordinator = new SpawnCoordinator(manager);
    try {
      const result = await coordinator.spawn(
        fakePi(),
        fakeCtx(),
        resolvedSpawnFixture({ runInBackground: false, prompt: "return the complete response" }),
      );

      expect(result.responseText).toBe(fullResponse);
      expect(result.record.result).toContain(TRUNCATED_TEXT_MARKER);
      expect(result.record.execution.promise).toBeUndefined();
      expect(Buffer.byteLength(result.record.result ?? "", "utf8")).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
      expect(result.record.stats.executions?.[0]?.responseText).toContain(TRUNCATED_TEXT_MARKER);
      expect(result.record.stats.executions?.[0]?.deliveredText).toContain(TRUNCATED_TEXT_MARKER);
    } finally {
      coordinator.dispose();
      manager.dispose();
    }
  });

  it("does not clear a newer continuation promise when an old caller releases late", () => {
    const manager = new AgentManager();
    try {
      const record = {
        execution: {},
      } as any;
      const oldPromise = Promise.resolve("old");
      const newPromise = Promise.resolve("new");
      record.execution.promise = newPromise;
      expect(manager.clearExecutionPromise(record, oldPromise)).toBe(false);
      expect(record.execution.promise).toBe(newPromise);
      expect(manager.releaseExecutionPromise(record, newPromise)).toBe(true);
      expect(record.execution.promise).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });
});
