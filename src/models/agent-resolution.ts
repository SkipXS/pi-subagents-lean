/** Shared model/thinking resolution for one effective agent definition. */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../agents/types.js";
import type { AgentSettingsOverride } from "../config/types.js";
import type { ThinkingLevel } from "../types.js";
import { normalizeThinkingLevel } from "./thinking.js";
import { findModelInRegistry } from "../utils.js";

export interface AgentModelRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
}

export interface AgentTunablesResolution {
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  modelKey?: string;
}

export interface ResolveAgentTunablesOptions {
  /** Canonical catalog key used when the effective definition has another name. */
  agentName?: string;
  /** Effective definition after bundled/user/shared/project/worktree merging. */
  agentConfig?: Pick<AgentConfig, "name" | "model" | "thinkingLevel">;
  /** Persisted, normalized per-agent settings. */
  overrides?: Readonly<Record<string, AgentSettingsOverride>>;
  modelRegistry: AgentModelRegistry;
  parentModel?: Model<any>;
  parentThinking?: ThinkingLevel;
  /** Already-resolved lower-precedence values supplied by an internal caller. */
  baseModel?: Model<any>;
  baseThinking?: ThinkingLevel;
  /** Lower-precedence requested thinking that still needs normalization. */
  requestedThinking?: ThinkingLevel;
}

/**
 * Find a persisted override using discovery's case-insensitive name semantics.
 * Iterating in object order also makes this safe for unnormalized adapter data:
 * the last matching case variant wins.
 */
export function findAgentSettingsOverride(
  overrides: Readonly<Record<string, AgentSettingsOverride>> | undefined,
  ...names: Array<string | undefined>
): AgentSettingsOverride | undefined {
  const candidateNames = new Set(
    names.filter((name): name is string => typeof name === "string" && name.length > 0)
      .map((name) => name.toLowerCase()),
  );
  if (candidateNames.size === 0 || !overrides) return undefined;

  let result: AgentSettingsOverride | undefined;
  for (const [name, override] of Object.entries(overrides)) {
    if (candidateNames.has(name.toLowerCase())) result = override;
  }
  return result;
}

/**
 * Resolve the model and thinking fields independently.
 *
 * Settings are applied above the effective Markdown definition and the parent
 * session. Each model candidate goes through the existing registry lookup; an
 * unavailable setting therefore falls through to the already resolved lower
 * precedence model. Thinking is normalized only after the final model is known.
 */
export function resolveAgentTunables(options: ResolveAgentTunablesOptions): AgentTunablesResolution {
  const override = findAgentSettingsOverride(
    options.overrides,
    options.agentConfig?.name,
    options.agentName,
  );

  const lowerModel = options.baseModel
    ?? findModelInRegistry(options.agentConfig?.model, options.modelRegistry, options.parentModel);
  const model = override?.model !== undefined
    ? findModelInRegistry(override.model, options.modelRegistry, lowerModel)
    : lowerModel;

  const requestedThinking = override?.thinking
    ?? options.baseThinking
    ?? options.requestedThinking
    ?? options.agentConfig?.thinkingLevel
    ?? options.parentThinking;
  // A coordinator/runner base value has already passed Pi's model-capability
  // normalization. Preserve it unless a settings override changes the model;
  // values resolved here from Markdown or the parent still use the shared
  // normalizer below.
  const thinkingLevel = options.baseThinking !== undefined
    && override?.thinking === undefined
    && override?.model === undefined
    ? options.baseThinking
    : normalizeThinkingLevel(model, requestedThinking);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  return { model, thinkingLevel, modelKey };
}
