import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { buildAgentDetails } from "./agent-details.js";
import type { AgentRenderMetadataBridge } from "./agent-render-bridge.js";
import { MAX_BACKGROUND_FAILURE_BYTES } from "../spawn/background-delivery-diagnostics.js";
import { truncateUtf8, validateAgentId, validateAgentPrompt } from "./agent-string-limits.js";
import type { AgentManager } from "./agent-manager.js";
import {
  agentControlRenderMetadata,
  agentRenderDetails,
  cancelledResult,
  emitAgentRenderUpdate,
  errorResult,
  formatForegroundAgentResultContent,
  successResult,
} from "./agent-tool-results.js";
import { getSubagentRuntimeContext } from "../shell.js";
import {
  getPiInstance,
  getCoordinator,
  getManager,
} from "../shell.js";
import {
  executionKind,
  formatAgentIdFirstContent,
  formatAgentStatusLine,
} from "./execution-display.js";

interface ControlRecordResolution {
  record?: AgentRecord;
  error: string;
}

/** Resolve an exact ID or unique prefix before a control operation mutates it. */
function resolveControlRecord(
  manager: AgentManager,
  requestedId: string,
): ControlRecordResolution {
  try {
    const direct = manager.getRecord(requestedId);
    if (direct) return { record: direct, error: "" };
  } catch {
    // Fall through to the defensive list lookup below.
  }

  let records: AgentRecord[] = [];
  try {
    const listed = manager.listAgents();
    records = Array.isArray(listed) ? listed : [];
  } catch {
    records = [];
  }
  const matches = records.filter((record) =>
    typeof record?.id === "string" && record.id.startsWith(requestedId),
  );
  if (matches.length === 1) return { record: matches[0], error: "" };
  if (matches.length > 1) {
    return { error: `Agent ${requestedId} is ambiguous; use a longer ID prefix` };
  }
  return { error: `Agent ${requestedId} not found` };
}

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(manager: AgentManager): string {
  let records: AgentRecord[] = [];
  try {
    const listed = manager.listAgents();
    records = Array.isArray(listed) ? listed : [];
  } catch {
    records = [];
  }
  const agents = records.filter(
    (a) => a.lifecycle?.status === "running" || a.lifecycle?.status === "queued",
  );

  if (agents.length === 0) return "none";

  return agents
    .map((a) => `${typeof a.id === "string" ? a.id.slice(0, SHORT_ID_LENGTH) : "—"} (${a.display?.type ?? "—"})`)
    .join(", ");
}

