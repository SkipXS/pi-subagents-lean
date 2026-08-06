import type {
  AgentExecutionKind,
  AgentExecutionMode,
  AgentExecutionSummary,
  AgentStatus,
} from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";

/** Safely identify legacy execution summaries that predate the explicit kind field. */
export function executionKind(
  execution: Pick<AgentExecutionSummary, "kind"> | undefined,
  index = 0,
): AgentExecutionKind {
  if (execution?.kind === "continued") return "continued";
  if (execution?.kind === "new") return "new";
  return index > 0 ? "continued" : "new";
}

/** Canonical short ID display shared by status and background notifications. */
export function formatShortAgentId(agentId: string): string {
  return `[${agentId.slice(0, SHORT_ID_LENGTH)}]`;
}

/**
 * Canonical status-line display shared by AgentStatus and background nudges.
 * The ID is intentionally short in text; structured details retain the full ID.
 */
export function formatAgentStatusLine(
  agentId: string,
  type: string,
  status: AgentStatus,
  execution?: { mode: AgentExecutionMode; kind: AgentExecutionKind },
  deliveryState?: string,
): string {
  const executionLabels = execution
    ? ` | ${formatExecutionLabels(execution.mode, execution.kind)}`
    : "";
  const delivery = deliveryState ? ` delivery:${deliveryState}` : "";
  return `${formatShortAgentId(agentId)} (${type}) ${status}${executionLabels}${delivery}`;
}

/** Canonical English execution labels shared by call, status, and notification UI. */
export function formatExecutionLabels(
  mode: AgentExecutionMode | undefined,
  kind: AgentExecutionKind | undefined,
): string {
  const modeLabel = mode === "background" ? "Background" : mode === "foreground" ? "Foreground" : "—";
  const runLabel = kind === "continued" ? "Continued" : kind === "new" ? "New" : "—";
  return `Mode: ${modeLabel} | Run: ${runLabel}`;
}

/** Put a full canonical agent ID before a result or acknowledgement body. */
export function formatAgentIdFirstContent(agentId: string, body: string): string {
  return `Agent ID: ${agentId}\n\n${body}`;
}
