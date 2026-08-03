/**
 * agent-manager.ts — Tracks root agents, global concurrency, and background execution.
 *
 * The manager intentionally has no hierarchy or child execution state. Every
 * record is a root execution owned by the parent session; AgentContinue reuses
 * the same retained root record and session.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeAgentTurn, runAgent } from "./agent-runner.js";
import { AgentOutputLog } from "./output-file.js";
import {
  type AgentExecutionSummary,
  type AgentRecord,
  type AgentStatus,
  type CompactionInfo,
  type CompactionReasonMetadata,
  type RunCallbacks,
  type StopInitiator,
  SHORT_ID_LENGTH,
  type SpawnConfig,
  type ToolActivity,
} from "../types.js";
import { getAgentConfig, resolveType, snapshotAgentConfig } from "./agent-types.js";
import type { SubagentType } from "./types.js";
import {
  addUsage,
  createContextStats,
  getLifetimeTotal,
  getSessionUsageSnapshot,
  observeContextStats,
  readSessionContextUsage,
  type AgentUsage,
  type SessionStatsContextUsage,
} from "./usage.js";
import { errorMessage } from "../utils.js";
import { getSubagentRuntimeContext } from "../shell.js";
import type { SubagentRuntimeSettings } from "../config/config-store.js";

/** How often to check for expired agent records (milliseconds). */
const CLEANUP_INTERVAL_MS = 60_000;
/** Age after which a completed agent record is evicted (milliseconds). */
const DEFAULT_RETENTION_MINUTES = 60;
/** UUID prefix length for agent IDs stored in the agents map. */
const AGENT_ID_PREFIX_LENGTH = 17;
/** Default global concurrency limit when not specified in config. */
const DEFAULT_CONCURRENCY_LIMIT = 4;

function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

export interface ConcurrencyConfig {
  default: number;
}

export type OnAgentComplete = (record: AgentRecord, execution: AgentExecutionSummary) => void;
export type OnAgentEvicted = (record: AgentRecord) => void;
type OnAgentStart = (record: AgentRecord) => void;

interface ConcurrencySlot {
  limit: number;
  running: number;
}

