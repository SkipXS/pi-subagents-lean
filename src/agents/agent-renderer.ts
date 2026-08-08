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
  getAgentRendererState,
  persistAgentRendererState,
  renderCallWithFormatter,
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
};
export type {
  AgentCallRenderMetadata,
  AgentControlRenderToolName,
  AgentRenderToolName,
};
export { AgentCallDetailsComponent, escapeTerminalText, visibleWidth };
export type { PlaintextComponent, AgentRendererContext };
interface AgentResultLike {
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
  return renderCallWithFormatter(args, context, formatAgentCallText);
}

/** Render the AgentContinue call header and complete prompt. */
export function renderAgentControlCall(
  toolName: AgentControlRenderToolName,
  args: unknown,
  _theme: unknown,
  context: AgentRendererContext,
): PlaintextComponent {
  return renderCallWithFormatter(
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
): PlaintextComponent {
  const safeResult = isRecord(result) ? result as AgentResultLike : {};
  const state = getAgentRendererState(context);
  const incoming = getAgentCallRenderMetadata(safeResult.details);
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

  const partial = options.isPartial === true;

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
