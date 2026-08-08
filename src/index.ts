/**
 * index.ts — Local subagents extension entry point.
 *
 * Registers the two foreground tools and root lifecycle listeners at init time.
 *
 * Fixed tool registration:
 *   - All tools register at extension init (not runtime)
 *   - Static descriptions only; no promptSnippet or promptGuidelines
 *   - Parameters without .description()
 *   - Model/thinking are resolved internally from settings and agent definitions;
 *     they are not public Agent-tool parameters
 *
 * Config:
 *   - Loaded from ~/.pi/agent/subagents-lean.json at session_start
 *   - ConfigStore owns current config + persistence + runtime side effects
 *
 * Events:
 *   - before_agent_start: Refresh the parent catalog and orchestration prompt
 *   - session_start: Load config, register agents, initialise root services
 *   - session_shutdown: Abort all, dispose root services
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentRuntimeContext, setPiInstance } from "./shell.js";
import { registerTools } from "./registration.js";
import { setupEventListeners } from "./events.js";
import { createAgentRenderMetadataBridge } from "./agents/agent-render-bridge.js";

export default function (pi: ExtensionAPI) {
  // Stay inert when Pi binds this extension while loading an agent session.
  // The ALS marker is the authority for child-session isolation, so no root
  // control tool or listener can leak into a subagent.
  if (getSubagentRuntimeContext()) return;
  setPiInstance(pi);
  const renderBridge = createAgentRenderMetadataBridge();
  registerTools(pi, renderBridge);
  setupEventListeners(pi, renderBridge);
}
