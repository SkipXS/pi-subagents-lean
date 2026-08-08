/**
 * Live resources shared by an AgentExecutionService.
 *
 * The service remains the owner of lifecycle decisions. This class owns the
 * parent-signal listener map and releases session resources so state cannot be
 * duplicated across runner and queue paths.
 */

import type { AgentRecord } from "../types.js";

export class AgentExecutionResources {
  private readonly parentAbortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();

  /** Bind a queued or running task to its caller's parent abort signal. */
  bindParentAbortSignal(id: string, signal: AbortSignal | undefined, onAbort: () => void): void {
    if (!signal) return;
    const listener = () => onAbort();
    this.parentAbortListeners.set(id, { signal, listener });
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted && this.parentAbortListeners.has(id)) listener();
  }

  clearParentAbortSignal(id: string): void {
    const entry = this.parentAbortListeners.get(id);
    if (!entry) return;
    entry.signal.removeEventListener("abort", entry.listener);
    this.parentAbortListeners.delete(id);
  }

  clearParentAbortSignals(): void {
    for (const id of [...this.parentAbortListeners.keys()]) this.clearParentAbortSignal(id);
  }

  /** Release handles retained by a record during parent-session shutdown. */
  releaseExecution(record: AgentRecord): void {
    this.clearParentAbortSignal(record.id);
    try { record.execution.session?.dispose(); } catch { /* do not strand other records */ }
    record.execution.session = undefined;
    record.execution.abortController = undefined;
    record.execution.promise = undefined;
  }

  /** Release all parent-signal listeners when the owning service is disposed. */
  dispose(): void {
    this.clearParentAbortSignals();
  }
}
