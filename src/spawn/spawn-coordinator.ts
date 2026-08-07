import { getSubagentRuntimeContext } from "../shell.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentExecutionSummary, AgentRecord } from "../types.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { ResolvedSpawn } from "./spawn-contract.js";
import {
  BackgroundDeliveryService,
  type DeliveryActivityObserver,
  type DeliveryActivitySnapshot,
} from "./background-delivery.js";

export type { DeliveryActivityProjection, DeliveryActivitySnapshot, DeliveryActivityObserver } from "./background-delivery.js";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * The coordinator is the root execution facade. AgentManager owns execution
 * and records; BackgroundDeliveryService owns execution-scoped result handoff.
 */
export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
  /** Full foreground response; retained record projections may be bounded. */
  responseText?: string;
}

/** Input for continueAgent(). Built by the AgentContinue tool executor. */
export interface ContinueIntent {
  agentId: string;
  prompt: string;
  runInBackground: boolean;
  /** Parent abort signal forwarded to the agent manager. */
  signal?: AbortSignal;
}

export interface ContinueResult {
  executionId: string;
  record: AgentRecord;
  /** Full foreground response; retained execution text may be bounded. */
  responseText?: string;
}

function isTerminal(record: AgentRecord): boolean {
  return record.lifecycle.status !== "running" && record.lifecycle.status !== "queued";
}

export class SpawnCoordinator {
  private readonly deliveryService: BackgroundDeliveryService;
  private readonly manager: AgentManager;
  /** Stable bound subscription facade; the delivery service remains the owner. */
  readonly subscribeDeliveryActivity: (observer: DeliveryActivityObserver) => () => void;

  constructor(manager: AgentManager) {
    this.manager = manager;
    this.deliveryService = new BackgroundDeliveryService(
      manager,
      () => { this.pruneRetainedRecords(); },
    );
    this.subscribeDeliveryActivity = this.deliveryService.subscribeActivity.bind(this.deliveryService);
    // The service owns the authoritative pending/armed delivery map. The
    // manager receives only a query, never a second copy of that state. Keep
    // minimal legacy test/host manager doubles compatible with the optional
    // retention hook; the public runtime always provides it.
    const setRetentionProtection = (this.manager as unknown as {
      setRetentionProtection?: (protection: (record: AgentRecord) => boolean) => void;
    }).setRetentionProtection;
    if (typeof setRetentionProtection === "function") {
      setRetentionProtection.call(this.manager, (record) => this.deliveryService.isPendingOrArmed(record.id));
    }
  }

  /** Return only completed, still-pending coordinator deliveries. */
  getDeliveryActivitySnapshot(): DeliveryActivitySnapshot {
    return this.deliveryService.getActivitySnapshot();
  }

