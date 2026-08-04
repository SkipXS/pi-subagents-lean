import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the public control tools.
 * Spawn coordination and nudge scheduling live in spawn-coordinator.ts;
 * buildAgentDetails remains a pure result-details helper.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import {
  type AgentCallRenderMetadata,
  withAgentCallRenderMetadata,
} from "./agent-renderer.js";
import type { AgentRenderMetadataBridge } from "./agent-render-bridge.js";
import { SHORT_ID_LENGTH } from "../types.js";
import type { AgentConfig } from "./types.js";
import { resolveType, getAgentConfig, discoverNewAgents, resolveAgentCatalog, resolveTypeInCatalog } from "./agent-types.js";
import { getSessionUsageSnapshot } from "./usage.js";
import { revalidateWorktreePath, validateWorktreePath } from "../spawn/worktree-validator.js";

import { findModelInRegistry } from "../utils.js";
import { normalizeThinkingLevel } from "../models/thinking.js";
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
    role: metadata.role,
    ...(modelKey !== undefined ? { model: modelKey } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    prompt: metadata.prompt,
    ...(metadata.agentId !== undefined ? { agentId: metadata.agentId } : {}),
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
): AgentCallRenderMetadata {
  if (!record) {
    return {
      agentId: requestedId || "—",
      role: "—",
      prompt,
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
 * Build a details Record from an AgentRecord, controlled by options.
 *
 * Always includes `type` and `description`. Optional groups:
 * - `includeStatus`: adds `status`, `outputFile`
 * - `includeStats`: adds turn/token/cost/context/compaction/model fields
 *
 * Consolidates the identical field-selection logic previously duplicated
 * across emitIndividualNudge, executeSpawnForeground, and executeSpawnBackground.
 */
export function buildAgentDetails(
  record: AgentRecord,
  opts?: { includeStats?: boolean; includeStatus?: boolean },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  if (opts?.includeStatus) {
    details.status = record.lifecycle.status;
    details.outputFile = record.display.outputFile;
  }

  if (opts?.includeStats) {
    // Only the current execution's compact delta/result is exposed: never
    // execution history, execution ids, timestamps, or prior responses. The
    // initial spawn's summary stays lifetime-cumulative; every continuation
    // reports the exact per-execution usage/compaction deltas instead of
    // cumulative record totals.
    const current = record.stats.executions?.at(-1);
    const continuation = current && (record.stats.executions?.length ?? 0) > 1 ? current : undefined;
    const usage = continuation?.usage;
    const elapsedMs = continuation
      ? (continuation.completedAt !== undefined ? continuation.completedAt - continuation.startedAt : 0)
      : (record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0);

    const terminal = record.lifecycle.status !== "running" && record.lifecycle.status !== "queued";
    // Terminal records retain manager-populated telemetry; their session may
    // already be disposed, so never perform a live branch read here.
    const liveSnapshot = terminal ? undefined : getSessionUsageSnapshot(record.execution.session);
    const terminalSnapshot = {
      contextPercent: record.stats.contextPercent,
      contextWindow: record.stats.contextWindow,
      autoCompactionEnabled: record.stats.autoCompactionEnabled,
      usingSubscription: record.stats.usingSubscription,
    };
    const hasLiveSample = liveSnapshot != null
      && (liveSnapshot.contextWindow !== undefined || liveSnapshot.contextPercent !== null);
    const usageSnapshot = terminal
      ? terminalSnapshot
      : {
        contextPercent: hasLiveSample
          ? liveSnapshot!.contextPercent
          : (terminalSnapshot.contextPercent ?? liveSnapshot?.contextPercent ?? null),
        contextWindow: liveSnapshot?.contextWindow ?? terminalSnapshot.contextWindow,
        autoCompactionEnabled: liveSnapshot?.autoCompactionEnabled ?? terminalSnapshot.autoCompactionEnabled,
        usingSubscription: liveSnapshot?.usingSubscription ?? terminalSnapshot.usingSubscription,
      };

    details.input = usage?.input ?? record.stats.lifetimeUsage.input;
    details.output = usage?.output ?? record.stats.lifetimeUsage.output;
    details.cacheRead = usage?.cacheRead ?? record.stats.cacheRead;
    details.cacheWrite = usage?.cacheWrite ?? record.stats.lifetimeUsage.cacheWrite;
    details.latestCacheHitRate = record.stats.latestCacheHitRate;
    const contextStats = record.stats.contextStats?.count ? record.stats.contextStats : undefined;
    // Keep the explicit live/terminal snapshot so shared formatting can prefer
    // a newly measured response without losing context history telemetry.
    details.contextPercent = usageSnapshot.contextPercent ?? null;
    // The explicit current/live window wins over historical telemetry from
    // an earlier model or branch.
    details.contextWindow = usageSnapshot.contextWindow ?? contextStats?.window;
    details.autoCompactionEnabled = usageSnapshot.autoCompactionEnabled;
    details.usingSubscription = usageSnapshot.usingSubscription;
    if (contextStats) {
      details.contextStats = { ...contextStats };
      details.contextCurrent = contextStats.current;
      details.contextLastKnown = contextStats.lastKnown;
      details.contextPeak = contextStats.peak;
      details.contextCount = contextStats.count;
    }
    details.durationMs = elapsedMs;
    details.compactions = continuation?.compactionCount ?? record.stats.compactionCount;
    details.compactionCount = continuation?.compactionCount ?? record.stats.compactionCount;
    details.modelName = record.display.invocation?.modelName;
    // The session is the source of truth: Pi may normalize the requested
    // invocation level for the selected model when it creates the session.
    details.thinkingLevel = record.execution.session?.thinkingLevel ?? record.display.invocation?.thinkingLevel;
    details.cost = usage?.cost ?? record.stats.lifetimeUsage.cost;
    // Only the current execution's compact delta/result is exposed: never
    // execution history, execution ids, timestamps, or prior responses. The
    // caller authored the current prompt and can recover earlier context from
    // the record itself.
    if (current) {
      details.currentExecution = {
        mode: current.mode,
        status: current.status,
        ...(current.responseText !== undefined ? { responseText: current.responseText } : {}),
        ...(current.usage !== undefined ? { usage: current.usage } : {}),
        ...(current.compactionCount !== undefined ? { compactionCount: current.compactionCount } : {}),
        ...(current.error !== undefined ? { error: current.error } : {}),
      };
    }
  }

  return details;
}

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

  // Validate worktree_path early — needed for on-demand agent discovery
  const rawWorktreePath = params.worktree_path as string | undefined;
  const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
  let validatedWorktreePath: string | undefined;
  let worktreeLabel: string | undefined;
  if (rawWorktreePath && rawWorktreePath.trim() !== "") {
    try {
      const warnings: string[] = [];
      const onWarning = (msg: string) => { warnings.push(msg); };
      const validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, onWarning);
      if (signal?.aborted) return cancelledResult();
      if (!validation.ok) {
        for (const msg of warnings) {
          if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lean] ${msg}`, "warning");
        }
        return errorResult(validation.error);
      }
      validatedWorktreePath = validation.resolvedPath;
      worktreeLabel = validation.label;
    } catch (err: unknown) {
      if (signal?.aborted) return cancelledResult();
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`worktree_path validation failed: ${msg}`);
    }
  }

  const rawType = params.agent;
  if (typeof rawType !== "string" || rawType.trim() === "") {
    return errorResult("Agent type is required");
  }
  const type = rawType.trim();
  const trustedWorktreeDir = validatedWorktreePath && (ctx.isProjectTrusted?.() ?? false)
    ? `${validatedWorktreePath}/.pi/agents`
    : undefined;

  // Worktree catalogs are local to this tool call. Never use the shared
  // registry for a worktree name: it may be an override of a parent type.
  let resolvedType: string | undefined;
  let agentConfig: AgentConfig | undefined;
  if (trustedWorktreeDir) {
    // Repeat validation directly before reading project-controlled overlays.
    // A deleted or swapped path must not contribute an agent definition.
    const validation = await revalidateWorktreePath(getPiInstance(), rawWorktreePath!, parentCwd, validatedWorktreePath!);
    if (signal?.aborted) return cancelledResult();
    if (!validation.ok || !validation.resolvedPath) return errorResult(validation.ok ? "worktree_path validation failed" : validation.error);
    validatedWorktreePath = validation.resolvedPath;
    worktreeLabel = validation.label;
    const catalog = await resolveAgentCatalog(`${validatedWorktreePath}/.pi/agents`, {
      disableDefaultAgents: getStore().agent.disableDefaultAgents,
    });
    if (signal?.aborted) return cancelledResult();
    resolvedType = resolveTypeInCatalog(catalog, type);
    agentConfig = resolvedType ? catalog.get(resolvedType) : undefined;
  } else {
    resolvedType = resolveType(type);
    if (!resolvedType) {
      await discoverNewAgents({ disableDefaultAgents: getStore().agent.disableDefaultAgents });
      if (signal?.aborted) return cancelledResult();
      resolvedType = resolveType(type);
    }
    agentConfig = resolvedType ? getAgentConfig(resolvedType) : undefined;
  }
  if (!resolvedType || !agentConfig) return errorResult(`Unknown agent type: ${type}`);

  const prompt = params.prompt as string;
  const description = (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;

  // Model and thinking come only from the resolved Agent Markdown definition;
  // missing or unavailable values fall back to the calling parent session.
  const store = getStore();
  const runtimeSettingsSnapshot = typeof store.createSubagentRuntimeSettings === "function"
    ? store.createSubagentRuntimeSettings()
    : undefined;
  const shouldRunInBackground = runInBackground === true;
  const model = findModelInRegistry(agentConfig.model, ctx.modelRegistry, ctx.model);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;
  const modelName = model?.id;
  const thinkingLevel = normalizeThinkingLevel(
    model,
    agentConfig.thinkingLevel ?? ctx.thinkingLevel,
  );

  // renderCall runs before this asynchronous resolution. Publish the resolved
  // values as a row-local partial update immediately, including the abort and
  // stale-runtime paths below; the same metadata is attached to the final
  // result so restored rows never depend on a global cache.
  const renderMetadata: AgentCallRenderMetadata = {
    role: resolvedType,
    ...(modelKey !== undefined ? { model: modelKey } : {}),
    ...(thinkingLevel !== undefined ? { thinking: thinkingLevel } : {}),
    prompt,
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
    result = await coordinator.spawn(getPiInstance(), ctx, {
      type: resolvedType,
      agentConfig,
      prompt,
      description,
      model,
      modelKey,
      thinkingLevel,
      worktreePath: validatedWorktreePath,
      worktreeLabel,
      worktreeParentCwd: validatedWorktreePath ? parentCwd : undefined,
      worktreeSelectionPath: validatedWorktreePath ? rawWorktreePath : undefined,
      invocation: {
        modelName,
        ...(modelKey !== undefined ? { modelKey } : {}),
        thinkingLevel,
      },
      runtimeSettingsSnapshot,
      runInBackground: shouldRunInBackground,
      signal,
    });
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

  return successResult(formatResultContent(record), details);
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
  const initialMetadata = agentControlRenderMetadata(resolution.record, agentId, prompt);
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
    const renderMetadata = agentControlRenderMetadata(record, resolvedAgentId, prompt);
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
    return successResult(formatResultContent(record), details);
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
    const renderMetadata = agentControlRenderMetadata(currentRecord, resolvedAgentId, prompt);
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
