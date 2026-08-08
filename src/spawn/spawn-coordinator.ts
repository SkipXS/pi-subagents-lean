import { getSubagentRuntimeContext } from "../shell.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import type { ResolvedSpawn } from "./spawn-contract.js";

/** Narrow manager port owned by the foreground coordinator. */
export interface SpawnManagerPort {
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, resolvedSpawn: ResolvedSpawn): string;
  getRecord(id: string): AgentRecord | undefined;
  continueAgent(
    agentId: string,
    prompt: string,
    options?: {
      signal?: AbortSignal;
      onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
      onTextDelta?: (delta: string, fullText: string) => void;
    },
  ): {
    executionId: string;
    record: AgentRecord;
    promise: Promise<string>;
  };
  releaseExecutionPromise(record: AgentRecord, promise: Promise<string>): boolean;
}

/** Result of one fully awaited foreground spawn. */
export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
  /** Complete caller-facing response; retained projections may be bounded. */
  responseText: string;
}

/** Input for one foreground continuation. */
export interface ContinueIntent {
  agentId: string;
  prompt: string;
  /** Parent abort signal forwarded to the manager. */
  signal?: AbortSignal;
}

export interface ContinueResult {
  executionId: string;
  record: AgentRecord;
  /** Complete caller-facing response; retained projections may be bounded. */
  responseText: string;
}

export class SpawnCoordinator {
  constructor(private readonly manager: SpawnManagerPort) {}

  /** Accept, publish, and await one root spawn. */
  async spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    resolvedSpawn: ResolvedSpawn,
    onAccepted?: (record: AgentRecord) => void,
  ): Promise<SpawnResult> {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }

    const agentId = this.manager.spawn(pi, ctx, resolvedSpawn);
    const record = this.manager.getRecord(agentId);
    if (!record) throw new Error(`Agent ${agentId} was not retained after acceptance`);
    try {
      onAccepted?.(record);
    } catch {
      // Rendering is observational and cannot change accepted work.
    }

    const callerPromise = record.execution.promise;
    if (!callerPromise) {
      return { agentId, record, responseText: record.result ?? "" };
    }
    try {
      const responseText = await callerPromise;
      return { agentId, record, responseText };
    } finally {
      this.releaseExecutionPromise(record, callerPromise);
    }
  }

  /** Accept, publish, and await one root continuation. */
  async continueAgent(
    intent: ContinueIntent,
    onAccepted?: (record: AgentRecord) => void,
  ): Promise<ContinueResult> {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent continuation is unavailable from a child runtime");
    }

    const accepted = this.manager.continueAgent(intent.agentId, intent.prompt, {
      signal: intent.signal,
    });
    try {
      onAccepted?.(accepted.record);
    } catch {
      // Rendering is observational and cannot change accepted work.
    }

    try {
      const responseText = await accepted.promise;
      return {
        executionId: accepted.executionId,
        record: accepted.record,
        responseText,
      };
    } finally {
      this.releaseExecutionPromise(accepted.record, accepted.promise);
    }
  }

  private releaseExecutionPromise(record: AgentRecord, promise: Promise<string>): void {
    try {
      this.manager.releaseExecutionPromise(record, promise);
    } catch {
      // Promise cleanup cannot change the caller's already-settled result.
    }
  }
}
