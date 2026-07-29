/**
 * agent-manager.ts — Tracks agents, global concurrency, background execution.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent-runner.js";
import { AgentOutputLog } from "./output-file.js";
import {
  type AgentRecord,
  type AgentStatus,
  type CompactionInfo,
  type RunCallbacks,
  type StopInitiator,
  SHORT_ID_LENGTH,
  type SpawnConfig,
  type ToolActivity,
} from "../types.js";
import { snapshotAgentConfig } from "./agent-types.js";
import type { SubagentType } from "./types.js";
import { addUsage, getLifetimeTotal, getSessionUsageSnapshot, type AgentUsage } from "./usage.js";
import { errorMessage } from "../utils.js";

/** How often to check for expired agent records (milliseconds). */
const CLEANUP_INTERVAL_MS = 60_000;

/** Age after which a completed agent record is evicted (milliseconds). Default: 10 min. */
const DEFAULT_RETENTION_MINUTES = 10;

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;



/** Default global concurrency limit when not specified in config. */
const DEFAULT_CONCURRENCY_LIMIT = 4;

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

/** Configuration for the global concurrency limit. */
export interface ConcurrencyConfig {
  default: number;
}

export type OnAgentComplete = (record: AgentRecord) => void;
type OnAgentStart = (record: AgentRecord) => void;

/** Internal global concurrency state. */
interface ConcurrencySlot {
  limit: number;
  running: number;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions extends SpawnConfig, RunCallbacks {
  isBackground?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;

  /** Session-level cumulative agent cost. Survives agent eviction. */
  private totalAgentCost = 0;

  /** Session-level cumulative accepted agent count. Survives agent eviction. */
  private totalAgentCount = 0;

  /** Retention cutoff in minutes for finished agents. Updated at runtime via setRetentionMinutes. */
  private retentionMinutes = DEFAULT_RETENTION_MINUTES;

  /** All agents share one concurrency slot, regardless of model. */
  private concurrencySlot: ConcurrencySlot;

  /** Queue of agents waiting to start, including completion for foreground waiters. */
  private queue: { id: string; args: SpawnArgs; resolve: (result: string) => void }[] = [];

  /** Parent-signal listeners, retained so they can be removed at terminal states. */
  private parentAbortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
    private bufferSize: number = 0,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.concurrencySlot = {
      limit: Math.max(1, concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT),
      running: 0,
    };

    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  /** Update the age cutoff for finished agent retention (minutes). Takes effect at the next cleanup tick. */
  setRetentionMinutes(minutes: number): void {
    this.retentionMinutes = Math.max(1, minutes);
  }

  /** Update the global concurrency limit and immediately drain the queue. */
  setConcurrency(config: ConcurrencyConfig): void {
    this.concurrencySlot.limit = Math.max(1, config.default);
    this.drainQueue();
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the global concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const abortController = new AbortController();
    // Copy mutable frontmatter arrays before this request can sit in the queue.
    const frozenOptions = options.agentConfig
      ? { ...options, agentConfig: snapshotAgentConfig(options.agentConfig) }
      : options;
    const args: SpawnArgs = { pi, ctx, type, prompt, options: frozenOptions };

    // Check global concurrency — applies to every foreground and background agent.
    const queued = this.concurrencySlot.running >= this.concurrencySlot.limit;
    let resolveQueued: ((result: string) => void) | undefined;
    const queuedPromise = queued
      ? new Promise<string>((resolve) => { resolveQueued = resolve; })
      : undefined;

    const record: AgentRecord = {
      id,
      lifecycle: {
        status: queued ? "queued" : "running",
        startedAt: Date.now(),
      },
      display: {
        type,
        description: options.description,
        invocation: options.invocation,
        worktreePath: options.worktreePath,
        worktreeLabel: options.worktreeLabel,
      },
      execution: {
        abortController,
        promise: queuedPromise,
      },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        turnCount: 1,
        compactionCount: 0,
        cacheRead: 0,
        maxTurns: options.maxTurns,
      },
    };
    this.agents.set(id, record);

    // Add a queued entry before binding the parent signal: an already-aborted
    // signal must be able to remove and settle it immediately.
    if (queued) {
      this.queue.push({ id, args, resolve: resolveQueued! });
      this.bindParentAbortSignal(id, options.signal);
      this.totalAgentCount++;
      return id;
    }

    this.bindParentAbortSignal(id, options.signal);
    // AbortSignal does not dispatch a past abort event, so bindParentAbortSignal
    // stops an already-aborted parent synchronously. Do not start it afterwards.
    if (record.lifecycle.status !== "running") {
      // No runner was created to reach startAgent's completion handler.
      this.safeNotifyComplete(record);
      this.totalAgentCount++;
      return id;
    }

    // startAgent can throw — clean up record so callers don't see an orphan.
    // Count only after a synchronous start succeeds.
    try {
      this.startAgent(id, record, args, this.concurrencySlot);
    } catch (err) {
      this.concurrencySlot.running--;
      this.clearParentAbortSignal(id);
      this.agents.delete(id);
      this.drainQueue();
      throw err;
    }
    this.totalAgentCount++;
    return id;
  }

