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
  type RunCallbacks,
  type StopInitiator,
  SHORT_ID_LENGTH,
  type SpawnConfig,
  type ToolActivity,
} from "../types.js";
import { getAgentConfig, resolveType, snapshotAgentConfig } from "./agent-types.js";
import type { SubagentType } from "./types.js";
import { getLifetimeTotal } from "./usage.js";
import { FifoConcurrencyScheduler } from "./concurrency-scheduler.js";
import { ExecutionTelemetry, type ExecutionBaseline } from "./execution-telemetry.js";
import { errorMessage } from "../utils.js";
import { getSubagentRuntimeContext } from "../shell.js";
import type { SubagentRuntimeSettings } from "../config/config-store.js";
import { acceptResolvedSpawn, snapshotAcceptedSpawn, type AcceptedSpawn, type ResolvedSpawn } from "../spawn/spawn-contract.js";

/** UUID prefix length for agent IDs stored in the agents map. */
const AGENT_ID_PREFIX_LENGTH = 17;
export interface ConcurrencyConfig {
  default: number;
}

export type OnAgentComplete = (record: AgentRecord, execution: AgentExecutionSummary) => void;
type OnAgentStart = (record: AgentRecord) => void;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** Present only for the retained direct-call adapter. */
  type?: SubagentType;
  /** Present only for the retained direct-call adapter. */
  prompt?: string;
  /** The immutable contract accepted by AgentManager for the normal path. */
  acceptedSpawn?: AcceptedSpawn;
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
  /** Immutable contract supplied by the regular Agent tool path. */
  acceptedSpawn?: AcceptedSpawn;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;

  /** Session-level cumulative agent cost. */
  private totalAgentCost = 0;
  /** Session-level cumulative accepted root count. */
  private totalAgentCount = 0;
  private readonly scheduler: FifoConcurrencyScheduler<QueueEntry>;
  private parentAbortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();
  private readonly telemetry: ExecutionTelemetry;

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.scheduler = new FifoConcurrencyScheduler(concurrency?.default ?? 4);
    this.telemetry = new ExecutionTelemetry((record) => this.agents.get(record.id) === record);
  }

  setConcurrency(config: ConcurrencyConfig): void {
    this.startQueuedEntries(this.scheduler.setLimit(
      config.default,
      (entry) => this.canStartQueuedEntry(entry),
      1,
    ));
  }

  /**
   * Accept a pre-resolved root agent and return its id immediately.
   *
   * This overload is the normal Agent-tool path. It is deliberately the only
   * ResolvedSpawn -> AcceptedSpawn boundary in the spawn pipeline.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    resolvedSpawn: ResolvedSpawn,
  ): string;
  /** Legacy adapter for direct callers that still provide scalar spawn fields. */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string;
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    typeOrResolved: SubagentType | ResolvedSpawn,
    promptOrOptions?: string | SpawnOptions,
    legacyOptions?: SpawnOptions,
  ): string {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }
    if (typeof typeOrResolved === "object" && typeOrResolved !== null) {
      const acceptedSpawn = acceptResolvedSpawn(typeOrResolved);
      const options: SpawnOptions = {
        description: acceptedSpawn.description,
        model: acceptedSpawn.model,
        modelKey: acceptedSpawn.modelKey,
        thinkingLevel: acceptedSpawn.thinkingLevel,
        projectTrusted: acceptedSpawn.projectTrusted,
        agentConfig: acceptedSpawn.agentConfig,
        worktreePath: acceptedSpawn.worktreePath,
        worktreeLabel: acceptedSpawn.worktreeLabel,
        worktreeParentCwd: acceptedSpawn.worktreeParentCwd,
        worktreeSelectionPath: acceptedSpawn.worktreeSelectionPath,
        invocation: acceptedSpawn.invocation,
        isBackground: acceptedSpawn.runInBackground,
        signal: acceptedSpawn.signal,
        runtimeSettings: acceptedSpawn.runtimeSettings,
        acceptedSpawn,
      };
      return this.spawnInternal(
        pi,
        ctx,
        acceptedSpawn.type,
        acceptedSpawn.prompt,
        options,
        acceptedSpawn,
      );
    }
    // Direct manager callers remain on the old adapter. They retain the
    // manager's historical registry/config fallback and optional accepted
    // contract support, but never participate in the normal tool path.
    return this.spawnInternal(
      pi,
      ctx,
      typeOrResolved,
      promptOrOptions as string,
      legacyOptions!,
    );
  }

  private spawnInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
    acceptedContract?: AcceptedSpawn,
  ): string {
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const abortController = new AbortController();
    // Normal calls pass the accepted contract explicitly. The acceptedSpawn
    // option remains a compatibility adapter for direct manager callers.
    const acceptedSpawn = acceptedContract
      ?? (options.acceptedSpawn ? snapshotAcceptedSpawn(options.acceptedSpawn) : undefined);

    let canonicalType: SubagentType;
    let effectivePrompt: string;
    let frozenOptions: SpawnOptions;
    if (acceptedSpawn) {
      // The accepted contract is authoritative. In particular, do not resolve
      // the registry again even when this request waits in the queue.
      canonicalType = acceptedSpawn.type;
      effectivePrompt = acceptedSpawn.prompt;
      frozenOptions = {
        ...options,
        description: acceptedSpawn.description,
        model: acceptedSpawn.model,
        modelKey: acceptedSpawn.modelKey,
        thinkingLevel: acceptedSpawn.thinkingLevel,
        projectTrusted: acceptedSpawn.projectTrusted,
        agentConfig: acceptedSpawn.agentConfig,
        worktreePath: acceptedSpawn.worktreePath,
        worktreeLabel: acceptedSpawn.worktreeLabel,
        worktreeParentCwd: acceptedSpawn.worktreeParentCwd,
        worktreeSelectionPath: acceptedSpawn.worktreeSelectionPath,
        invocation: acceptedSpawn.invocation,
        isBackground: acceptedSpawn.runInBackground,
        signal: acceptedSpawn.signal,
        runtimeSettings: acceptedSpawn.runtimeSettings,
        acceptedSpawn,
      };
    } else {
      // Narrow compatibility adapter for direct AgentManager callers. The
      // regular Agent tool always supplies acceptedSpawn and never enters this
      // lookup path.
      canonicalType = resolveType(type) ?? type;
      effectivePrompt = prompt;
      const resolvedConfig = options.agentConfig ?? getAgentConfig(canonicalType);
      frozenOptions = {
        ...options,
        agentConfig: resolvedConfig && snapshotAgentConfig(resolvedConfig),
      };
    }

    const args: SpawnArgs = acceptedSpawn
      ? { pi, ctx, acceptedSpawn, options: frozenOptions }
      : { pi, ctx, type: canonicalType, prompt: effectivePrompt, options: frozenOptions };
    const queueDecision = this.scheduler.decide();
    const queued = queueDecision === "queued";
    let resolveQueued: ((result: string) => void) | undefined;
    const queuedPromise = queued
      ? new Promise<string>((resolve) => { resolveQueued = resolve; })
      : undefined;
    const queueEntry: SpawnQueueEntry | undefined = queued
      ? { kind: "spawn", id, args, resolve: resolveQueued! }
      : undefined;
    const now = Date.now();
    const status: AgentStatus = queued ? "queued" : "running";
    const executionId = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const modelKey = frozenOptions.modelKey
      ?? (frozenOptions.model ? `${frozenOptions.model.provider}/${frozenOptions.model.id}` : undefined);
    const invocation = frozenOptions.invocation || modelKey !== undefined
      ? {
        ...(frozenOptions.invocation ?? {}),
        ...(modelKey !== undefined ? { modelKey } : {}),
      }
      : undefined;
    const record: AgentRecord = {
      id,
      lifecycle: { status, startedAt: now, settled: false },
      display: {
        type: canonicalType,
        description: frozenOptions.description,
        invocation,
        worktreePath: frozenOptions.worktreePath,
        worktreeLabel: frozenOptions.worktreeLabel,
      },
      execution: { abortController, promise: queuedPromise },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
        cacheRead: 0,
        executions: [{
          id: executionId,
          prompt: effectivePrompt,
          mode: frozenOptions.isBackground ? "background" : "foreground",
          kind: "new",
          status,
          startedAt: now,
        }],
      },
    };
    this.agents.set(id, record);
    this.telemetry.initializeRecord(record);
    this.telemetry.beginExecution(executionId, record);

    // Queue insertion precedes signal binding so an already-aborted caller can
    // remove and settle the accepted work synchronously.
    if (queued) {
      this.scheduler.enqueue(queueEntry!);
      this.bindParentAbortSignal(id, frozenOptions.signal);
      this.totalAgentCount++;
      return id;
    }

    this.bindParentAbortSignal(id, frozenOptions.signal);
    if (record.lifecycle.status !== "running") {
      this.finishUnstartedExecution(record, record.stats.executions![0]!, "stopped");
      this.totalAgentCount++;
      return id;
    }

    this.scheduler.acquire();
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      // A synchronous runner/setup failure bypasses the normal completion
      // promise. Close any already-created output execution without waiting for
      // its asynchronous writes.
      this.finalizeOutputLog(record);
      this.scheduler.releaseSlot();
      this.clearParentAbortSignal(id);
      this.agents.delete(id);
      this.startQueuedEntries(this.scheduler.takeNext(
        (entry) => this.canStartQueuedEntry(entry),
      ));
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

  /** Start one accepted root execution using a scheduler-reserved slot. */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, acceptedSpawn, options }: SpawnArgs,
  ): Promise<string> {
    const acceptedType = acceptedSpawn?.type ?? type;
    const acceptedPrompt = acceptedSpawn?.prompt ?? prompt;
    if (!acceptedType || acceptedPrompt === undefined) {
      throw new Error("Accepted spawn is missing type or prompt");
    }
    this.setStatus(record, "running");
    record.lifecycle.startedAt = Date.now();

    try {
      record.execution.outputLog = new AgentOutputLog(id, acceptedPrompt);
      record.display.outputFile = record.execution.outputLog.path;
    } catch { /* output logs are optional telemetry */ }

    this.onStart?.(record);
    const execution = record.stats.executions!.at(-1)!;
    execution.status = "running";

    const promise = runAgent(ctx, acceptedType, acceptedPrompt, {
      pi,
      agentId: id,
      agentConfig: options.agentConfig,
      runtimeSettings: options.runtimeSettings,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      worktreeParentCwd: options.worktreeParentCwd,
      worktreeSelectionPath: options.worktreeSelectionPath,
      projectTrusted: options.projectTrusted === true,
      acceptedSpawn,
      signal: record.execution.abortController!.signal,
      ...this.telemetry.createCallbacks(record, options, execution.id),
      onTextDelta: (delta, fullText) => {
        if (!this.telemetry.isActiveExecution(record, execution.id)) return;
        options.onTextDelta?.(delta, fullText);
      },
      onSessionCreated: (session) => {
        if (!this.telemetry.isCurrentRecord(record)) {
          try { session.dispose(); } catch { /* stale setup cleanup is best effort */ }
          return;
        }
        record.execution.session = session;
        this.telemetry.observeContext(record);
        if (record.execution.outputLog) record.execution.outputLog.attach(session);
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted }) => {
        if (this.telemetry.isCurrentRecord(record)) record.execution.session = session;
        this.finishTurnExecution(record, execution, { responseText, aborted });
        if (execution.mode === "foreground") execution.deliveredText = responseText;
        return responseText;
      })
      .catch((err) => {
        this.finishTurnExecution(
          record,
          execution,
          { responseText: "", aborted: false, error: errorMessage(err) },
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
    const baseline = this.telemetry.beginExecution(executionId, record);
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

    const queueDecision = this.scheduler.decide();
    const queued = queueDecision === "queued";
    const execution: AgentExecutionSummary = {
      id: executionId,
      prompt,
      mode: request.isBackground ? "background" : "foreground",
      kind: "continued",
      status: queued ? "queued" : "running",
      startedAt,
    };
    (record.stats.executions ??= []).push(execution);
    this.setStatus(record, queued ? "queued" : "running");
    record.lifecycle.settled = false;
    record.lifecycle.completedAt = undefined;
    if (queued) {
      this.scheduler.enqueue({ kind: "continue", id: resolved.id, request });
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

    this.scheduler.acquire();
    try {
      this.startContinueExecution(record, request);
    } catch (err) {
      this.scheduler.releaseSlot();
      const failure = errorMessage(err);
      this.finishUnstartedExecution(record, execution, "error", failure);
      request.reject(err instanceof Error ? err : new Error(failure));
      this.startQueuedEntries(this.scheduler.takeNext(
        (entry) => this.canStartQueuedEntry(entry),
      ));
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
  ): void {
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
      ...this.telemetry.createCallbacks(record, { onToolActivity: request.onToolActivity }, execution.id),
      onTextDelta: (delta, fullText) => {
        if (!this.telemetry.isActiveExecution(record, execution.id)) return;
        request.onTextDelta?.(delta, fullText);
      },
    })
      .then(({ responseText, aborted }) => {
        this.finishTurnExecution(record, execution, { responseText, aborted }, request.baseline);
        if (!request.isBackground) execution.deliveredText = responseText;
        request.resolve(responseText);
        return responseText;
      })
      .catch((err) => {
        this.finishTurnExecution(
          record,
          execution,
          { responseText: "", aborted: false, error: errorMessage(err) },
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
    baseline?: ExecutionBaseline,
  ): void {
    if (record.stats.executions?.at(-1) !== execution) {
      this.telemetry.forgetExecution(execution.id);
      return;
    }

    this.telemetry.observeContext(record, true);
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
    const delta = this.telemetry.delta(record, execution.id, baseline);
    execution.usage = delta?.usage;
    execution.compactionCount = delta?.compactionCount;
    this.telemetry.forgetExecution(execution.id);
    this.totalAgentCost += execution.usage?.cost ?? 0;

    if (record.lifecycle.status !== "stopped") this.setStatus(record, status);
    record.result = outcome.responseText;
    record.error = outcome.error;
    record.lifecycle.completedAt ??= completedAt;

    this.finalizeAgentCompletion(record);
    this.safeNotifyComplete(record, execution);
  }

  private finalizeAgentCompletion(record: AgentRecord): void {
    this.finalizeOutputLog(record);
    this.setSettled(record);
    this.clearParentAbortSignal(record.id);
    this.scheduler.releaseSlot();
    this.startQueuedEntries(this.scheduler.takeNext(
      (entry) => this.canStartQueuedEntry(entry),
    ));
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
    this.telemetry.finalizeUnstartedExecution(execution);
    this.telemetry.forgetExecution(execution.id);

    this.setStatus(record, status);
    record.result = undefined;
    record.error = error;
    record.lifecycle.completedAt = completedAt;
    this.finalizeOutputLog(record);
    this.setSettled(record);
    this.clearParentAbortSignal(record.id);
    this.safeNotifyComplete(record, execution);
    return true;
  }

  /** Finalize telemetry without making lifecycle cleanup wait for disk I/O. */
  private finalizeOutputLog(record: AgentRecord): void {
    const outputLog = record.execution.outputLog;
    if (!outputLog) return;
    try {
      outputLog.finalize({
        totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
        cost: record.stats.lifetimeUsage.cost,
      });
    } catch { /* output-log finalization is best effort */ }
    record.execution.outputLog = undefined;
  }

  private safeNotifyComplete(record: AgentRecord, execution: AgentExecutionSummary): void {
    try {
      this.onComplete?.(record, execution);
    } catch { /* completion observers must not affect lifecycle */ }
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  getTotalAgentCount(): number {
    return this.totalAgentCount;
  }

  private canStartQueuedEntry(entry: QueueEntry): boolean {
    const record = this.agents.get(entry.id);
    return record?.lifecycle.status === "queued";
  }

  /** Start scheduler-reserved entries while retaining FIFO and slot ownership. */
  private startQueuedEntries(entries: QueueEntry[]): void {
    const pending = [...entries];
    while (pending.length > 0) {
      const entry = pending.shift()!;
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") {
        this.scheduler.releaseSlot();
        pending.push(...this.scheduler.takeNext((candidate) => this.canStartQueuedEntry(candidate)));
        continue;
      }

      try {
        if (entry.kind === "spawn") {
          const promise = this.startAgent(entry.id, record, entry.args);
          promise.then(entry.resolve);
        } else {
          this.startContinueExecution(record, entry.request);
        }
        pending.push(...this.scheduler.takeNext((candidate) => this.canStartQueuedEntry(candidate)));
      } catch (err) {
        this.scheduler.releaseSlot();
        const failure = errorMessage(err);
        const failedExecution = entry.kind === "continue"
          ? record.stats.executions?.find((execution) => execution.id === entry.request.executionId)
          : record.stats.executions?.find((execution) => execution.status === "running" || execution.status === "queued");
        this.finishUnstartedExecution(record, failedExecution!, "error", failure);
        if (entry.kind === "continue") entry.request.reject(new Error(failure));
        else entry.resolve("");
        pending.push(...this.scheduler.takeNext((candidate) => this.canStartQueuedEntry(candidate)));
      }
    }
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

    const queuedEntries = wasQueued
      ? this.scheduler.removeWhere((entry) => entry.id === record.id)
      : [];
    const queuedEntry = queuedEntries[0];
    if (wasQueued) {
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
    // status reporting, but let the runner's completion release the slot and
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
    // Shutdown removes the record before a runner can report completion. Queue
    // its one terminal log entry, but deliberately do not await the disk.
    this.finalizeOutputLog(record);
    try { record.execution.session?.dispose(); } catch { /* do not strand other records */ }
    record.execution.session = undefined;
    record.execution.abortController = undefined;
    record.execution.promise = undefined;
  }

  private removeRecord(id: string, record: AgentRecord): void {
    this.telemetry.forgetRecord(record);
    this.releaseExecution(record);
    this.agents.delete(id);
  }

  /** Release every record and queued task at the end of the parent session. */
  dispose(): void {
    for (const entry of this.scheduler.clear()) {
      if (entry.kind === "continue") entry.request.reject(new Error("Agent session shut down"));
      else entry.resolve("");
    }
    for (const id of [...this.parentAbortListeners.keys()]) this.clearParentAbortSignal(id);
    for (const record of this.agents.values()) record.execution.abortController?.abort();
    for (const [id, record] of this.agents) this.removeRecord(id, record);
    this.agents.clear();
  }
}
