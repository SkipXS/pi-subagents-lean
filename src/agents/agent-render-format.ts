import type { AgentExecutionKind, AgentExecutionMode } from "../types.js";
import { formatExecutionLabels } from "./execution-display.js";
import { escapeTerminalText } from "./agent-render-text.js";
import { formatCost, formatTokens } from "./usage.js";

/**
 * Private result-details field used only by the Agent tool renderer.
 *
 * The field is deliberately namespaced and nested so that the public Agent
 * result details keep their existing shape while a restored tool row can
 * rebuild its display without process-global state.
 */
export const AGENT_RENDER_DETAILS_KEY = "__pi_subagents_lean_agent_render" as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse untrusted persisted renderer metadata into the stable display shape. */
export function parseAgentCallRenderMetadata(value: unknown): AgentCallRenderMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const role = nonEmptyString(value.role);
  const prompt = typeof value.prompt === "string" ? value.prompt : undefined;
  if (!role || prompt === undefined) return undefined;

  const model = nonEmptyString(value.model);
  const thinking = nonEmptyString(value.thinking);
  const agentId = nonEmptyString(value.agentId);
  return {
    role,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    prompt,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(value.mode === "foreground" || value.mode === "background" ? { mode: value.mode } : {}),
    ...(value.kind === "new" || value.kind === "continued" ? { kind: value.kind } : {}),
  };
}

/** Compare metadata fields without considering object identity. */
export function agentCallRenderMetadataEqual(
  a: AgentCallRenderMetadata | undefined,
  b: AgentCallRenderMetadata,
): boolean {
  return a?.role === b.role
    && a?.model === b.model
    && a?.thinking === b.thinking
    && a?.prompt === b.prompt
    && a?.agentId === b.agentId
    && a?.mode === b.mode
    && a?.kind === b.kind;
}

/** Merge a partial resolution into the row's last authoritative metadata. */
export function mergeAgentCallRenderMetadata(
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
  return parseAgentCallRenderMetadata(details[AGENT_RENDER_DETAILS_KEY]);
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

/** Format arbitrary Agent result content as terminal-safe text. */
export function formatAgentContentText(content: unknown): string {
  if (typeof content === "string") return escapeTerminalText(content, true);
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => isRecord(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => escapeTerminalText(part.text as string, true))
    .join("\n");
}

/** Format Agent result content and append the completed usage footer when present. */
export function formatAgentResultText(
  content: unknown,
  details: unknown,
  completed: boolean,
): string {
  const text = formatAgentContentText(content);
  if (!completed) return text;
  const usage = formatAgentUsageLine(details);
  if (!usage) return text;
  if (text.length === 0) return usage;

  // Keep exactly one empty line between response content and the footer. A
  // response may already end in a newline, so normalize only that separator;
  // when no footer exists the original text is returned unchanged above.
  const normalizedContent = text.replace(/\n+$/u, "");
  return normalizedContent.length > 0 ? `${normalizedContent}\n\n${usage}` : usage;
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
