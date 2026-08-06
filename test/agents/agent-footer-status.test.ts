import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";

const managerFooterMocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  executeAgentTurn: vi.fn(),
}));

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: managerFooterMocks.runAgent,
  executeAgentTurn: managerFooterMocks.executeAgentTurn,
}));

import {
  AGENT_FOOTER_STATUS_KEY,
  AgentFooterStatusController,
  formatAgentFooterStatus,
  supportsAgentFooterStatus,
} from "../../src/agents/agent-footer-status.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import type { AgentActivitySnapshot } from "../../src/agents/agent-manager.js";
import type { DeliveryActivitySnapshot } from "../../src/spawn/spawn-coordinator.js";

function execution(
  agentId: string,
  type: string,
  mode: "foreground" | "background",
  status: "running" | "queued",
  executionId = `${agentId}-execution`,
) {
  return Object.freeze({ agentId, type, mode, status, executionId });
}

function delivery(agentId: string, type: string, executionId = `${agentId}-delivery`) {
  return Object.freeze({ agentId, type, executionId });
}

class SnapshotSource<T extends readonly unknown[]> {
  private readonly observers = new Set<(snapshot: T) => void>();
  constructor(private snapshot: T) {}

  subscribe(observer: (snapshot: T) => void): () => void {
    this.observers.add(observer);
    observer(this.snapshot);
    return () => this.observers.delete(observer);
  }

  subscribeActivity(observer: (snapshot: T) => void): () => void {
    return this.subscribe(observer);
  }

  subscribeDeliveryActivity(observer: (snapshot: T) => void): () => void {
    return this.subscribe(observer);
  }

  emit(snapshot: T): void {
    this.snapshot = snapshot;
    for (const observer of [...this.observers]) observer(snapshot);
  }
}

