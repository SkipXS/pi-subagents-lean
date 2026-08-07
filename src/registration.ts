import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeAgentTool, executeContinueAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import type { AgentRenderMetadataBridge } from "./agents/agent-render-bridge.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import {
  MAX_AGENT_ID_BYTES,
  MAX_AGENT_PROMPT_BYTES,
  MAX_DESCRIPTION_BYTES,
} from "./agents/agent-string-limits.js";
import {
  renderAgentCall,
  renderAgentContinueCall,
  renderAgentResult,
  renderStopAgentCall,
  renderSubagentResult,
  SUBAGENT_RESULT_CUSTOM_TYPE,
} from "./agents/agent-renderer.js";

// Provider-side json_schema enforcement; "prefer" falls back gracefully on
// providers without strict mode (e.g. local Ollama).
const CONSTRAINED_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

/** Pi's public tool contract signals failures by throwing, not by isError results. */
function throwingToolExecute<T extends (...args: any[]) => Promise<any>>(execute: T): T {
  return (async (...args: Parameters<T>) => {
    const result = await execute(...args);
    if (result?.isError === true) {
      const text = result.content?.find?.((part: { type?: string; text?: string }) => part.type === "text")?.text;
      throw new Error(text || "Tool execution failed");
    }
    return result;
  }) as T;
}

/** Register the Agent tool once at extension initialization. */
function registerAgentTool(pi: ExtensionAPI, renderBridge: AgentRenderMetadataBridge | undefined): void {
  const executeAgentWithBridge: typeof executeAgentTool = (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => executeAgentTool(toolCallId, params, signal, onUpdate, ctx, renderBridge);

  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: "Delegate a task to a specialized agent.",
    parameters: Type.Object({
      prompt: Type.String({ maxLength: MAX_AGENT_PROMPT_BYTES }),
      description: Type.Optional(Type.String({ maxLength: MAX_DESCRIPTION_BYTES })),
      agent: Type.String(),
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    execute: throwingToolExecute(executeAgentWithBridge),
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
  });
}

/** Register all four public tools. */
export function registerTools(
  pi: ExtensionAPI,
  renderBridge?: AgentRenderMetadataBridge,
): void {
  // Background completions are custom messages, so give them the same safe
  // plaintext/result-footer renderer as foreground Agent-family results.
  // Optional invocation keeps minimal test/headless doubles compatible while
  // real Pi always provides the public registration method.
  pi.registerMessageRenderer?.(SUBAGENT_RESULT_CUSTOM_TYPE, renderSubagentResult);

  registerAgentTool(pi, renderBridge);

  // AgentContinue remains a strict-schema compatible root continuation tool.
  const executeContinueWithBridge: typeof executeContinueAgentTool = (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => executeContinueAgentTool(toolCallId, params, signal, onUpdate, ctx, renderBridge);

  const continueAgentTool = {
    name: "AgentContinue",
    label: "AgentContinue",
    description: "Continue an existing agent's session with a new prompt.",
    // Strict-mode providers (Codex) require every property to be present in
    // `required`, so run_in_background remains a mandatory boolean here even
    // though the executor tolerates its absence (defaults to foreground).
    parameters: Type.Object({
      agent_id: Type.String({ maxLength: MAX_AGENT_ID_BYTES }),
      prompt: Type.String({ maxLength: MAX_AGENT_PROMPT_BYTES }),
      run_in_background: Type.Boolean(),
    }, { additionalProperties: false }),
    execute: throwingToolExecute(executeContinueWithBridge),
    renderCall: renderAgentContinueCall,
    renderResult: renderAgentResult,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(continueAgentTool);

  const executeStopWithBridge: typeof executeStopAgentTool = (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => executeStopAgentTool(toolCallId, params, signal, onUpdate, ctx, renderBridge);

  const stopAgentTool = {
    name: "StopAgent",
    label: "StopAgent",
    description: "Stop a running or queued agent.",
    parameters: Type.Object({
      agent_id: Type.String({ maxLength: MAX_AGENT_ID_BYTES }),
    }, { additionalProperties: false }),
    execute: throwingToolExecute(executeStopWithBridge),
    renderCall: renderStopAgentCall,
    renderResult: renderAgentResult,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(stopAgentTool);

  const agentStatusTool = {
    name: "AgentStatus",
    label: "AgentStatus",
    description: "List subagents and their current status.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: throwingToolExecute(executeAgentStatusTool),
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(agentStatusTool);
}
