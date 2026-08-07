/**
 * Small FIFO scheduler used by AgentManager for the session-wide concurrency
 * limit. It owns slot accounting and queue order, but deliberately knows
 * nothing about records or how a queued task is started.
 */

import { normalizeConcurrencyDefault } from "../config/types.js";

export type QueueDecision = "queued" | "running";

/** Queue entries carry an id so a caller can cancel a retained task. */
export interface SchedulerEntry {
  readonly id: string;
}

export type QueueEligibility<T> = (entry: T) => boolean;

const ALWAYS_ELIGIBLE: QueueEligibility<never> = () => true;

function normalizeLimit(limit: number): number {
  // The scheduler is also a runtime boundary: callers can originate outside
  // the typed config path, so never let coercion, NaN, Infinity, or a fraction
  // alter slot accounting. Invalid values use the same durable default as the
  // persistence/store layers.
  return normalizeConcurrencyDefault(limit);
}

export class FifoConcurrencyScheduler<T extends SchedulerEntry> {
  private readonly queue: T[] = [];
  private limit: number;
  private running = 0;

  constructor(limit: number) {
    this.limit = normalizeLimit(limit);
  }

  get limitCount(): number {
    return this.limit;
  }

  get runningCount(): number {
    return this.running;
  }

  /** Number of accepted tasks waiting for a slot. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Existing queued-count alias retained for scheduler callers. */
  get queuedCount(): number {
    return this.pendingCount;
  }

  /** Decide whether a newly accepted task must wait for a slot. */
  decide(): QueueDecision {
    return this.running >= this.limit || this.queue.length > 0 ? "queued" : "running";
  }

  /** Whether a newly accepted task must wait for a slot. */
  shouldQueue(): boolean {
    return this.decide() === "queued";
  }

  /** Retain one task at the tail without changing slot ownership. */
  enqueue(entry: T): void {
    this.queue.push(entry);
  }

  /** Reserve a slot for a task that the caller is about to start. */
  acquire(): void {
    if (this.shouldQueue()) throw new Error("Concurrency slot unavailable");
    this.running++;
  }

  /**
   * Release one running slot and reserve every now-eligible queued task in
   * FIFO order. The returned entries are owned by the caller for starting.
   * Entries rejected by eligibility are discarded as stale queue records.
   */
  release(
    isEligible: QueueEligibility<T> = ALWAYS_ELIGIBLE as QueueEligibility<T>,
    maxEntries = Number.POSITIVE_INFINITY,
  ): T[] {
    this.releaseSlot();
    return this.takeAvailable(isEligible, maxEntries);
  }

  /** Release a slot while leaving queued entries available for a later drain. */
  releaseSlot(): void {
    if (this.running <= 0) throw new Error("Concurrency slot release underflow");
    this.running--;
  }

  /** Apply a new limit and return queued work made runnable by the change. */
  setLimit(
    limit: number,
    isEligible: QueueEligibility<T> = ALWAYS_ELIGIBLE as QueueEligibility<T>,
    maxEntries = Number.POSITIVE_INFINITY,
  ): T[] {
    this.limit = normalizeLimit(limit);
    return this.takeAvailable(isEligible, maxEntries);
  }

  /** Reserve the next eligible queued entry without changing running slots. */
  takeNext(isEligible: QueueEligibility<T> = ALWAYS_ELIGIBLE as QueueEligibility<T>): T[] {
    return this.takeAvailable(isEligible, 1);
  }

  /** Remove all retained entries matching a cancellation predicate. */
  removeWhere(predicate: (entry: T) => boolean): T[] {
    const removed: T[] = [];
    const retained: T[] = [];
    for (const entry of this.queue) {
      (predicate(entry) ? removed : retained).push(entry);
    }
    this.queue.length = 0;
    this.queue.push(...retained);
    return removed;
  }

  /** Release all queued entries during manager disposal. */
  clear(): T[] {
    return this.queue.splice(0, this.queue.length);
  }

  private takeAvailable(isEligible: QueueEligibility<T>, maxEntries = Number.POSITIVE_INFINITY): T[] {
    const started: T[] = [];
    while (started.length < maxEntries && this.running < this.limit && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (!isEligible(entry)) continue;
      this.running++;
      started.push(entry);
    }
    return started;
  }
}