describe("agent footer activity status", () => {
  describe("AgentManager activity observer", () => {
    let manager: AgentManager | undefined;

    beforeEach(() => {
      managerFooterMocks.runAgent.mockReset();
      managerFooterMocks.executeAgentTurn.mockReset();
    });

    afterEach(() => {
      manager?.dispose();
      manager = undefined;
    });

    it("tracks scheduler activity and stop transitions without exposing records", async () => {
      const first = makeResolvablePromise();
      managerFooterMocks.runAgent.mockReturnValueOnce(first.promise);
      manager = new AgentManager(undefined, { default: 1 });
      const snapshots: AgentActivitySnapshot[] = [];
      manager.subscribeActivity((snapshot) => snapshots.push(snapshot));

      const runningId = manager.spawn(fakePi(), fakeCtx(), "scout", "running", {
        description: "running", isBackground: true,
      });
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "reviewer", "queued", {
        description: "queued", isBackground: false,
      });
      expect(snapshots.at(-1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: runningId, status: "running" }),
        expect.objectContaining({ agentId: queuedId, status: "queued" }),
      ]));

      expect(manager.abort(queuedId, "user")).toBe(true);
      expect(snapshots.at(-1)).toEqual([
        expect.objectContaining({ agentId: runningId, status: "running" }),
      ]);
      expect(manager.abort(runningId, "user")).toBe(true);
      expect(snapshots.at(-1)).toEqual([]);

      first.resolve({
        responseText: "",
        session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() },
        aborted: true,
      });
      await manager.getRecord(runningId)!.execution.promise;
    });

    it("drops a queued continuation when its retained session disappears", async () => {
      const retainedSession = { subscribe: vi.fn(), messages: [], dispose: vi.fn() };
      managerFooterMocks.runAgent.mockResolvedValueOnce({
        responseText: "done",
        session: retainedSession,
        aborted: false,
      });
      manager = new AgentManager(undefined, { default: 1 });
      const completedId = manager.spawn(fakePi(), fakeCtx(), "scout", "initial", { description: "initial" });
      await manager.getRecord(completedId)!.execution.promise;

      const blocker = makeResolvablePromise();
      managerFooterMocks.runAgent.mockReturnValueOnce(blocker.promise);
      manager.spawn(fakePi(), fakeCtx(), "reviewer", "blocker", { description: "blocker" });
      const continuation = manager.continueAgent(completedId, "queued follow-up", {});
      (manager as any).releaseExecution(manager.getRecord(completedId));

      blocker.resolve({
        responseText: "",
        session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() },
        aborted: false,
      });
      await expect(continuation.promise).rejects.toThrow("session is no longer available");
    });
  });

  it("formats the exact single-agent states", () => {
    expect(formatAgentFooterStatus(
      [execution("a1b2c3d4-agent", "scout", "foreground", "running")] as AgentActivitySnapshot,
      [],
    )).toBe("Agent: scout [a1b2c3d4] · Foreground · Running");

    expect(formatAgentFooterStatus(
      [execution("a1b2c3d4-agent", "scout", "background", "queued")] as AgentActivitySnapshot,
      [],
    )).toBe("Agent: scout [a1b2c3d4] · Background · Queued");

    expect(formatAgentFooterStatus(
      [],
      [delivery("a1b2c3d4-agent", "scout")] as DeliveryActivitySnapshot,
    )).toBe("Agent: scout [a1b2c3d4] · Background · Delivering");
  });

  it("deduplicates ids and gives a current execution priority over old delivery", () => {
    expect(formatAgentFooterStatus(
      [
        execution("a1b2c3d4-agent", "scout", "foreground", "running"),
        execution("b2c3d4e5-agent", "reviewer", "background", "running"),
        execution("c3d4e5f6-agent", "architect", "foreground", "queued"),
      ] as AgentActivitySnapshot,
      [
        delivery("a1b2c3d4-agent", "scout"),
        delivery("d4e5f6a7-agent", "implementer"),
      ] as DeliveryActivitySnapshot,
    )).toBe("Agents: 4 active · FG 1 running · BG 1 running · 1 queued · 1 delivering");

    expect(formatAgentFooterStatus(
      [],
      [delivery("a1b2c3d4-agent", "scout"), delivery("a1b2c3d4-agent", "scout")],
    )).toBe("Agent: scout [a1b2c3d4] · Background · Delivering");
  });

  it("does not invent activity for terminal or non-pending delivery states", () => {
    expect(formatAgentFooterStatus([], [])).toBeUndefined();
    // Manager projections contain only queued/running and coordinator
    // projections contain only completed pending deliveries by contract.
    expect(formatAgentFooterStatus([], [] as DeliveryActivitySnapshot)).toBeUndefined();
  });

  it("publishes only text changes and clears on dispose", () => {
    const manager = new SnapshotSource<AgentActivitySnapshot>([]);
    const coordinator = new SnapshotSource<DeliveryActivitySnapshot>([]);
    const setStatus = vi.fn();
    const controller = new AgentFooterStatusController(
      { setStatus },
      manager,
      coordinator,
    );

    manager.emit([execution("a1b2c3d4-agent", "scout", "foreground", "running")] as AgentActivitySnapshot);
    manager.emit([execution("a1b2c3d4-agent", "scout", "foreground", "running")] as AgentActivitySnapshot);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenLastCalledWith(
      AGENT_FOOTER_STATUS_KEY,
      "Agent: scout [a1b2c3d4] · Foreground · Running",
    );

    coordinator.emit([delivery("b2c3d4e5-agent", "reviewer")] as DeliveryActivitySnapshot);
    expect(setStatus).toHaveBeenLastCalledWith(
      AGENT_FOOTER_STATUS_KEY,
      "Agents: 2 active · FG 1 running · BG 0 running · 0 queued · 1 delivering",
    );

    controller.dispose();
    expect(setStatus).toHaveBeenLastCalledWith(AGENT_FOOTER_STATUS_KEY, undefined);
    const callsAfterDispose = setStatus.mock.calls.length;
    manager.emit([]);
    coordinator.emit([]);
    expect(setStatus).toHaveBeenCalledTimes(callsAfterDispose);
    controller.dispose();
    expect(setStatus).toHaveBeenCalledTimes(callsAfterDispose);
  });

  it("does not let a stale controller clear a newer session", () => {
    const manager = new SnapshotSource<AgentActivitySnapshot>([
      execution("a1b2c3d4-agent", "scout", "foreground", "running"),
    ] as AgentActivitySnapshot);
    const coordinator = new SnapshotSource<DeliveryActivitySnapshot>([]);
    const setStatus = vi.fn();
    let owner = 1;
    const stale = new AgentFooterStatusController(
      { setStatus },
      manager,
      coordinator,
      () => owner === 1,
    );
    owner = 2;
    const current = new AgentFooterStatusController(
      { setStatus },
      manager,
      coordinator,
      () => owner === 2,
    );
    const callsBeforeStaleDispose = setStatus.mock.calls.length;

    stale.dispose();
    expect(setStatus).toHaveBeenCalledTimes(callsBeforeStaleDispose);
    current.dispose();
    expect(setStatus).toHaveBeenLastCalledWith(AGENT_FOOTER_STATUS_KEY, undefined);
  });

  it("only supports TUI and RPC, not print/json/headless contexts", () => {
    expect(supportsAgentFooterStatus({ mode: "tui" })).toBe(true);
    expect(supportsAgentFooterStatus({ mode: "rpc" })).toBe(true);
    expect(supportsAgentFooterStatus({ mode: "json" })).toBe(false);
    expect(supportsAgentFooterStatus({ mode: "print" })).toBe(false);
    expect(supportsAgentFooterStatus({ mode: undefined as never })).toBe(false);
  });
});
