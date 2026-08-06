/**
 * Renderer support for the public Agent tool.
 *
 * This module deliberately has no TUI-package dependency. Pi accepts any
 * structural component with render()/invalidate(), so the small component
 * below owns only the plaintext wrapping needed by this row.
 */

import type { AgentExecutionKind, AgentExecutionMode } from "../types.js";
import { formatExecutionLabels } from "./execution-display.js";
import { formatCost, formatTokens } from "./usage.js";

/**
 * Private result-details field used only by the Agent tool renderer.
 *
 * The field is deliberately namespaced and nested so that the public Agent
 * result details keep their existing shape while a restored tool row can
 * rebuild its display without process-global state.
 */
export const AGENT_RENDER_DETAILS_KEY = "__pi_subagents_lean_agent_render" as const;

/** Custom message type used for completed background-agent deliveries. */
export const SUBAGENT_RESULT_CUSTOM_TYPE = "subagent-result" as const;

/** Public tool names that have a custom agent-call renderer. */
export type AgentRenderToolName = "Agent" | "AgentContinue" | "StopAgent";
export type AgentControlRenderToolName = Exclude<AgentRenderToolName, "Agent">;

/** Metadata needed to render one Agent-family tool call. */
export interface AgentCallRenderMetadata {
  /** Canonical catalog key, not the caller's display-name alias. */
  role: string;
  /** Resolved provider/model id, for example `openai/gpt-4o`. */
  model?: string;
  /** Pi-normalized thinking level. */
  thinking?: string;
  /** The complete prompt passed to the agent, when the tool has one. */
  prompt: string;
  /** Canonical full root-agent id; absent on a new Agent row before acceptance. */
  agentId?: string;
  /** Execution display fields; omitted for StopAgent because stopping is not an execution. */
  mode?: AgentExecutionMode;
  kind?: AgentExecutionKind;
}

/** Pi's structural component contract, kept local to avoid a TUI import. */
export interface PlaintextComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** The subset of Pi's row-local renderer context used by this renderer. */
export interface AgentRendererContext {
  args: unknown;
  state: Record<string, unknown>;
  lastComponent: PlaintextComponent | undefined;
  invalidate: () => void;
}

interface AgentResultLike {
  content?: unknown;
  details?: unknown;
}

interface AgentMessageLike {
  content?: unknown;
  details?: unknown;
}

interface AgentRendererState {
  metadata?: AgentCallRenderMetadata;
  version: number;
  callVersion: number;
}

