import { describe, expect, it } from "vitest";
import {
  BackgroundDeliveryDiagnostics,
  MAX_RETAINED_DELIVERY_DIAGNOSTICS,
} from "../../src/spawn/background-delivery-diagnostics.js";

describe("background delivery diagnostics", () => {
  it("retains detached terminal projections and clears them", () => {
    const diagnostics = new BackgroundDeliveryDiagnostics();
    diagnostics.retain({
      executionId: "execution-detached",
      agentId: "agent-detached",
      type: "builder",
      state: "failed",
      attempts: 1,
      lastAttemptAt: 20,
      lastError: "delivery failed",
    });

    const diagnostic = diagnostics.get("execution-detached");
    expect(diagnostic).toMatchObject({ executionId: "execution-detached", state: "failed", attempts: 1 });
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(diagnostic).not.toHaveProperty("payload");
    expect(diagnostics.has("execution-detached")).toBe(true);

    diagnostics.clear();
    expect(diagnostics.size).toBe(0);
    expect(diagnostics.get("execution-detached")).toBeUndefined();
    expect(diagnostics.has("execution-detached")).toBe(false);
  });

  it("keeps a max-64 insertion-order ring without payload references", () => {
    const diagnostics = new BackgroundDeliveryDiagnostics();

    for (let index = 0; index < MAX_RETAINED_DELIVERY_DIAGNOSTICS + 1; index++) {
      diagnostics.retain({
        executionId: `execution-${index}`,
        agentId: `agent-${index}`,
        type: "builder",
        state: "accepted",
        attempts: 1,
      });
    }

    expect(diagnostics.size).toBe(MAX_RETAINED_DELIVERY_DIAGNOSTICS);
    expect(diagnostics.has("execution-0")).toBe(false);
    expect(diagnostics.has("execution-1")).toBe(true);
    expect(diagnostics.has("execution-64")).toBe(true);
    expect([...diagnostics.values()].every((diagnostic) => !("payload" in diagnostic))).toBe(true);
  });
});
