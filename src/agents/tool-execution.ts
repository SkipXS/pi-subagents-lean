/**
 * tool-execution.ts — Agent preflight and foreground execution boundary.
 *
 * Result envelopes and renderer metadata live in agent-tool-results.ts;
 * AgentContinue lives in agent-control-execution.ts. This module remains the
 * stable public facade for the Agent tool.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  agentRenderDetails,
  cancelledResult,
  emitAgentRenderUpdate,
  errorResult,
  finalAgentRenderMetadata,
  formatForegroundAgentResultContent,
  successResult,
} from "./agent-tool-results.js";
import type { AgentCallRenderMetadata } from "./agent-render-format.js";
import type { AgentRenderMetadataBridge } from "./agent-render-bridge.js";
import { buildAgentDetails } from "./agent-details.js";
import { runSpawnPreflight } from "../spawn/spawn-preflight.js";
import type { SpawnCoordinator } from "../spawn/spawn-coordinator.js";
import {
  getPiInstance,
  getSessionCtx,
  getStore,
  getCoordinator,
  getManager,
} from "../shell.js";

export { buildAgentDetails } from "./agent-details.js";
export {
  agentControlRenderMetadata,
  formatForegroundAgentResultContent,
  formatResultContent,
} from "./agent-tool-results.js";
export { executeContinueAgentTool } from "./agent-control-execution.js";

export async function executeAgentTool(
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
  renderBridge?: AgentRenderMetadataBridge,
): Promise<any> {
  if (signal?.aborted) return cancelledResult();

  const coordinator = getCoordinator();
  if (!coordinator || !getManager()) {
    return errorResult("Agent execution is unavailable until the root session is ready");
  }
  const store = getStore();
  let projectTrusted = false;
  try {
    projectTrusted = ctx.isProjectTrusted?.() === true;
  } catch {
    projectTrusted = false;
  }

  const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
  const preflight = await runSpawnPreflight({
    params,
    signal,
    pi: getPiInstance(),
    ctx,
    store,
    parentCwd,
    projectTrusted,
  });

  if (preflight.kind === "cancelled") return cancelledResult();
  if (preflight.kind === "error") {
    for (const msg of preflight.warnings) {
      if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lean] ${msg}`, "warning");
    }
    return errorResult(preflight.error);
  }

  const { resolvedSpawn } = preflight;
  const renderMetadata: AgentCallRenderMetadata = {
    role: resolvedSpawn.type,
    ...(resolvedSpawn.modelKey !== undefined ? { model: resolvedSpawn.modelKey } : {}),
    ...(resolvedSpawn.thinkingLevel !== undefined ? { thinking: resolvedSpawn.thinkingLevel } : {}),
    prompt: resolvedSpawn.prompt,
    kind: "new",
  };
  emitAgentRenderUpdate(toolCallId, onUpdate, renderMetadata, renderBridge);

  if (signal?.aborted) return cancelledResult(agentRenderDetails(undefined, renderMetadata));
  if (getCoordinator() !== coordinator || !getManager()) {
    return errorResult(
      "Agent execution is unavailable until the root session is ready",
      agentRenderDetails(undefined, renderMetadata),
    );
  }

  let result: Awaited<ReturnType<SpawnCoordinator["spawn"]>>;
  try {
    result = await coordinator.spawn(
      getPiInstance(),
      ctx,
      resolvedSpawn,
      (acceptedRecord) => {
        const acceptedRenderMetadata = finalAgentRenderMetadata(renderMetadata, acceptedRecord);
        emitAgentRenderUpdate(toolCallId, onUpdate, acceptedRenderMetadata, renderBridge);
      },
    );
  } catch (error) {
    const details = agentRenderDetails(undefined, renderMetadata);
    if (signal?.aborted) return cancelledResult(details);
    return errorResult(error instanceof Error ? error.message : String(error), details);
  }

  const { agentId, record } = result;
  const finalRenderMetadata = finalAgentRenderMetadata(renderMetadata, record);
  renderBridge?.update(toolCallId, finalRenderMetadata);

  const details = agentRenderDetails(
    buildAgentDetails(record, { includeStats: true }),
    finalRenderMetadata,
  );
  if (signal?.aborted || record.lifecycle.status === "aborted" || record.lifecycle.status === "stopped") {
    return cancelledResult(details);
  }
  if (record.lifecycle.status === "error") {
    return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
  }

  return successResult(formatForegroundAgentResultContent(record, result.responseText), details);
}
