import { getPiInstance, getSessionCtx, getStore, getSubagentRuntimeContext } from "../shell.js";
import { resolveAgentTunables } from "../models/agent-resolution.js";
import { getStatusNote } from "../status-note.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentExecutionSummary, AgentRecord, AgentStatus, SpawnConfig } from "../types.js";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.js";
import type { SubagentRuntimeSettings } from "../config/config-store.js";
import type { ResolvedSpawn } from "./spawn-contract.js";
import { getAgentConfig, resolveType, snapshotAgentConfig } from "../agents/agent-types.js";
import { buildAgentDetails } from "../agents/agent-details.js";
import { executionKind, formatAgentStatusLine } from "../agents/execution-display.js";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for the LLM tool spawn path. It owns background-result
 * delivery; AgentManager owns execution and records.
 */
/**
 * Legacy input for direct coordinator callers. The regular Agent tool passes a
 * ResolvedSpawn directly instead of duplicating these fields beside it.
 */
export interface LegacySpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /** Parent abort signal forwarded to the agent manager. */
  signal?: AbortSignal;
  /** Runtime settings snapshot captured by callers that resolve fields before entering the coordinator. */
  runtimeSettingsSnapshot?: SubagentRuntimeSettings;
  /** Transitional adapter for callers from the pre-unified contract shape. */
  resolvedSpawn?: ResolvedSpawn;
}

/** Transitional wrapper retained for callers migrating from the old intent shape. */
export interface ResolvedSpawnIntent {
  resolvedSpawn: ResolvedSpawn;
}

/** Normal authoritative input or one of the explicitly retained adapters. */
export type SpawnIntent = ResolvedSpawn | LegacySpawnIntent | ResolvedSpawnIntent;

function isResolvedSpawn(intent: SpawnIntent): intent is ResolvedSpawn {
  return "runtimeSettings" in intent && intent.runtimeSettings !== undefined;
}

function resolvedSpawnFromIntent(intent: SpawnIntent): ResolvedSpawn | undefined {
  if (isResolvedSpawn(intent)) return intent;
  return "resolvedSpawn" in intent ? intent.resolvedSpawn : undefined;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
}

/** Input for continueAgent(). Built by the AgentContinue tool executor. */
export interface ContinueIntent {
  agentId: string;
  prompt: string;
  runInBackground: boolean;
  /** Parent abort signal forwarded to the agent manager. */
  signal?: AbortSignal;
}

export interface ContinueResult {
  executionId: string;
  record: AgentRecord;
}

/** Short delay before each automatic background-result delivery (ms). */
const NUDGE_DELAY_MS = 200;

/** Immutable payload captured at one execution's completion boundary. */
interface BackgroundPayload {
  /** Resolved full record id; delivery never echoes a caller's short prefix. */
  agentId: string;
  type: string;
  /** Terminal status of this execution, frozen at completion. */
  status: AgentStatus;
  /** Result text frozen at completion; a later execution can never overwrite it. */
  result: string;
  /** Prebuilt message content frozen at completion. */
  content: string;
  details: Record<string, unknown>;
}

/**
 * Authoritative per-execution background delivery state.
 *
 * Everything one execution needs for its single automatic delivery — immutable
 * payload, timer, attempt state, in-flight guard, and parent-abort binding —
 * is keyed by the execution id, so a stale timer or callback can never send a
 * later execution's mutable `record.result`. `record.delivery` remains only a
 * public projection of the latest execution.
 */
