/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/**
 * Billable token usage accumulated from `message_end` events. Cache reads are
 * tracked separately on AgentAccumulatedStats so their Pi display total can be
 * maintained without changing this long-standing lifetime usage shape.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cost: number };

/**
 * A single per-turn usage event as emitted upstream. Adds `cacheRead`, which
 * LifetimeUsage omits from totals (see issue #38). Used to estimate input
 * deltas for providers like vLLM that don't report cache hits.
 */
export type AgentUsage = LifetimeUsage & { cacheRead: number };

/** Sum of lifetime token components (never dollar cost), or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  into.cost += delta.cost;
}

/** The actual/current context shape returned by `getContextUsage()`. */
export type SessionContextUsage = {
  percent: number | null;
  contextWindow: number;
  tokens?: number | null;
};

/** Historical stats shape; older session doubles omitted `contextWindow`. */
export type SessionStatsContextUsage = Omit<SessionContextUsage, "contextWindow"> & { contextWindow?: number };

/** Minimal session surface used by UI accounting. Methods are optional for test doubles. */
export type SessionLike = {
  getSessionStats?: () => { contextUsage?: SessionStatsContextUsage };
  getContextUsage?: () => SessionContextUsage | undefined;
  autoCompactionEnabled?: boolean;
  model?: { provider?: string; contextWindow?: number };
  state?: { model?: { provider?: string; contextWindow?: number } };
  modelRuntime?: { isUsingOAuth?: (provider: string) => boolean };
};

/** Result of one defensive context read, retaining failures separately from valid null usage. */
export interface SessionContextUsageRead {
  usage?: SessionStatsContextUsage;
  failed: boolean;
}

/**
 * Read context once, retaining whether the source threw so callers can avoid
 * turning a failed terminal read into a valid-looking null sample.
 */
export function readSessionContextUsage(session: SessionLike | undefined): SessionContextUsageRead {
  if (!session) return { failed: false };
  try {
    // Prefer the direct reader when available. An undefined direct sample is
    // not a failure, though: older/session-compatible implementations may
    // still expose the usable value through getSessionStats().
    if (session.getContextUsage) {
      const usage = session.getContextUsage();
      if (usage !== undefined) return { failed: false, usage };
    }
    return { failed: false, usage: session.getSessionStats?.().contextUsage };
  } catch {
    return { failed: true };
  }
}

/**
 * Context utilization history for one agent session.
 *
 * `current` intentionally remains null after compaction when Pi has not yet
 * measured the rebuilt context. `lastKnown` and `peak` retain useful samples
 * without pretending that either is the current value.
 */
export interface ContextStats {
  current: number | null;
  lastKnown: number | null;
  peak: number | null;
  window?: number;
  count: number;
}

/** Create an empty context history without affecting billable usage. */
export function createContextStats(): ContextStats {
  return { current: null, lastKnown: null, peak: null, count: 0 };
}

/**
 * Read the exact upstream context snapshot defensively.
 *
 * The object may contain null `tokens`/`percent` immediately after compaction;
 * only an absent or failed read is treated as an unavailable snapshot.
 */
export function getSessionContextUsage(session: SessionLike | undefined): SessionStatsContextUsage | undefined {
  return readSessionContextUsage(session).usage;
}

/** Record one context snapshot; null-valued samples count, and a window updates only when supplied. */
export function observeContextStats(stats: ContextStats, usage: SessionStatsContextUsage | undefined): void {
  if (!usage) return;
  stats.current = usage.percent;
  if (typeof usage.contextWindow === "number") stats.window = usage.contextWindow;
  stats.count++;
  if (usage.percent != null) {
    stats.lastKnown = usage.percent;
    stats.peak = stats.peak == null ? usage.percent : Math.max(stats.peak, usage.percent);
  }
}

/** Context/auth values which must survive after an AgentSession is no longer live. */
export interface SessionUsageSnapshot {
  contextPercent: number | null;
  contextWindow?: number;
  autoCompactionEnabled?: boolean;
  usingSubscription?: boolean;
}

/** Format a token count exactly like Pi's interactive footer. */
export function formatTokens(count: number, _compact?: boolean): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Format cost exactly like Pi's interactive footer. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

/**
 * Read Pi context and authentication state defensively, including model
 * fallback. Callers that already sampled context may pass it to avoid another
 * full-branch read at the same lifecycle boundary.
 */
export function getSessionUsageSnapshot(
  session: SessionLike | undefined,
  contextUsageOverride?: SessionStatsContextUsage,
): SessionUsageSnapshot | undefined {
  if (!session) return undefined;
  try {
    // Preserve the historical defensive contract for ordinary callers: a
    // throwing direct reader is unavailable rather than silently replaced by
    // model-only metadata. An explicit second argument, including undefined,
    // means the caller has already attempted the context read.
    const contextRead = arguments.length > 1 ? undefined : readSessionContextUsage(session);
    if (contextRead?.failed) return undefined;
    const contextUsage = arguments.length > 1 ? contextUsageOverride : contextRead?.usage;
    const model = session.model ?? session.state?.model;
    const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow;
    const provider = model?.provider;
    let usingSubscription: boolean | undefined;
    if (provider) {
      usingSubscription = provider === "kimi-coding";
      if (!usingSubscription) {
        try { usingSubscription = session.modelRuntime?.isUsingOAuth?.(provider) ?? false; }
        catch { usingSubscription = false; }
      }
    }
    return {
      contextPercent: contextUsage?.percent ?? null,
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      ...(typeof session.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: session.autoCompactionEnabled } : {}),
      ...(usingSubscription !== undefined ? { usingSubscription } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Context-window utilization (0–100), or null when unavailable. */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  return getSessionUsageSnapshot(session)?.contextPercent ?? null;
}
