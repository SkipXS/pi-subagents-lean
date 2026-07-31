import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination, nudge scheduling, and live-view tracking have moved
 * to spawn-coordinator.ts. buildAgentDetails stays here as a pure helper.
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
import { requireAvailableModel } from "../models/model-availability.js";
import { runWithSubagentRuntime, type NestedAgentExecutor, type SubagentRuntimeContext } from "../shell.js";
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

/** Compatibility with detached stores created before Eco-mode methods existed. */
function modeModelSetting(store: ReturnType<typeof getStore>, type: string, parent: string, config?: AgentConfig, explicit?: string) {
  return typeof store.modelSettingForMode === "function"
    ? store.modelSettingForMode(type, parent, config, explicit)
    : { ...store.modelSettingFor(type, parent, config, explicit), ecoConfigured: false };
}

function modeThinkingSetting(store: ReturnType<typeof getStore>, type: string, parent: import("../types.js").ThinkingLevel | undefined, config?: AgentConfig, explicit?: import("../types.js").ThinkingLevel) {
  return typeof store.thinkingSettingForMode === "function"
    ? store.thinkingSettingForMode(type, parent, config, explicit)
    : { ...store.thinkingSettingFor(type, parent, config, explicit), ecoConfigured: false };
}

/** Compatibility with runtime snapshots captured before Eco-mode resolvers existed. */
function snapshotModelSetting(settings: SubagentRuntimeSettings, type: string, parent: string, config?: AgentConfig, explicit?: string) {
  return typeof settings.modelSettingForMode === "function"
    ? settings.modelSettingForMode(type, parent, config, explicit)
    : { value: settings.modelFor(type, parent, config, explicit), source: "parent" as const, ecoConfigured: false };
}

function snapshotThinkingSetting(settings: SubagentRuntimeSettings, type: string, parent: import("../types.js").ThinkingLevel | undefined, config?: AgentConfig, explicit?: import("../types.js").ThinkingLevel) {
  return typeof settings.thinkingSettingForMode === "function"
    ? settings.thinkingSettingForMode(type, parent, config, explicit)
    : { ...settings.thinkingSettingFor(type, parent, config, explicit), ecoConfigured: false };
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
  const hierarchy = record.hierarchy;
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };
  if (opts?.includeStats || opts?.includeStatus) {
    details.depth = hierarchy?.depth ?? 1;
    if (hierarchy?.parentId) details.parentId = hierarchy.parentId;
    if (hierarchy?.waitingOnChildId) details.waitingOnChildId = hierarchy.waitingOnChildId;
  }

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  if (opts?.includeStatus) {
    details.status = record.lifecycle.status;
    details.outputFile = record.display.outputFile;
  }

  if (opts?.includeStats) {
    const elapsedMs = record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0;

    details.turnCount = record.stats.turnCount;
    details.maxTurns = record.stats.maxTurns;
    details.toolUses = record.stats.toolUses;
    const liveSnapshot = getSessionUsageSnapshot(record.execution.session);
    const terminalSnapshot = {
      contextPercent: record.stats.contextPercent,
      contextWindow: record.stats.contextWindow,
      autoCompactionEnabled: record.stats.autoCompactionEnabled,
      usingSubscription: record.stats.usingSubscription,
    };
    const usageSnapshot = record.lifecycle.completedAt != null
      && (terminalSnapshot.contextPercent != null || terminalSnapshot.contextWindow != null)
      ? terminalSnapshot
      : (liveSnapshot ?? terminalSnapshot);

    details.input = record.stats.lifetimeUsage.input;
    details.output = record.stats.lifetimeUsage.output;
    details.cacheRead = record.stats.cacheRead;
    details.cacheWrite = record.stats.lifetimeUsage.cacheWrite;
    details.latestCacheHitRate = record.stats.latestCacheHitRate;
    details.contextPercent = usageSnapshot.contextPercent ?? null;
    details.contextWindow = usageSnapshot.contextWindow;
    details.autoCompactionEnabled = usageSnapshot.autoCompactionEnabled;
    details.usingSubscription = usageSnapshot.usingSubscription;
    details.durationMs = elapsedMs;
    details.compactions = record.stats.compactionCount;
    details.modelName = record.display.invocation?.modelName;
    // The session is the source of truth: Pi may normalize the requested
    // invocation level for the selected model when it creates the session.
    details.thinkingLevel = record.execution.session?.thinkingLevel ?? record.display.invocation?.thinkingLevel;
    details.cost = record.stats.lifetimeUsage.cost;
  }

  return details;
}

