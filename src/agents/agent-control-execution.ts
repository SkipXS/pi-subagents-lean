import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import { buildAgentDetails } from "./agent-details.js";
import type { AgentRenderMetadataBridge } from "./agent-render-bridge.js";
import { validateAgentId, validateAgentPrompt } from "./agent-string-limits.js";
import {
  agentControlRenderMetadata,
  agentRenderDetails,
  cancelledResult,
  emitAgentRenderUpdate,
  errorResult,
  finalAgentRenderMetadata,
  formatForegroundAgentResultContent,
  successResult,
} from "./agent-tool-results.js";
import { getSubagentRuntimeContext, getCoordinator, getManager } from "../shell.js";
import type { AgentManager } from "./agent-manager.js";

interface ControlRecordResolution {
  record?: AgentRecord;
  error: string;
}

/** Resolve an exact ID or unique prefix without mutating the record. */
function resolveControlRecord(manager: AgentManager, requestedId: string): ControlRecordResolution {
  try {
    const direct = manager.getRecord(requestedId);
    if (direct) return { record: direct, error: "" };
  } catch {
    // Fall through to the bounded retained-list lookup.
  }

  let records: AgentRecord[] = [];
  try {
    const listed = manager.listAgents();
    records = Array.isArray(listed) ? listed : [];
  } catch {
    // Treat an unavailable record list as not found.
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
 * Execute AgentContinue against a retained root record.
 *
 * Resolution is root-only, prefixes must be unique, and the manager accepts
 * only successful settled records with a live session. The coordinator then
 * awaits the exact continuation promise and returns the complete response.
 */
export async function executeContinueAgentTool(
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
  renderBridge?: AgentRenderMetadataBridge,
): Promise<any> {
  if (signal?.aborted) return cancelledResult();
  if (getSubagentRuntimeContext()) return errorResult("AgentContinue is only available to the root agent");

  const rawAgentId = params.agent_id as string | undefined;
  const agentIdError = validateAgentId(rawAgentId, "agent_id");
  if (agentIdError) return errorResult(agentIdError);
  const agentId = rawAgentId!.trim();
  const prompt = params.prompt as string | undefined;
  if (typeof prompt !== "string" || prompt.trim() === "") return errorResult("prompt is required");
  const promptError = validateAgentPrompt(prompt, "AgentContinue prompt");
  if (promptError) return errorResult(promptError);

  const coordinator = getCoordinator();
  const manager = getManager();
  if (!coordinator || !manager) {
    return errorResult("AgentContinue is unavailable until the root session is ready");
  }

  const resolution = resolveControlRecord(manager, agentId);
  const initialMetadata = agentControlRenderMetadata(resolution.record, agentId, prompt);
  emitAgentRenderUpdate(toolCallId, onUpdate, initialMetadata, renderBridge);
  if (!resolution.record) return errorResult(resolution.error, agentRenderDetails(undefined, initialMetadata));

  const resolvedAgentId = resolution.record.id;
  try {
    const result = await coordinator.continueAgent(
      { agentId: resolvedAgentId, prompt, signal },
      (acceptedRecord) => {
        const acceptedMetadata = finalAgentRenderMetadata(initialMetadata, acceptedRecord);
        emitAgentRenderUpdate(toolCallId, onUpdate, acceptedMetadata, renderBridge);
      },
    );
    const renderMetadata = finalAgentRenderMetadata(initialMetadata, result.record);
    renderBridge?.update(toolCallId, renderMetadata);
    const details = agentRenderDetails(
      buildAgentDetails(result.record, { includeStats: true }),
      renderMetadata,
    );

    if (signal?.aborted || result.record.lifecycle.status === "aborted" || result.record.lifecycle.status === "stopped") {
      return cancelledResult(details);
    }
    if (result.record.lifecycle.status === "error") {
      return errorResult(`Agent failed: ${result.record.error || "unknown error"}`, details);
    }
    return successResult(formatForegroundAgentResultContent(result.record, result.responseText), details);
  } catch (error) {
    let currentRecord: AgentRecord | undefined = resolution.record;
    try {
      currentRecord = manager.getRecord(resolvedAgentId)
        ?? manager.listAgents().find((candidate) => candidate.id.startsWith(resolvedAgentId))
        ?? currentRecord;
    } catch {
      // Keep the record resolved before acceptance.
    }
    const renderMetadata = finalAgentRenderMetadata(
      initialMetadata,
      currentRecord,
    );
    renderBridge?.update(toolCallId, renderMetadata);
    const details = agentRenderDetails(
      currentRecord ? buildAgentDetails(currentRecord, { includeStats: true }) : undefined,
      renderMetadata,
    );
    if (signal?.aborted) return cancelledResult(details);
    return errorResult(error instanceof Error ? error.message : String(error), details);
  }
}
