import type { AgentExecutionKind, AgentExecutionMode } from "../types.js";
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

/** Pis installed default working-loader animation, kept in lockstep with Pi/TUI. */
export const AGENT_WORKING_SPINNER_FRAMES = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
] as const;

/** Pi's installed default working-loader interval. */
export const AGENT_WORKING_SPINNER_INTERVAL_MS = 80;

export const AGENT_RENDER_VERSION_KEY = `${AGENT_RENDER_DETAILS_KEY}:version`;
export const AGENT_RENDER_CALL_VERSION_KEY = `${AGENT_RENDER_DETAILS_KEY}:call-version`;
const AGENT_RENDER_INDICATOR_KEY = `${AGENT_RENDER_DETAILS_KEY}:indicator`;

/** The subset of Pi's row-local renderer context used by this renderer. */
export interface AgentRendererContext {
  args: unknown;
  state: Record<string, unknown>;
  lastComponent: PlaintextComponent | undefined;
  invalidate: () => void;
  /** True only after Pi has actually started this tool execution. */
  executionStarted?: boolean;
  /** Whether Pi is still showing a partial/open result. */
  isPartial?: boolean;
  /** Pi's terminal error flag for the current result. */
  isError?: boolean;
}

export type AgentCallIndicator = "" | "working" | "success" | "error" | "background" | "queued";

export interface AgentRendererState {
  metadata?: AgentCallRenderMetadata;
  version: number;
  callVersion: number;
  indicator: AgentCallIndicator;
}

type AgentRendererCapability = "unknown" | "interactive" | "noninteractive";

export interface AgentRendererRuntime {
  callComponent?: AgentCallDetailsComponent;
  spinner?: AgentSpinnerController;
  animationDisabled: boolean;
  frameIndex: number;
  capability: AgentRendererCapability;
  probing: boolean;
}

const rendererRuntimes = new WeakMap<object, AgentRendererRuntime>();
const activeSpinnerControllers = new Set<AgentSpinnerController>();

