/**
 * agent-record-store.ts — retained records and their lifecycle projections.
 *
 * The store owns the mutable record/current-projection boundary. ExecutionService owns
 * runner resources and slot cleanup; it uses these transitions instead of
 * duplicating record mutations in each execution path.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentExecutionSummary,
  AgentRecord,
  AgentLifecycleStatus,
} from "../types.js";
import type { AcceptedSpawn } from "../spawn/spawn-contract.js";
import {
  assertAgentPrompt,
  assertAgentSystemPrompt,
  retainAgentDescription,
  retainAgentError,
  retainAgentText,
  retainExecutionPrompt,
} from "./agent-string-limits.js";

const AGENT_ID_PREFIX_LENGTH = 17;

/** Maximum number of settled terminal root records retained by a manager. */
export const MAX_RETAINED_AGENT_RECORDS = 64;

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

export class AgentRecordStore {
  private readonly records = new Map<string, AgentRecord>();
  private readonly recordOrdinals = new Map<string, number>();
  private readonly createId: () => string;
  private nextRecordOrdinal = 0;

  constructor(options: RecordStoreOptions = {}) {
    this.createId = options.createId ?? (() => randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH));
  }

  /** Allocate a manager-scoped execution identity. */
  createExecutionId(): string {
    return this.createId();
  }

  /** Accept one resolved root and create its retained record/current projection. */
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
      // the current projection keeps a bounded diagnostic copy.
      prompt: retainExecutionPrompt(acceptedSpawn.prompt),
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
        currentExecution: execution,
      },
    };
    this.records.set(id, record);
    this.recordOrdinals.set(id, this.nextRecordOrdinal++);
    return { id, record, execution };
  }

  /** Replace the retained current execution with an accepted continuation. */
  createContinuation(
    record: AgentRecord,
    executionId: string,
    prompt: string,
    status: "queued" | "running",
    startedAt = Date.now(),
  ): AgentExecutionSummary {
    assertAgentPrompt(prompt, "AgentContinue prompt");
    const execution: AgentExecutionSummary = {
      id: executionId,
      prompt: retainExecutionPrompt(prompt),
      kind: "continued",
      status,
      startedAt,
    };
    record.stats.currentExecution = execution;
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

  /** Move a root from accepted/queued to running without changing its current projection. */
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

  /** Apply the terminal result of an executed turn to the current projection. */
  completeTurn(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    outcome: TurnOutcome,
    completedAt = Date.now(),
  ): AgentLifecycleStatus {
    if (!this.isCurrentExecution(record, execution)) return record.lifecycle.status;
    const status: AgentLifecycleStatus = record.lifecycle.status === "stopped"
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
    if (!this.isCurrentExecution(record, execution)) return false;
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
    return true;
  }

  /** Mark an active runner stopped while leaving settlement to its completion callback. */
  stopRunning(
    record: AgentRecord,
    execution: AgentExecutionSummary,
    stoppedAt = Date.now(),
  ): boolean {
    if (!this.isCurrentExecution(record, execution)) return false;
    record.lifecycle.status = "stopped";
    record.lifecycle.stoppedBy = "parent";
    record.lifecycle.completedAt = stoppedAt;
    record.result = undefined;
    if (execution.status === "running") {
      execution.status = "stopped";
      execution.completedAt ??= stoppedAt;
    }
    return true;
  }

  markSettled(record: AgentRecord): void {
    record.lifecycle.settled = true;
    this.capRetainedStrings(record);
  }

  isCurrentExecution(record: AgentRecord, execution: AgentExecutionSummary): boolean {
    return this.records.get(record.id) === record && record.stats.currentExecution === execution;
  }

  activeExecution(
    record: AgentRecord,
    status?: "queued" | "running",
  ): AgentExecutionSummary | undefined {
    const execution = record.stats.currentExecution;
    if (!execution) return undefined;
    if (status !== undefined && execution.status !== status) return undefined;
    return status === undefined && execution.status !== "running" && execution.status !== "queued"
      ? undefined
      : execution;
  }

  private capRetainedStrings(record: AgentRecord): void {
    record.display.description = retainAgentDescription(record.display.description);
    if (record.result !== undefined) record.result = retainAgentText(record.result);
    if (record.error !== undefined) record.error = retainAgentError(record.error);
    const execution = record.stats.currentExecution;
    if (!execution) return;
    execution.prompt = typeof execution.prompt === "string"
      ? retainExecutionPrompt(execution.prompt)
      : "";
    execution.responseText = execution.responseText === undefined
      ? undefined
      : retainAgentText(execution.responseText);
    execution.error = retainAgentError(execution.error);
  }

}
