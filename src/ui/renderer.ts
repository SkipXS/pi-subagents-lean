/**
 * renderer.ts — Rendering helpers for the Agent tool and subagent-result messages.
 *
 * Extracted from index.ts to separate display concerns from extension wiring.
 */

import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "./types.js";
import { buildStatsCells, formatStatsRow, formatThinkingTag, getAgentStatusDisplay, getDisplayName } from "./format.js";
import type { AgentStatus } from "../types.js";
import type { ContextStats } from "../agents/usage.js";

// ============================================================================
// Stats rendering helpers
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableFinite(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finiteNumber(value);
}

function contextStatsFromDetails(d: Record<string, unknown>): ContextStats | undefined {
  const nested = asRecord(d.contextStats);
  const hasFlattenedTelemetry = ["contextCurrent", "contextLastKnown", "contextPeak", "contextCount"]
    .some((key) => Object.prototype.hasOwnProperty.call(d, key));
  if (!nested && !hasFlattenedTelemetry) return undefined;
  const source = nested ?? d;
  const current = nullableFinite(source.current !== undefined ? source.current : d.contextCurrent);
  const lastKnown = nullableFinite(source.lastKnown !== undefined ? source.lastKnown : d.contextLastKnown);
  const peak = nullableFinite(source.peak !== undefined ? source.peak : d.contextPeak);
  const window = finiteNumber(source.window !== undefined ? source.window : d.contextWindow);
  const count = finiteNumber(source.count !== undefined ? source.count : d.contextCount);
  if (current === undefined && lastKnown === undefined && peak === undefined && window === undefined && count === undefined) return undefined;
  return {
    current: current ?? null,
    lastKnown: lastKnown ?? null,
    peak: peak ?? null,
    ...(window !== undefined ? { window } : {}),
    count: count ?? 0,
  };
}

function agentStatus(value: unknown): AgentStatus {
  switch (value) {
    case "running":
    case "queued":
    case "completed":
    case "turn_limited":
    case "stopped":
    case "error":
    case "aborted":
      return value;
    default:
      return "completed";
  }
}

/** Format agent display name with optional model and thinking level. */
export function agentNameLabel(d: Record<string, unknown>, theme: Theme): string {
  const typeName = getDisplayName(stringValue(d.type) || "");
  const modelName = typeof d.modelName === "string" && d.modelName.trim() ? d.modelName.trim() : undefined;
  const thinkingTag = formatThinkingTag(d.thinkingLevel);
  const label = [modelName, thinkingTag].filter((part): part is string => part !== undefined).join(" · ");
  return label ? `${theme.bold(typeName)} (${label})` : theme.bold(typeName);
}

/** Build the stats line for an agent result card. */
export function buildStatsLine(d: Record<string, unknown>, theme: Theme, showCost: boolean): string {
  const cells = buildStatsCells({
    toolUses: finiteNumber(d.toolUses) ?? 0,
    turnCount: finiteNumber(d.turnCount),
    maxTurns: finiteNumber(d.maxTurns),
    input: finiteNumber(d.input) ?? 0,
    output: finiteNumber(d.output) ?? 0,
    cacheRead: finiteNumber(d.cacheRead),
    cacheWrite: finiteNumber(d.cacheWrite),
    latestCacheHitRate: finiteNumber(d.latestCacheHitRate),
    contextPercent: nullableFinite(d.contextPercent),
    contextWindow: finiteNumber(d.contextWindow),
    compactionCount: finiteNumber(d.compactionCount ?? d.compactions),
    contextStats: contextStatsFromDetails(d),
    autoCompactionEnabled: typeof d.autoCompactionEnabled === "boolean" ? d.autoCompactionEnabled : undefined,
    cost: showCost ? finiteNumber(d.cost) : undefined,
    usingSubscription: showCost && typeof d.usingSubscription === "boolean" ? d.usingSubscription : undefined,
    durationMs: finiteNumber(d.durationMs),
  }, theme);
  return formatStatsRow(cells) ?? "";
}

// ============================================================================
// Agent tool renderers
// ============================================================================

