import type { AgentExecutionKind } from "../types.js";
import { escapeTerminalText } from "./agent-render-text.js";
import { formatCost, formatTokens } from "./usage.js";

/** Private result-details field used only by the Agent row renderer. */
export const AGENT_RENDER_DETAILS_KEY = "__pi_subagents_lean_agent_render" as const;

/** Public tool names with custom Agent-family row renderers. */
export type AgentRenderToolName = "Agent" | "AgentContinue";
export type AgentControlRenderToolName = "AgentContinue";

/** Metadata needed to render one Agent-family tool call. */
export interface AgentCallRenderMetadata {
  /** Canonical catalog key, not the caller's display-name alias. */
  role: string;
  /** Resolved provider/model id, for example `openai/gpt-4o`. */
  model?: string;
  /** Pi-normalized thinking level. */
  thinking?: string;
  /** Complete prompt passed to the child session. */
  prompt: string;
  /** Canonical full root-agent id; absent before Agent acceptance. */
  agentId?: string;
  /** Whether this execution starts a session or continues one. */
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
    ...(value.kind === "new" || value.kind === "continued" ? { kind: value.kind } : {}),
  };
}

export function agentCallRenderMetadataEqual(
  a: AgentCallRenderMetadata | undefined,
  b: AgentCallRenderMetadata,
): boolean {
  return a?.role === b.role
    && a?.model === b.model
    && a?.thinking === b.thinking
    && a?.prompt === b.prompt
    && a?.agentId === b.agentId
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
    ...(incoming.kind ?? previous?.kind
      ? { kind: incoming.kind ?? previous?.kind }
      : {}),
  };
}

export function getAgentCallRenderMetadata(details: unknown): AgentCallRenderMetadata | undefined {
  if (!isRecord(details)) return undefined;
  return parseAgentCallRenderMetadata(details[AGENT_RENDER_DETAILS_KEY]);
}

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

/** Format the compact usage line shared by completed foreground results. */
export function formatAgentUsageLine(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;

  try {
    if (!USAGE_DETAIL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(details, key))) return undefined;

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

export function formatAgentResultText(content: unknown, details: unknown, completed: boolean): string {
  const text = formatAgentContentText(content);
  if (!completed) return text;
  const usage = formatAgentUsageLine(details);
  if (!usage) return text;
  if (text.length === 0) return usage;
  const normalizedContent = text.replace(/\n+$/u, "");
  return normalizedContent.length > 0 ? `${normalizedContent}\n\n${usage}` : usage;
}

function formatRunLabel(kind: AgentExecutionKind | undefined): string {
  return `Run: ${kind === "continued" ? "Continued" : kind === "new" ? "New" : "—"}`;
}

function formatAgentHeader(
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs: Record<string, unknown> | undefined,
  options: { includeRawAgentId: boolean; defaultKind?: AgentExecutionKind },
): string {
  const role = escapeTerminalText(metadata?.role || (nonEmptyString(rawArgs?.agent) ?? "—"));
  const requestedId = options.includeRawAgentId ? nonEmptyString(rawArgs?.agent_id) : undefined;
  const agentId = nonEmptyString(metadata?.agentId) ?? requestedId;
  const model = escapeTerminalText(metadata?.model || "—");
  const thinking = escapeTerminalText(metadata?.thinking || "—");
  const kind = metadata?.kind ?? options.defaultKind;
  const fields = [
    `Role: ${role}`,
    ...(agentId !== undefined ? [`Agent ID: ${escapeTerminalText(agentId)}`] : []),
    `Model: ${model}`,
    `Thinking: ${thinking}`,
    formatRunLabel(kind),
  ];
  return fields.join(" | ");
}

export function formatAgentCallText(
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs?: unknown,
): string {
  const args = isRecord(rawArgs) ? rawArgs : undefined;
  const header = formatAgentHeader(metadata, args, {
    includeRawAgentId: false,
    defaultKind: "new",
  });
  const prompt = escapeTerminalText(
    metadata?.prompt ?? (typeof args?.prompt === "string" ? args.prompt : ""),
    true,
  );
  return `${header}\n\nPrompt:\n${prompt}`;
}

export function formatAgentControlCallText(
  _toolName: AgentControlRenderToolName,
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs?: unknown,
): string {
  const args = isRecord(rawArgs) ? rawArgs : undefined;
  const header = formatAgentHeader(metadata, args, {
    includeRawAgentId: true,
    defaultKind: "continued",
  });
  const prompt = escapeTerminalText(
    metadata?.prompt ?? (typeof args?.prompt === "string" ? args.prompt : ""),
    true,
  );
  return `${header}\n\nPrompt:\n${prompt}`;
}

export function formatAgentContinueCallText(
  metadata: Partial<AgentCallRenderMetadata> | undefined,
  rawArgs?: unknown,
): string {
  return formatAgentControlCallText("AgentContinue", metadata, rawArgs);
}
