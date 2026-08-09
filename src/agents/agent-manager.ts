/**
 * agent-manager.ts — lifecycle and scheduling facade for root agents.
 *
 * Records remain available for AgentContinue while AgentExecutionService owns
 * live runner resources, parent cancellation, and scheduler cleanup.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AgentExecutionService,
  type ContinueExecutionRequest,
  type ContinueExecutionTask,
  type SpawnExecutionTask,
} from "./agent-execution-service.js";
import {
  AgentRecordStore,
  MAX_RETAINED_AGENT_RECORDS,
} from "./agent-record-store.js";
import type {
  AgentRecord,
  ToolActivity,
} from "../types.js";
import { ExecutionTelemetry } from "./execution-telemetry.js";
import { getSubagentRuntimeContext } from "../shell.js";
import { acceptResolvedSpawn, type ResolvedSpawn } from "../spawn/spawn-contract.js";
import { normalizeConcurrencyDefault } from "../config/types.js";
import { assertAgentId, assertAgentPrompt } from "./agent-string-limits.js";

export interface ConcurrencyConfig {
  default: number;
}

/** Maximum number of accepted root executions waiting in the global queue. */
export const MAX_QUEUED_ROOT_EXECUTIONS = 128;
/** Stable tool-facing error when a new execution would exceed the queue quota. */
export const QUEUE_QUOTA_ERROR = "Agent queue is full (maximum 128 queued root executions)";

export interface ContinueOptions {
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
  private totalAgentCost = 0;
  private totalAgentCount = 0;
  private retentionPruneScheduled = false;

  constructor(concurrency?: ConcurrencyConfig) {
    const configuredConcurrency = concurrency;
    this.records = new AgentRecordStore();
    this.telemetry = new ExecutionTelemetry((record) => this.records.get(record.id) === record);
    this.executionService = new AgentExecutionService({
      store: this.records,
      telemetry: this.telemetry,
      concurrency: normalizeConcurrencyDefault(configuredConcurrency?.default),
      onSettled: () => this.scheduleRetentionPrune(),
      onCost: (cost) => { this.totalAgentCost += cost; },
    });
  }

  setConcurrency(config: ConcurrencyConfig): void {
    this.executionService.setConcurrency(normalizeConcurrencyDefault(config.default));
  }

  /** Accept a resolved root agent and return its canonical id immediately. */
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, resolvedSpawn: ResolvedSpawn): string {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }

    const acceptedSpawn = acceptResolvedSpawn(resolvedSpawn);
    const queued = this.executionService.shouldQueue();
    this.ensureQueueCapacity(queued);
    const abortController = new AbortController();
    let resolveSpawn!: (result: string) => void;
    const spawnPromise = new Promise<string>((resolve) => { resolveSpawn = resolve; });
    const created = this.records.createSpawnRecord(
      acceptedSpawn,
      queued ? "queued" : "running",
      abortController,
      spawnPromise,
    );
    this.telemetry.initializeRecord(created.record);
    this.telemetry.beginExecution(created.execution, created.record);

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

  /** Continue a successfully completed, settled root session. */
  continueAgent(agentId: string, prompt: string, options: ContinueOptions = {}): ContinueResult {
    assertAgentId(agentId, "agent_id");
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent continuation is unavailable from a child runtime");
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("AgentContinue prompt is required");
    }
    assertAgentPrompt(prompt, "AgentContinue prompt");

    const resolved = this.records.resolveId(agentId);
    if (!resolved.ok) throw new Error(resolved.error);
    const record = this.records.get(resolved.id)!;
    if (record.lifecycle.status !== "completed" || !record.lifecycle.settled) {
      throw new Error(`Agent ${resolved.id.slice(0, 8)} is ${record.lifecycle.status} and cannot be continued`);
    }
    const session = record.execution.session;
    if (!session) {
      throw new Error(`Agent ${resolved.id.slice(0, 8)} session is no longer available`);
    }

    const queued = this.executionService.shouldQueue();
    this.ensureQueueCapacity(queued);

    const executionId = this.records.createExecutionId();
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
      queued ? "queued" : "running",
      startedAt,
    );
    const baseline = this.telemetry.beginExecution(execution, record);
    // Install this caller's promise before the queue/runner boundary. A later
    // continuation can safely replace it because the coordinator releases by
    // promise identity.
    record.execution.promise = promise;
    const request: ContinueExecutionRequest = {
      record,
      session,
      executionId,
      baseline,
      prompt,
      signal: options.signal,
      onToolActivity: options.onToolActivity,
      onTextDelta: options.onTextDelta,
      resolve: resolveRequest!,
      reject: rejectRequest!,
      startedAt,
    };

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

  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  getTotalAgentCount(): number {
    return this.totalAgentCount;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.records.get(id);
  }

  /** Release only the caller promise that is still current for this record. */
  releaseExecutionPromise(record: AgentRecord, promise: Promise<string>): boolean {
    if (record.execution.promise !== promise) return false;
    record.execution.promise = undefined;
    return true;
  }

  /** Retained root records used for unique-prefix continuation lookup. */
  listAgents(): AgentRecord[] {
    return this.records.list();
  }

  /** Evict oldest safe settled records until the retained bound is satisfied. */
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
      this.telemetry.forgetRecord(record);
      this.executionService.releaseExecution(record);
      this.records.remove(record.id);
      evicted.push(record.id);
    }
    return evicted;
  }

  dispose(): void {
    this.executionService.dispose();
  }

  private ensureQueueCapacity(queued: boolean): void {
    if (!queued || this.executionService.pendingCount < MAX_QUEUED_ROOT_EXECUTIONS) return;
    throw new Error(QUEUE_QUOTA_ERROR);
  }

  private scheduleRetentionPrune(): void {
    if (this.retentionPruneScheduled) return;
    this.retentionPruneScheduled = true;
    queueMicrotask(() => {
      this.retentionPruneScheduled = false;
      this.pruneRetainedRecords();
    });
  }
}
