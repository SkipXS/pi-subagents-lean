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
      this.settleTaskForShutdown(task);
      return;
    }
    if (!this.hasCurrentRecordExecution(task)
      || (this.activeTasks.has(task.id) && this.activeTasks.get(task.id) !== task)) {
      this.settleTaskAsStale(task);
      return;
    }

    this.activeTasks.set(task.id, task);
    if (task.record.lifecycle.status === "queued") {
      this.scheduler.enqueue(task);
      this.resources.bindParentAbortSignal(task.id, this.signalFor(task), () => this.cancel(task));
      return;
    }

    this.resources.bindParentAbortSignal(task.id, this.signalFor(task), () => this.cancel(task));
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
      this.finishUnstartedExecution(task, "error", failure);
      task.request.reject(error instanceof Error ? error : new Error(failure));
      this.startQueuedEntries(this.scheduler.takeNext((entry) => this.canStartQueuedEntry(entry)));
    }
  }

  /** Finish work that never reached a runner; no scheduler slot is owned. */
  finishUnstartedExecution(
    task: ExecutionTask,
    status: "stopped" | "error",
    error?: string,
  ): boolean {
    if (!this.ownsTask(task)) return false;
    const finished = this.store.finishUnstarted(task.record, task.execution, status, error);
    if (!finished) return false;
    if (this.activeTasks.get(task.id) === task) this.activeTasks.delete(task.id);
    this.telemetry.finalizeUnstartedExecution(task.execution);
    this.telemetry.forgetExecution(task.execution);
    this.resources.clearParentAbortSignal(task.id);
    this.safeNotifySettled();
    return true;
  }

  releaseExecution(record: AgentRecord): void {
    this.resources.releaseExecution(record);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const clearedQueue = this.scheduler.clear();
    this.resources.clearParentAbortSignals();

    // A stale queue entry may no longer be the task owned by its record. It
    // still owns its caller's settlement, but it must not touch the record or
    // scheduler state belonging to a newer generation.
    for (const entry of clearedQueue) {
      if (this.activeTasks.get(entry.id) !== entry) {
        this.settleTaskForShutdown(entry);
      }
    }

    const retainedRecords = this.store.list();
    for (const record of retainedRecords) {
      const active = this.activeTasks.get(record.id);
      if (active && active.record === record && this.hasCurrentRecordExecution(active)) {
        if (record.lifecycle.status === "queued") {
          this.finishUnstartedExecution(active, "stopped", "Agent session shut down");
        } else if (record.lifecycle.status === "running") {
          record.execution.abortController?.abort();
          this.store.stopRunning(record, active.execution);
          this.store.markSettled(record);
        }
        this.settleTaskForShutdown(active);
        if (this.activeTasks.get(record.id) === active) this.activeTasks.delete(record.id);
      } else {
        // A stale task may still own a caller settlement, but shutdown must
        // terminalize only the current projection before releasing resources.
        if (active && active.record === record) {
          this.settleTaskForShutdown(active);
          if (this.activeTasks.get(record.id) === active) this.activeTasks.delete(record.id);
        }
        const execution = this.store.activeExecution(record);
        if (record.lifecycle.status === "running" && execution) {
          record.execution.abortController?.abort();
          this.store.stopRunning(record, execution);
          this.store.markSettled(record);
        } else if (record.lifecycle.status === "queued" && execution) {
          this.store.finishUnstarted(record, execution, "stopped", "Agent session shut down");
          this.telemetry.finalizeUnstartedExecution(execution);
        }
      }
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
      ...this.telemetry.createCallbacks(
        record,
        { isCurrentExecution: () => this.isLiveTask(task) },
        execution,
      ),
      onSessionCreated: (session) => {
        if (!this.isLiveTask(task)) {
          try { session.dispose(); } catch { /* stale setup cleanup is best effort */ }
          return;
        }
        record.execution.session = session;
        this.telemetry.observeContext(record);
      },
    })
      .then(({ responseText, session, aborted }) => {
        if (this.isLiveTask(task)) record.execution.session = session;
        this.finishTurnExecution(task, { responseText, aborted });
        acceptedSpawn = undefined;
        return responseText;
      })
      .catch((error) => {
        this.finishTurnExecution(
          task,
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
    this.resources.bindParentAbortSignal(id, signal, () => this.cancel(task));

    this.onStart?.(record);
    const promise = executeAgentTurn(session, promptForExecution, {
      signal: record.execution.abortController.signal,
      ...this.telemetry.createCallbacks(
        record,
        { onToolActivity, isCurrentExecution: () => this.isLiveTask(task) },
        execution,
      ),
      onTextDelta: (delta, fullText) => {
        if (!this.isLiveTask(task)) return;
        onTextDelta?.(delta, fullText);
      },
    })
      .then(({ responseText, aborted }) => {
        this.finishTurnExecution(task, { responseText, aborted }, baseline);
        promptForExecution = undefined;
        resolve(responseText);
        return responseText;
      })
      .catch((error) => {
        this.finishTurnExecution(
          task,
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
    task: ExecutionTask,
    outcome: { responseText: string; aborted: boolean; error?: string },
    baseline?: ExecutionBaseline,
  ): void {
    if (!this.isLiveTask(task)) {
      this.telemetry.forgetExecution(task.execution);
      return;
    }

    const { record, execution } = task;
    this.telemetry.observeContext(record, true);
    const completedAt = Date.now();
    const delta = this.telemetry.delta(record, execution, baseline);
    execution.usage = delta?.usage;
    execution.compactionCount = delta?.compactionCount;
    this.telemetry.forgetExecution(execution);
    this.onCost?.(execution.usage?.cost ?? 0);
    this.store.completeTurn(record, execution, outcome, completedAt);

    this.finalizeCompletedExecution(task);
    this.safeNotifySettled();
  }

  private finalizeCompletedExecution(task: ExecutionTask): void {
    if (!this.isLiveTask(task)) return;
    this.store.markSettled(task.record);
    this.resources.clearParentAbortSignal(task.id);
    if (this.activeTasks.get(task.id) === task) this.activeTasks.delete(task.id);
    this.scheduler.releaseSlot();
    this.startQueuedEntries(this.scheduler.takeNext((entry) => this.canStartQueuedEntry(entry)));
  }

  private finishStoppedBeforeStart(task: ExecutionTask): void {
    const error = new Error(`Agent ${task.id.slice(0, 8)} was stopped`);
    this.finishUnstartedExecution(task, "stopped");
    if (task.kind === "continue") task.request.reject(error);
    else task.resolve?.("");
  }

  private canStartQueuedEntry(entry: ExecutionTask): boolean {
    const record = this.store.get(entry.id);
    return record === entry.record
      && record.stats.currentExecution === entry.execution
      && this.activeTasks.get(entry.id) === entry
      && record.lifecycle.status === "queued";
  }

  /** Start scheduler-reserved entries while retaining FIFO and slot ownership. */
  private startQueuedEntries(entries: ExecutionTask[]): void {
    const pending = [...entries];
    while (pending.length > 0) {
      const entry = pending.shift()!;
      if (!this.canStartQueuedEntry(entry)) {
        this.scheduler.releaseSlot();
        this.settleTaskAsStale(entry);
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
        this.finishUnstartedExecution(entry, "error", failure);
        if (entry.kind === "continue") entry.request.reject(new Error(failure));
        else entry.resolve?.("");
        pending.push(...this.scheduler.takeNext((candidate) => this.canStartQueuedEntry(candidate)));
      }
    }
  }

  private cancel(task: ExecutionTask): boolean {
    if (!this.isLiveTask(task)) return false;
    const { record } = task;
    const wasQueued = record.lifecycle.status === "queued";
    if (!wasQueued && record.lifecycle.status !== "running") return false;

    if (wasQueued) {
      const removed = this.scheduler.removeWhere((entry) => entry === task);
      if (removed.length === 0) return false;
      record.lifecycle.stoppedBy = "parent";
      if (!this.finishUnstartedExecution(task, "stopped")) return false;
      this.settleTaskAsStopped(task);
      return true;
    }

    record.execution.abortController?.abort();
    if (!this.store.stopRunning(record, task.execution)) return false;
    this.resources.clearParentAbortSignal(record.id);
    return true;
  }

  private signalFor(task: ExecutionTask): AbortSignal | undefined {
    return task.kind === "spawn" ? task.acceptedSpawn.signal : task.request.signal;
  }

  private discardFailedSpawn(task: SpawnExecutionTask): void {
    if (!this.ownsTask(task)) {
      this.telemetry.forgetExecution(task.execution);
      return;
    }
    this.resources.releaseExecution(task.record);
    this.telemetry.forgetRecord(task.record);
    if (this.activeTasks.get(task.id) === task) this.activeTasks.delete(task.id);
    this.store.remove(task.id);
  }

  private hasCurrentRecordExecution(task: ExecutionTask): boolean {
    return this.store.get(task.id) === task.record
      && task.record.stats.currentExecution === task.execution;
  }

  /** Exact record, current projection, and active task ownership predicate. */
  private ownsTask(task: ExecutionTask): boolean {
    return this.hasCurrentRecordExecution(task) && this.activeTasks.get(task.id) === task;
  }

  private isLiveTask(task: ExecutionTask): boolean {
    return !this.disposed && this.ownsTask(task);
  }

  private settleTaskForShutdown(task: ExecutionTask): void {
    if (task.kind === "continue") task.request.reject(new Error("Agent session shut down"));
    else task.resolve?.("");
  }

  private settleTaskAsStale(task: ExecutionTask): void {
    if (task.kind === "continue") task.request.reject(new Error("Agent execution is no longer current"));
    else task.resolve?.("");
  }

  private settleTaskAsStopped(task: ExecutionTask): void {
    if (task.kind === "continue") task.request.reject(new Error(`Agent ${task.id.slice(0, 8)} was stopped`));
    else task.resolve?.("");
  }

  private safeNotifySettled(): void {
    try {
      this.onSettled?.();
    } catch {
      // Retention bookkeeping must not affect lifecycle or scheduler cleanup.
    }
  }
}
