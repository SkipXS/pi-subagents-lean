/**
 * agent-record-store.ts — retained records and their lifecycle projections.
 *
 * The store owns the mutable record/history boundary. ExecutionService owns
 * runner resources and slot cleanup; it uses these transitions instead of
 * duplicating record mutations in each execution path.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentExecutionMode,
  AgentExecutionSummary,
  AgentRecord,
  AgentStatus,
  StopInitiator,
} from "../types.js";
import type { AcceptedSpawn } from "../spawn/spawn-contract.js";
import {
  assertAgentPrompt,
  assertAgentSystemPrompt,
  retainAgentDescription,
  retainAgentError,
  retainAgentText,
  retainExecutionPrompt,
  utf8ByteLength,
  MAX_RETAINED_EXECUTION_TEXT_BUDGET_BYTES,
} from "./agent-string-limits.js";

const AGENT_ID_PREFIX_LENGTH = 17;

/** Maximum number of settled terminal root records retained by a manager. */
export const MAX_RETAINED_AGENT_RECORDS = 64;

/** Maximum number of completed execution summaries retained per record. */
export const MAX_RETAINED_EXECUTION_SUMMARIES = 128;
/** Maximum UTF-8 bytes used by text fields in retained summaries per record. */
export const MAX_RETAINED_EXECUTION_SUMMARY_TEXT_BYTES = MAX_RETAINED_EXECUTION_TEXT_BUDGET_BYTES;

export interface AgentActivityProjection {
  readonly agentId: string;
  readonly type: string;
  readonly mode: AgentExecutionMode;
  readonly status: "queued" | "running";
  readonly executionId: string;
}

export type AgentActivitySnapshot = readonly AgentActivityProjection[];
export type AgentActivityObserver = (snapshot: AgentActivitySnapshot) => void;

export interface SpawnRecordResult {
  id: string;
  record: AgentRecord;
  execution: AgentExecutionSummary;
}

export interface RecordStoreOptions {
  createId?: () => string;
}

export interface TurnOutcome {
  responseText: string;
  aborted: boolean;
  error?: string;
}

function executionSummaryTextBytes(executions: readonly AgentExecutionSummary[]): number {
  let total = 0;
  for (const execution of executions) {
    if (typeof execution.prompt === "string") total += utf8ByteLength(execution.prompt);
    if (execution.responseText !== undefined) total += utf8ByteLength(execution.responseText);
    if (execution.deliveredText !== undefined) total += utf8ByteLength(execution.deliveredText);
    if (execution.error !== undefined) total += utf8ByteLength(execution.error);
  }
  return total;
}

export class AgentRecordStore {
  private readonly records = new Map<string, AgentRecord>();
  private readonly recordOrdinals = new Map<string, number>();
  private readonly activityObservers = new Set<AgentActivityObserver>();
  private readonly createId: () => string;
  private nextRecordOrdinal = 0;

