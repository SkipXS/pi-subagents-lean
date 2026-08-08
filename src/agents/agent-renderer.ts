import {
  AGENT_RENDER_DETAILS_KEY,
  agentCallRenderMetadataEqual,
  formatAgentCallText,
  formatAgentControlCallText,
  formatAgentContinueCallText,
  formatAgentResultText,
  formatAgentUsageLine,
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
  getAgentRendererState,
  isExecutionTool,
  persistAgentRendererState,
  renderCallWithFormatter,
  runtimeFor,
  setRowIndicator,
  stopAgentRendererTimers,
} from "./agent-render-runtime.js";
import type { AgentRendererContext } from "./agent-render-runtime.js";

export {
  AGENT_RENDER_DETAILS_KEY,
  formatAgentCallText,
  formatAgentControlCallText,
  formatAgentContinueCallText,
  formatAgentUsageLine,
  getAgentCallRenderMetadata,
  withAgentCallRenderMetadata,
  stopAgentRendererTimers,
};
export type {
  AgentCallRenderMetadata,
  AgentControlRenderToolName,
  AgentRenderToolName,
};
export { AgentCallDetailsComponent, escapeTerminalText, visibleWidth };
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

/** Render the AgentContinue call header and complete prompt. */
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

export function renderAgentContinueCall(
  args: unknown,
  theme: unknown,
  context: AgentRendererContext,
): PlaintextComponent {
  return renderAgentControlCall("AgentContinue", args, theme, context);
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

/**
 * Hydrate row-local state from partial/final details and keep Pi's text result
 * rendering intact. Invalidation is guarded by value equality so repeated
 * partial updates cannot trigger a render loop.
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
    ?? (inferredExecutionTool && isRecord(context.args) && typeof context.args.agent_id === "string"
      ? "AgentContinue"
      : "Agent");
  let synchronouslyRedrawn = false;
  let metadataChanged = false;

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
  const runtime = runtimeFor(context);

  if (failed) {
    setRowIndicator(context, state, "error");
  } else if (queued) {
    setRowIndicator(context, state, "queued");
  } else if (partial) {
    if (
      (state.indicator === "" || state.indicator === "working")
      && canAnimateForeground(resolvedToolName, state.metadata, context.args, context, runtime)
    ) {
      setRowIndicator(context, state, "working");
    }
  } else {
    setRowIndicator(context, state, "success");
  }

  if (metadataChanged) {
    persistAgentRendererState(context, state);
    try {
      context.invalidate();
      synchronouslyRedrawn = context.state[AGENT_RENDER_CALL_VERSION_KEY] === state.version;
    } catch {
      // A renderer remains safe for minimal/headless callers.
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
