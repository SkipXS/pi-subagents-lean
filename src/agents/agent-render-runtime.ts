import {
  AGENT_RENDER_DETAILS_KEY,
  type AgentCallRenderMetadata,
  type AgentRenderToolName,
  parseAgentCallRenderMetadata,
} from "./agent-render-format.js";
import {
  AgentCallDetailsComponent,
  type PlaintextComponent,
} from "./agent-render-text.js";

export const AGENT_RENDER_VERSION_KEY = `${AGENT_RENDER_DETAILS_KEY}:version`;
export const AGENT_RENDER_CALL_VERSION_KEY = `${AGENT_RENDER_DETAILS_KEY}:call-version`;
const AGENT_RENDER_INDICATOR_KEY = `${AGENT_RENDER_DETAILS_KEY}:indicator`;

/** The row-local renderer context needed by the static Agent renderer. */
export interface AgentRendererContext {
  args: unknown;
  state: Record<string, unknown>;
  lastComponent: PlaintextComponent | undefined;
  invalidate: () => void;
  /** Pi's terminal error flag for the current result. */
  isError?: boolean;
}

export type AgentCallIndicator = "" | "queued" | "success" | "error";

export interface AgentRendererState {
  metadata?: AgentCallRenderMetadata;
  version: number;
  callVersion: number;
  indicator: AgentCallIndicator;
}

export interface AgentRendererRuntime {
  callComponent?: AgentCallDetailsComponent;
}

const rendererRuntimes = new WeakMap<object, AgentRendererRuntime>();

/** Return the sole row-local runtime associated with a Pi state object. */
export function runtimeFor(context: AgentRendererContext): AgentRendererRuntime {
  const existing = rendererRuntimes.get(context.state);
  if (existing) return existing;
  const runtime: AgentRendererRuntime = {};
  rendererRuntimes.set(context.state, runtime);
  return runtime;
}

/** Read persisted row state without trusting arbitrary restored values. */
export function getAgentRendererState(context: AgentRendererContext): AgentRendererState {
  const state = context.state;
  const stored = parseAgentCallRenderMetadata(state[AGENT_RENDER_DETAILS_KEY]);
  const versionValue = state[AGENT_RENDER_VERSION_KEY];
  const callVersionValue = state[AGENT_RENDER_CALL_VERSION_KEY];
  const indicatorValue = state[AGENT_RENDER_INDICATOR_KEY];
  const indicator: AgentCallIndicator = indicatorValue === "queued"
    || indicatorValue === "success"
    || indicatorValue === "error"
    ? indicatorValue
    : "";
  return {
    metadata: stored,
    version: typeof versionValue === "number" && Number.isSafeInteger(versionValue) ? versionValue : 0,
    callVersion: typeof callVersionValue === "number" && Number.isSafeInteger(callVersionValue)
      ? callVersionValue
      : -1,
    indicator,
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
    context.state[AGENT_RENDER_INDICATOR_KEY] = state.indicator;
  } catch {
    // Rendering must never make an otherwise valid Agent result fail.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isExecutionTool(
  toolName: AgentRenderToolName | undefined,
  metadata: AgentCallRenderMetadata | undefined,
  rawArgs: unknown,
): boolean {
  if (toolName !== undefined) return toolName === "Agent" || toolName === "AgentContinue";
  if (metadata?.kind === "new" || metadata?.kind === "continued") return true;
  if (!isRecord(rawArgs) || typeof rawArgs.prompt !== "string") return false;
  return typeof rawArgs.agent === "string" || typeof rawArgs.agent_id === "string";
}

function indicatorText(indicator: AgentCallIndicator): string {
  switch (indicator) {
    case "success":
      return "✓";
    case "error":
      return "✗";
    case "queued":
      return "◷";
    default:
      return "";
  }
}

/** Apply an authoritative static status marker to the call row. */
export function setRowIndicator(
  context: AgentRendererContext,
  state: AgentRendererState,
  indicator: AgentCallIndicator,
): void {
  const runtime = runtimeFor(context);
  if (state.indicator !== indicator) {
    state.indicator = indicator;
    state.version++;
    persistAgentRendererState(context, state);
  }
  runtime.callComponent?.setIndicator(indicatorText(indicator));
}

/** Return the persisted static marker for the call row. */
function callIndicator(state: AgentRendererState): string {
  return indicatorText(state.indicator);
}

/** Render a call row while keeping component/runtime ownership in one place. */
export function renderCallWithFormatter(
  toolName: AgentRenderToolName,
  args: unknown,
  context: AgentRendererContext,
  format: (metadata: Partial<AgentCallRenderMetadata> | undefined, args: unknown) => string,
): PlaintextComponent {
  const state = getAgentRendererState(context);
  const runtime = runtimeFor(context);
  const component = context.lastComponent instanceof AgentCallDetailsComponent
    ? context.lastComponent
    : new AgentCallDetailsComponent();

  runtime.callComponent = component;

  const marker = callIndicator(state);
  component.setIndicator(marker);
  component.setText(format(state.metadata, args));

  // Remember which metadata generation was rendered by the call slot. This is
  // used only to make synchronous invalidate implementations idempotent.
  state.callVersion = state.version;
  persistAgentRendererState(context, state);
  return component;
}