interface ExecutionBaseline {
  usage: AgentUsage;
  compactionCount: number;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface ContinueRequest {
  /** The accepted root record and retained session used by this task. */
  record: AgentRecord;
  session: AgentSession;
  /** Stable execution identity and telemetry baseline captured at acceptance. */
  executionId: string;
  baseline: ExecutionBaseline;
  prompt: string;
  isBackground: boolean;
  signal?: AbortSignal;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  startedAt: number;
}

interface SpawnQueueEntry {
  kind: "spawn";
  id: string;
  args: SpawnArgs;
  resolve: (result: string) => void;
}

interface ContinueQueueEntry {
  kind: "continue";
  id: string;
  request: ContinueRequest;
}

type QueueEntry = SpawnQueueEntry | ContinueQueueEntry;

export interface ContinueOptions {
  isBackground?: boolean;
  signal?: AbortSignal;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
}

export interface ContinueResult {
  executionId: string;
  record: AgentRecord;
  promise: Promise<string>;
}

export interface SpawnOptions extends SpawnConfig, RunCallbacks {
  isBackground?: boolean;
  /** Parent-session abort signal forwarded to this root execution. */
  signal?: AbortSignal;
  /** Detached settings captured at root acceptance for queued execution. */
  runtimeSettings?: SubagentRuntimeSettings;
}

function updateCumulativeCacheHitRate(record: AgentRecord): void {
  const { lifetimeUsage, cacheRead } = record.stats;
  const promptTokens = lifetimeUsage.input + cacheRead + lifetimeUsage.cacheWrite;
  record.stats.latestCacheHitRate = promptTokens > 0
    ? (cacheRead / promptTokens) * 100
    : undefined;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onRecordEvicted?: OnAgentEvicted;
  private onStart?: OnAgentStart;

  /** Session-level cumulative agent cost. Survives record eviction. */
  private totalAgentCost = 0;
  /** Session-level cumulative accepted root count. Survives record eviction. */
  private totalAgentCount = 0;
  private retentionMinutes = DEFAULT_RETENTION_MINUTES;
  static readonly DEFAULT_RETENTION_MINUTES = DEFAULT_RETENTION_MINUTES;
  private concurrencySlot: ConcurrencySlot;
  /** Root executions waiting for a global concurrency slot. */
  private queue: QueueEntry[] = [];
  private parentAbortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();
  private deferredContextSamples = new WeakMap<AgentRecord, AgentSession>();
  private executionBases = new Map<string, ExecutionBaseline>();

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
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

  setRetentionMinutes(minutes: number): void {
    this.retentionMinutes = Math.max(1, minutes);
  }

  setConcurrency(config: ConcurrencyConfig): void {
    this.concurrencySlot.limit = Math.max(1, config.default);
    this.drainQueue();
  }

  /** Accept a root agent and return its id immediately. */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }
    return this.spawnInternal(pi, ctx, type, prompt, options);
  }

  private spawnInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const abortController = new AbortController();
    const frozenOptions: SpawnOptions = {
      ...options,
      agentConfig: options.agentConfig && snapshotAgentConfig(options.agentConfig),
    };
    const args: SpawnArgs = { pi, ctx, type, prompt, options: frozenOptions };
    const queued = this.concurrencySlot.running >= this.concurrencySlot.limit;
    let resolveQueued: ((result: string) => void) | undefined;
    const queuedPromise = queued
      ? new Promise<string>((resolve) => { resolveQueued = resolve; })
      : undefined;

    // Direct manager callers may omit agentConfig. Resolve and snapshot the
    // role once so queueing never observes later registry or frontmatter edits.
    const canonicalType = resolveType(type) ?? type;
    const resolvedConfig = frozenOptions.agentConfig ?? getAgentConfig(canonicalType);
    const agentConfig = resolvedConfig && snapshotAgentConfig(resolvedConfig);
    frozenOptions.agentConfig = agentConfig;
    const now = Date.now();
    const status: AgentStatus = queued ? "queued" : "running";
    const executionId = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const modelKey = options.modelKey
      ?? (options.model ? `${options.model.provider}/${options.model.id}` : undefined);
    const invocation = options.invocation || modelKey !== undefined
      ? {
        ...(options.invocation ?? {}),
        ...(modelKey !== undefined ? { modelKey } : {}),
      }
      : undefined;
    const record: AgentRecord = {
      id,
      lifecycle: { status, startedAt: now, settled: false },
      display: {
        type: canonicalType,
        description: options.description,
        invocation,
        worktreePath: options.worktreePath,
        worktreeLabel: options.worktreeLabel,
      },
      execution: { abortController, promise: queuedPromise },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
        cacheRead: 0,
        contextStats: createContextStats(),
        compactionReasons: [],
        executions: [{
          id: executionId,
          prompt,
          mode: options.isBackground ? "background" : "foreground",
          status,
          startedAt: now,
        }],
      },
    };
    this.agents.set(id, record);
    this.executionBases.set(executionId, this.snapshotExecutionBaseline(record));

    // Queue insertion precedes signal binding so an already-aborted caller can
    // remove and settle the accepted work synchronously.
    if (queued) {
      this.queue.push({ kind: "spawn", id, args, resolve: resolveQueued! });
      this.bindParentAbortSignal(id, options.signal);
      this.totalAgentCount++;
      return id;
    }

    this.bindParentAbortSignal(id, options.signal);
    if (record.lifecycle.status !== "running") {
      this.finishUnstartedExecution(record, record.stats.executions![0]!, "stopped");
      this.totalAgentCount++;
      return id;
    }

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

  private setStatus(record: AgentRecord, status: AgentStatus): void {
    record.lifecycle.status = status;
  }

  private setSettled(record: AgentRecord): void {
    record.lifecycle.settled = true;
  }

  /** Start one accepted root execution and consume one global slot. */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    concurrencySlot: ConcurrencySlot,
  ): Promise<string> {
    concurrencySlot.running++;
    this.setStatus(record, "running");
    record.lifecycle.startedAt = Date.now();

    try {
      record.execution.outputLog = new AgentOutputLog(id, prompt);
      record.display.outputFile = record.execution.outputLog.path;
    } catch { /* output logs are optional telemetry */ }

    this.onStart?.(record);
    const execution = record.stats.executions!.at(-1)!;
    execution.status = "running";

    const promise = runAgent(ctx, record.display.type, prompt, {
      pi,
      agentId: id,
      agentConfig: options.agentConfig,
      runtimeSettings: options.runtimeSettings,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      worktreeParentCwd: options.worktreeParentCwd,
      worktreeSelectionPath: options.worktreeSelectionPath,
      signal: record.execution.abortController!.signal,
      ...this.createRecordCallbacks(record, options, execution.id),
      onTextDelta: (delta, fullText) => {
        if (!this.isActiveExecution(record, execution.id)) return;
        options.onTextDelta?.(delta, fullText);
      },
      onSessionCreated: (session) => {
        if (this.agents.get(record.id) !== record) {
          try { session.dispose(); } catch { /* stale setup cleanup is best effort */ }
          return;
        }
        record.execution.session = session;
        this.observeContext(record);
        if (record.execution.outputLog) record.execution.outputLog.attach(session);
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted }) => {
        if (this.agents.get(record.id) === record) record.execution.session = session;
        this.finishTurnExecution(record, execution, { responseText, aborted }, concurrencySlot);
        if (execution.mode === "foreground") execution.deliveredText = responseText;
        return responseText;
      })
      .catch((err) => {
        this.finishTurnExecution(
          record,
          execution,
          { responseText: "", aborted: false, error: errorMessage(err) },
          concurrencySlot,
        );
        return "";
      });

    record.execution.promise = promise;
    return promise;
  }

  /** Continue a completed root session with a new prompt. */
  continueAgent(agentId: string, prompt: string, options: ContinueOptions = {}): ContinueResult {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent continuation is unavailable from a child runtime");
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("AgentContinue prompt is required");
    }
    const resolved = this.resolveAgentId(agentId);
    if (!resolved.ok) throw new Error(resolved.error);
    const record = this.agents.get(resolved.id)!;
    if (record.lifecycle.status !== "completed" || !record.lifecycle.settled) {
      throw new Error(`Agent ${resolved.id.slice(0, SHORT_ID_LENGTH)} is ${record.lifecycle.status} and cannot be continued`);
    }
    const session = record.execution.session;
    if (!session) {
      throw new Error(`Agent ${resolved.id.slice(0, SHORT_ID_LENGTH)} session is no longer available`);
    }

    // Acceptance captures every value that may otherwise change while the
    // task waits for a slot. The queue therefore starts this exact retained
    // session and computes deltas from this exact baseline.
    const executionId = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const baseline = this.snapshotExecutionBaseline(record);
    // Promise constructors invoke the executor synchronously; no placeholder
    // resolver functions are needed before these assignments.
    let resolveRequest: ((result: string) => void) | undefined;
    let rejectRequest: ((error: Error) => void) | undefined;
    const promise = new Promise<string>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const startedAt = Date.now();
    const request: ContinueRequest = {
      record,
      session,
      executionId,
      baseline,
      prompt,
      isBackground: options.isBackground === true,
      signal: options.signal,
      onToolActivity: options.onToolActivity,
      onTextDelta: options.onTextDelta,
      resolve: resolveRequest!,
      reject: rejectRequest!,
      startedAt,
    };
    if (request.isBackground) promise.catch(() => {});

    const queued = this.concurrencySlot.running >= this.concurrencySlot.limit;
    const execution: AgentExecutionSummary = {
      id: executionId,
      prompt,
      mode: request.isBackground ? "background" : "foreground",
      status: queued ? "queued" : "running",
      startedAt,
    };
    (record.stats.executions ??= []).push(execution);
    this.setStatus(record, queued ? "queued" : "running");
    record.lifecycle.settled = false;
    record.lifecycle.completedAt = undefined;
    if (queued) {
      this.queue.push({ kind: "continue", id: resolved.id, request });
      this.bindParentAbortSignal(resolved.id, options.signal);
      return { executionId, record, promise };
    }

    this.bindParentAbortSignal(resolved.id, options.signal);
    const statusAfterAbort = record.lifecycle.status as AgentStatus;
    if (statusAfterAbort !== "running") {
      const stopError = new Error(`Agent ${resolved.id.slice(0, SHORT_ID_LENGTH)} was stopped`);
      this.finishUnstartedExecution(record, execution, "stopped");
      request.reject(stopError);
      return { executionId, record, promise };
    }

    try {
      this.startContinueExecution(record, request, this.concurrencySlot);
    } catch (err) {
      this.concurrencySlot.running--;
      const failure = errorMessage(err);
      this.finishUnstartedExecution(record, execution, "error", failure);
      request.reject(err instanceof Error ? err : new Error(failure));
      this.drainQueue();
    }
    return { executionId, record, promise };
  }

  private resolveAgentId(agentId: string): { ok: true; id: string } | { ok: false; error: string } {
    if (this.agents.has(agentId)) return { ok: true, id: agentId };
    let match: string | undefined;
    for (const id of this.agents.keys()) {
      if (!id.startsWith(agentId)) continue;
      if (match !== undefined) return { ok: false, error: `Agent ${agentId} is ambiguous; use a longer ID prefix` };
      match = id;
    }
    return match !== undefined
      ? { ok: true, id: match }
      : { ok: false, error: `Agent ${agentId} not found` };
  }

  private startContinueExecution(
    record: AgentRecord,
    request: ContinueRequest,
    concurrencySlot: ConcurrencySlot,
  ): void {
    concurrencySlot.running++;
    const execution = record.stats.executions?.find((e) => e.id === request.executionId);
    const session = request.session;
    // The accepted task owns the session identity. A record released while the
    // task was queued must fail rather than silently switching to another
    // session or attempting to use a disposed handle.
    if (!execution || !session || record.execution.session !== session) {
      throw new Error(`Agent ${record.id.slice(0, SHORT_ID_LENGTH)} session is no longer available`);
    }

    execution.status = "running";
    this.setStatus(record, "running");
    record.lifecycle.settled = false;
    record.lifecycle.completedAt = undefined;
    record.execution.abortController = new AbortController();
    this.clearParentAbortSignal(record.id);
    this.bindParentAbortSignal(record.id, request.signal);

    try {
      if (record.execution.outputLog) {
        record.execution.outputLog.append(request.prompt);
        record.execution.outputLog.attach(session, session.messages.length + 1);
      } else {
        record.execution.outputLog = new AgentOutputLog(record.id, request.prompt, undefined, true);
        record.display.outputFile = record.execution.outputLog.path;
        record.execution.outputLog.attach(session, session.messages.length + 1);
      }
    } catch { /* output logs are optional telemetry */ }

    this.onStart?.(record);
    const promise = executeAgentTurn(session, request.prompt, {
      signal: record.execution.abortController.signal,
      ...this.createRecordCallbacks(record, { onToolActivity: request.onToolActivity }, execution.id),
      onTextDelta: (delta, fullText) => {
        if (!this.isActiveExecution(record, execution.id)) return;
        request.onTextDelta?.(delta, fullText);
      },
    })
      .then(({ responseText, aborted }) => {
        this.finishTurnExecution(record, execution, { responseText, aborted }, concurrencySlot, request.baseline);
        if (!request.isBackground) execution.deliveredText = responseText;
        request.resolve(responseText);
        return responseText;
      })
      .catch((err) => {
        this.finishTurnExecution(
          record,
          execution,
          { responseText: "", aborted: false, error: errorMessage(err) },
          concurrencySlot,
          request.baseline,
        );
        request.resolve("");
        return "";
      });
    record.execution.promise = promise;
  }

  private finishTurnExecution(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    outcome: { responseText: string; aborted: boolean; error?: string },
    concurrencySlot: ConcurrencySlot,
    baseline?: ExecutionBaseline,
  ): void {
    if (record.stats.executions?.at(-1) !== execution) {
      this.executionBases.delete(execution.id);
      return;
    }

    this.observeContext(record, true);
    const completedAt = Date.now();
    const status: AgentStatus = record.lifecycle.status === "stopped"
      ? "stopped"
      : outcome.error !== undefined
        ? "error"
        : outcome.aborted ? "aborted" : "completed";
    execution.status = status;
    execution.completedAt = completedAt;
    execution.responseText = outcome.responseText;
    execution.error = outcome.error;
    const delta = this.executionDelta(record, execution.id, baseline);
    execution.usage = delta?.usage;
    execution.compactionCount = delta?.compactionCount;
    this.executionBases.delete(execution.id);
    this.totalAgentCost += execution.usage?.cost ?? 0;

    if (record.lifecycle.status !== "stopped") this.setStatus(record, status);
    record.result = outcome.responseText;
    record.error = outcome.error;
    record.lifecycle.completedAt ??= completedAt;

    this.finalizeAgentCompletion(record, concurrencySlot);
    this.safeNotifyComplete(record, execution);
  }

  private finalizeAgentCompletion(record: AgentRecord, concurrencySlot: ConcurrencySlot): void {
    if (record.execution.outputLog) {
      try {
        record.execution.outputLog.finalize({
          totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
          cost: record.stats.lifetimeUsage.cost,
        });
      } catch { /* ignore output-log finalization failures */ }
      record.execution.outputLog = undefined;
    }
    this.setSettled(record);
    this.clearParentAbortSignal(record.id);
    concurrencySlot.running--;
    this.drainQueue();
  }

  private snapshotExecutionBaseline(record: AgentRecord): ExecutionBaseline {
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

  private executionDelta(
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

  private finalizeUnstartedExecution(execution: AgentExecutionSummary): void {
    execution.usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
    execution.compactionCount = 0;
  }

  /**
   * Finish an accepted task that never reached the turn executor. This path is
   * deliberately idempotent: parent abort, queue cancellation, and a
   * synchronous startup failure can observe the same terminal boundary.
   */
  private finishUnstartedExecution(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    status: "stopped" | "error",
    error?: string,
  ): boolean {
    if (record.lifecycle.settled && execution.completedAt !== undefined) return false;

    const completedAt = Date.now();
    execution.status = status;
    execution.completedAt = completedAt;
    if (error !== undefined) execution.error = error;
    else delete execution.error;
    this.finalizeUnstartedExecution(execution);
    this.executionBases.delete(execution.id);

    this.setStatus(record, status);
    record.result = undefined;
    record.error = error;
    record.lifecycle.completedAt = completedAt;
    if (record.execution.outputLog) {
      try {
        record.execution.outputLog.finalize({
          totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
          cost: record.stats.lifetimeUsage.cost,
        });
      } catch { /* ignore output-log finalization failures */ }
      record.execution.outputLog = undefined;
    }
    this.setSettled(record);
    this.clearParentAbortSignal(record.id);
    this.safeNotifyComplete(record, execution);
    return true;
  }

  private safeNotifyComplete(record: AgentRecord, execution: AgentExecutionSummary): void {
    try {
      this.onComplete?.(record, execution);
    } catch { /* completion observers must not affect lifecycle */ }
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  setOnRecordEvicted(cb: OnAgentEvicted): void {
    this.onRecordEvicted = cb;
  }

  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  getTotalAgentCount(): number {
    return this.totalAgentCount;
  }

  private recordContextSample(record: AgentRecord, usage: SessionStatsContextUsage | undefined, skipUnchanged = false): void {
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

  private observeContext(record: AgentRecord, skipUnchanged = false): void {
    const session = record.execution.session;
    if (!session || this.agents.get(record.id) !== record) return;
    if (this.deferredContextSamples.get(record) === session) this.deferredContextSamples.delete(record);
    const contextRead = readSessionContextUsage(session);
    if (!contextRead.failed) this.recordContextSample(record, contextRead.usage, skipUnchanged);
    const snapshot = getSessionUsageSnapshot(session, contextRead.usage);
    this.persistContextSnapshot(record, snapshot, !contextRead.failed && contextRead.usage !== undefined);
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
      const current = this.agents.get(record.id);
      if (current !== record || record.lifecycle.settled || record.lifecycle.status !== "running") return;
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
    (record.stats.compactionReasons ??= []).push(metadata);
  }

  private isActiveExecution(record: AgentRecord, executionId: string): boolean {
    return this.agents.get(record.id) === record && record.stats.executions?.at(-1)?.id === executionId;
  }

  private createRecordCallbacks(
    record: AgentRecord,
    options?: Pick<SpawnOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
    executionId?: string,
  ): {
    onToolActivity: (activity: ToolActivity) => void;
    onAssistantUsage: (usage: AgentUsage) => void;
    onSupplementalUsage: (usage: AgentUsage) => void;
    onCompaction: (info: CompactionInfo) => void;
  } {
    const isActive = (): boolean => executionId === undefined || this.isActiveExecution(record, executionId);
    return {
      onToolActivity: (activity) => {
        if (!isActive()) return;
        options?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        if (!isActive()) return;
        addUsage(record.stats.lifetimeUsage, usage);
        record.stats.cacheRead += usage.cacheRead;
        updateCumulativeCacheHitRate(record);
        options?.onAssistantUsage?.(usage);
        this.deferContextSample(record, executionId);
      },
      onSupplementalUsage: (usage) => {
        if (!isActive()) return;
        addUsage(record.stats.lifetimeUsage, usage);
        record.stats.cacheRead += usage.cacheRead;
        updateCumulativeCacheHitRate(record);
      },
      onCompaction: (info) => {
        if (!isActive()) return;
        record.stats.compactionCount++;
        this.persistCompactionReason(record, info);
        this.observeContext(record);
        options?.onCompaction?.(info);
      },
    };
  }

  private drainQueue(): void {
    const started = new Set<string>();
    for (const entry of this.queue) {
      if (this.concurrencySlot.running >= this.concurrencySlot.limit) break;
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") continue;
      try {
        if (entry.kind === "spawn") {
          const promise = this.startAgent(entry.id, record, entry.args, this.concurrencySlot);
          promise.then(entry.resolve);
        } else {
          this.startContinueExecution(record, entry.request, this.concurrencySlot);
        }
        started.add(entry.id);
      } catch (err) {
        this.concurrencySlot.running--;
        const failure = errorMessage(err);
        const failedExecution = entry.kind === "continue"
          ? record.stats.executions?.find((execution) => execution.id === entry.request.executionId)
          : record.stats.executions?.find((execution) => execution.status === "running" || execution.status === "queued");
        this.finishUnstartedExecution(record, failedExecution!, "error", failure);
        if (entry.kind === "continue") entry.request.reject(new Error(failure));
        else entry.resolve("");
        started.add(entry.id);
      }
    }
    this.queue = this.queue.filter((entry) => !started.has(entry.id));
  }

  private bindParentAbortSignal(id: string, signal?: AbortSignal): void {
    if (!signal) return;
    const listener = () => this.abort(id, "parent");
    this.parentAbortListeners.set(id, { signal, listener });
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted && this.parentAbortListeners.has(id)) listener();
  }

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
    return [...this.agents.values()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt);
  }

  abort(id: string, stoppedBy?: StopInitiator): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    return this.stopAgent(record, stoppedBy);
  }

  /** Stop one running or queued root execution. */
  private stopAgent(record: AgentRecord, stoppedBy?: StopInitiator): boolean {
    const wasQueued = record.lifecycle.status === "queued";
    if (!wasQueued && record.lifecycle.status !== "running") return false;

    const queuedEntry = wasQueued ? this.queue.find((entry) => entry.id === record.id) : undefined;
    if (wasQueued) {
      this.queue = this.queue.filter((entry) => entry.id !== record.id);
      record.lifecycle.stoppedBy = stoppedBy;
      const activeExecution = record.stats.executions?.find(
        (execution) => execution.status === "running" || execution.status === "queued",
      );
      this.finishUnstartedExecution(record, activeExecution!, "stopped");
      if (queuedEntry?.kind === "continue") {
        queuedEntry.request.reject(new Error(`Agent ${record.id.slice(0, SHORT_ID_LENGTH)} was stopped`));
      } else if (queuedEntry?.kind === "spawn") {
        queuedEntry.resolve("");
      }
      return true;
    }

    // A running task owns a live runner. Mark it stopped immediately for
    // status/retention, but let the runner's completion release the slot and
    // compute its real (possibly partial) execution delta.
    record.execution.abortController?.abort();
    this.setStatus(record, "stopped");
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.completedAt = Date.now();
    record.result = undefined;
    const activeExecution = record.stats.executions?.find((execution) => execution.status === "running");
    if (activeExecution) {
      activeExecution.status = "stopped";
      activeExecution.completedAt ??= Date.now();
    }
    this.clearParentAbortSignal(record.id);
    return true;
  }

  private releaseExecution(record: AgentRecord): void {
    this.clearParentAbortSignal(record.id);
    try { record.execution.session?.dispose(); } catch { /* do not strand other records */ }
    record.execution.session = undefined;
    record.execution.abortController = undefined;
    record.execution.promise = undefined;
    record.execution.outputLog = undefined;
  }

  private removeRecord(id: string, record: AgentRecord): void {
    try { this.onRecordEvicted?.(record); } catch { /* coordinator cleanup is best effort */ }
    this.deferredContextSamples.delete(record);
    for (const execution of record.stats.executions ?? []) this.executionBases.delete(execution.id);
    this.releaseExecution(record);
    this.agents.delete(id);
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.retentionMinutes * 60_000;
    for (const [id, record] of this.agents) {
      if (!isTerminalStatus(record.lifecycle.status)) continue;
      if ((record.lifecycle.completedAt ?? 0) >= cutoff) continue;
      if (!record.lifecycle.settled) continue;
      this.removeRecord(id, record);
    }
  }

  dispose(): void {
    clearInterval(this.cleanupInterval);
    for (const entry of this.queue) {
      if (entry.kind === "continue") entry.request.reject(new Error("Agent session shut down"));
      else entry.resolve("");
    }
    this.queue = [];
    for (const id of [...this.parentAbortListeners.keys()]) this.clearParentAbortSignal(id);
    for (const record of this.agents.values()) record.execution.abortController?.abort();
    for (const [id, record] of this.agents) this.removeRecord(id, record);
    this.agents.clear();
  }
}
