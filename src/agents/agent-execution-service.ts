/**
 * agent-execution-service.ts — runner turns, parent cancellation, and slots.
 *
 * AgentManager accepts immutable work and delegates all live execution work to
 * this service. Queue order remains FIFO because the service is the sole owner
 * of the scheduler and every terminal turn releases its reserved slot here.
 */

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent-runner.js";
import { executeAgentTurn } from "./agent-session-runtime.js";
import { AgentExecutionResources } from "./agent-execution-resources.js";
import type {
  AgentExecutionSummary,
  AgentRecord,
  ToolActivity,
} from "../types.js";
import type { AcceptedSpawn } from "../spawn/spawn-contract.js";
import { FifoConcurrencyScheduler } from "./concurrency-scheduler.js";
import { ExecutionTelemetry, type ExecutionBaseline } from "./execution-telemetry.js";
import { errorMessage } from "../utils.js";
import { AgentRecordStore } from "./agent-record-store.js";

export type ExecutionStartHandler = (record: AgentRecord) => void;

export interface ContinueExecutionRequest {
  record: AgentRecord;
  session: AgentSession;
  executionId: string;
  baseline: ExecutionBaseline;
  prompt: string;
  signal?: AbortSignal;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  startedAt: number;
}

export interface SpawnExecutionTask {
  kind: "spawn";
  id: string;
  record: AgentRecord;
  execution: AgentExecutionSummary;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  acceptedSpawn: AcceptedSpawn;
  resolve?: (result: string) => void;
}

export interface ContinueExecutionTask {
  kind: "continue";
  id: string;
  record: AgentRecord;
  execution: AgentExecutionSummary;
  request: ContinueExecutionRequest;
}

export type ExecutionTask = SpawnExecutionTask | ContinueExecutionTask;

interface ExecutionServiceOptions {
  store: AgentRecordStore;
  telemetry: ExecutionTelemetry;
  concurrency: number;
  onStart?: ExecutionStartHandler;
  onSettled?: () => void;
  onCost?: (cost: number) => void;
}

export class AgentExecutionService {
  private readonly scheduler: FifoConcurrencyScheduler<ExecutionTask>;
  private readonly resources: AgentExecutionResources;
  private readonly store: AgentRecordStore;
  private readonly telemetry: ExecutionTelemetry;
  private readonly onStart?: ExecutionStartHandler;
  private readonly onSettled?: () => void;
  private readonly onCost?: (cost: number) => void;
  private readonly activeTasks = new Map<string, ExecutionTask>();
  private disposed = false;

  constructor(options: ExecutionServiceOptions) {
    this.store = options.store;
    this.resources = new AgentExecutionResources();
    this.telemetry = options.telemetry;
    this.scheduler = new FifoConcurrencyScheduler(options.concurrency);
    this.onStart = options.onStart;
    this.onSettled = options.onSettled;
    this.onCost = options.onCost;
  }

  /** Whether a newly accepted task must wait for a global slot. */
  shouldQueue(): boolean {
    return this.scheduler.shouldQueue();
  }

  /** Number of accepted tasks waiting for a global slot. */
  get pendingCount(): number {
    return this.scheduler.pendingCount;
  }

  setConcurrency(limit: number): void {
    this.startQueuedEntries(this.scheduler.setLimit(
      limit,
      (entry) => this.canStartQueuedEntry(entry),
      1,
    ));
  }

  /** Submit a record whose lifecycle already reflects its slot decision. */
  submit(task: ExecutionTask): void {
    if (this.disposed) {
      if (task.kind === "continue") task.request.reject(new Error("Agent session shut down"));
      else task.resolve?.("");
      return;
    }
    this.activeTasks.set(task.id, task);
    if (task.record.lifecycle.status === "queued") {
      this.scheduler.enqueue(task);
      this.resources.bindParentAbortSignal(task.id, this.signalFor(task), () => this.cancel(task.id));
      return;
    }

    this.resources.bindParentAbortSignal(task.id, this.signalFor(task), () => this.cancel(task.id));
    if (task.record.lifecycle.status !== "running") {
      this.finishStoppedBeforeStart(task);
      return;
    }

    this.scheduler.acquire();
    try {
      const promise = this.startTask(task);
      if (task.kind === "spawn" && task.resolve) promise.then(task.resolve);
    } catch (error) {
      this.scheduler.releaseSlot();
      if (task.kind === "spawn") {
        this.discardFailedSpawn(task);
        this.startQueuedEntries(this.scheduler.takeNext((entry) => this.canStartQueuedEntry(entry)));
        throw error;
      }

      const failure = errorMessage(error);
      this.finishUnstartedExecution(task.record, task.execution, "error", failure);
      task.request.reject(error instanceof Error ? error : new Error(failure));
      this.startQueuedEntries(this.scheduler.takeNext((entry) => this.canStartQueuedEntry(entry)));
    }
  }