  /** Spawn + wire tracking + (foreground) await. */
  async spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    resolvedSpawn: ResolvedSpawn,
    onAccepted?: (record: AgentRecord) => void,
  ): Promise<SpawnResult> {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }
    const runInBackground = resolvedSpawn.runInBackground;
    const agentId = this.manager.spawn(pi, ctx, resolvedSpawn);
    const record = this.manager.getRecord(agentId)!;

    // Foreground callers await below, so publish the accepted record's full ID
    // before that await. Rendering is observational and must never affect the
    // accepted execution if a host-side observer fails.
    if (!runInBackground && onAccepted) {
      try {
        onAccepted(record);
      } catch {
        // Render observers are best-effort and cannot change spawn semantics.
      }
    }

    const executionId = record.stats.executions?.[0]?.id;
    if (runInBackground) {
      if (executionId) {
        // Install the claim before reconciliation: the manager may have
        // completed synchronously before control returned to this facade.
        this.deliveryService.claim(record, executionId, resolvedSpawn.signal);
        this.deliveryService.reconcile(record, executionId);
        // Completion pruning is normally queued by the manager. Reconcile can
        // settle a completion-before-claim race synchronously, so make the
        // post-claim trigger explicit as well.
        this.pruneRetainedRecords();
      }
      // Background acceptance is always an immediate acknowledgement, even if
      // a malformed/legacy manager record has no execution id to reconcile.
      return { agentId, record };
    }

    if (isTerminal(record)) {
      // A conforming runner may settle before the coordinator regains control;
      // still capture its full caller-facing promise before releasing it.
      const terminalPromise = record.execution.promise;
      if (!terminalPromise) {
        record.lifecycle.resultConsumed = true;
        return { agentId, record };
      }
      try {
        const responseText = await terminalPromise;
        record.lifecycle.resultConsumed = true;
        return { agentId, record, responseText };
      } finally {
        this.releaseConsumedPromise(record, terminalPromise);
      }
    }

    // The execution promise is the foreground return channel and remains
    // complete. AgentRecord.result is only a retained diagnostic projection.
    const foregroundPromise = record.execution.promise;
    if (!foregroundPromise) return { agentId, record };
    try {
      const responseText = await foregroundPromise;
      record.lifecycle.resultConsumed = true;
      return { agentId, record, responseText };
    } finally {
      this.releaseConsumedPromise(record, foregroundPromise);
    }
  }

  /**
   * Continue an existing agent's session. Foreground callers await their own
   * execution; background callers return immediately and receive a per-
   * execution completion notification through BackgroundDeliveryService.
   */
  async continueAgent(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: ContinueIntent,
  ): Promise<ContinueResult> {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent continuation is unavailable from a child runtime");
    }
    const { executionId, record, promise } = this.manager.continueAgent(intent.agentId, intent.prompt, {
      isBackground: intent.runInBackground,
      signal: intent.signal,
    });

    if (intent.runInBackground) {
      // Claim before reconcile for the completion-before-claim race. The
      // service also resets the record's latest delivery projection here.
      this.deliveryService.claim(record, executionId, intent.signal, { resetRecordProjection: true });
      this.deliveryService.reconcile(record, executionId);
      this.pruneRetainedRecords();
      // Background callers never await this promise (a queued stop rejects
      // it), so observe the rejection here as well as at the manager.
      promise.catch(() => {});
      return { executionId, record };
    }

    // Capture the caller-facing promise locally. The record may move to a
    // newer continuation before this await/finally completes.
    try {
      const responseText = await promise;
      record.lifecycle.resultConsumed = true;
      return { executionId, record, responseText };
    } finally {
      // Even a rejected continuation (stopped/cancelled while queued) is
      // consumed by the caller's error result.
      record.lifecycle.resultConsumed = true;
      this.releaseConsumedPromise(record, promise);
    }
  }

  /** Called by AgentManager's completion callback, once per executed turn. */
  onAgentComplete(record: AgentRecord, execution: AgentExecutionSummary): void {
    this.deliveryService.onAgentComplete(record, execution);
  }

  private releaseConsumedPromise(record: AgentRecord, promise: Promise<string>): void {
    const manager = this.manager as unknown as {
      releaseExecutionPromise?: (record: AgentRecord, promise: Promise<string>) => boolean;
      clearExecutionPromise?: (record: AgentRecord, promise: Promise<string>) => boolean;
    };
    try {
      if (typeof manager.releaseExecutionPromise === "function") {
        manager.releaseExecutionPromise(record, promise);
      } else if (typeof manager.clearExecutionPromise === "function") {
        manager.clearExecutionPromise(record, promise);
      }
    } catch {
      // Promise retention is cleanup telemetry; it cannot change the caller's
      // already-consumed response.
    }
  }

  /** Ask the manager to prune without requiring legacy manager doubles to know retention. */
  private pruneRetainedRecords(): void {
    const prune = (this.manager as unknown as {
      pruneRetainedRecords?: () => string[];
    }).pruneRetainedRecords;
    if (typeof prune !== "function") return;
    try {
      prune.call(this.manager);
    } catch {
      // Retention must not change spawn/delivery behavior.
    }
  }

  /** Cancel all delayed/retained delivery work at session shutdown. */
  dispose(): void {
    this.deliveryService.dispose();
  }
}
