/**
 * agent-manager.ts — public lifecycle and scheduling facade for root agents.
 *
 * Records are retained for the parent session, while AgentExecutionService
 * owns live runner resources, parent abort wiring, and global slot cleanup.
 * AgentContinue reuses the same retained root record and session.
 */

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AgentExecutionService,
  type ContinueExecutionRequest,
  type ContinueExecutionTask,
  type ExecutionCompleteHandler,
  type SpawnExecutionTask,
} from "./agent-execution-service.js";
import {
  AgentRecordStore,
  MAX_RETAINED_AGENT_RECORDS,
  type AgentActivityObserver,
  type AgentActivityProjection,
  type AgentActivitySnapshot,
} from "./agent-record-store.js";
import {
  type AgentExecutionSummary,
  type AgentRecord,
  type StopInitiator,
  SHORT_ID_LENGTH,
  type ToolActivity,
} from "../types.js";
import { ExecutionTelemetry } from "./execution-telemetry.js";
import { getSubagentRuntimeContext } from "../shell.js";
import { acceptResolvedSpawn, type ResolvedSpawn } from "../spawn/spawn-contract.js";
import { normalizeConcurrencyDefault } from "../config/types.js";
import { assertAgentId, assertAgentPrompt } from "./agent-string-limits.js";

export type {
  AgentActivityObserver,
  AgentActivityProjection,
  AgentActivitySnapshot,
} from "./agent-record-store.js";

export interface ConcurrencyConfig {
  default: number;
}

export type OnAgentComplete = ExecutionCompleteHandler;
type OnAgentStart = (record: AgentRecord) => void;
export type RetentionProtection = (record: AgentRecord) => boolean;

/** Maximum number of accepted root executions waiting in the global queue. */
export const MAX_QUEUED_ROOT_EXECUTIONS = 128;
/** Stable tool-facing error when a new execution would exceed the queue quota. */
export const QUEUE_QUOTA_ERROR = "Agent queue is full (maximum 128 queued root executions)";

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