  /** Finish work that never reached a runner; no scheduler slot is owned. */
  finishUnstartedExecution(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    status: "stopped" | "error",
    error?: string,
  ): boolean {
    const finished = this.store.finishUnstarted(record, execution, status, error);
    if (!finished) return false;
    this.activeTasks.delete(record.id);
    this.telemetry.finalizeUnstartedExecution(execution);
    this.telemetry.forgetExecution(execution.id);
    this.resources.clearParentAbortSignal(record.id);
    this.safeNotifySettled();
    return true;
  }

  releaseExecution(record: AgentRecord): void {
    this.resources.releaseExecution(record);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.scheduler.clear()) {
      if (entry.kind === "continue") entry.request.reject(new Error("Agent session shut down"));
      else entry.resolve?.("");
    }
    this.resources.clearParentAbortSignals();
    const retainedRecords = this.store.list();
    for (const record of retainedRecords) {
      const active = this.activeTasks.get(record.id);
      if (record.lifecycle.status === "queued") {
        const execution = this.store.activeExecution(record);
        if (execution) this.finishUnstartedExecution(record, execution, "stopped", "Agent session shut down");
      } else if (record.lifecycle.status === "running") {
        record.execution.abortController?.abort();
        this.store.stopRunning(record);
        this.store.markSettled(record);
      }
      if (active?.kind === "continue") active.request.reject(new Error("Agent session shut down"));
      else active?.resolve?.("");
      this.activeTasks.delete(record.id);
      this.telemetry.forgetRecord(record);
      this.releaseExecution(record);
      this.store.remove(record.id);
    }
    this.activeTasks.clear();
    this.resources.dispose();
  }

  private startTask(task: ExecutionTask): Promise<string> {
    return task.kind === "spawn"
      ? this.startSpawn(task)
      : this.startContinuation(task);
  }

  private startSpawn(task: SpawnExecutionTask): Promise<string> {
    const { id, record, execution, pi, ctx } = task;
    let acceptedSpawn: AcceptedSpawn | undefined = task.acceptedSpawn;
    this.store.beginSpawn(record);

    this.onStart?.(record);
    execution.status = "running";

    const promise = runAgent(ctx, acceptedSpawn.type, acceptedSpawn.prompt, {
      pi,
      agentId: id,
      acceptedSpawn,
      signal: record.execution.abortController!.signal,
      ...this.telemetry.createCallbacks(record, {}, execution.id),
      onSessionCreated: (session) => {
        if (!this.telemetry.isCurrentRecord(record)) {
          try { session.dispose(); } catch { /* stale setup cleanup is best effort */ }
          return;
        }
        record.execution.session = session;
        this.telemetry.observeContext(record);
      },
    })
      .then(({ responseText, session, aborted }) => {
        if (this.telemetry.isCurrentRecord(record)) record.execution.session = session;
        this.finishTurnExecution(record, execution, { responseText, aborted });
        acceptedSpawn = undefined;
        return responseText;
      })
      .catch((error) => {
        this.finishTurnExecution(
          record,
          execution,
          { responseText: "", aborted: false, error: errorMessage(error) },
        );
        acceptedSpawn = undefined;
        return "";
      });

    // The manager normally installs the caller-facing promise at acceptance.
    // Keep direct service callers functional without replacing an existing one.
    if (!record.execution.promise) record.execution.promise = promise;
    return promise;
  }

  private startContinuation(task: ContinueExecutionTask): Promise<string> {
    const { id, record, execution, request } = task;
    const {
      session,
      baseline,
      signal,
      onToolActivity,
      onTextDelta,
      resolve,
    } = request;
    let promptForExecution: string | undefined = request.prompt;
    if (!session || record.execution.session !== session) {
      throw new Error(`Agent ${record.id.slice(0, 8)} session is no longer available`);
    }

    this.store.beginContinuation(record, execution);
    record.execution.abortController = new AbortController();
    this.resources.clearParentAbortSignal(id);
    this.resources.bindParentAbortSignal(id, signal, () => this.cancel(id));

    this.onStart?.(record);
    const promise = executeAgentTurn(session, promptForExecution, {
      signal: record.execution.abortController.signal,
      ...this.telemetry.createCallbacks(record, { onToolActivity }, execution.id),
      onTextDelta: (delta, fullText) => {
        if (!this.telemetry.isActiveExecution(record, execution.id)) return;
        onTextDelta?.(delta, fullText);
      },
    })
      .then(({ responseText, aborted }) => {
        this.finishTurnExecution(record, execution, { responseText, aborted }, baseline);
        promptForExecution = undefined;
        resolve(responseText);
        return responseText;
      })
      .catch((error) => {
        this.finishTurnExecution(
          record,
          execution,
          { responseText: "", aborted: false, error: errorMessage(error) },
          baseline,
        );
        promptForExecution = undefined;
        resolve("");
        return "";
      });

    // AgentManager installs the caller-facing continuation promise before the
    // task starts. The runner promise is only the scheduler completion chain.
    if (!record.execution.promise) record.execution.promise = promise;
    return promise;
  }

  private finishTurnExecution(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    outcome: { responseText: string; aborted: boolean; error?: string },
    baseline?: ExecutionBaseline,
  ): void {
    if (this.disposed || this.store.get(record.id) !== record || record.stats.executions?.at(-1) !== execution) {
      this.telemetry.forgetExecution(execution.id);
      return;
    }

    this.telemetry.observeContext(record, true);
    const completedAt = Date.now();
    const delta = this.telemetry.delta(record, execution.id, baseline);
    execution.usage = delta?.usage;
    execution.compactionCount = delta?.compactionCount;
    this.telemetry.forgetExecution(execution.id);
    this.onCost?.(execution.usage?.cost ?? 0);
    this.store.completeTurn(record, execution, outcome, completedAt);
    this.activeTasks.delete(record.id);

    this.finalizeCompletedExecution(record);
    this.safeNotifySettled();
  }

  private finalizeCompletedExecution(record: AgentRecord): void {
    this.store.markSettled(record);
    this.resources.clearParentAbortSignal(record.id);
    this.scheduler.releaseSlot();
    this.startQueuedEntries(this.scheduler.takeNext((entry) => this.canStartQueuedEntry(entry)));
  }

  private finishStoppedBeforeStart(task: ExecutionTask): void {
    const error = new Error(`Agent ${task.id.slice(0, 8)} was stopped`);
    this.finishUnstartedExecution(task.record, task.execution, "stopped");
    if (task.kind === "continue") task.request.reject(error);
    else task.resolve?.("");
  }

  private canStartQueuedEntry(entry: ExecutionTask): boolean {
    return this.store.get(entry.id)?.lifecycle.status === "queued";
  }

  /** Start scheduler-reserved entries while retaining FIFO and slot ownership. */
  private startQueuedEntries(entries: ExecutionTask[]): void {
    const pending = [...entries];
    while (pending.length > 0) {
      const entry = pending.shift()!;
      const record = this.store.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") {
        this.scheduler.releaseSlot();
        pending.push(...this.scheduler.takeNext((candidate) => this.canStartQueuedEntry(candidate)));
        continue;
      }

      try {
        const promise = this.startTask(entry);
        if (entry.kind === "spawn") promise.then((result) => entry.resolve?.(result));
        pending.push(...this.scheduler.takeNext((candidate) => this.canStartQueuedEntry(candidate)));
      } catch (error) {
        this.scheduler.releaseSlot();
        const failure = errorMessage(error);
        this.finishUnstartedExecution(record, entry.execution, "error", failure);
        if (entry.kind === "continue") entry.request.reject(new Error(failure));
        else entry.resolve?.("");
        pending.push(...this.scheduler.takeNext((candidate) => this.canStartQueuedEntry(candidate)));
      }
    }
  }

  private cancel(id: string): boolean {
    const record = this.store.get(id);
    if (!record) return false;
    return this.cancelRecord(record);
  }

  private cancelRecord(record: AgentRecord): boolean {
    const wasQueued = record.lifecycle.status === "queued";
    if (!wasQueued && record.lifecycle.status !== "running") return false;

    const removed = wasQueued
      ? this.scheduler.removeWhere((entry) => entry.id === record.id)
      : [];
    if (wasQueued) {
      record.lifecycle.stoppedBy = "parent";
      const activeExecution = this.store.activeExecution(record);
      if (!activeExecution) return false;
      this.finishUnstartedExecution(record, activeExecution, "stopped");
      const entry = removed[0];
      if (entry?.kind === "continue") entry.request.reject(new Error(`Agent ${record.id.slice(0, 8)} was stopped`));
      else entry?.resolve?.("");
      return true;
    }

    record.execution.abortController?.abort();
    this.store.stopRunning(record);
    this.resources.clearParentAbortSignal(record.id);
    return true;
  }

  private signalFor(task: ExecutionTask): AbortSignal | undefined {
    return task.kind === "spawn" ? task.acceptedSpawn.signal : task.request.signal;
  }

  private discardFailedSpawn(task: SpawnExecutionTask): void {
    this.resources.clearParentAbortSignal(task.id);
    this.telemetry.forgetRecord(task.record);
    this.store.remove(task.id);
  }

  private safeNotifySettled(): void {
    try {
      this.onSettled?.();
    } catch {
      // Retention bookkeeping must not affect lifecycle or scheduler cleanup.
    }
  }
}
