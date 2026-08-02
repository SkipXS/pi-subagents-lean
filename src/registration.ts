import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { executeAgentTool, executeContinueAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "./ui/renderer.js";
import { showAgentsMainMenu } from "./ui/menu/menus.js";
import { getPiInstance, getStore } from "./shell.js";

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

// ============================================================================
// Agent tool registration helper — fixed stealth schema
// ============================================================================

/** Register the Agent tool once at extension initialization. */
function registerAgentTool(pi: ExtensionAPI): void {
  const tool = {
    name: "Agent",
    label: "Agent",
    description: "Delegate a task to a specialized agent.",
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String()),
      agent: Type.String(),
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    execute: throwingToolExecute(executeAgentTool),

    renderCall: (args: Record<string, unknown>, theme: any) => renderAgentToolCall(args, theme),

    renderResult: (result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean }, options: { expanded?: boolean }, theme: any) => {
      const showCost = getStore().agent.showCost;
      return renderAgentToolResult(
        result,
        options,
        theme,
        showCost,
      );
    },
  };
  pi.registerTool(tool);
}

// ============================================================================
// Tool/Command/Message registration
// ============================================================================

/** Register all tools, commands, and message renderers. */
export function registerTools(pi: ExtensionAPI): void {
  // Agent tool — fixed stealth schema; live agents are advertised separately.
  registerAgentTool(pi);

  // AgentContinue tool — stealth schema, continue an existing agent session
  const continueAgentTool = {
    name: "AgentContinue",
    label: "AgentContinue",
    description: "Continue an existing agent's session with a new prompt.",
    // Strict-mode providers (Codex) require every property to be present in
    // `required`, so run_in_background must be a mandatory boolean here even
    // though the executor tolerates its absence (defaults to foreground).
    parameters: Type.Object({
      agent_id: Type.String(),
      prompt: Type.String(),
      run_in_background: Type.Boolean(),
    }, { additionalProperties: false }),
    execute: throwingToolExecute(executeContinueAgentTool),
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(continueAgentTool);

  // StopAgent tool — stealth schema, stop a running agent by ID
  const stopAgentTool = {
    name: "StopAgent",
    label: "StopAgent",
    description: "Stop a running or queued agent.",
    parameters: Type.Object({
      agent_id: Type.String(),
    }, { additionalProperties: false }),
    execute: throwingToolExecute(executeStopAgentTool),
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(stopAgentTool);

  // AgentStatus tool — stealth schema, list all agents and their statuses
  const agentStatusTool = {
    name: "AgentStatus",
    label: "AgentStatus",
    description: "List subagents and their current status.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: throwingToolExecute(executeAgentStatusTool),
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(agentStatusTool);

  // Message renderer — subagent-result (background agent completion)
  pi.registerMessageRenderer("subagent-result", (message, options, theme) => {
    const showCost = getStore().agent.showCost;
    return renderSubagentResult(
      message as { content?: string; details?: Record<string, unknown> },
      options as { expanded?: boolean },
      theme,
      showCost,
    );
  });

  // Command registration
  pi.registerCommand("agents", {
    description: "Manage subagents: running agents, spawning, agent catalog, execution, widget, and prompt settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The /agents management menu is available only in TUI mode.", "info");
        return;
      }
      const modelOptions = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      await showAgentsMainMenu(ctx, modelOptions);
    },
  });
}
