import type { ThinkingLevel } from "../types.js";

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** How the subagent system prompt is constructed. */
export type SystemPromptMode = "replace" | "inherit" | "custom";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  /** Tools to register with the session (controls availability, not LLM visibility). */
  registeredTools?: string[];
  /**
   * Controls which tool schemas the LLM sees. Can reference built-in tools
   * and extension tools. true = all, string[] = listed, false = none.
   * Supports ext/* syntax to include all tools from an extension.
   * Mutually exclusive with excludeTools.
   */
  tools?: true | string[] | false;
  /** Tool blacklist — all tools except these are visible. Mutually exclusive with tools (when tools is string[]). */
  excludeTools?: string[];
  /** true = inherit all, string[] = only listed, false = none. undefined = not set (uses global default). Mutually exclusive with excludeExtensions. */
  extensions?: true | string[] | false;
  /** Extension blacklist — all extensions except these load. Mutually exclusive with extensions (when extensions is string[]). */
  excludeExtensions?: string[];
  /** Whitelist of allowed skills (metadata only in system prompt). true = all, string[] = listed, false = none. undefined = not set (uses global default). */
  skills?: true | string[] | false;
  /** Skills to preload with full content into system prompt. string[] = listed, false/undefined = none */
  preloadSkills?: string[] | false;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  /** Max output tokens per LLM response. Passed to provider as max_tokens or max_completion_tokens. */
  maxTokens?: number;
  /** Roles this agent may delegate to from its isolated child runtime. */
  delegateTo?: string[];
  /** Maximum total direct children this agent may create. */
  maxChildAgents?: number;
  systemPrompt: string;

  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** true = agent is hidden from the schema enum but can still be called by name. */
  hidden?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

/**
 * Resolve a delegation policy after frontmatter layers have merged. An omitted
 * child limit permits one child only when the role explicitly delegates;
 * leaves always have no child capacity, even if a stale limit is present.
 */
export function getEffectiveMaxChildAgents(config: Pick<AgentConfig, "delegateTo" | "maxChildAgents">): number {
  if (!config.delegateTo?.length) return 0;
  if (config.maxChildAgents === undefined) return 1;
  return Number.isFinite(config.maxChildAgents)
    ? Math.max(0, Math.floor(config.maxChildAgents))
    : 0;
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  runInBackground?: boolean;
}