const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function graphemes(value: string): string[] {
  if (!graphemeSegmenter) return Array.from(value);
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

function graphemeWidth(grapheme: string): number {
  // Printable ASCII is always one cell. Treat every other grapheme cluster as
  // two cells: this intentionally overestimates combining-only and narrow
  // Unicode clusters, but never underestimates flags, keycaps, ZWJ emoji, or
  // East Asian characters. A conservative row is preferable to emitting a
  // line wider than Pi's viewport.
  return /^[\x20-\x7e]$/.test(grapheme) ? 1 : 2;
}

/** Calculate a conservative terminal-cell width for normal, ANSI-free text. */
export function visibleWidth(value: string): number {
  return graphemes(value).reduce((total, grapheme) => total + graphemeWidth(grapheme), 0);
}

/** Wrap without truncating, retaining every grapheme and explicit newline. */
function wrapPlaintext(value: string, width: number): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const lines: string[] = [];

  for (const logicalLine of value.split("\n")) {
    if (logicalLine.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;
    for (const grapheme of graphemes(logicalLine)) {
      const nextWidth = graphemeWidth(grapheme);
      if (line && lineWidth + nextWidth > safeWidth) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }
      line += grapheme;
      lineWidth += nextWidth;
    }
    lines.push(line);
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * Make arbitrary tool-controlled text safe for terminal output.
 *
 * Newline is retained only when it is the prompt's intentional line boundary;
 * every other C0/C1 control, ESC, and DEL becomes a visible \xNN/\t/\r form.
 * Escaping ESC also breaks OSC/CSI sequences, including 8-bit OSC/CSI forms.
 */
export function escapeTerminalText(value: string, preserveNewlines = false): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (preserveNewlines && codePoint === 0x0a) {
      escaped += "\n";
    } else if (codePoint === 0x09) {
      escaped += "\\t";
    } else if (codePoint === 0x0d) {
      escaped += "\\r";
    } else if (codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
      escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

/** A small stateful plaintext component with conservative Unicode wrapping. */
export class AgentCallDetailsComponent implements PlaintextComponent {
  private value = "";
  private cachedWidth: number | undefined;
  private cachedValue: string | undefined;
  private cachedLines: string[] | undefined;

  /** Update the component only when its content really changed. */
  setText(value: string): boolean {
    const safeValue = escapeTerminalText(value, true);
    if (this.value === safeValue) return false;
    this.value = safeValue;
    this.invalidate();
    return true;
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    if (this.cachedLines && this.cachedValue === this.value && this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }
    const lines = wrapPlaintext(this.value, safeWidth);
    this.cachedValue = this.value;
    this.cachedWidth = safeWidth;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedValue = undefined;
    this.cachedLines = undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const USAGE_DETAIL_KEYS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "latestCacheHitRate",
  "cost",
  "contextPercent",
  "contextWindow",
  "autoCompactionEnabled",
  "usingSubscription",
] as const;

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Format the compact usage footer shared by foreground results and background
 * completion messages. Details are untrusted because persisted tool results
 * can outlive the code that produced them.
 */
export function formatAgentUsageLine(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;

  try {
    if (!USAGE_DETAIL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(details, key))) {
      return undefined;
    }

    const input = nonNegativeFiniteNumber(details.input);
    const output = nonNegativeFiniteNumber(details.output);
    const cacheRead = nonNegativeFiniteNumber(details.cacheRead);
    const cacheWrite = nonNegativeFiniteNumber(details.cacheWrite);
    const latestCacheHitRate = nonNegativeFiniteNumber(details.latestCacheHitRate);
    const cost = nonNegativeFiniteNumber(details.cost);
    const contextPercent = details.contextPercent === null
      ? null
      : nonNegativeFiniteNumber(details.contextPercent);
    const contextWindow = nonNegativeFiniteNumber(details.contextWindow);
    const autoCompactionEnabled = details.autoCompactionEnabled === true;
    const usingSubscription = details.usingSubscription === true;

    // A malformed stats-shaped details object should be as harmless as a
    // details object without stats. Valid zeroes still count as stats because
    // buildAgentDetails intentionally exposes them for completed zero-cost
    // executions.
    const hasStatsValue = [
      input,
      output,
      cacheRead,
      cacheWrite,
      latestCacheHitRate,
      cost,
      contextPercent,
      contextWindow,
    ].some((value) => value !== undefined);
    if (!hasStatsValue) return undefined;

    const parts: string[] = [];
    if (input !== undefined && input > 0) parts.push(`↑${formatTokens(input)}`);
    if (output !== undefined && output > 0) parts.push(`↓${formatTokens(output)}`);
    if (cacheRead !== undefined && cacheRead > 0) parts.push(`R${formatTokens(cacheRead)}`);
    if (cacheWrite !== undefined && cacheWrite > 0) parts.push(`W${formatTokens(cacheWrite)}`);
    if ((cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0) {
      if (latestCacheHitRate !== undefined) parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
    }
    if ((cost !== undefined && cost > 0) || usingSubscription) {
      parts.push(`${formatCost(cost ?? 0)}${usingSubscription ? " (sub)" : ""}`);
    }

    const contextPercentText = contextPercent === null || contextPercent === undefined
      ? "?"
      : `${contextPercent.toFixed(1)}%`;
    const contextWindowText = contextWindow === undefined ? "?" : formatTokens(contextWindow);
    const autoIndicator = autoCompactionEnabled ? " (auto)" : "";
    parts.push(`${contextPercentText}/${contextWindowText}${autoIndicator}`);
    return parts.join(" ");
  } catch {
    return undefined;
  }
}

function metadataFromUnknown(value: unknown): AgentCallRenderMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const role = nonEmptyString(value.role);
  const prompt = typeof value.prompt === "string" ? value.prompt : undefined;
  if (!role || prompt === undefined) return undefined;

  return {
    role,
    ...(nonEmptyString(value.model) !== undefined ? { model: value.model as string } : {}),
    ...(nonEmptyString(value.thinking) !== undefined ? { thinking: value.thinking as string } : {}),
    prompt,
    ...(nonEmptyString(value.agentId) !== undefined ? { agentId: value.agentId as string } : {}),
    ...(value.mode === "foreground" || value.mode === "background" ? { mode: value.mode } : {}),
    ...(value.kind === "new" || value.kind === "continued" ? { kind: value.kind } : {}),
  };
}

function metadataEqual(a: AgentCallRenderMetadata | undefined, b: AgentCallRenderMetadata): boolean {
  return a?.role === b.role
    && a?.model === b.model
    && a?.thinking === b.thinking
    && a?.prompt === b.prompt
    && a?.agentId === b.agentId
    && a?.mode === b.mode
    && a?.kind === b.kind;
}

function stateFor(context: AgentRendererContext): AgentRendererState {
  const state = context.state;
  const stored = metadataFromUnknown(state[AGENT_RENDER_DETAILS_KEY]);
  const versionValue = state[`${AGENT_RENDER_DETAILS_KEY}:version`];
  const callVersionValue = state[`${AGENT_RENDER_DETAILS_KEY}:call-version`];
  return {
    metadata: stored,
    version: typeof versionValue === "number" && Number.isSafeInteger(versionValue) ? versionValue : 0,
    callVersion: typeof callVersionValue === "number" && Number.isSafeInteger(callVersionValue)
      ? callVersionValue
      : -1,
  };
}

function writeState(context: AgentRendererContext, state: AgentRendererState): void {
  // Pi supplies a mutable row-local object. Keep this helper defensive for
  // direct/headless callers that pass an unusual context object.
  try {
    if (state.metadata) context.state[AGENT_RENDER_DETAILS_KEY] = state.metadata;
    context.state[`${AGENT_RENDER_DETAILS_KEY}:version`] = state.version;
    context.state[`${AGENT_RENDER_DETAILS_KEY}:call-version`] = state.callVersion;
  } catch {
    // Rendering must never make an otherwise valid Agent result fail.
  }
}

function mergeMetadata(
  previous: AgentCallRenderMetadata | undefined,
  incoming: AgentCallRenderMetadata,
): AgentCallRenderMetadata {
  return {
    role: incoming.role || previous?.role || "—",
    model: incoming.model ?? previous?.model,
    thinking: incoming.thinking ?? previous?.thinking,
    prompt: incoming.prompt ?? previous?.prompt ?? "",
    ...(incoming.agentId ?? previous?.agentId
      ? { agentId: incoming.agentId ?? previous?.agentId }
      : {}),
    ...(incoming.mode ?? previous?.mode ? { mode: incoming.mode ?? previous?.mode } : {}),
    ...(incoming.kind ?? previous?.kind ? { kind: incoming.kind ?? previous?.kind } : {}),
  };
}

/** Read renderer metadata from a tool result without trusting arbitrary details. */
export function getAgentCallRenderMetadata(details: unknown): AgentCallRenderMetadata | undefined {
  if (!isRecord(details)) return undefined;
  return metadataFromUnknown(details[AGENT_RENDER_DETAILS_KEY]);
}

/** Add renderer-only metadata while preserving every existing details field. */
export function withAgentCallRenderMetadata(
  details: Record<string, unknown> | undefined,
  metadata: AgentCallRenderMetadata,
): Record<string, unknown> {
  return {
    ...(details ?? {}),
    [AGENT_RENDER_DETAILS_KEY]: { ...metadata },
  };
}

/** Format the common Agent-family header in its stable field order. */
function formatAgentHeader(
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs: Record<string, unknown> | undefined,
  options: {
    includeRawAgentId: boolean;
    defaultMode?: AgentExecutionMode;
    defaultKind?: AgentExecutionKind;
  },
): string {
  const role = escapeTerminalText(metadata?.role || (nonEmptyString(rawArgs?.agent) ?? "—"));
  const requestedId = options.includeRawAgentId ? nonEmptyString(rawArgs?.agent_id) : undefined;
  const agentId = nonEmptyString(metadata?.agentId) ?? requestedId;
  const model = escapeTerminalText(metadata?.model || "—");
  const thinking = escapeTerminalText(metadata?.thinking || "—");
  const mode = metadata?.mode ?? (rawArgs?.run_in_background === true ? "background" : options.defaultMode);
  const kind = metadata?.kind ?? options.defaultKind;
  const fields = [
    `Role: ${role}`,
    ...(agentId !== undefined ? [`Agent ID: ${escapeTerminalText(agentId)}`] : []),
    `Model: ${model}`,
    `Thinking: ${thinking}`,
    formatExecutionLabels(mode, kind),
  ];
  return fields.join(" | ");
}

/** Build the Agent call header and complete prompt. */
export function formatAgentCallText(
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs?: unknown,
): string {
  const args = isRecord(rawArgs) ? rawArgs : undefined;
  const header = formatAgentHeader(metadata, args, {
    includeRawAgentId: false,
    defaultMode: "foreground",
    defaultKind: "new",
  });
  const prompt = escapeTerminalText(
    metadata?.prompt ?? (typeof args?.prompt === "string" ? args.prompt : ""),
    true,
  );
  return `${header}\n\nPrompt:\n${prompt}`;
}

/**
 * Build the shared control-tool header. The raw agent_id is deliberately used
 * until an executor resolves a prefix to the record's canonical full id.
 */
export function formatAgentControlCallText(
  toolName: AgentControlRenderToolName,
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs?: unknown,
): string {
  const args = isRecord(rawArgs) ? rawArgs : undefined;
  const header = formatAgentHeader(metadata, args, {
    includeRawAgentId: true,
    ...(toolName === "AgentContinue"
      ? { defaultMode: args?.run_in_background === true ? "background" : "foreground", defaultKind: "continued" }
      : {}),
  });
  const prompt = toolName === "AgentContinue"
    ? escapeTerminalText(
      metadata?.prompt ?? (typeof args?.prompt === "string" ? args.prompt : ""),
      true,
    )
    : "";
  const promptSection = toolName === "AgentContinue" ? `\n\nPrompt:\n${prompt}` : "";
  return `${header}${promptSection}`;
}

/** Convenience formatter for the AgentContinue row. */
export function formatAgentContinueCallText(
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs?: unknown,
): string {
  return formatAgentControlCallText("AgentContinue", metadata, rawArgs);
}

/** Convenience formatter for the StopAgent row. */
export function formatStopAgentCallText(
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs?: unknown,
): string {
  return formatAgentControlCallText("StopAgent", metadata, rawArgs);
}

function rendererState(context: AgentRendererContext): AgentRendererState {
  return stateFor(context);
}

function renderCallWithFormatter(
  args: unknown,
  context: AgentRendererContext,
  format: (metadata: Partial<AgentCallRenderMetadata> | undefined, args: unknown) => string,
): PlaintextComponent {
  const state = rendererState(context);
  const component = context.lastComponent instanceof AgentCallDetailsComponent
    ? context.lastComponent
    : new AgentCallDetailsComponent();
  component.setText(format(state.metadata, args));

  // Remember which metadata generation was rendered by the call slot. This is
  // used only to make synchronous invalidate implementations idempotent.
  state.callVersion = state.version;
  writeState(context, state);
  return component;
}

/** Render the Agent call header and complete prompt. */
export function renderAgentCall(
  args: unknown,
  _theme: unknown,
  context: AgentRendererContext,
): PlaintextComponent {
  return renderCallWithFormatter(args, context, formatAgentCallText);
}

/** Render either root control tool with the shared ID/role/model header. */
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

function textContent(content: unknown): string {
  if (typeof content === "string") return escapeTerminalText(content, true);
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => isRecord(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => escapeTerminalText(part.text as string, true))
    .join("\n");
}

function textResult(result: AgentResultLike): string {
  return textContent(result.content);
}

function resultTextWithUsage(
  text: string,
  details: unknown,
  completed: boolean,
): string {
  if (!completed) return text;
  const usage = formatAgentUsageLine(details);
  if (!usage) return text;
  if (text.length === 0) return usage;

  // Keep exactly one empty line between response content and the footer. A
  // response may already end in a newline, so normalize only that separator;
  // when no footer exists the original text is returned unchanged above.
  const content = text.replace(/\n+$/u, "");
  return content.length > 0 ? `${content}\n\n${usage}` : usage;
}

/** Render a completed background notification with the same result footer. */
export function renderSubagentResult(
  message: AgentMessageLike,
  _options: { expanded?: boolean; outputPad?: number },
  _theme: unknown,
): PlaintextComponent {
  const component = new AgentCallDetailsComponent();
  component.setText(resultTextWithUsage(textContent(message.content), message.details, true));
  return component;
}

/**
 * Hydrate row-local state from partial/final details and keep Pi's text result
 * rendering intact. The invalidate request is guarded by value equality, so a
 * repeated partial update or final hydration cannot trigger a loop.
 */
export function renderAgentResult(
  result: AgentResultLike,
  options: { expanded?: boolean; isPartial?: boolean },
  _theme: unknown,
  context: AgentRendererContext,
): PlaintextComponent {
  const safeResult = isRecord(result) ? result as AgentResultLike : {};
  const state = rendererState(context);
  const incoming = getAgentCallRenderMetadata(safeResult.details);
  let synchronouslyRedrawn = false;

  if (incoming) {
    const merged = mergeMetadata(state.metadata, incoming);
    if (!metadataEqual(state.metadata, merged)) {
      state.metadata = merged;
      state.version++;
      writeState(context, state);

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
        synchronouslyRedrawn = context.state[`${AGENT_RENDER_DETAILS_KEY}:call-version`] === state.version;
      } catch {
        // A renderer must remain safe when used by a minimal/headless caller.
      }
    }
  }

  if (synchronouslyRedrawn) return new AgentCallDetailsComponent();

  const component = context.lastComponent instanceof AgentCallDetailsComponent
    ? context.lastComponent
    : new AgentCallDetailsComponent();
  component.setText(resultTextWithUsage(
    textResult(safeResult),
    safeResult.details,
    options.isPartial !== true,
  ));
  return component;
}
