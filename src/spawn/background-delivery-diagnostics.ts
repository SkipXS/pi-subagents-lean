import type { BackgroundDeliveryState } from "../types.js";

/** Maximum number of terminal delivery diagnostics retained per session. */
export const MAX_RETAINED_DELIVERY_DIAGNOSTICS = 64;
/** Maximum UTF-8 bytes for the per-record aggregated failure projection. */
export const MAX_BACKGROUND_FAILURE_BYTES = 4 * 1024;

/** Detached terminal delivery state retained after transient handoff cleanup. */
export interface DeliveryDiagnostic {
  readonly executionId: string;
  readonly agentId: string;
  readonly type: string;
  readonly state: BackgroundDeliveryState;
  readonly attempts: number;
  readonly lastAttemptAt?: number;
  readonly lastError?: string;
}

/** Structural input accepted from an active delivery entry. */
export interface DeliveryDiagnosticSource {
  readonly executionId: string;
  readonly agentId: string;
  readonly type: string;
  readonly state: BackgroundDeliveryState;
  readonly attempts: number;
  readonly lastAttemptAt?: number;
  readonly lastError?: string;
}

/**
 * Payload-free insertion-ordered terminal diagnostics.
 *
 * The ring owns only detached projections. It never retains an active entry,
 * payload, timer, signal, or record reference, so active delivery ownership
 * remains entirely in BackgroundDeliveryService.
 */
export class BackgroundDeliveryDiagnostics {
  private readonly ring = new Map<string, DeliveryDiagnostic>();

  retain(source: DeliveryDiagnosticSource): void {
    this.ring.set(source.executionId, Object.freeze({
      executionId: source.executionId,
      agentId: source.agentId,
      type: source.type,
      state: source.state,
      attempts: source.attempts,
      ...(source.lastAttemptAt !== undefined ? { lastAttemptAt: source.lastAttemptAt } : {}),
      ...(source.lastError !== undefined ? { lastError: source.lastError } : {}),
    }));
    while (this.ring.size > MAX_RETAINED_DELIVERY_DIAGNOSTICS) {
      const oldest = this.ring.keys().next().value;
      if (oldest === undefined) break;
      this.ring.delete(oldest);
    }
  }

  clear(): void {
    this.ring.clear();
  }

  get(executionId: string): DeliveryDiagnostic | undefined {
    return this.ring.get(executionId);
  }

  has(executionId: string): boolean {
    return this.ring.has(executionId);
  }

  values(): IterableIterator<DeliveryDiagnostic> {
    return this.ring.values();
  }

  get size(): number {
    return this.ring.size;
  }
}