/** Render the Agent tool call line (e.g., "▸ Agent (model)"). */
export function renderAgentToolCall(
  args: Record<string, unknown>,
  theme: Theme,
): Text {
  const typeName = getDisplayName((args.agent as string) || "");
  const label = typeName || "Agent";
  let text = `▸ ${theme.fg("accent", theme.bold(label))}`;

  const modelOverride = typeof args._modelOverride === "string" && args._modelOverride.trim()
    ? args._modelOverride.trim()
    : undefined;
  const thinkingTag = formatThinkingTag(args.thinking);
  const details = [modelOverride, thinkingTag].filter((part): part is string => part !== undefined).join(" · ");
  if (details) text += ` (${details})`;

  return new Text(text, 0, 0);
}

/** Render the Agent tool result — compact or expanded. */
export function renderAgentToolResult(
  result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
): Text {
  const { expanded } = options;
  const firstContent = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = firstContent?.type === "text" && typeof firstContent.text === "string" ? firstContent.text : "";
  const d = asRecord(result.details);
  const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const desc = stringValue(d?.description) || "";

  if (d && finiteNumber(d.turnCount) !== undefined) {
    const namePart = agentNameLabel(d, theme);
    const statsLine = buildStatsLine(d, theme, showCost);
    let lines = `${icon} ${namePart} · ${statsLine}\n  ${theme.fg("text", desc)}`;
    if (expanded && text) {
      lines += "\n" + text.split("\n").map(l => `  ${l}`).join("\n");
    }
    return new Text(lines, 0, 0);
  }

  // Minimal card — background spawns (no stats) use space placeholder
  const isBackground = text.includes("running in background") || text.includes("queued");
  const prefix = isBackground ? "  " : `${icon} `;
  if (desc) {
    return new Text(`${prefix}${theme.fg("text", desc)}`, 0, 0);
  }

  return new Text(`${prefix}${theme.fg("dim", text)}`, 0, 0);
}

// ============================================================================
// Message renderer — subagent-result (background agent completion)
// ============================================================================

/** Render a subagent-result message injected after background agent completion. */
export function renderSubagentResult(
  message: { content?: string; details?: Record<string, unknown> },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
): Container {
  const { expanded } = options;
  const d = asRecord(message.details);
  const text = typeof message.content === "string" ? message.content.trim() : "";

  const inner = new Container();
  inner.addChild(new Text(theme.fg("customMessageLabel", "Subagent Result"), 0, 0));
  inner.addChild(new Spacer(1));

  if (d && d.turnCount != null) {
    const status = agentStatus(d.status);
    const { icon, color } = getAgentStatusDisplay(status);
    const statusIcon = theme.fg(color, icon);

    const namePart = agentNameLabel(d, theme);
    const statsLine = buildStatsLine(d, theme, showCost);
    let headerLine = `${statusIcon} ${namePart} · ${statsLine}\n  ${theme.fg("text", stringValue(d.description) || "")}`;
    const outputFile = stringValue(d.outputFile);
    const worktreePath = stringValue(d.worktreePath);
    if (outputFile) {
      headerLine += `\n  ${theme.fg("dim", `output log: ${outputFile}`)}`;
    }
    if (worktreePath) {
      headerLine += `\n  ${theme.fg("dim", `worktree: ${worktreePath}`)}`;
    }
    inner.addChild(new Text(headerLine, 0, 0));

    if (expanded && text) {
      inner.addChild(new Spacer(1));
      inner.addChild(new Text(text.split("\n").map(l => `  ${l}`).join("\n"), 0, 0));
    }
  } else {
    inner.addChild(new Text(buildFallbackResultLine(d, text, theme), 0, 0));
  }

  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(inner);

  const outer = new Container();
  outer.addChild(new Spacer(1));
  outer.addChild(box);
  outer.addChild(new Spacer(1));
  return outer;
}

/** Build a fallback result line for subagent-result messages without stats. */
function buildFallbackResultLine(
  d: Record<string, unknown> | undefined,
  text: string,
  theme: Theme,
): string {
  const { icon, color } = getAgentStatusDisplay(agentStatus(d?.status));
  let line = theme.fg(color, icon);
  if (stringValue(d?.type)) {
    line += ` ${agentNameLabel(d!, theme)}`;
  }
  const desc = stringValue(d?.description);
  if (desc) line += `\n  ${theme.fg("text", desc)}`;
  const outputFile = stringValue(d?.outputFile);
  const worktreePath = stringValue(d?.worktreePath);
  if (outputFile) {
    line += `\n  ${theme.fg("dim", `output log: ${outputFile}`)}`;
  }
  if (worktreePath) {
    line += `\n  ${theme.fg("dim", `worktree: ${worktreePath}`)}`;
  }
  return line;
}
