import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi, resolvedSpawnFixture } from "./fixtures.ts";

const state = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock("../src/agents/agent-runner.js", () => ({ runAgent: state.runAgent }));

import { AgentManager } from "../src/agents/agent-manager.js";
import { SpawnCoordinator } from "../src/spawn/spawn-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => vi.clearAllMocks());

describe("full foreground response boundary", () => {
  it("returns the complete caller response while retaining a bounded projection", async () => {
    const run = deferred<{ responseText: string; session: any; aborted: boolean }>();
    state.runAgent.mockReturnValue(run.promise);
    const manager = new AgentManager({ default: 1 });
    const coordinator = new SpawnCoordinator(manager);
    const pending = coordinator.spawn(fakePi(), fakeCtx(), resolvedSpawnFixture({ prompt: "complete response" }));
    const full = "response-".repeat(20_000);
    run.resolve({ responseText: full, session: { messages: [], subscribe: vi.fn(), dispose: vi.fn() }, aborted: false });

    const result = await pending;
    expect(result.responseText).toBe(full);
    expect(result.record.result).not.toBe(full);
    expect(Buffer.byteLength(result.record.result!, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(result.record.execution.promise).toBeUndefined();
    manager.dispose();
  });
});
