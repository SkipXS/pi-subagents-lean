/**
 * Public façade for the Agent-family tool renderers.
 *
 * Text safety, formatting, and row lifecycle state live in focused modules;
 * this file keeps Pi's public renderCall/renderResult entry points stable.
 */

import {
  AGENT_RENDER_DETAILS_KEY,
  agentCallRenderMetadataEqual,
  formatAgentCallText,
  formatAgentControlCallText,
  formatAgentContinueCallText,
  formatAgentResultText,
  formatAgentUsageLine,
  formatStopAgentCallText,
  getAgentCallRenderMetadata,
  mergeAgentCallRenderMetadata,
  withAgentCallRenderMetadata,
} from "./agent-render-format.js";
import type {
  AgentCallRenderMetadata,
  AgentControlRenderToolName,
  AgentRenderToolName,
} from "./agent-render-format.js";
import {
  AgentCallDetailsComponent,
  escapeTerminalText,
  visibleWidth,
} from "./agent-render-text.js";
import type { PlaintextComponent } from "./agent-render-text.js";
import {
  AGENT_RENDER_CALL_VERSION_KEY,
  canAnimateForeground,
  executionMode,
  getAgentRendererState,
  isExecutionTool,
  persistAgentRendererState,
  renderCallWithFormatter,
  runtimeFor,
  setRowIndicator,
  stopAgentRendererTimers,
} from "./agent-render-runtime.js";
import type { AgentRendererContext } from "./agent-render-runtime.js";

/** Custom message type used for completed background-agent deliveries. */
export const SUBAGENT_RESULT_CUSTOM_TYPE = "subagent-result" as const;

export {
  AGENT_RENDER_DETAILS_KEY,
  formatAgentCallText,
  formatAgentControlCallText,
  formatAgentContinueCallText,
  formatAgentUsageLine,
  formatStopAgentCallText,
  getAgentCallRenderMetadata,
  withAgentCallRenderMetadata,
  stopAgentRendererTimers,
};
export type {
  AgentCallRenderMetadata,
  AgentControlRenderToolName,
  AgentRenderToolName,
};
export {
  AgentCallDetailsComponent,
  escapeTerminalText,
  visibleWidth,
};
export type { PlaintextComponent, AgentRendererContext };
export {
  AGENT_WORKING_SPINNER_FRAMES,
  AGENT_WORKING_SPINNER_INTERVAL_MS,
} from "./agent-render-runtime.js";

interface AgentResultLike {
  content?: unknown;
  details?: unknown;
  isError?: unknown;
}

