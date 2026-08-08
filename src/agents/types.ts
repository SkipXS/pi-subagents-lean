import type { ThinkingLevel } from "../types.js";

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  /** Retained/display description is capped at 8 KiB UTF-8. */
  description: string;
  /** Tools to register with the session (controls availability, not LLM visibility). */
  registeredTools?: string[];
  /**
   * Controls which tool schemas the LLM sees. Can reference built-in tools
   * and extension tools. true/undefined = all active, string[] = listed,
   * false = none. Supports ext/* syntax to include all tools from an extension.
   */
  tools?: true | string[] | false;
  /** Tools removed from the selected tool set. Supports the same ext/* syntax. */
  excludeTools?: string[];
  /**
   * Controls which extensions load. true/undefined = all active, string[] =
   * listed, false = none.
   */
  extensions?: true | string[] | false;
  /** Extensions removed from the selected extension set. */
  excludeExtensions?: string[];
  /** Selects skill metadata for the system prompt. true = all active, string[] = listed, false = none. */
  skills?: true | string[] | false;
  /** Skills removed from the selected metadata set. */
  excludeSkills?: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Preflight rejects values above 512 KiB UTF-8; it is never silently truncated. */
  systemPrompt: string;

  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** true = agent is hidden from the schema enum but can still be called by name. */
  hidden?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export interface AgentInvocation {
  /** Short model id used for rendering, when available. */
  modelName?: string;
  /** Resolved provider/model id retained internally for queued control rows. */
  modelKey?: string;
  thinkingLevel?: ThinkingLevel;
}
