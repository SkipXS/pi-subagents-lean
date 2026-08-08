import {
  AGENT_RENDER_DETAILS_KEY,
  type AgentCallRenderMetadata,
  parseAgentCallRenderMetadata,
} from "./agent-render-format.js";
import {
  AgentCallDetailsComponent,
  type PlaintextComponent,
} from "./agent-render-text.js";

export const AGENT_RENDER_VERSION_KEY = `${AGENT_RENDER_DETAILS_KEY}:version`;
export const AGENT_RENDER_CALL_VERSION_KEY = `${AGENT_RENDER_DETAILS_KEY}:call-version`;

/** The row-local renderer context needed by the static Agent renderer. */
export interface AgentRendererContext {
  args: unknown;
  state: Record<string, unknown>;
  lastComponent: PlaintextComponent | undefined;
  invalidate: () => void;
}

export interface AgentRendererState {
  metadata?: AgentCallRenderMetadata;
  version: number;
  callVersion: number;
}

/** Read persisted row state without trusting arbitrary restored values. */
export function getAgentRendererState(context: AgentRendererContext): AgentRendererState {
  const state = context.state;
  const stored = parseAgentCallRenderMetadata(state[AGENT_RENDER_DETAILS_KEY]);
  const versionValue = state[AGENT_RENDER_VERSION_KEY];
  const callVersionValue = state[AGENT_RENDER_CALL_VERSION_KEY];
  return {
    metadata: stored,
    version: typeof versionValue === "number" && Number.isSafeInteger(versionValue) ? versionValue : 0,
    callVersion: typeof callVersionValue === "number" && Number.isSafeInteger(callVersionValue)
      ? callVersionValue
      : -1,
  };
}

/** Persist row-local state defensively for direct/headless callers. */
export function persistAgentRendererState(
  context: AgentRendererContext,
  state: AgentRendererState,
): void {
  // Pi supplies a mutable row-local object. Keep this helper defensive for
  // direct/headless callers that pass an unusual context object.
  try {
    if (state.metadata) context.state[AGENT_RENDER_DETAILS_KEY] = state.metadata;
    context.state[AGENT_RENDER_VERSION_KEY] = state.version;
    context.state[AGENT_RENDER_CALL_VERSION_KEY] = state.callVersion;
  } catch {
    // Rendering must never make an otherwise valid Agent result fail.
  }
}

/** Render a call row while keeping metadata hydration in one place. */
export function renderCallWithFormatter(
  args: unknown,
  context: AgentRendererContext,
  format: (metadata: Partial<AgentCallRenderMetadata> | undefined, args: unknown) => string,
): PlaintextComponent {
  const state = getAgentRendererState(context);
  const component = context.lastComponent instanceof AgentCallDetailsComponent
    ? context.lastComponent
    : new AgentCallDetailsComponent();

  component.setText(format(state.metadata, args));

  // Remember which metadata generation was rendered by the call slot. This is
  // used only to make synchronous invalidate implementations idempotent.
  state.callVersion = state.version;
  persistAgentRendererState(context, state);
  return component;
}
