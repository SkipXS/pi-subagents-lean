/**
 * Execution-scoped telemetry collaborator for AgentManager.
 *
 * Records remain owned by AgentManager. This module only owns the bookkeeping
 * needed to update their execution statistics and to reject callbacks from an
 * execution that is no longer the active one.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  AgentExecutionSummary,
  AgentRecord,
  CompactionInfo,
  CompactionReasonMetadata,
  ToolActivity,
} from "../types.js";
import {
  addUsage,
  createContextStats,
  getSessionUsageSnapshot,
  observeContextStats,
  readSessionContextUsage,
  type AgentUsage,
  type SessionStatsContextUsage,
} from "./usage.js";
import { capUtf8Strings } from "../utils.js";

/** Maximum number of newest compaction metadata entries retained per record. */
export const MAX_RETAINED_COMPACTION_REASONS = 128;
/** Maximum UTF-8 bytes for each string field in retained compaction metadata. */
export const MAX_COMPACTION_REASON_TEXT_BYTES = 8 * 1024;

export interface ExecutionBaseline {
  usage: AgentUsage;
  compactionCount: number;
}

export interface ExecutionTelemetryCallbackOptions {
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: AgentUsage) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

export interface ExecutionTelemetryCallbacks {
  onToolActivity: (activity: ToolActivity) => void;
  onAssistantUsage: (usage: AgentUsage) => void;
  onSupplementalUsage: (usage: AgentUsage) => void;
  onCompaction: (info: CompactionInfo) => void;
}

export type RecordOwnershipGuard = (record: AgentRecord) => boolean;

export class ExecutionTelemetry {
  private readonly executionBases = new Map<string, ExecutionBaseline>();
  private readonly deferredContextSamples = new WeakMap<AgentRecord, AgentSession>();

  constructor(private readonly ownsRecord: RecordOwnershipGuard) {}

  /** Initialize optional telemetry collections on a newly accepted record. */
  initializeRecord(record: AgentRecord): void {
    record.stats.contextStats ??= createContextStats();
    record.stats.compactionReasons = capCompactionReasons(record.stats.compactionReasons);
  }

  /** Capture and retain the cumulative baseline for one accepted execution. */
  beginExecution(executionId: string, record: AgentRecord): ExecutionBaseline {
    const baseline = this.snapshotBaseline(record);
    this.executionBases.set(executionId, baseline);
    return baseline;
  }

  snapshotBaseline(record: AgentRecord): ExecutionBaseline {
    return {
      usage: {
        input: record.stats.lifetimeUsage.input,
        output: record.stats.lifetimeUsage.output,
        cacheWrite: record.stats.lifetimeUsage.cacheWrite,
        cost: record.stats.lifetimeUsage.cost,
        cacheRead: record.stats.cacheRead,
      },
      compactionCount: record.stats.compactionCount,
    };
  }

  /** Compute a non-negative per-execution delta from the retained baseline. */
  delta(
    record: AgentRecord,
    executionId: string,
    baseline?: ExecutionBaseline,
  ): ExecutionBaseline | undefined {
    const base = baseline ?? this.executionBases.get(executionId);
    if (!base) return undefined;
    return {
      usage: {
        input: Math.max(0, record.stats.lifetimeUsage.input - base.usage.input),
        output: Math.max(0, record.stats.lifetimeUsage.output - base.usage.output),
        cacheWrite: Math.max(0, record.stats.lifetimeUsage.cacheWrite - base.usage.cacheWrite),
        cacheRead: Math.max(0, record.stats.cacheRead - base.usage.cacheRead),
        cost: Math.max(0, record.stats.lifetimeUsage.cost - base.usage.cost),
      },
      compactionCount: Math.max(0, record.stats.compactionCount - base.compactionCount),
    };
  }

  forgetExecution(executionId: string): void {
    this.executionBases.delete(executionId);
  }

  forgetRecord(record: AgentRecord): void {
    this.deferredContextSamples.delete(record);
    for (const execution of record.stats.executions ?? []) this.forgetExecution(execution.id);
  }

  finalizeUnstartedExecution(execution: AgentExecutionSummary): void {
    execution.usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
    execution.compactionCount = 0;
  }

  /** Current ownership guard used by setup, stream, and telemetry callbacks. */
  isCurrentRecord(record: AgentRecord): boolean {
    return this.ownsRecord(record);
  }

  /** Reject callbacks from an old execution after a continuation is accepted. */
  isActiveExecution(record: AgentRecord, executionId: string): boolean {
    return this.ownsRecord(record) && record.stats.executions?.at(-1)?.id === executionId;
  }

  createCallbacks(
    record: AgentRecord,
    options: ExecutionTelemetryCallbackOptions = {},
    executionId?: string,
  ): ExecutionTelemetryCallbacks {
    const isActive = (): boolean => executionId === undefined || this.isActiveExecution(record, executionId);
    return {
      onToolActivity: (activity) => {
        if (!isActive()) return;
        options.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        if (!isActive()) return;
        this.addUsage(record, usage);
        options.onAssistantUsage?.(usage);
        this.deferContextSample(record, executionId);
      },
      onSupplementalUsage: (usage) => {
        if (!isActive()) return;
        this.addUsage(record, usage);
      },
      onCompaction: (info) => {
        if (!isActive()) return;
        record.stats.compactionCount++;
        this.persistCompactionReason(record, info);
        this.observeContext(record);
        options.onCompaction?.(info);
      },
    };
  }

