import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the public control tools.
 * Spawn coordination and nudge scheduling live in spawn-coordinator.ts;
 * buildAgentDetails remains a pure result-details helper.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import type { AgentConfig } from "./types.js";
import { resolveType, getAgentConfig, discoverNewAgents, resolveAgentCatalog, resolveTypeInCatalog } from "./agent-types.js";
import { getSessionUsageSnapshot } from "./usage.js";
import { revalidateWorktreePath, validateWorktreePath } from "../spawn/worktree-validator.js";

import { parseModelKey, findModelInRegistry, parseThinkingLevel } from "../utils.js";
import { normalizeThinkingLevel } from "../models/thinking.js";
import { getSubagentRuntimeContext } from "../shell.js";
import type { SubagentRuntimeSettings } from "../config/config-store.js";
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
    // reports the exact per-execution summary (usage/turn/tool/compaction
    // deltas) instead of cumulative record totals.
    const current = record.stats.executions?.at(-1);
    const continuation = current && (record.stats.executions?.length ?? 0) > 1 ? current : undefined;
    const usage = continuation?.usage;
    const elapsedMs = continuation
      ? (continuation.completedAt !== undefined ? continuation.completedAt - continuation.startedAt : 0)
      : (record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0);

    details.turnCount = continuation?.turnCount ?? record.stats.turnCount;
    details.maxTurns = record.stats.maxTurns;
    details.toolUses = continuation?.toolUses ?? record.stats.toolUses;
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
        ...(current.turnCount !== undefined ? { turnCount: current.turnCount } : {}),
        ...(current.toolUses !== undefined ? { toolUses: current.toolUses } : {}),
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
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
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
  const maxTurns = params.max_turns as number | undefined ?? agentConfig.maxTurns;

  // Worktree definitions are resolved above, then share the same explicit >
  // session > persisted > Markdown > global > parent precedence as all spawns.
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const explicitModel = params._modelFromSettings === true
    ? undefined
    : typeof params.model === "string" ? params.model : undefined;
  const store = getStore();
  const runtimeSettingsSnapshot = typeof store.createSubagentRuntimeSettings === "function"
    ? store.createSubagentRuntimeSettings()
    : undefined;
  // Keep scalar runtime controls stable across asynchronous model preflight.
  // Older detached stores have no snapshot, so capture their live settings at
  // the same boundary as the compatibility fallback.
  const runtimeAgentSettings = runtimeSettingsSnapshot?.agent ?? store.agent;
  const graceTurns = runtimeAgentSettings.graceTurns;
  const forceBackground = runtimeAgentSettings.forceBackground;
  const shouldRunInBackground = runInBackground || forceBackground;
  const resolvedModelKey = runtimeSettingsSnapshot
    ? runtimeSettingsSnapshot.modelFor(resolvedType, parentModelId, agentConfig, explicitModel)
    : store.modelSettingFor(resolvedType, parentModelId, agentConfig, explicitModel).value;
  let model: ReturnType<typeof findModelInRegistry>;
  if (explicitModel !== undefined) {
    // Explicit models are exact, while Pi's session creation remains the
    // authentication boundary.
    const parsed = parseModelKey(explicitModel);
    model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
    if (!model) return errorResult(`Model not found: ${explicitModel}`);
  } else {
    model = findModelInRegistry(resolvedModelKey, ctx.modelRegistry, ctx.model);
  }
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;
  const modelName = model?.id;
  const explicitThinking = params._thinkingFromSettings === true
    ? undefined
    : parseThinkingLevel(params.thinking as string | undefined);
  const requestedThinking = (runtimeSettingsSnapshot
    ? runtimeSettingsSnapshot.thinkingSettingFor(resolvedType, ctx.thinkingLevel, agentConfig, explicitThinking)
    : store.thinkingSettingFor(resolvedType, ctx.thinkingLevel, agentConfig, explicitThinking)
  ).value;
  const thinkingLevel = normalizeThinkingLevel(model, requestedThinking);

  // No spawn may begin after cancellation, including cancellation during
  // asynchronous catalog/worktree preflight.
  if (signal?.aborted) return cancelledResult();

  // Preflight may have awaited while session_shutdown ran. Do not let a
  // captured, now-disposed coordinator spawn against a stale root runtime.
  if (getCoordinator() !== coordinator || !getManager()) {
    return errorResult("Agent execution is unavailable until the root session is ready");
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
      maxTurns,
      thinkingLevel,
      graceTurns,
      worktreePath: validatedWorktreePath,
      worktreeLabel,
      worktreeParentCwd: validatedWorktreePath ? parentCwd : undefined,
      worktreeSelectionPath: validatedWorktreePath ? rawWorktreePath : undefined,
      invocation: { modelName, thinkingLevel, maxTurns },
      runtimeSettingsSnapshot,
      runInBackground: shouldRunInBackground,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return cancelledResult();
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const { agentId, record } = result;

  // A background spawn may complete its abort path while coordinator.spawn()
  // is still pending. Its stopped record is not a successful tool result.
  if (signal?.aborted) {
    return cancelledResult(buildAgentDetails(record, { includeStatus: true }));
  }

  if (shouldRunInBackground) {
    const isActive = record.lifecycle.status === "queued" || record.lifecycle.status === "running";
    const details = buildAgentDetails(record, isActive ? undefined : { includeStatus: true });
    if (!isActive) {
      return successResult(`[Agent ${record.lifecycle.status}] Agent ID: ${agentId}`, details);
    }

    // Background: return immediately
    const suffix = `A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    return successResult(`[${label}] ${suffix}`, details);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const details = buildAgentDetails(record, { includeStats: true });

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
  const agents = manager.listAgents().filter(
    (a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued",
  );

  if (agents.length === 0) return "none";

  return agents
    .map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.display.type})`)
    .join(", ");
}

