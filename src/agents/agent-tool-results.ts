import { getStatusNote } from "../status-note.js";
import { formatAgentIdFirstContent } from "./execution-display.js";
import type { AgentRecord } from "../types.js";
import {
  type AgentCallRenderMetadata,
  withAgentCallRenderMetadata,
} from "./agent-render-format.js";
import type { AgentRenderMetadataBridge } from "./agent-render-bridge.js";

export type { AgentCallRenderMetadata };

/** Shortcut for a successful tool result. */
export function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/** Shortcut for an error tool result. */
export function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true as const, details };
}

/** Cancellation has a distinct tool contract; it is never reported as success. */
export function cancelledResult(details?: Record<string, unknown>) {
  return errorResult("Agent execution cancelled", details);
}

/** Attach renderer-only invocation metadata without changing public result text. */
export function agentRenderDetails(
  details: Record<string, unknown> | undefined,
  metadata: AgentCallRenderMetadata,
): Record<string, unknown> {
  return withAgentCallRenderMetadata(details, metadata);
}

/**
 * Notify Pi's row renderer as soon as model/type resolution is complete.
 * Partial updates are UI-only; the final tool result remains the sole LLM
 * result and keeps its existing content unchanged.
 */
export function emitAgentRenderUpdate(
  toolCallId: string,
  onUpdate: ((update: any) => void) | undefined,
  metadata: AgentCallRenderMetadata,
  renderBridge: AgentRenderMetadataBridge | undefined,
): void {
  renderBridge?.update(toolCallId, metadata);
  if (!onUpdate) return;
  try {
    onUpdate({ content: [], details: agentRenderDetails(undefined, metadata) });
  } catch {
    // A renderer update must never turn a valid tool execution into a failure.
  }
}

/** Prefer the session's actual model/thinking values once a session exists. */
export function finalAgentRenderMetadata(
  metadata: AgentCallRenderMetadata,
  record: AgentRecord | undefined,
): AgentCallRenderMetadata {
  let modelKey = metadata.model;
  let thinking = metadata.thinking;
  try {
    const session = record?.execution?.session;
    if (session?.model) modelKey = `${session.model.provider}/${session.model.id}`;
    if (session?.thinkingLevel) thinking = session.thinkingLevel;
  } catch {
    // Terminal/legacy records may expose no live session; keep the resolved
    // preflight values, which are still sufficient to render the row.
  }
  const agentId = typeof record?.id === "string" && record.id.length > 0 ? record.id : undefined;
  return {
    ...metadata,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(modelKey !== undefined ? { model: modelKey } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

/** Return the actual provider/model key retained on a root record. */
function recordModelKey(record: AgentRecord | undefined): string | undefined {
  try {
    const sessionModel = record?.execution?.session?.model;
    if (
      typeof sessionModel?.provider === "string" && sessionModel.provider.length > 0
      && typeof sessionModel.id === "string" && sessionModel.id.length > 0
    ) {
      return `${sessionModel.provider}/${sessionModel.id}`;
    }
  } catch {
    // A disposed/legacy session may throw while its invocation is still safe.
  }
  try {
    const persisted = record?.display?.invocation?.modelKey;
    return typeof persisted === "string" && persisted.length > 0 ? persisted : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build renderer metadata for AgentContinue/StopAgent from a retained record.
 * The invocation fallback is important while an accepted agent is queued and
 * has not created its session yet.
 */
export function agentControlRenderMetadata(
  record: AgentRecord | undefined,
  requestedId: string,
  prompt = "",
  execution?: { mode: "foreground" | "background"; kind: "continued" },
): AgentCallRenderMetadata {
  if (!record) {
    return {
      agentId: requestedId || "—",
      role: "—",
      prompt,
      ...execution,
    };
  }

  let role = "—";
  let thinking: string | undefined;
  try {
    if (typeof record.display?.type === "string" && record.display.type.length > 0) {
      role = record.display.type;
    }
  } catch {
    // Legacy/malformed terminal records still render their safe ID and dashes.
  }
  try {
    const sessionThinking = record.execution?.session?.thinkingLevel;
    if (typeof sessionThinking === "string" && sessionThinking.length > 0) {
      thinking = sessionThinking;
    }
  } catch {
    // Fall back to the persisted invocation below.
  }
  if (thinking === undefined) {
    try {
      const invocationThinking = record.display?.invocation?.thinkingLevel;
      if (typeof invocationThinking === "string" && invocationThinking.length > 0) {
        thinking = invocationThinking;
      }
    } catch {
      // Keep the dash for malformed legacy records.
    }
  }

  const agentId = typeof record.id === "string" && record.id.length > 0 ? record.id : requestedId || "—";
  const model = recordModelKey(record);
  return {
    agentId,
    role,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    prompt,
    ...execution,
  };
}

/**
 * Result text plus status note, for tool delivery.
 *
 * Shared by the foreground tool result and the subagent-result nudge so both
 * callers stay in sync on the nullish default and separator handling — they
 * have diverged before. getStatusNote owns the leading separator.
 */
export function formatResultContent(record: AgentRecord, responseText?: string): string {
  return (responseText ?? record.result ?? "") + getStatusNote(record.lifecycle);
}

/** Format the shared canonical-ID/response envelope for successful foreground results. */
export function formatForegroundAgentResultContent(record: AgentRecord, responseText?: string): string {
  return formatAgentIdFirstContent(record.id, `Response:\n${formatResultContent(record, responseText)}`);
}
