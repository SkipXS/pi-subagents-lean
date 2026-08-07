import { formatAgentIdFirstContent } from "./execution-display.js";
/**
 * tool-execution.ts — Agent spawn/preflight execution handler.
 *
 * Result envelopes and renderer metadata live in agent-tool-results.ts;
 * StopAgent and AgentContinue live in agent-control-execution.ts. This module
 * remains the stable public façade for the Agent tool and its legacy exports.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import {
  agentRenderDetails,
  cancelledResult,
  emitAgentRenderUpdate,
  errorResult,
  finalAgentRenderMetadata,
  formatForegroundAgentResultContent,
  successResult,
} from "./agent-tool-results.js";
import type { AgentCallRenderMetadata } from "./agent-tool-results.js";
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

// Keep the established public import paths stable while the implementation is
// split by execution boundary.
export { buildAgentDetails } from "./agent-details.js";
export {
  agentControlRenderMetadata,
  formatForegroundAgentResultContent,
  formatResultContent,
} from "./agent-tool-results.js";
export {
  executeContinueAgentTool,
  executeStopAgentTool,
} from "./agent-control-execution.js";

export async function executeAgentTool(
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
  renderBridge?: AgentRenderMetadataBridge,
): Promise<any> {
  // Do not start preflight work for a tool call Pi has already cancelled.
  if (signal?.aborted) return cancelledResult();

  // Tools are registered before session_start, so Pi can invoke this callback
  // while the root runtime is not yet available (or after it was disposed).
  // Keep cancellation's established contract ahead of this readiness check.
  const coordinator = getCoordinator();
  if (!coordinator || !getManager()) {
    return errorResult("Agent execution is unavailable until the root session is ready");
  }
  const store = getStore();
  // Trust is a preflight input, not a live capability. Snapshot it before the
  // first async validation/discovery boundary so a later trust change cannot
  // reinterpret this tool call. Missing legacy context methods are untrusted.
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
  const resolvedType = resolvedSpawn.type;
  const prompt = resolvedSpawn.prompt;
  const modelKey = resolvedSpawn.modelKey;
  const thinkingLevel = resolvedSpawn.thinkingLevel;
  const shouldRunInBackground = resolvedSpawn.runInBackground;

  // renderCall runs before this asynchronous resolution. Publish the resolved
  // values as a row-local partial update immediately, including the abort and
  // stale-runtime paths below; the same metadata is attached to the final
  // result so restored rows never depend on a global cache.
  const renderMetadata: AgentCallRenderMetadata = {
    role: resolvedType,
    ...(modelKey !== undefined ? { model: modelKey } : {}),
    ...(thinkingLevel !== undefined ? { thinking: thinkingLevel } : {}),
    prompt,
    mode: shouldRunInBackground ? "background" : "foreground",
    kind: "new",
  };
  emitAgentRenderUpdate(toolCallId, onUpdate, renderMetadata, renderBridge);

  // No spawn may begin after cancellation, including cancellation during
  // asynchronous catalog/worktree preflight.
  if (signal?.aborted) return cancelledResult(agentRenderDetails(undefined, renderMetadata));

  // Preflight may have awaited while session_shutdown ran. Do not let a
  // captured, now-disposed coordinator spawn against a stale root runtime.
  if (getCoordinator() !== coordinator || !getManager()) {
    return errorResult(
      "Agent execution is unavailable until the root session is ready",
      agentRenderDetails(undefined, renderMetadata),
    );
  }

  // Use SpawnCoordinator for unified spawn path. A synchronous acceptance/setup
  // failure is an expected tool error: keep the internal executor on its
  // ToolResult contract, while registration.ts translates it to Pi's public
  // throwing contract.
  let result: Awaited<ReturnType<SpawnCoordinator["spawn"]>>;
  try {
    // The resolved contract is authoritative. Coordinator and Manager consume
    // this exact snapshot through the normal acceptance path.
    result = await coordinator.spawn(
      getPiInstance(),
      ctx,
      resolvedSpawn,
      shouldRunInBackground
        ? undefined
        : (acceptedRecord) => {
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
  // Keep the bridge hydrated for throwing/error paths where Pi may not retain
  // the final ToolResult details for renderAgentResult to consume.
  renderBridge?.update(toolCallId, finalRenderMetadata);

  // A background spawn may complete its abort path while coordinator.spawn()
  // is still pending. Its stopped record is not a successful tool result.
  if (signal?.aborted) {
    return cancelledResult(agentRenderDetails(
      buildAgentDetails(record, { includeStatus: true }),
      finalRenderMetadata,
    ));
  }

  if (shouldRunInBackground) {
    const isActive = record.lifecycle.status === "queued" || record.lifecycle.status === "running";
    const details = agentRenderDetails(
      buildAgentDetails(record, isActive ? undefined : { includeStatus: true }),
      finalRenderMetadata,
    );
    if (!isActive) {
      return successResult(
        formatAgentIdFirstContent(agentId, `[Agent ${record.lifecycle.status}]`),
        details,
      );
    }

    // Background: return immediately
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    const acknowledgement = `[${label}] A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.`;
    return successResult(formatAgentIdFirstContent(agentId, acknowledgement), details);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const details = agentRenderDetails(
    buildAgentDetails(record, { includeStats: true }),
    finalRenderMetadata,
  );

  // The manager bridges the parent signal to its own execution controller. Once
  // the foreground tool call is cancelled, never turn its partial response
  // into a misleading successful Agent result.
  if (signal?.aborted || record.lifecycle.status === "aborted" || record.lifecycle.status === "stopped") {
    return cancelledResult(details);
  }

  if (record.lifecycle.status === "error") {
    return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
  }

  return successResult(formatForegroundAgentResultContent(record, result.responseText), details);
}
