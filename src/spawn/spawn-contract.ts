import type { Model } from "@earendil-works/pi-ai";
import type { SubagentRuntimeSettings } from "../config/config-store.js";
import type { AgentConfig } from "../agents/types.js";
import type { AgentInvocation, SubagentType } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";

/**
 * Values resolved by the regular Agent tool before the spawn is accepted.
 *
 * This is intentionally a data contract rather than a lookup request. Once a
 * caller has produced it, downstream scheduling must not consult the mutable
 * agent registry, ConfigStore, or model registry again.
 */
export interface ResolvedSpawn {
  readonly type: SubagentType;
  readonly prompt: string;
  readonly description: string;
  readonly runInBackground: boolean;
  readonly agentConfig: AgentConfig;
  readonly runtimeSettings: SubagentRuntimeSettings;
  /** Trust snapshot captured before tool-preflight awaits. */
  readonly projectTrusted: boolean;
  readonly model?: Model<any>;
  readonly modelKey?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly worktreePath?: string;
  readonly worktreeLabel?: string;
  readonly worktreeParentCwd?: string;
  readonly worktreeSelectionPath?: string;
  readonly invocation?: AgentInvocation;
  readonly signal?: AbortSignal;
}

/** Contract retained by the manager queue and carried into the runner. */
export interface AcceptedSpawn extends ResolvedSpawn {
  readonly accepted: true;
}

const DEFAULT_RUNTIME_AGENT_SETTINGS = {
  includeContextFiles: true,
  disableDefaultAgents: false,
  orchestrationPrompt: true,
} as const;

/**
 * Clone and recursively freeze contract-owned data. Model instances and
 * AbortSignals deliberately remain external identities; all plain data that
 * the accepted contract owns is detached, including nested arrays/objects.
 */
function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const source = value as object;
  const previous = seen.get(source);
  if (previous !== undefined) return previous as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(source, clone);
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if ("value" in descriptor) descriptor.value = cloneAndFreeze(descriptor.value, seen);
      Object.defineProperty(clone, key, descriptor);
    }
    return Object.freeze(clone) as T;
  }

  const clone = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  seen.set(source, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = cloneAndFreeze(descriptor.value, seen);
    Object.defineProperty(clone, key, descriptor);
  }
  return Object.freeze(clone) as T;
}

/** Clone the mutable portions of an AgentConfig and freeze the snapshot. */
function freezeAgentConfig(config: AgentConfig): AgentConfig {
  return cloneAndFreeze({ ...config });
}

/**
 * Detach and freeze runtime settings. ConfigStore already returns this shape
 * frozen in production, but the adapter also protects direct/test callers that
 * provide a mutable settings object.
 */
export function snapshotRuntimeSettings(
  settings?: SubagentRuntimeSettings,
): SubagentRuntimeSettings {
  const sourceAgent = settings?.agent;
  const agent = Object.freeze({
    includeContextFiles: sourceAgent?.includeContextFiles ?? DEFAULT_RUNTIME_AGENT_SETTINGS.includeContextFiles,
    disableDefaultAgents: sourceAgent?.disableDefaultAgents ?? DEFAULT_RUNTIME_AGENT_SETTINGS.disableDefaultAgents,
    orchestrationPrompt: sourceAgent?.orchestrationPrompt ?? DEFAULT_RUNTIME_AGENT_SETTINGS.orchestrationPrompt,
  });
  const sourceAgents = settings?.agents;
  const agents = sourceAgents
    ? Object.fromEntries(
      Object.entries(sourceAgents).map(([name, override]) => [name, { ...override }]),
    )
    : undefined;

  return cloneAndFreeze({
    agent,
    ...(agents ? { agents } : {}),
  });
}

type ResolvedSpawnInput = Omit<ResolvedSpawn, "projectTrusted"> & {
  /** Optional only for legacy/direct callers; snapshots always materialize false. */
  readonly projectTrusted?: boolean;
};

function snapshotResolvedFields(spawn: ResolvedSpawnInput): ResolvedSpawn {
  return Object.freeze({
    type: spawn.type,
    prompt: spawn.prompt,
    description: spawn.description,
    runInBackground: spawn.runInBackground,
    agentConfig: freezeAgentConfig(spawn.agentConfig),
    runtimeSettings: snapshotRuntimeSettings(spawn.runtimeSettings),
    projectTrusted: spawn.projectTrusted === true,
    model: spawn.model,
    modelKey: spawn.modelKey,
    thinkingLevel: spawn.thinkingLevel,
    worktreePath: spawn.worktreePath,
    worktreeLabel: spawn.worktreeLabel,
    worktreeParentCwd: spawn.worktreeParentCwd,
    worktreeSelectionPath: spawn.worktreeSelectionPath,
    invocation: spawn.invocation ? cloneAndFreeze({ ...spawn.invocation }) : undefined,
    signal: spawn.signal,
  });
}

/** Create the detached, immutable pre-acceptance resolution snapshot. */
export function snapshotResolvedSpawn(spawn: ResolvedSpawnInput): ResolvedSpawn {
  return snapshotResolvedFields(spawn);
}

/** Mark a resolved snapshot as accepted while retaining a fresh defensive copy. */
export function acceptResolvedSpawn(spawn: ResolvedSpawnInput): AcceptedSpawn {
  return Object.freeze({
    ...snapshotResolvedFields(spawn),
    accepted: true as const,
  });
}

/** Re-snapshot an accepted contract at the manager acceptance boundary. */
export function snapshotAcceptedSpawn(spawn: AcceptedSpawn): AcceptedSpawn {
  return acceptResolvedSpawn(spawn);
}
