/**
 * agent-execution-service.ts — runner turns, parent abort, and slot cleanup.
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
  StopInitiator,
  ToolActivity,
} from "../types.js";
import type { AcceptedSpawn } from "../spawn/spawn-contract.js";
import { FifoConcurrencyScheduler } from "./concurrency-scheduler.js";
import { ExecutionTelemetry, type ExecutionBaseline } from "./execution-telemetry.js";
import { errorMessage } from "../utils.js";
import { AgentRecordStore } from "./agent-record-store.js";
import { retainAgentText } from "./agent-string-limits.js";

export type ExecutionStartHandler = (record: AgentRecord) => void;
export type ExecutionCompleteHandler = (record: AgentRecord, execution: AgentExecutionSummary) => void;
export interface ContinueExecutionRequest {
  record: AgentRecord;
  session: AgentSession;
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
  onComplete?: ExecutionCompleteHandler;
  onCost?: (cost: number) => void;
}
export class AgentExecutionService {
  private readonly scheduler: FifoConcurrencyScheduler<ExecutionTask>;
  private readonly resources: AgentExecutionResources;
  private readonly store: AgentRecordStore;
  private readonly telemetry: ExecutionTelemetry;
  private readonly onStart?: ExecutionStartHandler;
  private onComplete?: ExecutionCompleteHandler;
  private readonly onCost?: (cost: number) => void;

  constructor(options: ExecutionServiceOptions) {
    this.store = options.store;
    this.resources = new AgentExecutionResources();
    this.telemetry = options.telemetry;
    this.scheduler = new FifoConcurrencyScheduler(options.concurrency);
    this.onStart = options.onStart;
    this.onComplete = options.onComplete;
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
  /** Submit a record whose initial lifecycle status already reflects this slot decision. */
  submit(task: ExecutionTask): void {
    if (task.record.lifecycle.status === "queued") {
      this.scheduler.enqueue(task);
      this.resources.bindParentAbortSignal(task.id, this.signalFor(task), () => this.abort(task.id, "parent"));
      this.store.notifyActivityObservers();
      return;
    }

    this.resources.bindParentAbortSignal(task.id, this.signalFor(task), () => this.abort(task.id, "parent"));
    if (task.record.lifecycle.status !== "running") {
      this.finishStoppedBeforeStart(task);
      return;
    }

    this.scheduler.acquire();
    try {
      const promise = this.startTask(task);
      if (task.kind === "spawn" && task.resolve) promise.then(task.resolve);
      this.store.notifyActivityObservers();
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
  abort(id: string, stoppedBy?: StopInitiator): boolean {
    const record = this.store.get(id);
    if (!record) return false;
    return this.stopRecord(record, stoppedBy);
  }
  /** Finish a task that did not reach a runner; no scheduler slot is owned. */
  finishUnstartedExecution(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    status: "stopped" | "error",
    error?: string,
  ): boolean {
    const finished = this.store.finishUnstarted(record, execution, status, error);
    if (!finished) return false;
    if (execution.mode === "background") {
      this.releaseBackgroundPromiseWhenSettled(record, record.execution.promise);
    }
    this.telemetry.finalizeUnstartedExecution(execution);
    this.telemetry.forgetExecution(execution.id);
    this.finalizeOutputLog(record);
    this.resources.clearParentAbortSignal(record.id);
    this.store.notifyActivityObservers();
    this.safeNotifyComplete(record, execution);
    return true;
  }
  finalizeOutputLog(record: AgentRecord): void { this.resources.finalizeOutputLog(record); }
  releaseExecution(record: AgentRecord): void { this.resources.releaseExecution(record); }
  dispose(): void {
    for (const entry of this.scheduler.clear()) {
      if (entry.kind === "continue") entry.request.reject(new Error("Agent session shut down"));
      else entry.resolve?.("");
    }
    this.resources.clearParentAbortSignals();
    const retainedRecords = this.store.list();
    for (const record of retainedRecords) record.execution.abortController?.abort();
    for (const record of retainedRecords) {
      this.telemetry.forgetRecord(record);
      this.releaseExecution(record);
      this.store.remove(record.id);
    }
    this.resources.dispose();
    this.store.notifyActivityObservers();
    this.store.clearActivityObservers();
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
    this.resources.prepareSpawnOutput(record, id, acceptedSpawn!.prompt);

    this.onStart?.(record);
    execution.status = "running";

    let publicPromise = record.execution.promise;
    const promise = runAgent(ctx, acceptedSpawn!.type, acceptedSpawn!.prompt, {
      pi,
      agentId: id,
      acceptedSpawn: acceptedSpawn!,
      signal: record.execution.abortController!.signal,
      ...this.telemetry.createCallbacks(record, {}, execution.id),
      onSessionCreated: (session) => {
        if (!this.telemetry.isCurrentRecord(record)) {
          try { session.dispose(); } catch { /* stale setup cleanup is best effort */ }
          return;
        }
        record.execution.session = session;
        this.telemetry.observeContext(record);
        if (record.execution.outputLog) record.execution.outputLog.attach(session);
      },
    })
      .then(({ responseText, session, aborted }) => {
        if (this.telemetry.isCurrentRecord(record)) record.execution.session = session;
        if (execution.mode === "foreground") execution.deliveredText = retainAgentText(responseText);
        this.finishTurnExecution(record, execution, { responseText, aborted });
        // Background callers have no foreground consumer. Release the stable
        // promise after it settles; identity checking protects later turns.
        if (execution.mode === "background") this.releaseBackgroundPromiseWhenSettled(record, publicPromise);
        acceptedSpawn = undefined;
        return responseText;
      })
      .catch((error) => {
        this.finishTurnExecution(
          record,
          execution,
          { responseText: "", aborted: false, error: errorMessage(error) },
        );
        if (execution.mode === "background") this.releaseBackgroundPromiseWhenSettled(record, publicPromise);
        acceptedSpawn = undefined;
        return "";
      });
    // A queued spawn already owns its stable public promise. An unqueued
    // legacy/direct service caller gets the runner promise as its identity.
    if (!record.execution.promise) {
      record.execution.promise = promise;
      publicPromise = promise;
    }
    return promise;
  }

  private startContinuation(task: ContinueExecutionTask): Promise<string> {
    const { id, record, execution, request } = task;
    const {
      session,
      baseline,
      isBackground,
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
    this.resources.bindParentAbortSignal(id, signal, () => this.abort(id, "parent"));

    this.resources.prepareContinuationOutput(record, id, promptForExecution!, session);

    this.onStart?.(record);
    let publicPromise = record.execution.promise;
    const promise = executeAgentTurn(session, promptForExecution!, {
      signal: record.execution.abortController.signal,
      ...this.telemetry.createCallbacks(record, { onToolActivity }, execution.id),
      onTextDelta: (delta, fullText) => {
        if (!this.telemetry.isActiveExecution(record, execution.id)) return;
        onTextDelta?.(delta, fullText);
      },
    })
      .then(({ responseText, aborted }) => {
        if (!isBackground) execution.deliveredText = retainAgentText(responseText);
        this.finishTurnExecution(record, execution, { responseText, aborted }, baseline);
        if (isBackground) this.releaseBackgroundPromiseWhenSettled(record, publicPromise);
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
        if (isBackground) this.releaseBackgroundPromiseWhenSettled(record, publicPromise);
        promptForExecution = undefined;
        resolve("");
        return "";
      });
    // AgentManager installs the caller-facing continuation promise before the
    // task starts. Keep it stable; this internal promise is only the runner
    // completion chain used for scheduler release.
    if (!record.execution.promise) {
      record.execution.promise = promise;
      publicPromise = promise;
    }
    return promise;
  }

  private finishTurnExecution(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    outcome: { responseText: string; aborted: boolean; error?: string },
    baseline?: ExecutionBaseline,
  ): void {
    if (record.stats.executions?.at(-1) !== execution) {
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

    this.finalizeCompletedExecution(record);
    this.store.notifyActivityObservers();
    this.safeNotifyComplete(record, execution);
  }

  private finalizeCompletedExecution(record: AgentRecord): void {
    this.finalizeOutputLog(record);
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
        this.store.notifyActivityObservers();
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

  private stopRecord(record: AgentRecord, stoppedBy?: StopInitiator): boolean {
    const wasQueued = record.lifecycle.status === "queued";
    if (!wasQueued && record.lifecycle.status !== "running") return false;

    const removed = wasQueued
      ? this.scheduler.removeWhere((entry) => entry.id === record.id)
      : [];
    if (wasQueued) {
      record.lifecycle.stoppedBy = stoppedBy;
      const activeExecution = this.store.activeExecution(record);
      if (!activeExecution) return false;
      this.finishUnstartedExecution(record, activeExecution, "stopped");
      const entry = removed[0];
      if (entry?.kind === "continue") entry.request.reject(new Error(`Agent ${record.id.slice(0, 8)} was stopped`));
      else entry?.resolve?.("");
      return true;
    }

    record.execution.abortController?.abort();
    this.store.stopRunning(record, stoppedBy);
    this.resources.clearParentAbortSignal(record.id);
    this.store.notifyActivityObservers();
    return true;
  }

  private signalFor(task: ExecutionTask): AbortSignal | undefined {
    return task.kind === "spawn" ? task.acceptedSpawn.signal : task.request.signal;
  }

  private discardFailedSpawn(task: SpawnExecutionTask): void {
    this.finalizeOutputLog(task.record);
    this.resources.clearParentAbortSignal(task.id);
    this.telemetry.forgetRecord(task.record);
    this.store.remove(task.id);
    this.store.notifyActivityObservers();
  }

  private releaseBackgroundPromiseWhenSettled(
    record: AgentRecord,
    expectedPromise: Promise<string> | undefined,
  ): void {
    const promise = expectedPromise;
    // A stale completion may arrive after a continuation replaced the record's
    // promise. Never attach cleanup to that newer execution.
    if (!promise || record.execution.promise !== promise) return;
    // Register before the service resolves/rejects the public promise so a
    // foreground observer awaiting the same object sees it cleared afterward.
    void promise.then(
      () => this.clearExecutionPromise(record, promise),
      () => this.clearExecutionPromise(record, promise),
    );
  }

  private clearExecutionPromise(record: AgentRecord, promise: Promise<string>): void {
    if (record.execution.promise === promise) record.execution.promise = undefined;
  }

  private safeNotifyComplete(record: AgentRecord, execution: AgentExecutionSummary): void {
    try {
      this.onComplete?.(record, execution);
    } catch {
      // Completion observers must not affect lifecycle or scheduler cleanup.
    }
  }
}
