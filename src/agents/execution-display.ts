import type { AgentExecutionKind, AgentExecutionSummary } from "../types.js";

/** Safely identify summaries that predate the explicit execution kind. */
export function executionKind(
  execution: Pick<AgentExecutionSummary, "kind"> | undefined,
  index = 0,
): AgentExecutionKind {
  if (execution?.kind === "continued") return "continued";
  if (execution?.kind === "new") return "new";
  return index > 0 ? "continued" : "new";
}

/** Put a full canonical agent ID before a result body. */
export function formatAgentIdFirstContent(agentId: string, body: string): string {
  return `Agent ID: ${agentId}\n\n${body}`;
}