  observeContext(record: AgentRecord, skipUnchanged = false): void {
    const session = record.execution.session;
    if (!session || !this.isCurrentRecord(record)) return;
    if (this.deferredContextSamples.get(record) === session) this.deferredContextSamples.delete(record);
    const contextRead = readSessionContextUsage(session);
    if (!contextRead.failed) this.recordContextSample(record, contextRead.usage, skipUnchanged);
    const snapshot = getSessionUsageSnapshot(session, contextRead.usage);
    this.persistContextSnapshot(record, snapshot, !contextRead.failed && contextRead.usage !== undefined);
  }

  private addUsage(record: AgentRecord, usage: AgentUsage): void {
    addUsage(record.stats.lifetimeUsage, usage);
    record.stats.cacheRead += usage.cacheRead;
    this.updateCumulativeCacheHitRate(record);
  }

  private updateCumulativeCacheHitRate(record: AgentRecord): void {
    const { lifetimeUsage, cacheRead } = record.stats;
    const promptTokens = lifetimeUsage.input + cacheRead + lifetimeUsage.cacheWrite;
    record.stats.latestCacheHitRate = promptTokens > 0
      ? (cacheRead / promptTokens) * 100
      : undefined;
  }

  private recordContextSample(
    record: AgentRecord,
    usage: SessionStatsContextUsage | undefined,
    skipUnchanged = false,
  ): void {
    if (!usage) return;
    const stats = record.stats.contextStats ??= createContextStats();
    if (skipUnchanged && stats.count > 0 && stats.current === usage.percent && stats.window === usage.contextWindow) {
      record.stats.contextPercent = stats.current;
      record.stats.contextWindow = stats.window;
      return;
    }
    observeContextStats(stats, usage);
    record.stats.contextPercent = stats.current;
    record.stats.contextWindow = stats.window;
  }

  private persistContextSnapshot(
    record: AgentRecord,
    snapshot: ReturnType<typeof getSessionUsageSnapshot>,
    contextSampled: boolean,
  ): void {
    if (!snapshot) return;
    if (contextSampled) record.stats.contextPercent = snapshot.contextPercent;
    if (typeof snapshot.contextWindow === "number") record.stats.contextWindow = snapshot.contextWindow;
    else if (record.stats.contextStats?.window !== undefined) record.stats.contextWindow = record.stats.contextStats.window;
    if (typeof snapshot.autoCompactionEnabled === "boolean") record.stats.autoCompactionEnabled = snapshot.autoCompactionEnabled;
    if (typeof snapshot.usingSubscription === "boolean") record.stats.usingSubscription = snapshot.usingSubscription;
  }

  private deferContextSample(record: AgentRecord, executionId?: string): void {
    const session = record.execution.session;
    if (!session) return;
    const pending = this.deferredContextSamples.get(record);
    if (pending === session) return;
    if (pending) this.deferredContextSamples.delete(record);
    this.deferredContextSamples.set(record, session);
    queueMicrotask(() => {
      if (this.deferredContextSamples.get(record) !== session) return;
      this.deferredContextSamples.delete(record);
      if (!this.isCurrentRecord(record) || record.lifecycle.settled || record.lifecycle.status !== "running") return;
      if (record.execution.session !== session) return;
      if (executionId !== undefined && !this.isActiveExecution(record, executionId)) return;
      this.observeContext(record);
    });
  }

  private persistCompactionReason(record: AgentRecord, info: CompactionInfo): void {
    const metadata: CompactionReasonMetadata = {
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      ...(info.summary !== undefined ? { summary: info.summary } : {}),
      ...(info.firstKeptEntryId !== undefined ? { firstKeptEntryId: info.firstKeptEntryId } : {}),
    };
    try {
      const leaf = record.execution.session?.sessionManager?.getLeafEntry();
      if (
        leaf?.type === "compaction"
        && typeof leaf.id === "string"
        && leaf.tokensBefore === info.tokensBefore
        && (info.summary === undefined || leaf.summary === info.summary)
        && (info.firstKeptEntryId === undefined || leaf.firstKeptEntryId === info.firstKeptEntryId)
      ) metadata.entryId = leaf.id;
    } catch { /* optional session-manager fields */ }
    const reasons = capCompactionReasons(record.stats.compactionReasons);
    reasons.push(capUtf8Strings(metadata, MAX_COMPACTION_REASON_TEXT_BYTES));
    record.stats.compactionReasons = reasons.slice(-MAX_RETAINED_COMPACTION_REASONS);
  }
}

function capCompactionReasons(raw: unknown): CompactionReasonMetadata[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-MAX_RETAINED_COMPACTION_REASONS)
    .map((entry) => capUtf8Strings(entry, MAX_COMPACTION_REASON_TEXT_BYTES)) as CompactionReasonMetadata[];
}
