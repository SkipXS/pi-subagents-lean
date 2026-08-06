import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the public control tools.
 * Spawn coordination and nudge scheduling live in spawn-coordinator.ts;
 * result details are built by the neutral agent-details module.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import {
  type AgentCallRenderMetadata,
  withAgentCallRenderMetadata,
} from "./agent-renderer.js";
import type { AgentRenderMetadataBridge } from "./agent-render-bridge.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { buildAgentDetails } from "./agent-details.js";
export { buildAgentDetails } from "./agent-details.js";
import { runSpawnPreflight } from "../spawn/spawn-preflight.js";
import { getSubagentRuntimeContext } from "../shell.js";
import type { AgentManager } from "./agent-manager.js";
import type { SpawnCoordinator } from "../spawn/spawn-coordinator.js";
import {
  getPiInstance,
  getSessionCtx,
  getStore,
  getCoordinator,
  getManager,
} from "../shell.js";

// ============================================================================
// Tool result helpers
// ============================================================================

/** Shortcut for a successful tool result. */
function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/** Shortcut for an error tool result. */
function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true as const, details };
}

/** Cancellation has a distinct tool contract; it is never reported as success. */
function cancelledResult(details?: Record<string, unknown>) {
  return errorResult("Agent execution cancelled", details);
}

/** Attach renderer-only invocation metadata without changing public result text. */
function agentRenderDetails(
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
function emitAgentRenderUpdate(
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
function finalAgentRenderMetadata(
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
  return {
    ...metadata,
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

// ============================================================================
// Activity tracking
// ============================================================================

/**
 * Result text plus status note, for tool delivery.
 *
 * Shared by the foreground tool result and the subagent-result nudge so both
 * callers stay in sync on the nullish default and separator handling — they
 * have diverged before. getStatusNote owns the leading separator.
 */
export function formatResultContent(record: AgentRecord): string {
  return (record.result ?? "") + getStatusNote(record.lifecycle);
}

/** Format the shared canonical-ID/response envelope for successful foreground results. */
export function formatForegroundAgentResultContent(record: AgentRecord): string {
  return `Agent ID: ${record.id}\n\nResponse:\n${formatResultContent(record)}`;
}

// ============================================================================
// Tool execute handlers
// ============================================================================

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
    // The resolved contract is authoritative. Do not repeat its fields in a
    // parallel SpawnIntent object: Coordinator and Manager must consume this
    // exact snapshot through the normal acceptance path.
    result = await coordinator.spawn(getPiInstance(), ctx, resolvedSpawn);
  } catch (error) {
    const details = agentRenderDetails(undefined, renderMetadata);
    if (signal?.aborted) return cancelledResult(details);
    return errorResult(error instanceof Error ? error.message : String(error), details);
  }

  const { agentId, record } = result;
  const finalRenderMetadata = finalAgentRenderMetadata(renderMetadata, record);

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
      return successResult(`[Agent ${record.lifecycle.status}] Agent ID: ${agentId}`, details);
    }

    // Background: return immediately
    const suffix = `A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    return successResult(`[${label}] ${suffix}`, details);
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

  return successResult(formatForegroundAgentResultContent(record), details);
}

// ============================================================================
// Running agents list helper (used by executeStopAgentTool)
// ============================================================================

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

// ============================================================================
// StopAgent execute handler
// ============================================================================

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
  const manager = getManager();

  if (!manager || !getCoordinator()) {
    return errorResult("Agent control is unavailable until the root session is ready");
  }

  if (typeof rawAgentId !== "string" || rawAgentId.trim() === "") {
    return errorResult("agent_id is required");
  }
  const agentId = rawAgentId.trim();

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

// ============================================================================
// AgentContinue execute handler
// ============================================================================

/**
 * Execute the AgentContinue tool: continue an existing agent's session.
 *
 * Root-only by registration; this handler additionally rejects any call that
 * reaches it from an isolated session so it can never continue another
 * root session through a forwarded or legacy tool definition.
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

  const coordinator = getCoordinator();
  const manager = getManager();
  if (!coordinator || !manager) {
    return errorResult("AgentContinue is unavailable until the root session is ready");
  }

  const rawAgentId = params.agent_id as string | undefined;
  if (typeof rawAgentId !== "string" || rawAgentId.trim() === "") {
    return errorResult("agent_id is required");
  }
  const agentId = rawAgentId.trim();
  const prompt = params.prompt as string | undefined;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return errorResult("prompt is required");
  }
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
    const { record } = await coordinator.continueAgent(getPiInstance(), ctx, {
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
      const suffix = "A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.\n\n"
        // The manager resolved the caller's id (possibly a short prefix) to
        // the record's full id; the acknowledgement must carry the resolved id.
        + `Agent ID: ${record.id}`;
      return successResult(`[AgentContinue] ${suffix}`, details);
    }

    const details = agentRenderDetails(buildAgentDetails(record, { includeStats: true }), renderMetadata);
    if (signal?.aborted || record.lifecycle.status === "aborted" || record.lifecycle.status === "stopped") {
      return cancelledResult(details);
    }
    if (record.lifecycle.status === "error") {
      return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
    }
    return successResult(formatForegroundAgentResultContent(record), details);
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
