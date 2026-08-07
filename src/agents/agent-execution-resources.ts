/**
 * Live resources shared by an AgentExecutionService.
 *
 * The service remains the owner of lifecycle decisions. This class owns the
 * one output root, output-log setup/release, and parent-signal listener map so
 * state cannot be duplicated across runner and queue paths.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentOutputLog, createOutputRoot, releaseOutputRoot } from "./output-file.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "./usage.js";

export class AgentExecutionResources {
  private readonly parentAbortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();
  private outputRoot: string | null | undefined;

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

  /** Lazily create one private root; output logging remains optional. */
  getOutputRoot(): string | undefined {
    if (this.outputRoot !== undefined) return this.outputRoot ?? undefined;
    try {
      this.outputRoot = createOutputRoot();
    } catch {
      // Logging is optional telemetry; do not use a shared fallback directory.
      this.outputRoot = null;
    }
    return this.outputRoot ?? undefined;
  }

  /** Attach the initial output log without making logging lifecycle-critical. */
  prepareSpawnOutput(record: AgentRecord, id: string, prompt: string): void {
    try {
      const outputRoot = this.getOutputRoot();
      if (!outputRoot) throw new Error("Private output log root unavailable");
      record.execution.outputLog = new AgentOutputLog(id, prompt, outputRoot);
      record.display.outputFile = record.execution.outputLog.path;
    } catch {
      // Output logs are optional telemetry.
    }
  }

  /** Reuse or create the continuation log and attach it to the session. */
  prepareContinuationOutput(
    record: AgentRecord,
    id: string,
    prompt: string,
    session: AgentSession,
  ): void {
    try {
      if (record.execution.outputLog) {
        record.execution.outputLog.append(prompt);
        record.execution.outputLog.attach(session, session.messages.length + 1);
      } else {
        const outputRoot = this.getOutputRoot();
        if (!outputRoot) throw new Error("Private output log root unavailable");
        record.execution.outputLog = new AgentOutputLog(id, prompt, outputRoot, true);
        record.display.outputFile = record.execution.outputLog.path;
        record.execution.outputLog.attach(session, session.messages.length + 1);
      }
    } catch {
      // Output logs are optional telemetry.
    }
  }

  /** Finalize telemetry without waiting for asynchronous output writes. */
  finalizeOutputLog(record: AgentRecord): void {
    const outputLog = record.execution.outputLog;
    if (!outputLog) return;
    try {
      outputLog.finalize({
        totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
        cost: record.stats.lifetimeUsage.cost,
      });
    } catch {
      // Output logging is optional telemetry and never blocks lifecycle work.
    }
    record.execution.outputLog = undefined;
  }

  /** Release handles retained by a record during parent-session shutdown. */
  releaseExecution(record: AgentRecord): void {
    this.clearParentAbortSignal(record.id);
    this.finalizeOutputLog(record);
    try { record.execution.session?.dispose(); } catch { /* do not strand other records */ }
    record.execution.session = undefined;
    record.execution.abortController = undefined;
    record.execution.promise = undefined;
  }

  /** Release root accounting after callers have stopped retaining executions. */
  dispose(): void {
    this.clearParentAbortSignals();
    const outputRoot = this.outputRoot;
    this.outputRoot = undefined;
    if (outputRoot) {
      // releaseOutputRoot waits for already-queued final log writes without
      // blocking disposal, then clears accounting/identity maps and leaves the
      // persistent root for global retention.
      void releaseOutputRoot(outputRoot);
    }
  }
}