  /**
   * Actually start an agent (called immediately or from queue drain).
   * The global slot's running count is incremented on start and decremented in finally.
   */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    concurrencySlot: ConcurrencySlot,
  ) {
    concurrencySlot.running++;

    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();

    // Output logs are optional telemetry. A filesystem failure must not prevent
    // the agent from running or hold a queue slot.
    try {
      record.execution.outputLog = new AgentOutputLog(id, prompt, undefined, this.bufferSize);
      record.display.outputFile = record.execution.outputLog.path;
    } catch { /* ignore output-log initialization failures */ }

    this.onStart?.(record);

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      agentConfig: options.agentConfig,
      model: options.model,
      maxTurns: options.maxTurns,
      maxTokens: options.maxTokens,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      graceTurns: options.graceTurns,
      signal: record.execution.abortController!.signal,
      ...this.createRecordCallbacks(record, options),
      onTurnEnd: (turnCount) => {
        record.stats.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: options.onTextDelta,
      onSessionCreated: (session) => {
        record.execution.session = session;
        // Flush any steers that arrived before the session was ready
        if (record.execution.pendingSteers?.length) {
          for (const msg of record.execution.pendingSteers) {
            session.steer(msg).catch(() => {
              // Steer is advisory — a failure here (e.g. session already aborting)
              // is fine; the user can re-send if needed.
            });
          }
          record.execution.pendingSteers = undefined;
        }
        // Attach output log stream to session
        if (record.execution.outputLog) {
          record.execution.outputLog.attach(session);
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, turnLimited }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = aborted ? "aborted" : turnLimited ? "turn_limited" : "completed";
        }
        record.result = responseText;
        record.execution.session = session;
        record.lifecycle.completedAt ??= Date.now();
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = "error";
        }
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        return "";
      })
      .finally(() => {
        // Session handles are not guaranteed to remain usable after completion,
        // so retain the footer values that terminal cards need before cleanup.
        const snapshot = getSessionUsageSnapshot(record.execution.session);
        if (snapshot) {
          record.stats.contextPercent = snapshot.contextPercent;
          record.stats.contextWindow = snapshot.contextWindow;
          record.stats.autoCompactionEnabled = snapshot.autoCompactionEnabled;
          record.stats.usingSubscription = snapshot.usingSubscription;
        }

        // Finalize output log with final stats
        if (record.execution.outputLog) {
          try {
            record.execution.outputLog.finalize({
              turnCount: record.stats.turnCount ?? 0,
              toolUseCount: record.stats.toolUses,
              totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
              cost: record.stats.lifetimeUsage.cost,
            });
          } catch { /* ignore */ }
          record.execution.outputLog = undefined;
        }

        // Decrement global concurrency count
        concurrencySlot.running--;
        this.clearParentAbortSignal(id);

        this.safeNotifyComplete(record);
        this.drainQueue();
      });

    record.execution.promise = promise;
    return promise;
  }

  /** Notify completion callback, ignoring any errors. */
  private safeNotifyComplete(record: AgentRecord): void {
    this.totalAgentCost += record.stats.lifetimeUsage.cost;
    try { this.onComplete?.(record); } catch { /* ignore */ }
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  /** Get the session-level cumulative agent cost. Survives agent eviction. */
  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  /** Get the session-level cumulative accepted agent count. Survives agent eviction. */
  getTotalAgentCount(): number {
    return this.totalAgentCount;
  }

  /**
   * Build common record-tracking callbacks shared by startAgent.
   * Updates the record's toolUses, lifetimeUsage, and compactionCount.
   * When options are provided, also forwards events to the caller.
   */
  private createRecordCallbacks(
    record: AgentRecord,
    options?: Pick<SpawnOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
  ): {
    onToolActivity: (activity: ToolActivity) => void;
    onAssistantUsage: (usage: AgentUsage) => void;
    onSupplementalUsage: (usage: AgentUsage) => void;
    onCompaction: (info: CompactionInfo) => void;
  } {
    return {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.stats.toolUses++;
        options?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.stats.lifetimeUsage, usage);
        record.stats.cacheRead += usage.cacheRead;
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        record.stats.latestCacheHitRate = promptTokens > 0
          ? (usage.cacheRead / promptTokens) * 100
          : undefined;
        options?.onAssistantUsage?.(usage);
      },
      // Compaction and tool-result usage is billable but is not an assistant
      // request, so it bypasses assistant-request cache-hit calculations.
      onSupplementalUsage: (usage) => {
        addUsage(record.stats.lifetimeUsage, usage);
        record.stats.cacheRead += usage.cacheRead;
      },
      onCompaction: (info) => {
        record.stats.compactionCount++;
        options?.onCompaction?.(info);
      },
    };
  }

  /** Start queued agents while global capacity is available. */
  private drainQueue() {
    const started = new Set<string>();
    for (const entry of this.queue) {
      if (this.concurrencySlot.running >= this.concurrencySlot.limit) break;
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") continue;

      try {
        const promise = this.startAgent(entry.id, record, entry.args, this.concurrencySlot);
        promise.then(entry.resolve);
        started.add(entry.id);
      } catch (err) {
        // Late failure — surface on the record so the user can see it
        this.concurrencySlot.running--;
        record.lifecycle.status = "error";
        record.error = errorMessage(err);
        record.lifecycle.completedAt = Date.now();
        entry.resolve("");
        started.add(entry.id);
        this.clearParentAbortSignal(entry.id);
        this.safeNotifyComplete(record);
      }
    }
    this.queue = this.queue.filter(e => !started.has(e.id));
  }


  /**
   * Send a steering message to a running agent.
   * If the session hasn't been created yet, the message is queued.
   */
  async steer(id: string, message: string): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.lifecycle.status !== "running") return false;

    if (!record.execution.session) {
      // Session not yet created — queue the steer
      if (!record.execution.pendingSteers) record.execution.pendingSteers = [];
      record.execution.pendingSteers.push(message);
      return true;
    }

    try {
      await record.execution.session.steer(message);
      return true;
    } catch {
      // steer failures are surfaced to the caller via the boolean return value
      return false;
    }
  }

  /** Bind a parent abort signal and retain its listener for explicit cleanup. */
  private bindParentAbortSignal(id: string, signal?: AbortSignal): void {
    if (!signal) return;

    const listener = () => this.abort(id, "agent");
    this.parentAbortListeners.set(id, { signal, listener });
    signal.addEventListener("abort", listener, { once: true });
    // AbortSignal does not invoke listeners added after it was aborted.
    if (signal.aborted && this.parentAbortListeners.has(id)) listener();
  }

  /** Remove the parent abort listener once an agent can no longer react to it. */
  private clearParentAbortSignal(id: string): void {
    const entry = this.parentAbortListeners.get(id);
    if (!entry) return;
    entry.signal.removeEventListener("abort", entry.listener);
    this.parentAbortListeners.delete(id);
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt,
    );
  }

  abort(id: string, stoppedBy?: StopInitiator): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    return this.stopAgent(record, stoppedBy);
  }

  /**
   * Stop an agent by aborting its session or removing it from the queue.
   * Returns true if the agent was stopped, false if it wasn't running/queued.
   */
  private stopAgent(record: AgentRecord, stoppedBy?: StopInitiator): boolean {
    const wasQueued = record.lifecycle.status === "queued";
    if (wasQueued) {
      const queuedEntry = this.queue.find(q => q.id === record.id);
      queuedEntry?.resolve("");
      this.queue = this.queue.filter(q => q.id !== record.id);
    } else if (record.lifecycle.status !== "running") {
      return false;
    } else {
      record.execution.abortController?.abort();
    }
    record.lifecycle.status = "stopped";
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.completedAt = Date.now();
    this.clearParentAbortSignal(record.id);
    if (wasQueued) this.safeNotifyComplete(record);
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.clearParentAbortSignal(id);
    record.execution.session?.dispose();
    record.execution.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - this.retentionMinutes * 60_000;
    for (const [id, record] of this.agents) {
      if (!isTerminalStatus(record.lifecycle.status)) continue;
      if ((record.lifecycle.completedAt ?? 0) >= cutoff) continue;
      // Keep the record until the LLM has read the result (foreground return or
      // background nudge). Otherwise a completed background agent can be wiped
      // before its nudge is emitted.
      if (!record.lifecycle.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    for (const entry of this.queue) entry.resolve("");
    this.queue = [];
    for (const id of this.parentAbortListeners.keys()) this.clearParentAbortSignal(id);
    for (const record of this.agents.values()) {
      // A session may not exist yet while setup is in progress. Abort the
      // controller as well so every active run is stopped during shutdown.
      record.execution.abortController?.abort();
      record.execution.session?.dispose();
    }
    this.agents.clear();
  }
}
