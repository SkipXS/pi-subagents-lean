/**
 * output-file.ts — Human-readable output logging for agent transcripts.
 *
 * Path: <system temp dir>/pi-agent-outputs/<agentId>.log
 * Append-only, human-readable, and can be followed with `tail -f` where available.
 * Lines: [USER], [TOOL], [ASSISTANT], [DONE] with ISO timestamps.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatCost, formatTokens } from "./usage.js";
import { summarizeToolArgs } from "../utils.js";


/** Format the [DONE] summary line with final usage stats. */
function formatDoneLine(stats: { totalTokens: number; cost: number }): string {
  const tokensStr = `${formatTokens(stats.totalTokens)} tokens`;
  const costStr = formatCost(stats.cost);
  return `${timestamp()} [DONE] ${tokensStr}, ${costStr}\n`;
}
/** Max content length for a full tool result log entry — longer results get a summary line. */
const MAX_TOOL_RESULT_DISPLAY_LENGTH = 500;

/** Get an ISO 8601 timestamp string suitable for log output. */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Create the output file path for an agent.
 * Default path: <system temp dir>/pi-agent-outputs/<agentId>.log
 * Ensures the parent directory exists with 0o700 permissions.
 *
 * @param baseDir - Optional base directory. Provided for testability;
 *                  production callers use the system temporary directory.
 */
export function createOutputFilePath(agentId: string, baseDir?: string): string {
  const dir = baseDir ?? join(tmpdir(), "pi-agent-outputs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${agentId}.log`);
}

/**
 * Write the initial user prompt entry to the output file.
 * Format: <ISO timestamp> [USER] <prompt>
 */
export function writeInitialEntry(
  path: string,
  prompt: string,
): void {
  const line = `${timestamp()} [USER] ${prompt}\n`;
  writeFileSync(path, line, "utf-8");
}

/**
 * Safe append — silently ignores write errors.
 * Used for best-effort output file writes that must never throw.
 */
function safeAppend(path: string, content: string): void {
  try { appendFileSync(path, content, "utf-8"); } catch { /* ignore write errors */ }
}

/** Split text into non-empty lines, prefixing each with a timestamp and role tag. */
function splitAndPrefix(text: string, role: string): string {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => `${timestamp()} [${role}] ${l}\n`)
    .join("");
}

/** Format a toolUse/toolCall content item as a single log line. */
function formatToolItem(item: Record<string, unknown>): string {
  const name = (item.name ?? item.toolName ?? "unknown") as string;
  // pi-ai ToolCall uses `arguments`, legacy/anthropic format uses `input`
  const rawArgs = (item.arguments ?? item.input) as Record<string, unknown> | undefined;
  const argsStr = summarizeToolArgs(name, rawArgs);
  return `${timestamp()} [TOOL] ${name}${argsStr}\n`;
}

/** Extract text from a user message's content (string or array of items). */
function extractUserText(content: string | ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => String(c.text ?? "")).join("\n");
  }
  return "";
}

/**
 * Format a tool result message as log line(s), truncating if content is too long.
 *
 * - If content length ≤ MAX_TOOL_RESULT_DISPLAY_LENGTH chars: each line is prefixed with [TOOL_RESULT]
 * - If content length > MAX_TOOL_RESULT_DISPLAY_LENGTH chars: single summary line `[TOOL_RESULT] <toolName>: <N> chars`
 */
function formatToolResult(toolName: string, content: ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (!content || !Array.isArray(content)) return "";

  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  if (text.length > MAX_TOOL_RESULT_DISPLAY_LENGTH) {
    return `${timestamp()} [TOOL_RESULT] ${toolName}: ${text.length} chars\n`;
  }

  if (!text.trim()) return "";

  return splitAndPrefix(text, "TOOL_RESULT");
}

/**
 * Format a single message content item as log lines.
 * Handles text, toolUse/toolCall, and thinking content.
 */