/**
 * Result text plus status note, for display.
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
  let agentCatalog: ReadonlyMap<string, AgentConfig> | undefined;
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
    // Retain this invocation-local overlay with the parent record. Nested
    // children must resolve roles against the same worktree definitions.
    agentCatalog = new Map(catalog);
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
  const modelSetting = runtimeSettingsSnapshot
    ? snapshotModelSetting(runtimeSettingsSnapshot, resolvedType, parentModelId, agentConfig, explicitModel)
    : modeModelSetting(store, resolvedType, parentModelId, agentConfig, explicitModel);
  let model: ReturnType<typeof findModelInRegistry>;
  if (modelSetting.ecoConfigured) {
    try {
      model = await requireAvailableModel(modelSetting.value, ctx.modelRegistry, "Eco model");
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  } else if (explicitModel !== undefined) {
    // Preserve Default-mode semantics: explicit models are exact, while Pi's
    // session creation remains the authentication boundary.
    const parsed = parseModelKey(explicitModel);
    model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
    if (!model) return errorResult(`Model not found: ${explicitModel}`);
  } else {
    model = findModelInRegistry(modelSetting.value, ctx.modelRegistry, ctx.model);
  }
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;
  const modelName = model?.id;
  const explicitThinking = params._thinkingFromSettings === true
    ? undefined
    : parseThinkingLevel(params.thinking as string | undefined);
  const requestedThinking = (runtimeSettingsSnapshot
    ? snapshotThinkingSetting(runtimeSettingsSnapshot, resolvedType, ctx.thinkingLevel, agentConfig, explicitThinking)
    : modeThinkingSetting(store, resolvedType, ctx.thinkingLevel, agentConfig, explicitThinking)
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

  // Use SpawnCoordinator for unified spawn path
  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    agentConfig,
    prompt,
    description,
    model,
    modelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: validatedWorktreePath,
    worktreeLabel,
    worktreeParentCwd: validatedWorktreePath ? parentCwd : undefined,
    worktreeSelectionPath: validatedWorktreePath ? rawWorktreePath : undefined,
    agentCatalog,
    invocation: { modelName, thinkingLevel, maxTurns },
    runtimeSettingsSnapshot,
    runInBackground: runInBackground || getStore().agent.forceBackground,
    signal,
  });

  const { agentId, record } = result;

  // A background spawn may complete its abort path while coordinator.spawn()
  // is still pending. Its stopped record is not a successful tool result.
  if (signal?.aborted) {
    return cancelledResult(buildAgentDetails(record, { includeStatus: true }));
  }

  if (runInBackground || getStore().agent.forceBackground) {
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

  // The manager bridges the parent signal to its own child controller. Once
  // the foreground tool call is cancelled, never turn its partial response
  // into a misleading successful Agent result.
  if (signal?.aborted || record.lifecycle.status === "aborted") {
    return cancelledResult(details);
  }

  if (record.lifecycle.status === "error") {
    return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
  }

  return successResult(formatResultContent(record), details);
}

// ============================================================================
// Nested Agent proxy
// ============================================================================

/**
 * Bind root-owned collaborators to the only operation exposed to a child
 * runtime. The returned closure always acts for this parent and cannot become
 * a general root-spawn capability.
 */
export function createNestedAgentExecutor(
  parentId: string,
  pi: Parameters<AgentManager["spawn"]>[0],
  manager: Pick<AgentManager, "preflightNested">,
  coordinator: Pick<SpawnCoordinator, "spawnNested">,
  settings = getStore().createSubagentRuntimeSettings(),
): NestedAgentExecutor {
  return (params, signal, ctx) => executeBoundNestedAgent(parentId, pi, manager, coordinator, settings, params, signal, ctx);
}