export class AgentManager {
  private readonly records: AgentRecordStore;
  private readonly telemetry: ExecutionTelemetry;
  private readonly executionService: AgentExecutionService;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private totalAgentCost = 0;
  private totalAgentCount = 0;
  private retentionProtection?: RetentionProtection;
  private retentionPruneScheduled = false;

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.records = new AgentRecordStore();
    this.telemetry = new ExecutionTelemetry((record) => this.records.get(record.id) === record);
    this.executionService = new AgentExecutionService({
      store: this.records,
      telemetry: this.telemetry,
      concurrency: normalizeConcurrencyDefault(concurrency?.default),
      onStart: (record) => this.onStart?.(record),
      onComplete: (record, execution) => this.notifyComplete(record, execution),
      onCost: (cost) => { this.totalAgentCost += cost; },
    });
  }

  subscribeActivity(observer: AgentActivityObserver): () => void {
    return this.records.subscribeActivity(observer);
  }

  getActivitySnapshot(): AgentActivitySnapshot {
    return this.records.getActivitySnapshot();
  }

  /** Re-cap execution-summary text after a delivery projection is attached. */
  reconcileExecutionHistory(record: AgentRecord): void {
    this.records.reconcileExecutionHistory(record);
  }

  setConcurrency(config: ConcurrencyConfig): void {
    this.executionService.setConcurrency(normalizeConcurrencyDefault(config.default));
  }

  /** Accept a resolved root agent and return its id immediately. */
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, resolvedSpawn: ResolvedSpawn): string {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }

    const acceptedSpawn = acceptResolvedSpawn(resolvedSpawn);
    const queued = this.executionService.shouldQueue();
    this.ensureQueueCapacity(queued);
    const abortController = new AbortController();
    // Keep one caller-facing promise identity from acceptance through queueing
    // and execution. The coordinator can await the full response and later
    // clear exactly this promise without racing a replacement execution.
    let resolveSpawn!: (result: string) => void;
    const spawnPromise = new Promise<string>((resolve) => { resolveSpawn = resolve; });
    const created = this.records.createSpawnRecord(
      acceptedSpawn,
      queued ? "queued" : "running",
      abortController,
      spawnPromise,
    );
    this.telemetry.initializeRecord(created.record);
    this.telemetry.beginExecution(created.execution.id, created.record);

    const task: SpawnExecutionTask = {
      kind: "spawn",
      id: created.id,
      record: created.record,
      execution: created.execution,
      pi,
      ctx,
      acceptedSpawn,
      resolve: resolveSpawn,
    };
    this.executionService.submit(task);
    this.totalAgentCount++;
    return created.id;
  }

  /** Continue a completed, settled root session with a new prompt. */
  continueAgent(agentId: string, prompt: string, options: ContinueOptions = {}): ContinueResult {
    // Keep direct manager callers behind the same bounded control boundary as
    // the public tool; this must precede prefix resolution/reflection.
    assertAgentId(agentId, "agent_id");
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent continuation is unavailable from a child runtime");
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("AgentContinue prompt is required");
    }
    // Keep this before ID/session lookup, queue accounting, Promise creation,
    // and history mutation. A continuation must never allocate retained state
    // for a prompt that cannot be executed unchanged.
    assertAgentPrompt(prompt, "AgentContinue prompt");

    const resolved = this.records.resolveId(agentId);
    if (!resolved.ok) throw new Error(resolved.error);
    const record = this.records.get(resolved.id)!;
    if (record.lifecycle.status !== "completed" || !record.lifecycle.settled) {
      throw new Error(`Agent ${resolved.id.slice(0, SHORT_ID_LENGTH)} is ${record.lifecycle.status} and cannot be continued`);
    }
    const session = record.execution.session;
    if (!session) {
      throw new Error(`Agent ${resolved.id.slice(0, SHORT_ID_LENGTH)} session is no longer available`);
    }

    const queued = this.executionService.shouldQueue();
    this.ensureQueueCapacity(queued);

    const executionId = this.records.createExecutionId();
    const baseline = this.telemetry.beginExecution(executionId, record);
    let resolveRequest: ((result: string) => void) | undefined;
    let rejectRequest: ((error: Error) => void) | undefined;
    const promise = new Promise<string>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const startedAt = Date.now();
    const execution = this.records.createContinuation(
      record,
      executionId,
      prompt,
      options.isBackground === true ? "background" : "foreground",
      queued ? "queued" : "running",
      startedAt,
    );
    // Replace the previous settled turn with this continuation's stable
    // caller-facing promise before any queue/runner boundary.
    record.execution.promise = promise;
    const request: ContinueExecutionRequest = {
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

    const task: ContinueExecutionTask = {
      kind: "continue",
      id: resolved.id,
      record,
      execution,
      request,
    };
    this.executionService.submit(task);
    return { executionId, record, promise };
  }

  setOnComplete(callback: OnAgentComplete): void {
    this.onComplete = callback;
  }

  /**
   * Install a read-only delivery protection query. The BackgroundDelivery
   * service remains the owner of delivery state; the manager only asks it
   * before evicting a terminal record.
   */
  setRetentionProtection(protection?: RetentionProtection): void {
    this.retentionProtection = protection;
  }

  /**
   * Evict the oldest safe settled terminal records until the bounded retained
   * set is within its limit. Active, unsettled, and pending-delivery records
   * are never candidates, even if that temporarily leaves more than the cap.
   */
  pruneRetainedRecords(): string[] {
    const terminal = this.records.listRetentionOrder().filter((record) =>
      record.lifecycle.settled === true
      && record.lifecycle.status !== "queued"
      && record.lifecycle.status !== "running",
    );
    const excess = terminal.length - MAX_RETAINED_AGENT_RECORDS;
    if (excess <= 0) return [];

    const evicted: string[] = [];
    for (const record of terminal) {
      if (evicted.length >= excess) break;
      if (this.isRetentionProtected(record)) continue;

      // Forget callbacks before releasing the session so late telemetry from a
      // disposed session cannot mutate a record that is no longer retained.
      this.telemetry.forgetRecord(record);
      this.executionService.releaseExecution(record);
      this.records.remove(record.id);
      evicted.push(record.id);
    }
    return evicted;
  }

  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  getTotalAgentCount(): number {
    return this.totalAgentCount;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Release a caller-facing promise only when it is still the current
   * execution. A continuation may have installed a newer promise meanwhile.
   */
  clearExecutionPromise(record: AgentRecord, promise: Promise<string>): boolean {
    if (record.execution.promise !== promise) return false;
    record.execution.promise = undefined;
    return true;
  }

  /** Explicit lifecycle name used by foreground callers after consumption. */
  releaseExecutionPromise(record: AgentRecord, promise: Promise<string>): boolean {
    return this.clearExecutionPromise(record, promise);
  }

  listAgents(): AgentRecord[] {
    return this.records.list();
  }

  abort(id: string, stoppedBy?: StopInitiator): boolean {
    assertAgentId(id, "agent_id");
    return this.executionService.abort(id, stoppedBy);
  }

  dispose(): void {
    this.executionService.dispose();
  }

  private ensureQueueCapacity(queued: boolean): void {
    if (!queued || this.executionService.pendingCount < MAX_QUEUED_ROOT_EXECUTIONS) return;
    throw new Error(QUEUE_QUOTA_ERROR);
  }

  private notifyComplete(record: AgentRecord, execution: AgentExecutionSummary): void {
    try {
      this.onComplete?.(record, execution);
    } finally {
      // Queue this after the completion callback. Coordinator claims for a
      // background execution are installed in the same synchronous acceptance
      // turn, so a completed record cannot be evicted before its delivery
      // claim is visible. Terminal delivery callbacks prune synchronously.
      this.scheduleRetentionPrune();
    }
  }

  private scheduleRetentionPrune(): void {
    if (this.retentionPruneScheduled) return;
    this.retentionPruneScheduled = true;
    queueMicrotask(() => {
      this.retentionPruneScheduled = false;
      this.pruneRetainedRecords();
    });
  }

  private isRetentionProtected(record: AgentRecord): boolean {
    // This public projection is also useful for manager-only callers. The
    // coordinator additionally installs the authoritative service query below.
    if (record.delivery?.state === "pending") return true;
    if (!this.retentionProtection) return false;
    try {
      return this.retentionProtection(record);
    } catch {
      // A failed protection query must fail closed for resource retention.
      return true;
    }
  }
}
