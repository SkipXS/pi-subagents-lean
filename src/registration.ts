import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeAgentTool } from "./agents/tool-execution.js";
import { executeContinueAgentTool } from "./agents/agent-control-execution.js";
import type { AgentRenderMetadataBridge } from "./agents/agent-render-bridge.js";
import {
  MAX_AGENT_ID_BYTES,
  MAX_AGENT_PROMPT_BYTES,
  MAX_DESCRIPTION_BYTES,
} from "./agents/agent-string-limits.js";
import {
  renderAgentCall,
  renderAgentContinueCall,
  renderAgentResult,
} from "./agents/agent-renderer.js";

// Provider-side json_schema enforcement; "prefer" falls back gracefully on
// providers without strict mode.
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
    description: "Delegate to a context-isolated specialized agent and wait for its result. It cannot see the parent conversation, parent tool results, or other agents' output, so its prompt must be self-contained.",
    parameters: Type.Object({
      prompt: Type.String({ maxLength: MAX_AGENT_PROMPT_BYTES }),
      agent: Type.String(),
      description: Type.Optional(Type.String({ maxLength: MAX_DESCRIPTION_BYTES })),
      worktree_path: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    execute: throwingToolExecute(executeAgentWithBridge),
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
  });
}

/** Register the two foreground tools. */
export function registerTools(
  pi: ExtensionAPI,
  renderBridge?: AgentRenderMetadataBridge,
): void {
  registerAgentTool(pi, renderBridge);

  const executeContinueWithBridge: typeof executeContinueAgentTool = (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => executeContinueAgentTool(toolCallId, params, signal, onUpdate, ctx, renderBridge);

  pi.registerTool({
    name: "AgentContinue",
    label: "AgentContinue",
    description: "Continue a finished agent's session with a new prompt and wait for its result.",
    parameters: Type.Object({
      agent_id: Type.String({ maxLength: MAX_AGENT_ID_BYTES }),
      prompt: Type.String({ maxLength: MAX_AGENT_PROMPT_BYTES }),
    }, { additionalProperties: false }),
    execute: throwingToolExecute(executeContinueWithBridge),
    renderCall: renderAgentContinueCall,
    renderResult: renderAgentResult,
    constrainedSampling: CONSTRAINED_SAMPLING,
  });
}