interface AgentMessageLike {
  content?: unknown;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Render the Agent call header and complete prompt. */
export function renderAgentCall(
  args: unknown,
  _theme: unknown,
  context: AgentRendererContext,
): PlaintextComponent {
  return renderCallWithFormatter("Agent", args, context, formatAgentCallText);
}

/** Render either root control tool with the shared ID/role/model header. */
export function renderAgentControlCall(
  toolName: AgentControlRenderToolName,
  args: unknown,
  _theme: unknown,
  context: AgentRendererContext,
): PlaintextComponent {
  return renderCallWithFormatter(
    toolName,
    args,
    context,
    (metadata, rawArgs) => formatAgentControlCallText(toolName, metadata, rawArgs),
  );
}

/** Convenience renderer for AgentContinue. */
export function renderAgentContinueCall(
  args: unknown,
  theme: unknown,
  context: AgentRendererContext,
): PlaintextComponent {
  return renderAgentControlCall("AgentContinue", args, theme, context);
}

/** Convenience renderer for StopAgent. */
export function renderStopAgentCall(
  args: unknown,
  theme: unknown,
  context: AgentRendererContext,
): PlaintextComponent {
  return renderAgentControlCall("StopAgent", args, theme, context);
}

function failureStatus(value: unknown): boolean {
  return value === "error" || value === "aborted" || value === "stopped" || value === "cancelled";
}

function resultIsFailure(result: AgentResultLike, context: AgentRendererContext, executionTool: boolean): boolean {
  if (context.isError === true || result.isError === true) return true;
  if (!executionTool || !isRecord(result.details)) return false;

  if (failureStatus(result.details.status)) return true;
  const currentExecution = isRecord(result.details.currentExecution)
    ? result.details.currentExecution
    : undefined;
  return failureStatus(currentExecution?.status);
}

/** Only an explicit lifecycle status qualifies as an authoritative queue marker. */
function resultIsQueued(result: AgentResultLike, executionTool: boolean): boolean {
  if (!executionTool || !isRecord(result.details)) return false;
  if (result.details.status === "queued") return true;
  const currentExecution = isRecord(result.details.currentExecution)
    ? result.details.currentExecution
    : undefined;
  return currentExecution?.status === "queued";
}

/** Render a completed background notification as safe plaintext. */
export function renderSubagentResult(
  message: AgentMessageLike,
  _options: { expanded?: boolean; outputPad?: number },
  _theme: unknown,
): PlaintextComponent {
  const component = new AgentCallDetailsComponent();
  component.setText(formatAgentResultText(message.content, message.details, true));
  return component;
}

/**
 * Hydrate row-local state from partial/final details and keep Pi's text result
 * rendering intact. The invalidate request is guarded by value equality, so a
 * repeated partial update or final hydration cannot trigger a loop.
 *
 * `toolName` is optional for source-compatible direct callers; registered tools
 * pass it explicitly so StopAgent can never start an execution spinner.
 */
export function renderAgentResult(
  result: AgentResultLike,
  options: { expanded?: boolean; isPartial?: boolean },
  _theme: unknown,
  context: AgentRendererContext,
  toolName?: AgentRenderToolName,
): PlaintextComponent {
  const safeResult = isRecord(result) ? result as AgentResultLike : {};
  const state = getAgentRendererState(context);
  const incoming = getAgentCallRenderMetadata(safeResult.details);
  const inferredExecutionTool = isExecutionTool(toolName, state.metadata, context.args);
  const resolvedToolName: AgentRenderToolName = toolName
    ?? (inferredExecutionTool ? "Agent" : "StopAgent");
  let synchronouslyRedrawn = false;
  let metadataChanged = false;

  // Merge first so the resolved mode is authoritative before deciding whether
  // this open row is foreground or background.
  if (incoming) {
    const merged = mergeAgentCallRenderMetadata(state.metadata, incoming);
    if (!agentCallRenderMetadataEqual(state.metadata, merged)) {
      state.metadata = merged;
      state.version++;
      metadataChanged = true;
    }
  }

  const executionTool = isExecutionTool(resolvedToolName, state.metadata, context.args);
  const partial = options.isPartial === true;
  const failed = resultIsFailure(safeResult, context, executionTool);
  const queued = resultIsQueued(safeResult, executionTool);
  const background = executionTool && executionMode(state.metadata, context.args) === "background";
  const runtime = runtimeFor(context);

  if (failed) {
    setRowIndicator(context, state, "error");
  } else if (queued) {
    setRowIndicator(context, state, "queued");
  } else if (partial) {
    if (background && state.indicator === "working") {
      // Resolved renderer metadata can correct the raw call's provisional
      // mode. End a provisional foreground timer immediately.
      setRowIndicator(context, state, "background");
    } else if (
      (state.indicator === "" || state.indicator === "working")
      && canAnimateForeground(resolvedToolName, state.metadata, context.args, context, runtime)
    ) {
      setRowIndicator(context, state, "working");
    }
  } else {
    // A background row is an acknowledgement, not a long-lived background
    // loader. An explicit `status: "queued"` was handled above; otherwise
    // queue state is never guessed from acknowledgement text or unrelated
    // details.
    setRowIndicator(context, state, background ? "background" : "success");
  }

  if (metadataChanged) {
    persistAgentRendererState(context, state);

    // Pi 0.82.1 calls renderCall before renderResult. Ask for one more row
    // render after metadata arrives so the header immediately switches from
    // raw/dashes to the resolved invocation. The equality guard above makes
    // this idempotent for repeated partial/final results.
    try {
      context.invalidate();
      // ToolExecutionComponent.invalidate() redraws synchronously in Pi
      // 0.82.1. If that happened, the nested render already installed the
      // actual result component; returning an empty component avoids adding
      // the same result a second time in the outer redraw. Async/headless
      // invalidate implementations do not advance this marker and retain
      // the normal text result below.
      synchronouslyRedrawn = context.state[AGENT_RENDER_CALL_VERSION_KEY] === state.version;
    } catch {
      // A renderer must remain safe when used by a minimal/headless caller.
    }
  }

  if (synchronouslyRedrawn) return new AgentCallDetailsComponent();

  const component = context.lastComponent instanceof AgentCallDetailsComponent
    ? context.lastComponent
    : new AgentCallDetailsComponent();
  component.setText(formatAgentResultText(
    safeResult.content,
    safeResult.details,
    !partial,
  ));
  return component;
}
