import { getPiInstance, getSessionCtx } from "../shell.js";
import type { AgentExecutionSummary, AgentRecord, AgentStatus, BackgroundDeliveryState } from "../types.js";
import type { AgentManager } from "../agents/agent-manager.js";
import {
  captureBackgroundPayload,
  retainBackgroundDeliveryError,
  retainBackgroundDeliveryFailure,
} from "./background-delivery-payload.js";
import type { BackgroundPayload } from "./background-delivery-payload.js";
import { BackgroundDeliveryDiagnostics } from "./background-delivery-diagnostics.js";

export {
  buildBackgroundContent,
  MAX_BACKGROUND_DETAILS_TEXT_BYTES,
  MAX_BACKGROUND_ERROR_BYTES,
  MAX_BACKGROUND_FAILURE_BYTES,
  MAX_BACKGROUND_MESSAGE_TEXT_BYTES,
  MAX_BACKGROUND_RESULT_BYTES,
} from "./background-delivery-payload.js";
export { MAX_RETAINED_DELIVERY_DIAGNOSTICS } from "./background-delivery-diagnostics.js";

export interface DeliveryActivityProjection {
  readonly agentId: string;
  readonly type: string;
  readonly executionId: string;
}
export type DeliveryActivitySnapshot = readonly DeliveryActivityProjection[];
export type DeliveryActivityObserver = (snapshot: DeliveryActivitySnapshot) => void;
export type BackgroundDeliverySettledHandler = (agentId: string, executionId: string) => void;
export interface BackgroundDeliveryClaimOptions {
  resetRecordProjection?: boolean;
}

const NUDGE_DELAY_MS = 200;

interface BackgroundDeliveryEntry {
  readonly executionId: string;
  readonly agentId: string;
  readonly type: string;
  readonly claimOrder: number;
  payload?: BackgroundPayload;
  signal?: AbortSignal;
  onParentAbort?: () => void;
  state: BackgroundDeliveryState;
  completed: boolean;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
  autoNudgeIssued: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  settledNotified: boolean;
}

export class BackgroundDeliveryService {
  private readonly backgroundDeliveries = new Map<string, BackgroundDeliveryEntry>();
  private readonly terminalDiagnostics = new BackgroundDeliveryDiagnostics();
  private readonly latestDeliveryKeys = new Map<string, string>();
  // A weak key keeps the ordering metadata bounded by retained record
  // lifetimes without retaining evicted record ids in the service.
  private readonly lastFailureOrders = new WeakMap<AgentRecord, number>();
  private readonly deliveryObservers = new Set<DeliveryActivityObserver>();
  private nextClaimOrder = 0;
  private disposed = false;