/** Format a single agent record for the AgentStatus control tool. */
function formatAgentStatus(record: AgentRecord): string {
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

/** Keep AgentStatus's established result shape without an implicit details key. */
function agentStatusResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/** Execute the AgentStatus control tool without changing its text contract. */
export async function executeAgentStatusTool(
  _toolCallId: string,
  _params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  if (signal?.aborted) return agentStatusResult("Agent execution cancelled", true);

  const manager = getManager();
  if (!manager || !getCoordinator()) {
    return agentStatusResult("Agent status is unavailable until the root session is ready", true);
  }
  const agents = manager.listAgents();
  const nudge = "Don't poll — you'll receive notifications when agents complete.";

  if (agents.length === 0) {
    return agentStatusResult(`No agents running or completed.\n\n${nudge}`);
  }

  const formatted = agents.map(formatAgentStatus).join(", ");
  return agentStatusResult(`${formatted}\n\n${nudge}`);
}

/**
 * Execute the StopAgent tool using the canonical ID resolved from the retained
 * manager record. The handler remains a ToolResult boundary; registration
 * translates its error result into Pi's public throwing contract.
 */
export async function executeStopAgentTool(
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
  renderBridge?: AgentRenderMetadataBridge,
): Promise<any> {
  if (signal?.aborted) return cancelledResult();

  const rawAgentId = params.agent_id as string | undefined;
  // Validate before manager/list/reflection work. In particular, an oversized
  // prefix must not be copied into render metadata or compared against every
  // retained record.
  const agentIdError = validateAgentId(rawAgentId, "agent_id");
  if (agentIdError) return errorResult(agentIdError);
  const agentId = rawAgentId!.trim();
  const manager = getManager();

  if (!manager || !getCoordinator()) {
    return errorResult("Agent control is unavailable until the root session is ready");
  }

  // Resolve before aborting so the row can show the canonical ID and the
  // queued record's persisted provider/model rather than only the prefix.
  const resolution = resolveControlRecord(manager, agentId);
  const record = resolution.record;
  const renderMetadata = agentControlRenderMetadata(record, agentId);
  emitAgentRenderUpdate(toolCallId, onUpdate, renderMetadata, renderBridge);

  if (!record) {
    // Agent not found → return error + list of running agents
    return errorResult(
      `${resolution.error}. Running agents: ${formatRunningAgents(manager)}`,
      agentRenderDetails(undefined, renderMetadata),
    );
  }

  if (signal?.aborted) return cancelledResult(agentRenderDetails(undefined, renderMetadata));

  // Check if already in a terminal state (not running or queued)
  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents(manager)}`,
      agentRenderDetails(buildAgentDetails(record, { includeStatus: true }), renderMetadata),
    );
  }

  // Attempt to stop the running/queued agent using the canonical full ID.
  let stopped = false;
  try {
    stopped = manager.abort(record.id, "agent");
  } catch (error) {
    return errorResult(
      error instanceof Error ? error.message : String(error),
      agentRenderDetails(buildAgentDetails(record, { includeStatus: true }), renderMetadata),
    );
  }
  if (stopped) {
    return successResult(
      `Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`,
      agentRenderDetails(buildAgentDetails(record, { includeStatus: true }), renderMetadata),
    );
  }

  return errorResult(
    `Failed to stop agent ${agentId}`,
    agentRenderDetails(buildAgentDetails(record, { includeStatus: true }), renderMetadata),
  );
}

/**
 * Execute the AgentContinue tool: continue an existing agent's session.
 *
 * Root-only by registration; this handler additionally rejects any call that
 * reaches it from an isolated session so it can never continue another root
 * session through a forwarded or legacy tool definition.
 */
export async function executeContinueAgentTool(
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
  renderBridge?: AgentRenderMetadataBridge,
): Promise<any> {
  if (signal?.aborted) return cancelledResult();
  if (getSubagentRuntimeContext()) {
    return errorResult("AgentContinue is only available to the root agent");
  }

  const rawAgentId = params.agent_id as string | undefined;
  // This check intentionally precedes coordinator/manager resolution and all
  // prefix reflection so the control boundary has one stable size error.
  const agentIdError = validateAgentId(rawAgentId, "agent_id");
  if (agentIdError) return errorResult(agentIdError);
  const agentId = rawAgentId!.trim();
  const coordinator = getCoordinator();
  const manager = getManager();
  if (!coordinator || !manager) {
    return errorResult("AgentContinue is unavailable until the root session is ready");
  }
  const prompt = params.prompt as string | undefined;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return errorResult("prompt is required");
  }
  // Reject before record/history lookup and before coordinator/manager can
  // allocate a continuation Promise or execution entry.
  const promptError = validateAgentPrompt(prompt, "AgentContinue prompt");
  if (promptError) return errorResult(promptError);
  const runInBackground = params.run_in_background === true;

  // Resolve from the retained record before asking the coordinator to accept
  // the continuation. This hydrates the row even for terminal/queued/error
  // paths and ensures a short prefix is never passed to the mutating call.
  const resolution = resolveControlRecord(manager, agentId);
  const executionDisplay = {
    mode: runInBackground ? "background" as const : "foreground" as const,
    kind: "continued" as const,
  };
  const initialMetadata = agentControlRenderMetadata(resolution.record, agentId, prompt, executionDisplay);
  emitAgentRenderUpdate(toolCallId, onUpdate, initialMetadata, renderBridge);
  if (!resolution.record) {
    return errorResult(resolution.error, agentRenderDetails(undefined, initialMetadata));
  }
  const resolvedAgentId = resolution.record.id;

  try {
    const { record, responseText } = await coordinator.continueAgent(getPiInstance(), ctx, {
      agentId: resolvedAgentId,
      prompt,
      runInBackground,
      signal,
    });
    const renderMetadata = agentControlRenderMetadata(record, resolvedAgentId, prompt, executionDisplay);
    // Keep throwing/error paths repairable even if Pi drops the final details
    // after the session has normalized a value differently.
    renderBridge?.update(toolCallId, renderMetadata);

    if (runInBackground) {
      const details = agentRenderDetails(
        buildAgentDetails(record, { includeStatus: true }),
        renderMetadata,
      );
      if (signal?.aborted || record.lifecycle.status === "aborted" || record.lifecycle.status === "stopped") {
        return cancelledResult(details);
      }
      const acknowledgement = "[AgentContinue] A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.";
      return successResult(formatAgentIdFirstContent(record.id, acknowledgement), details);
    }

    const details = agentRenderDetails(buildAgentDetails(record, { includeStats: true }), renderMetadata);
    if (signal?.aborted || record.lifecycle.status === "aborted" || record.lifecycle.status === "stopped") {
      return cancelledResult(details);
    }
    if (record.lifecycle.status === "error") {
      return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
    }
    return successResult(formatForegroundAgentResultContent(record, responseText), details);
  } catch (error) {
    // A queued foreground continuation is rejected when StopAgent removes it
    // from the global queue. Preserve that error contract, but include the
    // finalized execution details so a stopped continuation cannot fall back
    // to the record's lifetime totals in its tool result.
    let stoppedRecord: AgentRecord | undefined;
    try {
      stoppedRecord = manager.getRecord(resolvedAgentId)
        ?? manager.listAgents().find((candidate) => candidate.id.startsWith(resolvedAgentId));
    } catch {
      stoppedRecord = resolution.record;
    }
    const currentRecord = stoppedRecord ?? resolution.record;
    const renderMetadata = agentControlRenderMetadata(currentRecord, resolvedAgentId, prompt, executionDisplay);
    renderBridge?.update(toolCallId, renderMetadata);
    const details = agentRenderDetails(
      currentRecord ? buildAgentDetails(currentRecord, { includeStats: true }) : undefined,
      renderMetadata,
    );
    if (currentRecord && (currentRecord.lifecycle.status === "stopped" || currentRecord.lifecycle.status === "aborted")) {
      if (signal?.aborted) return cancelledResult(details);
      return errorResult(error instanceof Error ? error.message : String(error), details);
    }
    if (signal?.aborted) return cancelledResult(details);
    return errorResult(error instanceof Error ? error.message : String(error), details);
  }
}
