/**
 * output-file.ts — Human-readable output logging for agent transcripts.
 *
 * Path: <private system temp dir>/pi-subagents-outputs-<random>/<agentId>.log
 * Append-only, human-readable, and can be followed with `tail -f` where available.
 * Lines: [USER], [TOOL], [ASSISTANT], [DONE] with ISO timestamps.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatCost, formatTokens } from "./usage.js";
import { summarizeToolArgs } from "../utils.js";
import { resolveOutputFilePath } from "./output-log-store.js";
import {
  enqueueOutputDirectory,
  enqueueOutputWrite,
  whenOutputLogIdle,
} from "./output-log-writer.js";

// Keep the established facade exports available to existing callers.
export type {
  OutputPathCanonicalizer,
  OutputRootCleanupOptions,
  OutputRootCleanupResult,
} from "./output-log-store.js";
export {
  assertWindowsOpenedFileIdentity,
  cleanupOutputRoots,
  createOutputRoot,
  MAX_OUTPUT_ROOTS,
  MAX_OUTPUT_ROOT_RETENTION_BYTES,
  MAX_OUTPUT_ROOT_ENTRIES,
  MAX_OUTPUT_ROOT_DEPTH,
  MAX_OUTPUT_PARENT_ENTRIES,
  MAX_OUTPUT_GLOBAL_PASS_ENTRIES,
  MAX_OUTPUT_JANITOR_PASS_ENTRIES,
  MAX_OUTPUT_GLOBAL_ENTRIES,
  OUTPUT_ROOT_MAX_AGE_MS,
  OUTPUT_ROOT_PREFIX,
  releaseOutputRootIdentity,
  releaseOutputFileIdentities,
  scheduleOutputRootCleanup,
} from "./output-log-store.js";
export {
  MAX_OUTPUT_LOG_BYTES,
  MAX_OUTPUT_ROOT_BYTES,
  OUTPUT_LOG_MAX_BYTES,
  OUTPUT_ROOT_MAX_BYTES,
  OUTPUT_TRUNCATION_MARKER,
  getOutputLogAccounting,
  releaseOutputLogResources,
  releaseOutputRoot,
  whenOutputLogsIdle,
  whenOutputRootIdle,
  whenIdle,
} from "./output-log-writer.js";

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
 * Default path: <private system temp dir>/pi-subagents-outputs-<random>/<agentId>.log
 * Parent-directory creation is queued asynchronously and is best effort.
 *
 * @param baseDir - Optional already-selected root. Production callers pass the
 *                  private root owned by the parent session; tests may provide
 *                  an isolated fixture directory.
 */
export function createOutputFilePath(agentId: string, baseDir?: string): string {
  const path = resolveOutputFilePath(agentId, baseDir);
  // Keep path creation non-blocking while retaining the directory-creation
  // guarantee once the queue is allowed to drain.
  void enqueueOutputDirectory(path);
  return path;
}

/**
 * Write the initial user prompt entry to the output file.
 * Format: <ISO timestamp> [USER] <prompt>
 *
 * The returned promise is best effort and always resolves. Runtime callers do
 * not need to await it; tests or an explicit host shutdown flush may do so.
 */
export function writeInitialEntry(
  path: string,
  prompt: string,
): Promise<void> {
  const line = `${timestamp()} [USER] ${prompt}\n`;
  return enqueueOutputWrite(path, false, line);
}

/**
 * Safe append — silently ignores write errors. The shared path writer keeps
 * each complete log entry ordered without blocking the caller.
 */