interface BackgroundDeliveryEntry {
  /** Manager-assigned execution id; every claim is execution-scoped. */
  executionId: string;
  agentId: string;
  payload?: BackgroundPayload;
  signal?: AbortSignal;
  onParentAbort?: () => void;
  state: "pending" | "accepted" | "failed" | "abandoned";
  /** True once the runner reported completion and delivery may be scheduled. */
  completed: boolean;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** Claims the single automatic delivery attempt. */
  autoNudgeIssued: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Return whether a record has reached a terminal lifecycle status. */
function isTerminal(record: AgentRecord): boolean {
  return record.lifecycle.status !== "running" && record.lifecycle.status !== "queued";
}

function deliveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SpawnCoordinator {
  /** Authoritative per-execution background delivery state. */
  private backgroundDeliveries = new Map<string, BackgroundDeliveryEntry>();

  /** Latest claimed execution per record, retained after accepted entries are cleared. */
  private latestDeliveryKeys = new Map<string, string>();

  /** Set during dispose to prevent delivery through a stale Pi instance. */
  private disposed = false;

  constructor(private manager: AgentManager) {}

  /** Spawn + wire tracking + (foreground) await. */
  async spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
    onAccepted?: (record: AgentRecord) => void,
  ): Promise<SpawnResult> {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }
    return this.spawnInternal(pi, ctx, intent, onAccepted);
  }

  private async spawnInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
    onAccepted?: (record: AgentRecord) => void,
  ): Promise<SpawnResult> {
    let runInBackground: boolean;
    let signal: AbortSignal | undefined;
    let agentId: string;
    const resolvedSpawn = resolvedSpawnFromIntent(intent);

    if (resolvedSpawn) {
      // The regular Agent tool has already completed discovery, worktree
      // preflight, settings capture, and model/thinking resolution. Pass that
      // authoritative contract to AgentManager; it is the sole acceptance
      // boundary that turns ResolvedSpawn into AcceptedSpawn.
      runInBackground = resolvedSpawn.runInBackground;
      signal = resolvedSpawn.signal;
      agentId = this.manager.spawn(pi, ctx, resolvedSpawn);
    } else {
      // Narrow compatibility adapter for direct coordinator callers that have
      // not migrated to the authoritative contract yet. This is the only
      // coordinator path allowed to retain registry/config/model resolution.
      const legacyIntent = intent as LegacySpawnIntent;
      const runtimeSettings = legacyIntent.runtimeSettingsSnapshot ?? getStore().createSubagentRuntimeSettings();
      const canonicalType = resolveType(legacyIntent.type) ?? legacyIntent.type;
      const selectedConfig = legacyIntent.agentConfig ?? getAgentConfig(canonicalType);
      const agentConfig = selectedConfig ? snapshotAgentConfig(selectedConfig) : undefined;
      const resolvedTunables = resolveAgentTunables({
        agentName: canonicalType,
        agentConfig,
        overrides: runtimeSettings.agents,
        modelRegistry: ctx.modelRegistry,
        parentModel: ctx.model,
        parentThinking: ctx.thinkingLevel,
        baseModel: legacyIntent.model,
        requestedThinking: legacyIntent.thinkingLevel,
      });
      const model = resolvedTunables.model;
      const thinkingLevel = resolvedTunables.thinkingLevel;
      const modelKey = resolvedTunables.modelKey ?? legacyIntent.modelKey;
      const {
        type: legacyType,
        prompt: legacyPrompt,
        runInBackground: legacyRunInBackground,
        signal: legacySignal,
        runtimeSettingsSnapshot: _runtimeSettingsSnapshot,
        resolvedSpawn: _resolvedSpawn,
        ...legacyConfig
      } = legacyIntent;
      runInBackground = legacyRunInBackground;
      signal = legacySignal;
      agentId = this.manager.spawn(pi, ctx, legacyType, legacyPrompt, {
        ...legacyConfig,
        signal,
        model,
        modelKey,
        thinkingLevel,
        projectTrusted: legacyIntent.projectTrusted === true,
        agentConfig,
        invocation: {
          ...legacyIntent.invocation,
          ...(modelKey !== undefined ? { modelKey } : {}),
          thinkingLevel,
        },
        isBackground: runInBackground,
        runtimeSettings,
      });
    }
    const record = this.manager.getRecord(agentId)!;
    // Foreground callers await below, so publish the accepted record's full ID
    // before that await. Rendering is observational and must never affect the
    // accepted execution if a host-side observer fails.
    if (!runInBackground && onAccepted) {
      try {
        onAccepted(record);
      } catch {
        // Render observers are best-effort and cannot change spawn semantics.
      }
    }
    const executionId = record.stats.executions?.[0]?.id;
    if (runInBackground && executionId) {
      // The initial spawn is execution 0. Claims are deliberately keyed only
      // by the manager-issued execution id.
      this.claimBackgroundDelivery(record, executionId, signal);
    }

    if (isTerminal(record)) {
      // A synchronous terminal start can complete before the claim above was
      // installed. Reconcile that terminal execution after claiming it so the
      // completion still gets exactly one delivery attempt.
      if (runInBackground) {
        this.reconcileBackgroundClaim(record, executionId);
      } else {
        record.lifecycle.resultConsumed = true;
      }
      return { agentId, record };
    }

    if (runInBackground) {
      // The delivery claim above is the only background tracking needed.
    } else {
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
    }

    return { agentId, record };
  }

  /**
   * Continue an existing agent's session. Foreground callers await their own
   * execution; background callers return immediately and receive a per-execution
   * completion notification through the normal delivery path.
   */
  async continueAgent(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: ContinueIntent,
  ): Promise<ContinueResult> {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent continuation is unavailable from a child runtime");
    }
    const { executionId, record, promise } = this.manager.continueAgent(intent.agentId, intent.prompt, {
      isBackground: intent.runInBackground,
      signal: intent.signal,
    });

    if (intent.runInBackground) {
      // Fresh per-execution delivery state; an earlier execution's state is
      // already consumed or still delivering under its own execution key.
      record.delivery = { state: "pending", attempts: 0 };
      record.lifecycle.resultConsumed = false;
      this.claimBackgroundDelivery(record, executionId, intent.signal);
      // The manager can finish a synchronous startup before this claim exists.
      // Reconcile the terminal summary against the fresh execution claim; the
      // per-execution guard makes a callback/timer race exactly-once.
      this.reconcileBackgroundClaim(record, executionId);
      // Background callers never await this promise (a queued stop rejects
      // it), so observe the rejection here as well as at the manager.
      promise.catch(() => {});
    }
    if (!intent.runInBackground) {
      try {
        await promise;
      } finally {
        // Even a rejected continuation (stopped/cancelled while queued) is
        // consumed by the caller's error result.
        record.lifecycle.resultConsumed = true;
      }
    }
    return { executionId, record };
  }

  /** Check if an agent still has a background execution awaiting completion. */
  isBackground(agentId: string): boolean {
    return this.entriesFor(agentId).some((entry) => !entry.completed);
  }

  /**
   * Request the sole automatic delivery attempt for a background completion.
   * Kept public for existing callers/tests; duplicate requests are deliberately
   * ignored, including after a failed attempt.
   */
  scheduleNudge(agentId: string): void {
    const record = this.manager.getRecord(agentId);
    const entry = this.latestDelivery(agentId);
    if (this.disposed || !entry || !record || !isTerminal(record) || entry.state !== "pending") return;
    entry.completed = true;
    const executions = record.stats.executions;
    const retained = executions?.find((candidate) => candidate.id === entry.executionId) ?? executions?.at(-1);
    const index = retained ? (executions?.indexOf(retained) ?? 0) : 0;
    const execution: AgentExecutionSummary = retained
      ? {
        ...retained,
        kind: executionKind(retained, index),
        status: record.lifecycle.status,
        responseText: record.result ?? retained.responseText,
      }
      : {
        id: entry.executionId,
        prompt: "",
        mode: "background",
        kind: "new",
        status: record.lifecycle.status,
        startedAt: record.lifecycle.startedAt,
        responseText: record.result,
      };
    entry.payload ??= this.capturePayload(record, execution);
    this.scheduleEntry(entry);
  }

  /** Called by AgentManager's completion callback, once per executed turn. */
  onAgentComplete(record: AgentRecord, execution: AgentExecutionSummary): void {
    // Every background execution gets exactly one automatic delivery attempt,
    // keyed by its own execution id so repeated continuations can never reuse
    // a stale claim or read a later execution's mutable result.
    if (execution.mode === "background") {
      const entry = this.backgroundDeliveries.get(execution.id);
      if (!entry || entry.completed) return;
      entry.completed = true;
      entry.payload = this.capturePayload(record, execution);
      if (this.disposed || entry.signal?.aborted) {
        this.abandonBackgroundDelivery(entry, record);
        return;
      }
      this.scheduleEntry(entry);
      return;
    }
  }

  /** Reconcile a claim installed after a synchronous terminal completion. */
  private reconcileBackgroundClaim(record: AgentRecord, executionId?: string): void {
    if (!executionId) return;
    const execution = record.stats.executions?.find((candidate) => candidate.id === executionId);
    if (!execution || execution.status === "running" || execution.status === "queued") return;
    this.onAgentComplete(record, execution);
  }

  /** Dispose without delivering any retained pending or failed result. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.backgroundDeliveries.values()) {
      if (entry.state === "pending" || entry.state === "failed") {
        this.abandonBackgroundDelivery(entry, this.manager.getRecord(entry.agentId));
      } else {
        this.clearEntry(entry, true);
      }
    }
    this.backgroundDeliveries.clear();
    this.latestDeliveryKeys.clear();
  }

  /** Register one background execution's delivery claim at acceptance. */
  private claimBackgroundDelivery(record: AgentRecord, executionId: string, signal?: AbortSignal): void {
    const entry: BackgroundDeliveryEntry = {
      executionId,
      agentId: record.id,
      signal,
      state: "pending",
      completed: false,
      attempts: 0,
      autoNudgeIssued: false,
      timer: null,
    };
    this.backgroundDeliveries.set(entry.executionId, entry);
    this.latestDeliveryKeys.set(record.id, entry.executionId);
    record.delivery ??= { state: "pending", attempts: 0 };
    this.trackBackgroundParentAbort(entry, record);
  }

  /** Keep each execution's delivery tied to its parent turn until acceptance or session shutdown. */
  private trackBackgroundParentAbort(entry: BackgroundDeliveryEntry, record: AgentRecord): void {
    const signal = entry.signal;
    if (!signal) return;
    if (signal.aborted) {
      // AbortSignal does not dispatch a past abort event; abandon immediately.
      this.abandonBackgroundDelivery(entry, record);
      return;
    }
    entry.onParentAbort = () => this.abandonBackgroundDelivery(entry, this.manager.getRecord(entry.agentId));
    signal.addEventListener("abort", entry.onParentAbort, { once: true });
  }

  private removeParentAbortListener(entry: BackgroundDeliveryEntry): void {
    if (!entry.signal || !entry.onParentAbort) return;
    entry.signal.removeEventListener("abort", entry.onParentAbort);
    entry.onParentAbort = undefined;
  }

  /** Parent/dispose abandonment is terminal and deliberately has no retry path. */
  private abandonBackgroundDelivery(entry: BackgroundDeliveryEntry, record?: AgentRecord): void {
    if (entry.state !== "accepted") {
      entry.state = "abandoned";
      if (record) {
        // Only the latest execution owns the record's projection and consumption flag.
        if (this.isLatestDelivery(record.id, entry)) {
          this.projectDelivery(record, entry);
          record.lifecycle.resultConsumed = true;
        }
      }
    }
    this.clearEntry(entry, true);
  }

  /** Clear transient tracking; failed delivery entries remain until session shutdown. */
  private clearEntry(entry: BackgroundDeliveryEntry, clearParent: boolean): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (clearParent) {
      this.removeParentAbortListener(entry);
      this.backgroundDeliveries.delete(entry.executionId);
    }
  }

  /** All delivery entries for one record, in claim order. */
  private entriesFor(agentId: string): BackgroundDeliveryEntry[] {
    return [...this.backgroundDeliveries.values()].filter((entry) => entry.agentId === agentId);
  }

  /** The most recently claimed delivery entry for a record, if any. */
  private latestDelivery(agentId: string): BackgroundDeliveryEntry | undefined {
    const entries = this.entriesFor(agentId);
    return entries.length > 0 ? entries[entries.length - 1] : undefined;
  }

  private isLatestDelivery(agentId: string, entry: BackgroundDeliveryEntry): boolean {
    return this.latestDeliveryKeys.get(agentId) === entry.executionId;
  }

  /** Mirror one execution's delivery state onto the record projection. */
  private projectDelivery(record: AgentRecord, entry: BackgroundDeliveryEntry): void {
    if (!this.isLatestDelivery(record.id, entry)) return;
    record.delivery = {
      state: entry.state,
      attempts: entry.attempts,
      ...(entry.lastAttemptAt !== undefined ? { lastAttemptAt: entry.lastAttemptAt } : {}),
      ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
    };
  }

  /** Freeze the completion-time payload; delivery never re-reads the mutable record. */
  private capturePayload(record: AgentRecord, execution: AgentExecutionSummary): BackgroundPayload {
    const executions = record.stats.executions;
    const index = executions?.indexOf(execution) ?? 0;
    const kind = executionKind(execution, index);
    const result = execution.responseText ?? record.result ?? "";
    return {
      agentId: record.id,
      type: record.display.type,
      status: execution.status,
      result,
      content: `${formatAgentStatusLine(record.id, record.display.type, execution.status, {
        mode: execution.mode,
        kind,
      })}\n\nResponse:\n${result}${getStatusNote({ ...record.lifecycle, status: execution.status })}`,
      details: buildAgentDetails(record, { includeStats: true, includeStatus: true, execution }),
    };
  }

  /** Claim and arm the one automatic delivery attempt for a completed execution. */
  private scheduleEntry(entry: BackgroundDeliveryEntry): void {
    if (this.disposed || entry.state !== "pending" || !entry.completed || entry.autoNudgeIssued) return;
    entry.autoNudgeIssued = true;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.deliver(entry);
    }, NUDGE_DELAY_MS);
  }

  /** Attempt the one automatic delivery for a completed execution. */
  private deliver(entry: BackgroundDeliveryEntry): void {
    if (this.disposed) return;
    const record = this.manager.getRecord(entry.agentId);
    if (!record) {
      this.clearEntry(entry, true);
      return;
    }
    if (entry.state !== "pending") return;
    if (entry.signal?.aborted) {
      this.abandonBackgroundDelivery(entry, record);
      return;
    }

    entry.attempts++;
    entry.lastAttemptAt = Date.now();
    delete entry.lastError;
    try {
      const pi = getPiInstance();
      if (!pi) throw new Error("Pi instance unavailable for background result delivery");
      // Check immediately before the irreversible handoff as well as before
      // preparation, so a queued timer can never send after parent/dispose.
      if (this.disposed || entry.signal?.aborted) {
        this.abandonBackgroundDelivery(entry, record);
        return;
      }

      const payload = entry.payload;
      if (!payload) throw new Error("Background result payload is unavailable");
      const parentIdle = getSessionCtx()?.isIdle?.() ?? true;
      pi.sendMessage(
        {
          customType: "subagent-result",
          content: payload.content,
          details: payload.details,
          display: true,
        },
        { deliverAs: parentIdle ? "followUp" : "steer", triggerTurn: true },
      );

      // This intentionally means only that Pi did not synchronously throw. It
      // is not an LLM/provider delivery confirmation.
      entry.state = "accepted";
      // deliveredText records an actual handoff only — never completion.
      const execution = record.stats.executions?.find((e) => e.id === entry.executionId);
      if (execution) execution.deliveredText = payload.result;
      // Only the latest execution owns the record's consumption flag.
      if (this.isLatestDelivery(record.id, entry)) record.lifecycle.resultConsumed = true;
      this.projectDelivery(record, entry);
      this.clearEntry(entry, true);
    } catch (error) {
      // Keep the result and record the sendMessage failure diagnostically until
      // session shutdown; there is no automatic or manual retry path.
      entry.state = "failed";
      entry.lastError = deliveryErrorMessage(error);
      this.projectDelivery(record, entry);
      this.clearEntry(entry, false);
    }
  }
}
