/**
 * index.ts — Local subagents extension entry point.
 *
 * Registers the four tools and root lifecycle listeners at init time.
 *
 * Stealth tool registration:
 *   - All tools register at extension init (not runtime)
 *   - No description, no promptSnippet, no promptGuidelines
 *   - Parameters without .description()
 *   - Model/thinking may be explicit per spawn; otherwise resolved by the tool_call listener/executor
 *
 * Config:
 *   - Loaded from ~/.pi/agent/subagents-lean.json at session_start
 *   - ConfigStore owns config + session overrides + persistence + runtime side effects
 *
 * Events:
 *   - tool_call: Inject effective model/thinking into Agent tool calls
 *   - before_agent_start: Refresh the parent catalog and orchestration prompt
 *   - session_start: Load config, register agents, initialise root services
 *   - session_shutdown: Abort all, dispose root services
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentRuntimeContext, isInsideSubagentSpawn, setPiInstance } from "./shell.js";
import { registerTools } from "./registration.js";
import { setupEventListeners } from "./events.js";

export default function (pi: ExtensionAPI) {
  // Stay inert when Pi binds this extension while loading an agent session.
  // The ALS marker is the authority for child-session isolation, so no root
  // control tool or listener can leak into a subagent.
  if (getSubagentRuntimeContext() || isInsideSubagentSpawn()) return;
  setPiInstance(pi);
  registerTools(pi);
  setupEventListeners(pi);
}
