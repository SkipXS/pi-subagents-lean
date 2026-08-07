import { getStatusNote } from "../status-note.js";
import type { AgentExecutionSummary, AgentRecord, AgentStatus } from "../types.js";
import { buildAgentDetails } from "../agents/agent-details.js";
import { executionKind, formatAgentStatusLine } from "../agents/execution-display.js";
import {
  MAX_RETAINED_ERROR_BYTES,
  MAX_RETAINED_TEXT_BYTES,
  retainAgentDescription,
  retainAgentError,
  retainAgentText,
  truncateUtf8,
  utf8ByteLength,
} from "../agents/agent-string-limits.js";
import { capUtf8StringsToBudget } from "../utils.js";
import { MAX_BACKGROUND_FAILURE_BYTES } from "./background-delivery-diagnostics.js";

export { MAX_BACKGROUND_FAILURE_BYTES } from "./background-delivery-diagnostics.js";

/** Maximum UTF-8 bytes for a background execution result retained for delivery. */
export const MAX_BACKGROUND_RESULT_BYTES = MAX_RETAINED_TEXT_BYTES;
/** Maximum UTF-8 bytes for the complete message text/details representation. */
export const MAX_BACKGROUND_MESSAGE_TEXT_BYTES = 64 * 1024;
/** Maximum UTF-8 bytes of text values retained in secondary delivery details. */
export const MAX_BACKGROUND_DETAILS_TEXT_BYTES = 8 * 1024;
/** Maximum UTF-8 bytes for retained sendMessage failure diagnostics. */
export const MAX_BACKGROUND_ERROR_BYTES = MAX_RETAINED_ERROR_BYTES;

/** Immutable payload captured at one execution's completion boundary. */
export interface BackgroundPayload {
  /** Resolved full record id; delivery never echoes a caller's short prefix. */
  readonly agentId: string;
  readonly type: string;
  /** Terminal status of this execution, frozen at completion. */
  readonly status: AgentStatus;
  /** UTF-8-bounded result text frozen at completion; later executions cannot overwrite it. */
  readonly result: string;
  /** Prebuilt message content frozen at completion. */
  readonly content: string;
  readonly details: Record<string, unknown>;
}

/**
 * Build the visible background-result message while reserving the details
 * representation inside the same 64 KiB UTF-8 budget.
 */
export function buildBackgroundContent(
  record: AgentRecord,
  execution: AgentExecutionSummary,
  kind: ReturnType<typeof executionKind>,
  result: string,
  details: Record<string, unknown>,
): string {
  const rawContent = `${formatAgentStatusLine(record.id, record.display.type, execution.status, {
    mode: execution.mode,
    kind,
  })}\n\nResponse:\n${result}${getStatusNote({ ...record.lifecycle, status: execution.status })}`;
  const detailsBytes = serializedUtf8ByteLength(details);
  const contentBudget = Math.max(0, MAX_BACKGROUND_MESSAGE_TEXT_BYTES - detailsBytes);
  return truncateUtf8(rawContent, contentBudget);
}

/**
 * Capture every value needed for one background handoff at completion time.
 * The record/execution projections are hardened in place for legacy/direct
 * records, while the returned payload is detached from later record changes.
 */
export function captureBackgroundPayload(
  record: AgentRecord,
  execution: AgentExecutionSummary,
): BackgroundPayload {
  // Delivery is another retained-projection boundary. Normal records already
  // arrive capped from AgentRecordStore; these assignments also harden the
  // service against legacy/direct record shapes without touching a
  // foreground execution's full return channel.
  if (record.result !== undefined) record.result = retainAgentText(record.result);
  if (record.error !== undefined) record.error = retainAgentError(record.error);
  if (typeof record.display.description === "string") {
    record.display.description = retainAgentDescription(record.display.description);
  }
  if (execution.responseText !== undefined) execution.responseText = retainAgentText(execution.responseText);
  if (execution.deliveredText !== undefined) execution.deliveredText = retainAgentText(execution.deliveredText);
  execution.error = retainAgentError(execution.error);

  const executions = record.stats.executions;
  const index = executions?.indexOf(execution) ?? 0;
  const kind = executionKind(execution, index);
  const result = retainAgentText(execution.responseText ?? record.result ?? "");
  const details = capUtf8StringsToBudget(
    buildAgentDetails(record, { includeStats: true, includeStatus: true, execution }),
    MAX_BACKGROUND_DETAILS_TEXT_BYTES,
  );
  return Object.freeze({
    agentId: record.id,
    type: record.display.type,
    status: execution.status,
    result,
    content: buildBackgroundContent(record, execution, kind, result, details),
    details,
  });
}

/** Convert a thrown delivery value into bounded diagnostic text. */
function retainDeliveryDiagnostic(error: unknown, maxBytes: number): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateUtf8(message, maxBytes);
}

/** Convert a thrown sendMessage value into the retained diagnostic text. */
export function retainBackgroundDeliveryError(error: unknown): string {
  return retainDeliveryDiagnostic(error, MAX_BACKGROUND_ERROR_BYTES);
}

/** Convert a delivery error into the smaller per-record failure projection. */
export function retainBackgroundDeliveryFailure(error: unknown): string {
  return retainDeliveryDiagnostic(error, MAX_BACKGROUND_FAILURE_BYTES);
}

function serializedUtf8ByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : utf8ByteLength(serialized);
  } catch {
    // Details are expected to be JSON-shaped. If a legacy/custom value is not,
    // fail closed for the content budget rather than risk an oversized message.
    return MAX_BACKGROUND_MESSAGE_TEXT_BYTES;
  }
}
