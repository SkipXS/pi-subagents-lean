import { describe, expect, it, vi } from "vitest";
import {
  addUsage,
  createContextStats,
  formatCost,
  formatTokens,
  getLifetimeTotal,
  getSessionUsageSnapshot,
  observeContextStats,
  type LifetimeUsage,
} from "../../src/agents/usage.js";

describe("usage accounting", () => {
  it("accumulates billable usage but never treats dollars as tokens", () => {
    const usage: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    addUsage(usage, { input: 10, output: 5, cacheWrite: 1, cost: 2 });
    expect(usage).toEqual({ input: 110, output: 55, cacheWrite: 11, cost: 7 });
    expect(getLifetimeTotal(usage)).toBe(176);
    expect(getLifetimeTotal(undefined)).toBe(0);
  });
});

describe("context telemetry", () => {
  it("retains a known window when a later stats sample omits it", () => {
    const stats = createContextStats();
    observeContextStats(stats, { percent: 80, contextWindow: 100 });
    observeContextStats(stats, { percent: null });

    expect(stats).toEqual({ current: null, lastKnown: 80, peak: 80, window: 100, count: 2 });
  });

  it("retains current, lastKnown, peak, window, and count across null compaction snapshots", () => {
    const stats = createContextStats();
    observeContextStats(stats, { tokens: 80, percent: 80, contextWindow: 100 });
    observeContextStats(stats, { tokens: null, percent: null, contextWindow: 100 });
    observeContextStats(stats, { tokens: 125, percent: 125, contextWindow: 100 });

    expect(stats).toEqual({ current: 125, lastKnown: 125, peak: 125, window: 100, count: 3 });
    const afterNull = createContextStats();
    observeContextStats(afterNull, { tokens: 80, percent: 80, contextWindow: 100 });
    observeContextStats(afterNull, { tokens: null, percent: null, contextWindow: 100 });
    expect(afterNull).toEqual({ current: null, lastKnown: 80, peak: 80, window: 100, count: 2 });
  });

  it("does not change cumulative billing usage while sampling context", () => {
    const billing: LifetimeUsage = { input: 10, output: 20, cacheWrite: 3, cost: 0.4 };
    const before = { ...billing };
    observeContextStats(createContextStats(), { tokens: 90, percent: 90, contextWindow: 100 });
    expect(billing).toEqual(before);
  });
});

describe("Pi-compatible formatting", () => {
  it("uses Pi token thresholds exactly", () => {
    expect([
      formatTokens(999),
      formatTokens(1_000),
      formatTokens(9_999),
      formatTokens(10_000),
      formatTokens(999_999),
      formatTokens(1_000_000),
      formatTokens(9_999_999),
      formatTokens(10_000_000),
    ]).toEqual(["999", "1.0k", "10.0k", "10k", "1000k", "1.0M", "10.0M", "10M"]);
  });

  it("formats costs to exactly three decimals", () => {
    expect([formatCost(0), formatCost(0.008), formatCost(1.23), formatCost(12.3456)])
      .toEqual(["$0.000", "$0.008", "$1.230", "$12.346"]);
  });

  it("reads context/model fallback, auto compaction, and subscription defensively", () => {
    const session = {
      getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 272_000 }),
      model: { provider: "oauth-provider" },
      autoCompactionEnabled: true,
      modelRuntime: { isUsingOAuth: (provider: string) => provider === "oauth-provider" },
    };
    expect(getSessionUsageSnapshot(session)).toEqual({
      contextPercent: null,
      contextWindow: 272_000,
      autoCompactionEnabled: true,
      usingSubscription: true,
    });
    expect(getSessionUsageSnapshot({ model: { provider: "kimi-coding", contextWindow: 128_000 } }))
      .toMatchObject({ contextPercent: null, contextWindow: 128_000, usingSubscription: true });
    expect(getSessionUsageSnapshot({
      getSessionStats: () => ({ contextUsage: { tokens: 190_000, percent: 70.1, contextWindow: 272_000 } }),
    })).toEqual({ contextPercent: 70.1, contextWindow: 272_000 });
    const statsFallback = vi.fn(() => ({ contextUsage: { percent: 61, contextWindow: 128_000 } }));
    expect(getSessionUsageSnapshot({ getContextUsage: () => undefined, getSessionStats: statsFallback }))
      .toEqual({ contextPercent: 61, contextWindow: 128_000 });
    const statsAfterFailure = vi.fn(() => ({ contextUsage: { percent: 99, contextWindow: 128_000 } }));
    expect(getSessionUsageSnapshot({ getContextUsage: () => { throw new Error("mock"); }, getSessionStats: statsAfterFailure }))
      .toBeUndefined();
    expect(statsAfterFailure).not.toHaveBeenCalled();
  });

  it("preserves context when model data is only available from session state", () => {
    const session = {
      getSessionStats: () => ({ contextUsage: { tokens: 13_440, percent: 42, contextWindow: 32_000 } }),
      state: { model: { provider: "state-provider", contextWindow: 64_000 } },
    };

    expect(getSessionUsageSnapshot(session)).toEqual({
      contextPercent: 42,
      contextWindow: 32_000,
      usingSubscription: false,
    });
  });

  it("contains OAuth probe failures and treats unavailable sessions as absent", () => {
    expect(getSessionUsageSnapshot({
      model: { provider: "oauth-provider" },
      modelRuntime: { isUsingOAuth: () => { throw new Error("provider unavailable"); } },
    })).toEqual({ contextPercent: null, usingSubscription: false });
    expect(getSessionUsageSnapshot(undefined)).toBeUndefined();
  });
});