/** Invoke the child runtime's scoped nested-Agent capability. */
export async function executeNestedAgentTool(
  runtime: SubagentRuntimeContext,
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  const executeNestedAgent = runtime.executeNestedAgent;
  if (!executeNestedAgent) return errorResult("Nested agent execution is unavailable");
  // Tool callbacks can be invoked after session setup has returned, so enter
  // the captured child context again before using the bound capability.
  return runWithSubagentRuntime(runtime, () => executeNestedAgent(params, signal, ctx));
}

async function executeBoundNestedAgent(
  parentId: string,
  pi: Parameters<AgentManager["spawn"]>[0],
  manager: Pick<AgentManager, "preflightNested">,
  coordinator: Pick<SpawnCoordinator, "spawnNested">,
  settings: SubagentRuntimeSettings,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  if (signal?.aborted) return cancelledResult();
  if (params.run_in_background === true) return errorResult("Nested agents must run in the foreground");
  if (typeof params.worktree_path === "string" && params.worktree_path.trim() !== "") {
    return errorResult("Nested agents cannot select a worktree");
  }

  const requestedType = typeof params.agent === "string" ? params.agent.trim() : "";
  const preflight = manager.preflightNested(parentId, requestedType);
  if (!preflight.ok) return errorResult(preflight.error);
  const { type: resolvedType, agentConfig } = preflight;

  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  if (!prompt.trim()) return errorResult("Agent prompt is required");
  const description = (typeof params.description === "string" && params.description.trim())
    || prompt.split("\n")[0]!.slice(0, 80) || prompt.slice(0, 80);
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const modelSetting = typeof settings.modelSettingForMode === "function"
    ? settings.modelSettingForMode(resolvedType, parentModelId, agentConfig)
    : { value: settings.modelFor(resolvedType, parentModelId, agentConfig), source: "parent" as const, ecoConfigured: false };
  let model: ReturnType<typeof findModelInRegistry>;
  if (modelSetting.ecoConfigured) {
    try {
      model = await requireAvailableModel(modelSetting.value, ctx.modelRegistry, "Eco model");
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  } else {
    model = findModelInRegistry(modelSetting.value, ctx.modelRegistry, ctx.model);
  }
  const nestedThinking = typeof settings.thinkingSettingForMode === "function"
    ? settings.thinkingSettingForMode(resolvedType, ctx.thinkingLevel, agentConfig)
    : { ...settings.thinkingSettingFor(resolvedType, ctx.thinkingLevel, agentConfig), ecoConfigured: false };
  const thinkingLevel = normalizeThinkingLevel(model, nestedThinking.value);

  try {
    const { record } = await coordinator.spawnNested(parentId, pi, ctx, {
      type: resolvedType,
      agentConfig,
      prompt,
      description,
      model,
      modelKey: model ? `${model.provider}/${model.id}` : undefined,
      maxTurns: agentConfig.maxTurns,
      thinkingLevel,
      graceTurns: settings.agent.graceTurns,
      // AgentManager unconditionally inherits the private parent worktree and
      // catalog at the nested boundary; nested callers cannot choose either.
      invocation: { modelName: model?.id, thinkingLevel, maxTurns: agentConfig.maxTurns },
      runInBackground: false,
      signal,
    });
    const details = buildAgentDetails(record, { includeStats: true });
    if (signal?.aborted || record.lifecycle.status === "aborted" || record.lifecycle.status === "stopped") return cancelledResult(details);
    if (record.lifecycle.status === "error") return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
    return successResult(formatResultContent(record), details);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
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
// Tool_call listener — inject model into Agent tool calls
// =============================================================================

export async function toolCallListener(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  // Preserve an explicit model in the invocation display even for worktrees.
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
    const effectiveModel = typeof store.modelSettingForMode === "function"
      ? store.modelSettingForMode(subagentType, parentModelId, agentConfig).value
      : store.modelFor(subagentType, parentModelId, agentConfig);
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
    const setting = modeThinkingSetting(getStore(), subagentType, ctx.thinkingLevel, agentConfig);
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
