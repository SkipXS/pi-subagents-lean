/**
 * index.ts — Local subagents extension entry point.
 *
 * Registers tools, commands, and event listeners at init time.
 *
 * Stealth tool registration:
 *   - All tools register at extension init (not runtime)
 *   - No description, no promptSnippet, no promptGuidelines
 *   - Parameters without .description()
 *   - Model/thinking may be explicit per spawn; otherwise resolved by the tool_call listener/executor
 *
 * Config:
 *   - Loaded from ~/.pi/agent/subagents-lean.json at session_start
 *   - ConfigStore owns config + session overrides + persistence + side effects
 *   - Tool execution and menus read/write through store
 *
 * Commands:
 *   - /agents: Management menu (agent settings, concurrency, running agents, debug)
 *
 * Events:
 *   - tool_call: Inject effective model/thinking into Agent tool calls
 *   - session_start: Load config, register agents, initialise manager
 *   - session_shutdown: Abort all, dispose manager
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentRuntimeContext, isInsideSubagentSpawn, setPiInstance } from "./shell.js";
import { registerTools } from "./registration.js";
import { setupEventListeners } from "./events.js";

export default function (pi: ExtensionAPI) {
  // Child sessions receive their local Agent proxy through createAgentSession's
  // customTools API. Stay inert if this root extension is encountered while
  // binding child extensions so it cannot register root control tools.
  // The deprecated marker only preserves old inert-registration behavior.
  // ALS remains the sole authority for child shell isolation and root guards.
  if (getSubagentRuntimeContext() || isInsideSubagentSpawn()) return;
  setPiInstance(pi);
  registerTools(pi);
  setupEventListeners(pi);
}