function safeAppend(path: string, content: string): void {
  if (!content) return;
  void enqueueOutputWrite(path, true, content);
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
 * when a session turn completes. Returns an idempotent cleanup function that
 * queues the DONE line and unsubscribes.
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
  let cleanedUp = false;

  const flush = () => {
    try {
      const messages = session.messages;
      let content = "";
      while (writtenCount < messages.length) {
        const msg = messages[writtenCount];
        if (msg.role === "assistant") {
          content += formatMessageLine("ASSISTANT", msg.content as any);
        } else if (msg.role === "user") {
          const text = extractUserText(msg.content as any);
          if (text.trim()) {
            content += `${timestamp()} [USER] ${text}\n`;
          }
        } else if (msg.role === "toolResult") {
          const msgAny = msg as unknown as Record<string, unknown>;
          content += formatToolResult(
            (msgAny.toolName ?? "unknown") as string,
            msgAny.content as ReadonlyArray<Record<string, unknown>> | undefined,
          );
        }
        writtenCount++;
      }
      safeAppend(path, content);
    } catch {
      // A malformed/closed session must not affect the agent lifecycle.
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
  });

  return () => {
    if (cleanedUp) return;
    cleanedUp = true;

    try { unsubscribe(); } catch { /* session cleanup is best effort */ }

    // Queue the last message flush before the DONE entry. Both operations use
    // the path-shared writer, so a slow earlier turn cannot reorder them.
    flush();
    const doneStats = stats ?? { totalTokens: 0, cost: 0 };
    safeAppend(path, formatDoneLine(doneStats));
  };
}

// ---------------------------------------------------------------------------
//  AgentOutputLog — lifecycle wrapper for per-agent output streaming
// ---------------------------------------------------------------------------

/** Final usage stats written to the [DONE] line at agent completion. */
export interface OutputFinalStats {
  totalTokens: number;
  cost: number;
}

/**
 * Manages a single agent execution's output log lifecycle: create path → queue
 * initial entry → attach session stream → finalize with stats. All filesystem
 * work is asynchronous and best effort; lifecycle methods never wait for it.
 */
export class AgentOutputLog {
  readonly path: string;
  private cleanup?: () => void;
  private statsRef?: OutputFinalStats;
  private finalized = false;

  constructor(agentId: string, prompt: string, baseDir?: string, append: boolean = false) {
    this.path = createOutputFilePath(agentId, baseDir);
    if (append) {
      // Continuation: reuse the existing file and append the new prompt.
      this.append(prompt);
    } else {
      void writeInitialEntry(this.path, prompt);
    }
  }

  /**
   * Append a continuation's user prompt to the existing log file. Never
   * truncates: the file accumulates one [USER] entry per execution.
   */
  append(prompt: string): void {
    if (this.finalized) return;
    safeAppend(this.path, `${timestamp()} [USER] ${prompt}\n`);
  }

  /**
   * Subscribe to session events so messages stream to the output file.
   * `startIndex` is the first session message that still needs flushing;
   * continuation attaches pass the current message count so already-written
   * messages from earlier executions are not duplicated.
   */
  attach(session: AgentSession, startIndex: number = 1): void {
    if (this.finalized || this.cleanup) return;
    this.statsRef = { totalTokens: 0, cost: 0 };
    this.cleanup = streamToOutputFile(session, this.path, this.statsRef, startIndex);
  }

  /**
   * Flush remaining messages, write exactly one [DONE] line with final stats,
   * and unsubscribe from session events. Safe to call without a prior attach.
   * The method only queues work, so it never waits for a slow disk.
   */
  finalize(stats: OutputFinalStats): void {
    if (this.finalized) return;
    this.finalized = true;

    const cleanup = this.cleanup;
    const statsRef = this.statsRef;
    this.cleanup = undefined;
    this.statsRef = undefined;

    try {
      if (cleanup && statsRef) {
        statsRef.totalTokens = stats.totalTokens;
        statsRef.cost = stats.cost;
        cleanup();
      } else {
        safeAppend(this.path, formatDoneLine(stats));
      }
    } catch {
      // Logging must never block spawn/continue/stop or slot release.
    }
  }

  /** Wait for this path's queued writes without creating a retained idle writer. */
  whenIdle(): Promise<void> {
    return whenOutputLogIdle(this.path);
  }
}