function formatMessageLine(
  role: "ASSISTANT" | "TOOL" | "USER",
  content: string | ReadonlyArray<Record<string, unknown>> | undefined,
): string {
  if (typeof content === "string") {
    return splitAndPrefix(content, role);
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item.type === "text" && typeof item.text === "string") {
          return splitAndPrefix(item.text, role);
        }
        if (item.type === "toolUse" || item.type === "toolCall") {
          return formatToolItem(item);
        }
        if (item.type === "thinking" && typeof item.thinking === "string") {
          const text = item.redacted ? "[redacted]" : item.thinking;
          return splitAndPrefix(text, "THINKING");
        }
        return "";
      })
      .join("");
  }

  return "";
}
/**
 * Subscribe to session events and flush new messages to the output file
 * when a session turn completes. Returns a cleanup function that writes the
 * DONE line and unsubscribes.
 *
 * The optional stats parameter provides final usage data for the DONE line.
 * `startIndex` selects the first session message still missing from the file;
 * continuation attaches reuse the current message count so earlier executions
 * are never rewritten.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  stats?: { totalTokens: number; cost: number },
  startIndex: number = 1,
): () => void {
  let writtenCount = startIndex; // initial user prompt (or prior executions) already written

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      if (msg.role === "assistant") {
        const lines = formatMessageLine("ASSISTANT", msg.content as any);
        if (lines) safeAppend(path, lines);
      } else if (msg.role === "user") {
        const text = extractUserText(msg.content as any);
        if (text.trim()) {
          safeAppend(path, `${timestamp()} [USER] ${text}\n`);
        }
      } else if (msg.role === "toolResult") {
        const msgAny = msg as unknown as Record<string, unknown>;
        const lines = formatToolResult(
          (msgAny.toolName ?? "unknown") as string,
          msgAny.content as ReadonlyArray<Record<string, unknown>> | undefined,
        );
        if (lines) safeAppend(path, lines);
      }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
  });

  return () => {
    // Final flush
    flush();

    // Write DONE line
    const doneStats = stats ?? { totalTokens: 0, cost: 0 };
    safeAppend(path, formatDoneLine(doneStats));

    // Unsubscribe from session events
    unsubscribe();
  };
}

// ---------------------------------------------------------------------------
//  AgentOutputLog — lifecycle wrapper for per-agent output streaming
// ---------------------------------------------------------------------------

/** Final usage stats written to the DONE line at agent completion. */
export interface OutputFinalStats {
  totalTokens: number;
  cost: number;
}

/**
 * Manages a single agent's output log lifecycle: create path → write initial
 * entry → attach session stream → finalize with stats → close.
 *
 * The manager holds one instance per agent. At spawn time the constructor
 * creates the file and writes the [USER] entry. When the session is ready,
 * `attach()` subscribes to streaming events. At completion, `finalize()`
 * flushes remaining messages, writes the [DONE] line, and unsubscribes.
 */
export class AgentOutputLog {
  readonly path: string;
  private cleanup?: () => void;
  private statsRef?: OutputFinalStats;

  constructor(agentId: string, prompt: string, baseDir?: string, append: boolean = false) {
    this.path = createOutputFilePath(agentId, baseDir);
    if (append) {
      // Continuation: reuse the existing file and append the new prompt.
      this.append(prompt);
    } else {
      writeInitialEntry(this.path, prompt);
    }
  }

  /**
   * Append a continuation's user prompt to the existing log file. Never
   * truncates: the file accumulates one [USER] entry per execution.
   */
  append(prompt: string): void {
    safeAppend(this.path, `${timestamp()} [USER] ${prompt}\n`);
  }

  /**
   * Subscribe to session events so messages stream to the output file.
   * Internally passes a mutable usage reference that `finalize()` populates
   * before the DONE line is written.
   *
   * `startIndex` is the first session message that still needs flushing;
   * continuation attaches pass the current message count so already-written
   * messages from earlier executions are not duplicated.
   */
  attach(session: AgentSession, startIndex: number = 1): void {
    this.statsRef = { totalTokens: 0, cost: 0 };
    this.cleanup = streamToOutputFile(session, this.path, this.statsRef, startIndex);
  }

  /**
   * Flush remaining messages, write the [DONE] line with final stats,
   * and unsubscribe from session events.
   *
   * Safe to call without a prior `attach()` — writes the DONE line only.
   */
  finalize(stats: OutputFinalStats): void {
    if (this.cleanup && this.statsRef) {
      // Populate the mutable stats ref so streamToOutputFile's cleanup
      // writes the actual final values to the DONE line.
      this.statsRef.totalTokens = stats.totalTokens;
      this.statsRef.cost = stats.cost;
      this.cleanup();
      this.cleanup = undefined;
      this.statsRef = undefined;
    } else {
      // No attach was called — write DONE directly
      safeAppend(this.path, formatDoneLine(stats));
    }
  }
}