  constructor(
    private readonly manager: AgentManager,
    private readonly onSettled?: BackgroundDeliverySettledHandler,
  ) {}
  subscribeActivity(observer: DeliveryActivityObserver): () => void {
    this.deliveryObservers.add(observer);
    this.notifyDeliveryObserver(observer);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.deliveryObservers.delete(observer);
    };
  }
  getActivitySnapshot(): DeliveryActivitySnapshot {
    const byAgent = new Map<string, DeliveryActivityProjection>();
    for (const entry of this.backgroundDeliveries.values()) {
      if (!entry.completed || entry.state !== "pending" || !entry.payload) continue;
      byAgent.set(entry.agentId, Object.freeze({
        agentId: entry.agentId,
        type: entry.type,
        executionId: entry.executionId,
      }));
    }
    return Object.freeze([...byAgent.values()].sort((left, right) =>
      left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0,
    ));
  }
  isPendingOrArmed(agentId: string): boolean {
    return [...this.backgroundDeliveries.values()].some((entry) =>
      entry.agentId === agentId && entry.state === "pending",
    );
  }
  claim(
    record: AgentRecord,
    executionId: string,
    signal?: AbortSignal,
    options: BackgroundDeliveryClaimOptions = {},
  ): void {
    if (this.disposed || this.backgroundDeliveries.has(executionId) || this.terminalDiagnostics.has(executionId)) return;
    const entry: BackgroundDeliveryEntry = {
      executionId,
      agentId: record.id,
      type: record.display.type,
      claimOrder: ++this.nextClaimOrder,
      signal,
      state: "pending",
      completed: false,
      attempts: 0,
      autoNudgeIssued: false,
      timer: null,
      settledNotified: false,
    };
    this.backgroundDeliveries.set(executionId, entry);
    this.latestDeliveryKeys.set(record.id, executionId);
    if (options.resetRecordProjection) {
      const lastFailure = record.delivery?.lastFailure;
      record.delivery = {
        state: "pending",
        attempts: 0,
        ...(lastFailure !== undefined ? { lastFailure } : {}),
      };
      record.lifecycle.resultConsumed = false;
    } else {
      record.delivery ??= { state: "pending", attempts: 0 };
    }
    this.trackBackgroundParentAbort(entry, record);
    this.notifyDeliveryObservers();
  }
  reconcile(record: AgentRecord, executionId?: string): void {
    if (!executionId) return;
    const execution = record.stats.executions?.find((candidate) => candidate.id === executionId);
    if (!execution || execution.status === "running" || execution.status === "queued") return;
    this.onAgentComplete(record, execution);
  }
  onAgentComplete(record: AgentRecord, execution: AgentExecutionSummary): void {
    if (execution.mode !== "background") return;
    const entry = this.backgroundDeliveries.get(execution.id);
    if (!entry || entry.completed) return;
    entry.completed = true;
    entry.payload = captureBackgroundPayload(record, execution);
    if (this.disposed || entry.signal?.aborted) {
      this.abandonBackgroundDelivery(entry, record);
      return;
    }
    this.scheduleEntry(entry);
    this.notifyDeliveryObservers();
  }
  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.backgroundDeliveries.values()]) {
      this.abandonBackgroundDelivery(entry, this.manager.getRecord(entry.agentId));
    }
    this.backgroundDeliveries.clear();
    this.terminalDiagnostics.clear();
    this.latestDeliveryKeys.clear();
    this.notifyDeliveryObservers();
    this.deliveryObservers.clear();
  }
  private notifyDeliveryObserver(observer: DeliveryActivityObserver): void {
    try {
      observer(this.getActivitySnapshot());
    } catch {
      // Presentation observers must never affect delivery lifecycle.
    }
  }
  private notifyDeliveryObservers(): void {
    for (const observer of [...this.deliveryObservers]) this.notifyDeliveryObserver(observer);
  }
  private trackBackgroundParentAbort(entry: BackgroundDeliveryEntry, record: AgentRecord): void {
    const signal = entry.signal;
    if (!signal) return;
    if (signal.aborted) {
      this.abandonBackgroundDelivery(entry, record);
      return;
    }
    entry.onParentAbort = () => this.abandonBackgroundDelivery(entry, this.manager.getRecord(entry.agentId));
    signal.addEventListener("abort", entry.onParentAbort, { once: true });
  }

  private removeParentAbortListener(entry: BackgroundDeliveryEntry): void {
    if (!entry.signal || !entry.onParentAbort) return;
    entry.signal.removeEventListener("abort", entry.onParentAbort);
    entry.onParentAbort = undefined;
  }

  private abandonBackgroundDelivery(entry: BackgroundDeliveryEntry, record?: AgentRecord): void {
    if (entry.settledNotified || entry.state === "accepted") return;
    entry.state = "abandoned";
    if (record && this.isLatestDelivery(record.id, entry)) {
      this.projectDelivery(record, entry);
      record.lifecycle.resultConsumed = true;
    }
    this.settleEntry(entry);
  }

  private clearTransientEntry(entry: BackgroundDeliveryEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.removeParentAbortListener(entry);
    entry.signal = undefined;
    entry.payload = undefined;
  }

  private settleEntry(entry: BackgroundDeliveryEntry): void {
    if (entry.settledNotified) return;
    this.clearTransientEntry(entry);
    if (this.backgroundDeliveries.get(entry.executionId) === entry) {
      this.backgroundDeliveries.delete(entry.executionId);
    }
    this.terminalDiagnostics.retain(entry);
    this.cleanupLatestDeliveryKey(entry.agentId);
    this.notifyDeliveryObservers();
    this.notifySettled(entry);
  }

  private cleanupLatestDeliveryKey(agentId: string): void {
    const hasActiveEntry = [...this.backgroundDeliveries.values()].some((entry) =>
      entry.agentId === agentId && entry.state === "pending",
    );
    if (!hasActiveEntry) this.latestDeliveryKeys.delete(agentId);
  }

  private isLatestDelivery(agentId: string, entry: BackgroundDeliveryEntry): boolean {
    return this.latestDeliveryKeys.get(agentId) === entry.executionId;
  }

  private projectFailure(record: AgentRecord, entry: BackgroundDeliveryEntry): void {
    if (entry.state !== "failed" || entry.lastError === undefined) return;
    const previousOrder = this.lastFailureOrders.get(record);
    // Claim order, rather than completion timing, makes concurrent delivery
    // failures deterministic and prevents an older execution from replacing a
    // newer failure projection that completed first.
    if (previousOrder !== undefined && previousOrder > entry.claimOrder) return;

    const lastFailure = Object.freeze({
      executionId: entry.executionId,
      attempts: entry.attempts,
      ...(entry.lastAttemptAt !== undefined ? { lastAttemptAt: entry.lastAttemptAt } : {}),
      lastError: retainBackgroundDeliveryFailure(entry.lastError),
    });
    this.lastFailureOrders.set(record, entry.claimOrder);
    if (record.delivery) {
      record.delivery = { ...record.delivery, lastFailure };
    } else {
      // Defensive fallback for direct/legacy records; normal claims initialize
      // the latest projection before any delivery attempt can run.
      record.delivery = {
        state: entry.state,
        attempts: entry.attempts,
        ...(entry.lastAttemptAt !== undefined ? { lastAttemptAt: entry.lastAttemptAt } : {}),
        lastError: entry.lastError,
        lastFailure,
      };
    }
  }

  private projectDelivery(record: AgentRecord, entry: BackgroundDeliveryEntry): void {
    if (!this.isLatestDelivery(record.id, entry)) return;
    const lastFailure = record.delivery?.lastFailure;
    record.delivery = {
      state: entry.state,
      attempts: entry.attempts,
      ...(entry.lastAttemptAt !== undefined ? { lastAttemptAt: entry.lastAttemptAt } : {}),
      ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
      ...(lastFailure !== undefined ? { lastFailure } : {}),
    };
  }

  private scheduleEntry(entry: BackgroundDeliveryEntry): void {
    if (this.disposed || entry.state !== "pending" || !entry.completed || entry.autoNudgeIssued) return;
    entry.autoNudgeIssued = true;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.deliver(entry);
    }, NUDGE_DELAY_MS);
  }

  private deliver(entry: BackgroundDeliveryEntry): void {
    if (this.disposed || this.backgroundDeliveries.get(entry.executionId) !== entry) return;
    const record = this.manager.getRecord(entry.agentId);
    if (!record) {
      entry.state = "abandoned";
      this.settleEntry(entry);
      return;
    }
    if (entry.state !== "pending") return;
    if (entry.signal?.aborted) {
      this.abandonBackgroundDelivery(entry, record);
      return;
    }

    entry.attempts++;
    entry.lastAttemptAt = Date.now();
    delete entry.lastError;
    try {
      const pi = getPiInstance();
      if (!pi) throw new Error("Pi instance unavailable for background result delivery");
      if (this.disposed || this.backgroundDeliveries.get(entry.executionId) !== entry || entry.signal?.aborted) {
        this.abandonBackgroundDelivery(entry, record);
        return;
      }
      const payload = entry.payload;
      if (!payload) throw new Error("Background result payload is unavailable");
      const parentIdle = getSessionCtx()?.isIdle?.() ?? true;
      pi.sendMessage(
        {
          customType: "subagent-result",
          content: payload.content,
          details: payload.details,
          display: true,
        },
        { deliverAs: parentIdle ? "followUp" : "steer", triggerTurn: true },
      );
      entry.state = "accepted";
      const execution = record.stats.executions?.find((candidate) => candidate.id === entry.executionId);
      if (execution) {
        execution.deliveredText = payload.result;
        // Delivery attaches a retained summary projection after runner
        // completion; reconcile the aggregate per-record text budget now.
        this.manager.reconcileExecutionHistory?.(record);
      }
      if (this.isLatestDelivery(record.id, entry)) record.lifecycle.resultConsumed = true;
      this.projectDelivery(record, entry);
      this.settleEntry(entry);
    } catch (error) {
      if (entry.settledNotified) return;
      entry.state = "failed";
      entry.lastError = retainBackgroundDeliveryError(error);
      this.projectFailure(record, entry);
      this.projectDelivery(record, entry);
      this.settleEntry(entry);
    }
  }

  private notifySettled(entry: BackgroundDeliveryEntry): void {
    if (entry.settledNotified) return;
    entry.settledNotified = true;
    try {
      this.onSettled?.(entry.agentId, entry.executionId);
    } catch {
      // Retention is best effort and must never alter exactly-once delivery.
    }
  }
}
