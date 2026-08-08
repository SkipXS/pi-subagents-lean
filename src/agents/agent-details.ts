import type { AgentRecord } from "../types.js";
import { executionKind } from "./execution-display.js";
import { getSessionUsageSnapshot } from "./usage.js";
import { retainAgentDescription, retainAgentError, retainAgentText } from "./agent-string-limits.js";

/**
 * Build a details Record from an AgentRecord, controlled by options.
 *
 * Always includes canonical `agentId`, `type`, and `description`. Optional groups:
 * - `includeStatus`: adds `status`
 * - `includeStats`: adds turn/token/cost/context/compaction/model fields
 *
 * Consolidates the field-selection logic used by the Agent and AgentContinue
 * result paths.
 */
export function buildAgentDetails(
  record: AgentRecord,
  opts?: { includeStats?: boolean; includeStatus?: boolean; execution?: NonNullable<AgentRecord["stats"]["executions"]>[number] },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    agentId: record.id,
    type: record.display.type,
    description: typeof record.display.description === "string"
      ? retainAgentDescription(record.display.description)
      : record.display.description,
  };

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  if (opts?.includeStatus) {
    details.status = opts.execution?.status ?? record.lifecycle.status;
  }

  if (opts?.includeStats) {
    // Only the current execution's compact delta/result is exposed: never
    // execution history, execution ids, timestamps, or prior responses. The
    // initial spawn's summary stays lifetime-cumulative; every continuation
    // reports the exact per-execution usage/compaction deltas instead of
    // cumulative record totals.
    const executions = record.stats.executions;
    const current = opts.execution ?? executions?.at(-1);
    const currentIndex = current ? (executions?.indexOf(current) ?? 0) : 0;
    const currentKind = executionKind(current, currentIndex);
    const continuation = current && currentKind === "continued" ? current : undefined;
    const usage = continuation?.usage;
    const elapsedMs = continuation
      ? (continuation.completedAt !== undefined ? continuation.completedAt - continuation.startedAt : 0)
      : (record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0);

    const terminal = record.lifecycle.status !== "running" && record.lifecycle.status !== "queued";
    // Terminal records retain manager-populated telemetry; their session may
    // already be disposed, so never perform a live branch read here.
    const liveSnapshot = terminal ? undefined : getSessionUsageSnapshot(record.execution.session);
    const terminalSnapshot = {
      contextPercent: record.stats.contextPercent,
      contextWindow: record.stats.contextWindow,
      autoCompactionEnabled: record.stats.autoCompactionEnabled,
      usingSubscription: record.stats.usingSubscription,
    };
    const hasLiveSample = liveSnapshot != null
      && (liveSnapshot.contextWindow !== undefined || liveSnapshot.contextPercent !== null);
    const usageSnapshot = terminal
      ? terminalSnapshot
      : {
        contextPercent: hasLiveSample
          ? liveSnapshot!.contextPercent
          : (terminalSnapshot.contextPercent ?? liveSnapshot?.contextPercent ?? null),
        contextWindow: liveSnapshot?.contextWindow ?? terminalSnapshot.contextWindow,
        autoCompactionEnabled: liveSnapshot?.autoCompactionEnabled ?? terminalSnapshot.autoCompactionEnabled,
        usingSubscription: liveSnapshot?.usingSubscription ?? terminalSnapshot.usingSubscription,
      };

    details.input = usage?.input ?? record.stats.lifetimeUsage.input;
    details.output = usage?.output ?? record.stats.lifetimeUsage.output;
    details.cacheRead = usage?.cacheRead ?? record.stats.cacheRead;
    details.cacheWrite = usage?.cacheWrite ?? record.stats.lifetimeUsage.cacheWrite;
    details.latestCacheHitRate = record.stats.latestCacheHitRate;
    const contextStats = record.stats.contextStats?.count ? record.stats.contextStats : undefined;
    // Keep the explicit live/terminal snapshot so shared formatting can prefer
    // a newly measured response without losing context history telemetry.
    details.contextPercent = usageSnapshot.contextPercent ?? null;
    // The explicit current/live window wins over historical telemetry from
    // an earlier model or branch.
    details.contextWindow = usageSnapshot.contextWindow ?? contextStats?.window;
    details.autoCompactionEnabled = usageSnapshot.autoCompactionEnabled;
    details.usingSubscription = usageSnapshot.usingSubscription;
    if (contextStats) {
      details.contextStats = { ...contextStats };
      details.contextCurrent = contextStats.current;
      details.contextLastKnown = contextStats.lastKnown;
      details.contextPeak = contextStats.peak;
      details.contextCount = contextStats.count;
    }
    details.durationMs = elapsedMs;
    details.compactions = continuation?.compactionCount ?? record.stats.compactionCount;
    details.compactionCount = continuation?.compactionCount ?? record.stats.compactionCount;
    details.modelName = record.display.invocation?.modelName;
    // The session is the source of truth: Pi may normalize the requested
    // invocation level for the selected model when it creates the session.
    details.thinkingLevel = record.execution.session?.thinkingLevel ?? record.display.invocation?.thinkingLevel;
    details.cost = usage?.cost ?? record.stats.lifetimeUsage.cost;
    // Only the current execution's compact delta/result is exposed: never
    // execution history, execution ids, timestamps, or prior responses. The
    // caller authored the current prompt and can recover earlier context from
    // the record itself.
    if (current) {
      details.currentExecution = {
        kind: currentKind,
        status: current.status,
        ...(current.responseText !== undefined ? { responseText: retainAgentText(current.responseText) } : {}),
        ...(current.usage !== undefined ? { usage: current.usage } : {}),
        ...(current.compactionCount !== undefined ? { compactionCount: current.compactionCount } : {}),
        ...(current.error !== undefined ? { error: retainAgentError(current.error) } : {}),
      };
    }
  }

  return details;
}
