import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntimeSettings } from "../config/config-store.js";
import type { AgentConfig } from "../agents/types.js";
import {
  discoverNewAgents,
  getAgentConfig,
  resolveAgentCatalog,
  resolveType,
  resolveTypeInCatalog,
} from "../agents/agent-types.js";
import { resolveAgentTunables } from "../models/agent-resolution.js";
import { revalidateWorktreePath, validateWorktreePath } from "./worktree-validator.js";
import { snapshotResolvedSpawn, snapshotRuntimeSettings, type ResolvedSpawn } from "./spawn-contract.js";

/** The read-only ConfigStore surface needed during Agent preflight. */
export interface SpawnPreflightStore {
  readonly agent: {
    readonly disableDefaultAgents: boolean;
  };
  readonly createSubagentRuntimeSettings?: () => SubagentRuntimeSettings | undefined;
}

/** Explicit inputs and collaborators for one Agent spawn preflight. */
export interface SpawnPreflightInput {
  readonly params: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly store: SpawnPreflightStore;
  readonly parentCwd: string;
  /** Trust captured by the parent before the first async boundary. */
  readonly projectTrusted: boolean;
}

/** Structured result for the expected preflight outcomes. */
export type SpawnPreflightResult =
  | {
    readonly kind: "ready";
    readonly resolvedSpawn: ResolvedSpawn;
    readonly warnings: readonly string[];
  }
  | {
    readonly kind: "cancelled";
    readonly warnings: readonly string[];
  }
  | {
    readonly kind: "error";
    readonly error: string;
    readonly warnings: readonly string[];
  };

function cancelled(warnings: readonly string[] = []): SpawnPreflightResult {
  return { kind: "cancelled", warnings };
}

function failed(error: string, warnings: readonly string[] = []): SpawnPreflightResult {
  return { kind: "error", error, warnings };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve all inputs needed before the coordinator accepts a root spawn.
 *
 * This function deliberately has no shell lookups or renderer/tool-result
 * concerns. Its trust value is an input snapshot, and every awaited boundary
 * checks the caller's abort signal before project-controlled work proceeds.
 */
export async function runSpawnPreflight(input: SpawnPreflightInput): Promise<SpawnPreflightResult> {
  const {
    params,
    signal,
    pi,
    ctx,
    store,
    parentCwd,
    projectTrusted,
  } = input;

  if (signal?.aborted) return cancelled();

  const rawWorktreePath = params.worktree_path as string | undefined;
  let validatedWorktreePath: string | undefined;
  let worktreeLabel: string | undefined;
  let validationWarnings: string[] = [];

  if (rawWorktreePath && rawWorktreePath.trim() !== "") {
    const warnings: string[] = [];
    let validation;
    try {
      validation = await validateWorktreePath(
        pi,
        rawWorktreePath,
        parentCwd,
        (message) => { warnings.push(message); },
      );
    } catch (error) {
      if (signal?.aborted) return cancelled();
      return failed(`worktree_path validation failed: ${errorMessage(error)}`);
    }
    if (signal?.aborted) return cancelled();
    if (!validation.ok) return failed(validation.error, warnings);
    validatedWorktreePath = validation.resolvedPath;
    worktreeLabel = validation.label;
    validationWarnings = warnings;
  }

  const rawType = params.agent;
  if (typeof rawType !== "string" || rawType.trim() === "") {
    return failed("Agent type is required");
  }
  const type = rawType.trim();
  const trustedWorktreeDir = validatedWorktreePath && projectTrusted
    ? `${validatedWorktreePath}/.pi/agents`
    : undefined;

  try {
    // Worktree catalogs are local to this tool call. Never use the shared
    // registry for a worktree name: it may be an override of a parent type.
    let resolvedType: string | undefined;
    let agentConfig: AgentConfig | undefined;
    if (trustedWorktreeDir) {
      // Repeat validation directly before reading project-controlled overlays.
      // A deleted or swapped path must not contribute an agent definition.
      const validation = await revalidateWorktreePath(
        pi,
        rawWorktreePath!,
        parentCwd,
        validatedWorktreePath!,
      );
      if (signal?.aborted) return cancelled();
      if (!validation.ok || !validation.resolvedPath) {
        return failed(validation.ok ? "worktree_path validation failed" : validation.error);
      }
      validatedWorktreePath = validation.resolvedPath;
      worktreeLabel = validation.label;
      const catalog = await resolveAgentCatalog(`${validatedWorktreePath}/.pi/agents`, {
        disableDefaultAgents: store.agent.disableDefaultAgents,
      });
      if (signal?.aborted) return cancelled();
      resolvedType = resolveTypeInCatalog(catalog, type);
      agentConfig = resolvedType ? catalog.get(resolvedType) : undefined;
    } else {
      resolvedType = resolveType(type);
      if (!resolvedType) {
        await discoverNewAgents({ disableDefaultAgents: store.agent.disableDefaultAgents });
        if (signal?.aborted) return cancelled();
        resolvedType = resolveType(type);
      }
      agentConfig = resolvedType ? getAgentConfig(resolvedType) : undefined;
    }
    if (!resolvedType || !agentConfig) return failed(`Unknown agent type: ${type}`);

    const prompt = params.prompt as string;
    const description = (params.description as string | undefined)
      || prompt.split("\n")[0].slice(0, 80)
      || prompt.slice(0, 80);
    const runInBackground = params.run_in_background as boolean | undefined;

    // Persisted per-agent settings are applied above the effective merged
    // Markdown definition. The runtime snapshot keeps the accepted spawn
    // stable if config is reloaded while it waits for a concurrency slot.
    const runtimeSettingsSnapshot = typeof store.createSubagentRuntimeSettings === "function"
      ? store.createSubagentRuntimeSettings()
      : undefined;
    const runtimeSettings = snapshotRuntimeSettings(runtimeSettingsSnapshot);
    const shouldRunInBackground = runInBackground === true;
    const resolvedTunables = resolveAgentTunables({
      agentName: resolvedType,
      agentConfig,
      overrides: runtimeSettings.agents,
      modelRegistry: ctx.modelRegistry,
      parentModel: ctx.model,
      parentThinking: ctx.thinkingLevel,
    });
    const model = resolvedTunables.model;
    const modelKey = resolvedTunables.modelKey;
    const modelName = model?.id;
    const thinkingLevel = resolvedTunables.thinkingLevel;
    const resolvedSpawn = snapshotResolvedSpawn({
      type: resolvedType,
      prompt,
      description,
      runInBackground: shouldRunInBackground,
      agentConfig,
      runtimeSettings,
      projectTrusted,
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
      signal,
    });

    return {
      kind: "ready",
      resolvedSpawn,
      warnings: validationWarnings,
    };
  } catch (error) {
    // Unexpected collaborator failures retain the existing rejection behavior;
    // expected validation/domain failures are returned above as discriminated results.
    throw error;
  }
}
