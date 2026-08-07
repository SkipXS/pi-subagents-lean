/**
 * agent-status.ts — AgentStatus tool implementation.
 *
 * A lightweight informational tool that lists all agents (running, queued,
 * completed, stopped, error) from the manager and returns a clear message
 * about not polling for status.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import { getCoordinator, getManager } from "../shell.js";
import { executionKind, formatAgentStatusLine } from "./execution-display.js";
import { MAX_BACKGROUND_FAILURE_BYTES } from "../spawn/background-delivery-diagnostics.js";
import { truncateUtf8 } from "./agent-string-limits.js";

/** Format a single agent record as "[short_id] (type) status [delivery state]". */
function formatAgent(record: AgentRecord): string {
  const executions = record.stats?.executions;
  const latest = executions?.at(-1);
  const statusLine = formatAgentStatusLine(
    record.id,
    record.display.type,
    record.lifecycle.status,
    latest
      ? { mode: latest.mode, kind: executionKind(latest, (executions?.length ?? 1) - 1) }
      : undefined,
    record.delivery?.state,
  );
  const failure = record.delivery?.lastFailure?.lastError;
  return typeof failure === "string" && failure.length > 0
    ? `${statusLine} delivery-failure:${truncateUtf8(failure, MAX_BACKGROUND_FAILURE_BYTES)}`
    : statusLine;
}

/**
 * Execute the AgentStatus tool.
 *
 * Returns a formatted list of all agents with their type, short ID, and status,
 * followed by a nudge message telling the model not to poll.
 */
export async function executeAgentStatusTool(
  _toolCallId: string,
  _params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  if (signal?.aborted) {
    return {
      content: [{ type: "text", text: "Agent execution cancelled" }],
      isError: true as const,
    };
  }

  const manager = getManager();
  if (!manager || !getCoordinator()) {
    return {
      content: [{ type: "text", text: "Agent status is unavailable until the root session is ready" }],
      isError: true as const,
    };
  }
  const agents = manager.listAgents();

  const nudge = "Don't poll — you'll receive notifications when agents complete.";

  if (agents.length === 0) {
    return {
      content: [{ type: "text", text: `No agents running or completed.\n\n${nudge}` }],
    };
  }

  const formatted = agents.map(formatAgent).join(", ");
  return {
    content: [{ type: "text", text: `${formatted}\n\n${nudge}` }],
  };
}
