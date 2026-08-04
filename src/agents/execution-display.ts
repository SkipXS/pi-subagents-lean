import type { AgentExecutionKind, AgentExecutionMode, AgentExecutionSummary } from "../types.js";

/** Safely identify legacy execution summaries that predate the explicit kind field. */
export function executionKind(
  execution: Pick<AgentExecutionSummary, "kind"> | undefined,
  index = 0,
): AgentExecutionKind {
  if (execution?.kind === "continued") return "continued";
  if (execution?.kind === "new") return "new";
  return index > 0 ? "continued" : "new";
}

/** Canonical English execution labels shared by call, status, and notification UI. */
export function formatExecutionLabels(mode: AgentExecutionMode, kind: AgentExecutionKind): string {
  const modeLabel = mode === "background" ? "Background" : "Foreground";
  const runLabel = kind === "continued" ? "Continued" : "New";
  return `Mode: ${modeLabel} | Run: ${runLabel}`;
}