// ============================================================================
// StopAgent execute handler
// ============================================================================

export async function executeStopAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  if (signal?.aborted) return cancelledResult();

  const agentId = params.agent_id as string | undefined;
  const manager = getManager();

  if (!manager || !getCoordinator()) {
    return errorResult("Agent control is unavailable until the root session is ready");
  }

  if (!agentId) {
    return errorResult("agent_id is required");
  }

  const record = manager.getRecord(agentId);

  if (!record) {
    // Agent not found → return error + list of running agents
    return errorResult(
      `Agent ${agentId} not found. Running agents: ${formatRunningAgents(manager)}`,
    );
  }

  // Check if already in a terminal state (not running or queued)
  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents(manager)}`,
    );
  }

  // Attempt to stop the running/queued agent
  if (manager.abort(agentId, "agent")) {
    return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
  }

  return errorResult(`Failed to stop agent ${agentId}`);
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
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  if (signal?.aborted) return cancelledResult();
  if (getSubagentRuntimeContext()) {
    return errorResult("AgentContinue is only available to the root agent");
  }

  const coordinator = getCoordinator();
  if (!coordinator || !getManager()) {
    return errorResult("AgentContinue is unavailable until the root session is ready");
  }

  const agentId = params.agent_id as string | undefined;
  if (typeof agentId !== "string" || agentId.trim() === "") {
    return errorResult("agent_id is required");
  }
  const prompt = params.prompt as string | undefined;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return errorResult("prompt is required");
  }
  const runInBackground = params.run_in_background === true;

  try {
    const { record } = await coordinator.continueAgent(getPiInstance(), ctx, {
      agentId: agentId.trim(),
      prompt,
      runInBackground,
      signal,
    });

    if (runInBackground) {
      const details = buildAgentDetails(record, { includeStatus: true });
      const suffix = "A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.\n\n"
        // The manager resolved the caller's id (possibly a short prefix) to
        // the record's full id; the acknowledgement must carry the resolved id.
        + `Agent ID: ${record.id}`;
      return successResult(`[AgentContinue] ${suffix}`, details);
    }

    const details = buildAgentDetails(record, { includeStats: true });
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
    const manager = getManager();
    const stoppedRecord = manager?.getRecord(agentId.trim())
      ?? manager?.listAgents().find((candidate) => candidate.id.startsWith(agentId.trim()));
    if (stoppedRecord && (stoppedRecord.lifecycle.status === "stopped" || stoppedRecord.lifecycle.status === "aborted")) {
      const details = buildAgentDetails(stoppedRecord, { includeStats: true });
      if (signal?.aborted) return cancelledResult(details);
      return errorResult(error instanceof Error ? error.message : String(error), details);
    }
    if (signal?.aborted) return cancelledResult();
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// Tool_call listener — inject model into Agent tool calls
// =============================================================================

export async function toolCallListener(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  // Preserve an explicit model in invocation details even for worktrees.
  if (typeof input.model === "string") {
    const parsed = parseModelKey(input.model);
    if (parsed) input._modelOverride = parsed.modelId;
  }
  // Worktree overlays are selected atomically in executeAgentTool.
  if (typeof input.worktree_path === "string" && input.worktree_path.trim() !== "") return;

  const requestedType = input.agent as string | undefined;
  const subagentType = requestedType ? resolveType(requestedType) : undefined;
  const agentConfig = subagentType ? getAgentConfig(subagentType) : undefined;
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

  if (subagentType && input.model === undefined) {
    const store = getStore();
    const effectiveModel = store.modelFor(subagentType, parentModelId, agentConfig);
    if (effectiveModel) {
      input.model = effectiveModel;
      input._modelFromSettings = true;
    }
  }
  if (typeof input.model === "string") {
    const parsed = parseModelKey(input.model);
    if (parsed) input._modelOverride = parsed.modelId;
  }

  if (subagentType && input.thinking === undefined) {
    const setting = getStore().thinkingSettingFor(subagentType, ctx.thinkingLevel, agentConfig, undefined);
    input.thinking = setting.value;
    input._thinkingFromSettings = true;
  }

  const invocationModel = findModelInRegistry(
    typeof input.model === "string" ? input.model : undefined,
    ctx.modelRegistry,
    ctx.model,
  );
  const requestedThinking = parseThinkingLevel(input.thinking as string | undefined);
  const normalizedThinking = normalizeThinkingLevel(invocationModel, requestedThinking ?? ctx.thinkingLevel);
  if (normalizedThinking !== undefined) input.thinking = normalizedThinking;
}
