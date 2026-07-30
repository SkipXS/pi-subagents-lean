import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executeNestedAgentTool } from "./tool-execution.js";
import { renderAgentToolCall, renderAgentToolResult } from "../ui/renderer.js";
import type { SubagentRuntimeContext } from "../shell.js";

/**
 * Build the child runtime's local Agent proxy. It is supplied directly to the
 * session as a Pi custom tool, so it remains available when extensions are
 * disabled and never loads the root control tools.
 */
export function createNestedAgentProxy(runtime: SubagentRuntimeContext): ToolDefinition {
  return {
    name: "Agent",
    label: "Agent",
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String()),
      agent: Type.String(),
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: ExtensionContext,
    ) => executeNestedAgentTool(runtime, toolCallId, params, signal, onUpdate, ctx),
    renderCall: (args: Record<string, unknown>, theme: any) => renderAgentToolCall(args, theme),
    renderResult: (result: any, options: any, theme: any) =>
      renderAgentToolResult(result, options, theme, runtime.settings.agent.showCost),
  } as unknown as ToolDefinition;
}