/** Return the sole row-local runtime associated with a Pi state object. */
export function runtimeFor(context: AgentRendererContext): AgentRendererRuntime {
  const existing = rendererRuntimes.get(context.state);
  if (existing) return existing;
  const runtime: AgentRendererRuntime = {
    animationDisabled: false,
    frameIndex: 0,
    capability: "unknown",
    probing: false,
  };
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
  const indicator: AgentCallIndicator = indicatorValue === "working"
    || indicatorValue === "success"
    || indicatorValue === "error"
    || indicatorValue === "background"
    || indicatorValue === "queued"
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

/** Stop one row's timer and remove it from the active lifecycle set. */
function stopSpinner(context: AgentRendererContext, clearIndicator: boolean): void {
  const runtime = runtimeFor(context);
  runtime.spinner?.stop();
  runtime.spinner = undefined;
  if (!clearIndicator) return;

  const state = getAgentRendererState(context);
  if (state.indicator === "working") {
    state.indicator = "";
    persistAgentRendererState(context, state);
    runtime.callComponent?.setIndicator("");
  }
}

/** A row-local spinner whose only side effect is asking Pi to redraw the row. */
export class AgentSpinnerController {
  private timer: ReturnType<typeof setInterval> | undefined;
  context: AgentRendererContext;

  constructor(context: AgentRendererContext) {
    this.context = context;
  }

  updateContext(context: AgentRendererContext): void {
    this.context = context;
  }

  start(): void {
    if (this.timer !== undefined) return;
    activeSpinnerControllers.add(this);
    this.timer = setInterval(() => {
      const runtime = runtimeFor(this.context);
      if (runtime.spinner !== this) {
        this.stop();
        return;
      }
      runtime.frameIndex = (runtime.frameIndex + 1) % AGENT_WORKING_SPINNER_FRAMES.length;
      try {
        this.context.invalidate();
      } catch {
        // A detached/invalid row must not leave a process-live interval behind.
        const currentRuntime = runtimeFor(this.context);
        currentRuntime.animationDisabled = true;
        stopSpinner(this.context, true);
      }
    }, AGENT_WORKING_SPINNER_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    activeSpinnerControllers.delete(this);
  }
}

/** End every row-local animation during reload/shutdown. */
export function stopAgentRendererTimers(): void {
  for (const controller of [...activeSpinnerControllers]) {
    const context = controller.context;
    controller.stop();
    const runtime = runtimeFor(context);
    runtime.animationDisabled = true;
    if (runtime.spinner === controller) runtime.spinner = undefined;
    const state = getAgentRendererState(context);
    if (state.indicator === "working") {
      state.indicator = "";
      persistAgentRendererState(context, state);
      runtime.callComponent?.setIndicator("");
    }
  }
}

/**
 * Confirm that this is an interactive row before allowing a timer to start.
 * Pi's HTML renderer copies executionStarted/isPartial but its invalidate is a
 * no-op. A temporary call-version mismatch makes that difference observable:
 * only ToolExecutionComponent's synchronous invalidate reaches renderCall and
 * restores the marker before this call returns.
 */
export function establishRendererCapability(
  context: AgentRendererContext,
  state: AgentRendererState,
  runtime: AgentRendererRuntime,
): boolean {
  if (runtime.capability === "interactive") return true;
  if (runtime.capability === "noninteractive" || runtime.probing) return false;
  // Headless/direct callers do not expose Pi's lifecycle capability. They may
  // still render safely, but must not create a process-live animation.
  if (typeof context.executionStarted !== "boolean") return false;

  runtime.probing = true;
  const previousCallComponent = runtime.callComponent;
  const previousCallVersion = state.callVersion;
  const probeCallVersion = state.version === Number.MIN_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : state.version - 1;
  let synchronous = false;

  try {
    state.callVersion = probeCallVersion;
    persistAgentRendererState(context, state);
    context.invalidate();
    synchronous = getAgentRendererState(context).callVersion === state.version;
  } catch {
    // A no-op, detached, or headless invalidator is not an animation host.
  } finally {
    state.callVersion = previousCallVersion;
    persistAgentRendererState(context, state);
    // The probe can re-enter renderCall before the outer call has installed its
    // component. Restore the owner so that is not mistaken for replacement.
    runtime.callComponent = previousCallComponent;
    runtime.probing = false;
  }

  runtime.capability = synchronous ? "interactive" : "noninteractive";
  return synchronous;
}

export function executionMode(
  metadata: AgentCallRenderMetadata | undefined,
  rawArgs: unknown,
  defaultMode: AgentExecutionMode | undefined = "foreground",
): AgentExecutionMode | undefined {
  if (metadata?.mode !== undefined) return metadata.mode;
  if (isRecord(rawArgs) && rawArgs.run_in_background === true) return "background";
  return defaultMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isExecutionTool(
  toolName: AgentRenderToolName | undefined,
  metadata: AgentCallRenderMetadata | undefined,
  rawArgs: unknown,
): boolean {
  if (toolName !== undefined) return toolName !== "StopAgent";
  if (metadata?.kind === "new" || metadata?.kind === "continued") return true;
  if (!isRecord(rawArgs) || typeof rawArgs.prompt !== "string") return false;
  return typeof rawArgs.agent === "string" || typeof rawArgs.agent_id === "string";
}

function indicatorText(indicator: AgentCallIndicator, runtime: AgentRendererRuntime): string {
  switch (indicator) {
    case "working":
      return runtime.spinner
        ? (AGENT_WORKING_SPINNER_FRAMES[runtime.frameIndex] ?? AGENT_WORKING_SPINNER_FRAMES[0])
        : "";
    case "success":
      return "✓";
    case "error":
      return "✗";
    case "background":
      return "●";
    case "queued":
      return "◷";
    default:
      return "";
  }
}

export function canAnimateForeground(
  toolName: AgentRenderToolName,
  metadata: AgentCallRenderMetadata | undefined,
  rawArgs: unknown,
  context: AgentRendererContext,
  runtime: AgentRendererRuntime,
): boolean {
  return toolName !== "StopAgent"
    && executionMode(metadata, rawArgs) === "foreground"
    && context.executionStarted === true
    // An explicitly false value means the row is already terminal. Headless
    // callers may omit this Pi-only field, so undefined remains compatible.
    && context.isPartial !== false
    && runtime.capability === "interactive"
    && !runtime.animationDisabled;
}

/** Apply a row-local status marker and stop any obsolete spinner. */
export function setRowIndicator(
  context: AgentRendererContext,
  state: AgentRendererState,
  indicator: AgentCallIndicator,
): void {
  const runtime = runtimeFor(context);
  if (indicator === "working") {
    if (runtime.animationDisabled) return;
    const current = runtime.spinner;
    if (current) {
      current.updateContext(context);
    } else {
      runtime.frameIndex = 0;
      const spinner = new AgentSpinnerController(context);
      runtime.spinner = spinner;
      spinner.start();
    }
    if (state.indicator !== "working") {
      state.indicator = "working";
      state.version++;
      persistAgentRendererState(context, state);
    }
    runtime.callComponent?.setIndicator(indicatorText("working", runtime));
    return;
  }

  stopSpinner(context, false);
  if (state.indicator !== indicator) {
    state.indicator = indicator;
    state.version++;
    persistAgentRendererState(context, state);
  }
  runtime.callComponent?.setIndicator(indicatorText(indicator, runtime));
}

/** Resolve and apply the call-row marker before its text is rendered. */
export function callIndicator(
  toolName: AgentRenderToolName,
  args: unknown,
  context: AgentRendererContext,
  state: AgentRendererState,
  runtime: AgentRendererRuntime,
): string {
  const metadata = state.metadata;
  const mode = executionMode(metadata, args, toolName === "StopAgent" ? undefined : "foreground");

  if (state.indicator === "working" && mode === "background") {
    setRowIndicator(context, state, "background");
  } else if (
    state.indicator !== "success"
    && state.indicator !== "error"
    && state.indicator !== "background"
    && state.indicator !== "queued"
    && canAnimateForeground(toolName, metadata, args, context, runtime)
  ) {
    setRowIndicator(context, state, "working");
  } else if (state.indicator === "working" && !runtime.spinner) {
    // A lifecycle teardown or a failed invalidate can stop the interval while
    // this row is still referenced. Do not render a stale animated marker.
    state.indicator = "";
    persistAgentRendererState(context, state);
  }

  return indicatorText(state.indicator, runtime);
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
  establishRendererCapability(context, state, runtime);
  const component = context.lastComponent instanceof AgentCallDetailsComponent
    ? context.lastComponent
    : new AgentCallDetailsComponent();

  // A renderer component replacement is a lifecycle boundary for the old
  // animation. Never let the old row keep an interval after that switch.
  if (runtime.callComponent && runtime.callComponent !== component) {
    stopSpinner(context, true);
    runtime.animationDisabled = true;
  }
  runtime.callComponent = component;

  const marker = callIndicator(toolName, args, context, state, runtime);
  component.setIndicator(marker);
  component.setText(format(state.metadata, args));

  // Remember which metadata generation was rendered by the call slot. This is
  // used only to make synchronous invalidate implementations idempotent.
  state.callVersion = state.version;
  persistAgentRendererState(context, state);
  return component;
}
