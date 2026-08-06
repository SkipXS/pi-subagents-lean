/**
 * output-file.ts — Human-readable output logging for agent transcripts.
 *
 * Path: <system temp dir>/pi-agent-outputs/<agentId>.log
 * Append-only, human-readable, and can be followed with `tail -f` where available.
 * Lines: [USER], [TOOL], [ASSISTANT], [DONE] with ISO timestamps.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
 * One append/write queue for one physical log path. Every operation catches its
 * own I/O failure so a broken log cannot poison later operations or the caller
 * that submitted them.
 */
class SerialLogWriter {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onIdle: () => void) {}

  enqueue(operation: () => Promise<void>): Promise<void> {
    this.pending++;
    const next = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await operation();
        } catch {
          // Output logs are optional best-effort telemetry.
        } finally {
          this.pending--;
        }
      });
    this.tail = next;
    // Retire only after this operation settles. A write queued before that
    // point increments pending and therefore keeps this exact writer alive.
    void next.then(() => this.retireIfIdle());
    return next;
  }

  whenIdle(): Promise<void> {
    return this.tail.catch(() => undefined);
  }

  isIdle(): boolean {
    return this.pending === 0;
  }

  private retireIfIdle(): void {
    if (this.pending === 0) this.onIdle();
  }
}

/** Writers are shared by path so separate execution wrappers cannot race. */
const writers = new Map<string, SerialLogWriter>();
let writerGeneration = 0;

function writerFor(path: string): SerialLogWriter {
  const key = resolve(path);
  let writer = writers.get(key);
  if (!writer) {
    let createdWriter: SerialLogWriter;
    createdWriter = new SerialLogWriter(() => {
      // Identity and idle checks prevent an old writer from deleting a newer
      // writer created for the same path after the old queue drained.
      if (createdWriter.isIdle() && writers.get(key) === createdWriter) {
        writers.delete(key);
      }
    });
    writer = createdWriter;
    writers.set(key, writer);
    writerGeneration++;
  }
  return writer;
}

/**
 * Queue one filesystem operation after creating the log directory. The promise
 * always resolves; callers can await it for deterministic tests without making
 * runtime logging failures observable to agent execution.
 */
function enqueueFileOperation(
  path: string,
  operation: () => Promise<void>,
): Promise<void> {
  return writerFor(path).enqueue(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await operation();
  });
}

/**
 * Wait for all output-log writes submitted so far. This is intentionally not
 * used by the agent manager's hot lifecycle paths; it exists for tests and
 * hosts that explicitly want to wait for best-effort telemetry.
 */
export async function whenOutputLogsIdle(): Promise<void> {
  // Capture currently queued writers, then re-check generation and pending
  // state so retirement/recreation cannot hide a write submitted while waiting.
  while (true) {
    const generation = writerGeneration;
    const snapshot = [...writers.values()];
    await Promise.all(snapshot.map((writer) => writer.whenIdle()));
    if (
      generation === writerGeneration
      && snapshot.every((writer) => writer.isIdle())
      && [...writers.values()].every((writer) => writer.isIdle())
    ) return;
  }
}

/** Short alias for explicit test/shutdown flushing. */
export function whenIdle(): Promise<void> {
  return whenOutputLogsIdle();
}

/**
 * Create the output file path for an agent.
 * Default path: <system temp dir>/pi-agent-outputs/<agentId>.log
 * Parent-directory creation is queued asynchronously and is best effort.
 *
 * @param baseDir - Optional base directory. Provided for testability;
 *                  production callers use the system temporary directory.
 */
export function createOutputFilePath(agentId: string, baseDir?: string): string {
  const dir = baseDir ?? join(tmpdir(), "pi-agent-outputs");
  const path = join(dir, `${agentId}.log`);
  // Keep path creation non-blocking while retaining the old directory-creation
  // guarantee once the queue is allowed to drain.
  void enqueueFileOperation(path, async () => undefined);
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
  return enqueueFileOperation(path, () => writeFile(path, line, "utf-8"));
}

/**
 * Safe append — silently ignores write errors. The shared path writer keeps
 * each complete log entry ordered without blocking the caller.
 */
function safeAppend(path: string, content: string): void {
  if (!content) return;
  void enqueueFileOperation(path, () => appendFile(path, content, "utf-8"));
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
    return writers.get(resolve(this.path))?.whenIdle() ?? Promise.resolve();
  }
}