  constructor(options: RecordStoreOptions = {}) {
    this.createId = options.createId ?? (() => randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH));
  }

  /** Allocate a manager-scoped execution identity. */
  createExecutionId(): string {
    return this.createId();
  }

  /** Accept one resolved root and create its retained record/history entry. */
  createSpawnRecord(
    acceptedSpawn: AcceptedSpawn,
    status: "queued" | "running",
    abortController: AbortController,
    promise?: Promise<string>,
    startedAt = Date.now(),
  ): SpawnRecordResult {
    // Keep direct store callers honest as well; production manager acceptance
    // performs the same checks before queue/record allocation.
    assertAgentPrompt(acceptedSpawn.prompt, "Agent prompt");
    assertAgentSystemPrompt(acceptedSpawn.agentConfig?.systemPrompt);
    const id = this.createId();
    const executionId = this.createId();
    const modelKey = acceptedSpawn.modelKey
      ?? (acceptedSpawn.model ? `${acceptedSpawn.model.provider}/${acceptedSpawn.model.id}` : undefined);
    const invocation = acceptedSpawn.invocation || modelKey !== undefined
      ? {
        ...(acceptedSpawn.invocation ?? {}),
        ...(modelKey !== undefined ? { modelKey } : {}),
      }
      : undefined;
    const execution: AgentExecutionSummary = {
      id: executionId,
      // The full accepted prompt remains only on the active execution task;
      // retained history keeps a bounded diagnostic projection.
      prompt: retainExecutionPrompt(acceptedSpawn.prompt),
      mode: acceptedSpawn.runInBackground ? "background" : "foreground",
      kind: "new",
      status,
      startedAt,
    };
    const record: AgentRecord = {
      id,
      lifecycle: { status, startedAt, settled: false },
      display: {
        type: acceptedSpawn.type,
        description: retainAgentDescription(acceptedSpawn.description),
        invocation,
        worktreePath: acceptedSpawn.worktreePath,
        worktreeLabel: acceptedSpawn.worktreeLabel,
      },
      execution: { abortController, promise },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
        cacheRead: 0,
        executions: [execution],
      },
    };
    this.records.set(id, record);
    this.recordOrdinals.set(id, this.nextRecordOrdinal++);
    return { id, record, execution };
  }

  /** Append an accepted continuation to the retained execution history. */
  createContinuation(
    record: AgentRecord,
    executionId: string,
    prompt: string,
    mode: AgentExecutionMode,
    status: "queued" | "running",
    startedAt = Date.now(),
  ): AgentExecutionSummary {
    assertAgentPrompt(prompt, "AgentContinue prompt");
    const execution: AgentExecutionSummary = {
      id: executionId,
      prompt: retainExecutionPrompt(prompt),
      mode,
      kind: "continued",
      status,
      startedAt,
    };
    (record.stats.executions ??= []).push(execution);
    this.capExecutionHistory(record);
    record.lifecycle.status = status;
    record.lifecycle.settled = false;
    record.lifecycle.completedAt = undefined;
    return execution;
  }

  get(id: string): AgentRecord | undefined {
    return this.records.get(id);
  }

  list(): AgentRecord[] {
    return [...this.records.values()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt);
  }

  resolveId(agentId: string): { ok: true; id: string } | { ok: false; error: string } {
    if (this.records.has(agentId)) return { ok: true, id: agentId };
    let match: string | undefined;
    for (const id of this.records.keys()) {
      if (!id.startsWith(agentId)) continue;
      if (match !== undefined) return { ok: false, error: `Agent ${agentId} is ambiguous; use a longer ID prefix` };
      match = id;
    }
    return match !== undefined
      ? { ok: true, id: match }
      : { ok: false, error: `Agent ${agentId} not found` };
  }

  remove(id: string): void {
    this.records.delete(id);
    this.recordOrdinals.delete(id);
  }

  /**
   * Return records in deterministic oldest-first retention order. Completion
   * time is the meaningful age for terminal records; the acceptance ordinal
   * breaks equal-time ties without depending on wall-clock resolution.
   */
  listRetentionOrder(): AgentRecord[] {
    return [...this.records.values()].sort((left, right) => {
      const leftTime = left.lifecycle.completedAt ?? left.lifecycle.startedAt;
      const rightTime = right.lifecycle.completedAt ?? right.lifecycle.startedAt;
      if (leftTime !== rightTime) return leftTime - rightTime;
      const leftOrdinal = this.recordOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightOrdinal = this.recordOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  }

  /** Move a root from accepted/queued to running without changing its history entry yet. */
  beginSpawn(record: AgentRecord, startedAt = Date.now()): void {
    record.lifecycle.status = "running";
    record.lifecycle.startedAt = startedAt;
  }

  /** Mark a continuation as the active running turn. */
  beginContinuation(record: AgentRecord, execution: AgentExecutionSummary): void {
    execution.status = "running";
    record.lifecycle.status = "running";
    record.lifecycle.settled = false;
    record.lifecycle.completedAt = undefined;
  }

  /** Apply the terminal result of an executed turn to record and history. */
  completeTurn(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    outcome: TurnOutcome,
    completedAt = Date.now(),
  ): AgentStatus {
    const status: AgentStatus = record.lifecycle.status === "stopped"
      ? "stopped"
      : outcome.error !== undefined
        ? "error"
        : outcome.aborted ? "aborted" : "completed";
    execution.status = status;
    execution.completedAt = completedAt;
    // Retain only diagnostic projections. The raw outcome remains available to
    // the execution promise/foreground caller and is never truncated here.
    execution.responseText = retainAgentText(outcome.responseText);
    execution.error = retainAgentError(outcome.error);
    if (record.lifecycle.status !== "stopped") record.lifecycle.status = status;
    record.result = retainAgentText(outcome.responseText);
    record.error = retainAgentError(outcome.error);
    record.lifecycle.completedAt ??= completedAt;
    this.capExecutionHistory(record);
    return status;
  }

  /** Terminalize work that never reached the runner. This transition is idempotent. */
  finishUnstarted(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    status: "stopped" | "error",
    error?: string,
    completedAt = Date.now(),
  ): boolean {
    if (record.lifecycle.settled && execution.completedAt !== undefined) return false;

    execution.status = status;
    execution.completedAt = completedAt;
    if (error !== undefined) execution.error = retainAgentError(error);
    else delete execution.error;
    record.lifecycle.status = status;
    record.result = undefined;
    record.error = retainAgentError(error);
    record.lifecycle.completedAt = completedAt;
    record.lifecycle.settled = true;
    this.capExecutionHistory(record);
    return true;
  }

  /** Mark an active runner stopped while leaving settlement to its completion callback. */
  stopRunning(record: AgentRecord, stoppedBy?: StopInitiator, stoppedAt = Date.now()): void {
    record.lifecycle.status = "stopped";
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.completedAt = stoppedAt;
    record.result = undefined;
    const activeExecution = this.activeExecution(record, "running");
    if (activeExecution) {
      activeExecution.status = "stopped";
      activeExecution.completedAt ??= stoppedAt;
    }
  }

  markSettled(record: AgentRecord): void {
    record.lifecycle.settled = true;
    this.capRetainedStrings(record);
    this.capExecutionHistory(record);
  }

  /** Reconcile a projection added by a later delivery boundary. */
  reconcileExecutionHistory(record: AgentRecord): void {
    this.capExecutionHistory(record);
  }

  activeExecution(
    record: AgentRecord,
    status?: "queued" | "running",
  ): AgentExecutionSummary | undefined {
    const executions = record.stats.executions ?? [];
    return executions.find((execution) =>
      status === undefined
        ? execution.status === "running" || execution.status === "queued"
        : execution.status === status,
    );
  }

  /**
   * Keep the newest completed summaries while preserving every active entry.
   * Normally there is one active entry, but retaining all active entries makes
   * this boundary safe for legacy or concurrently-observed record shapes too.
   */
  private capRetainedStrings(record: AgentRecord): void {
    record.display.description = retainAgentDescription(record.display.description);
    if (record.result !== undefined) record.result = retainAgentText(record.result);
    if (record.error !== undefined) record.error = retainAgentError(record.error);
    for (const execution of record.stats.executions ?? []) {
      execution.prompt = typeof execution.prompt === "string"
        ? retainExecutionPrompt(execution.prompt)
        : "";
      execution.responseText = execution.responseText === undefined
        ? undefined
        : retainAgentText(execution.responseText);
      execution.deliveredText = execution.deliveredText === undefined
        ? undefined
        : retainAgentText(execution.deliveredText);
      execution.error = retainAgentError(execution.error);
    }
  }

  private capExecutionHistory(record: AgentRecord): void {
    this.capRetainedStrings(record);
    let executions = record.stats.executions;
    if (!executions) return;

    // Active entries are protected. Prune the oldest completed entry one at a
    // time until both the existing completed-count bound and the aggregate
    // UTF-8 text budget are satisfied. Array order is acceptance order, so the
    // result is deterministic even when timestamps collide.
    while (
      executions.filter((execution) => !this.isActiveExecutionSummary(execution)).length > MAX_RETAINED_EXECUTION_SUMMARIES
      || executionSummaryTextBytes(executions) > MAX_RETAINED_EXECUTION_SUMMARY_TEXT_BYTES
    ) {
      const oldestCompletedIndex = executions.findIndex((execution) => !this.isActiveExecutionSummary(execution));
      if (oldestCompletedIndex < 0) break;
      executions = executions.filter((_, index) => index !== oldestCompletedIndex);
    }
    record.stats.executions = executions;
  }

  private isActiveExecutionSummary(execution: AgentExecutionSummary): boolean {
    return execution.status === "queued" || execution.status === "running";
  }

  /** Return a detached, sorted projection for footer/status observers. */
  getActivitySnapshot(): AgentActivitySnapshot {
    const projections: AgentActivityProjection[] = [];
    for (const record of this.records.values()) {
      const status = record.lifecycle.status;
      if (status !== "running" && status !== "queued") continue;
      const execution = [...(record.stats.executions ?? [])].reverse().find((candidate) =>
        candidate.status === status && (candidate.status === "running" || candidate.status === "queued"),
      );
      if (!execution) continue;
      projections.push(Object.freeze({
        agentId: record.id,
        type: record.display.type,
        mode: execution.mode,
        status,
        executionId: execution.id,
      }));
    }
    projections.sort((left, right) => left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0);
    return Object.freeze(projections);
  }

  subscribeActivity(observer: AgentActivityObserver): () => void {
    this.activityObservers.add(observer);
    try {
      observer(this.getActivitySnapshot());
    } catch {
      // Presentation observers must never affect lifecycle work.
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.activityObservers.delete(observer);
    };
  }

  notifyActivityObservers(): void {
    for (const observer of [...this.activityObservers]) {
      try {
        observer(this.getActivitySnapshot());
      } catch {
        // Presentation observers must never affect lifecycle work.
      }
    }
  }

  clearActivityObservers(): void {
    this.activityObservers.clear();
  }
}
