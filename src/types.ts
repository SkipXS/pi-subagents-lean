/**
 * Type definitions for the subagent system.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentOutputLog } from "./agents/output-file.js";
import type { ContextStats, LifetimeUsage, AgentUsage } from "./agents/usage.js";
import type { SubagentType, AgentInvocation } from "./agents/types.js";
export type { AgentConfig } from "./agents/types.js";

/** Thinking level for agent models (sourced from @earendil-works/pi-ai). */
export type ThinkingLevel = ModelThinkingLevel;

/** Tool activity event: start/end of a tool invocation. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface AgentRecord {
  id: string;
  /** Retained result projection; UTF-8 bounded at 64 KiB with `[TRUNCATED]`. */
  result?: string;
  /** Retained error projection; UTF-8 bounded at 8 KiB with `[TRUNCATED]`. */
  error?: string;
  /** Background-result handoff state; absent for foreground agents. */
  delivery?: BackgroundDelivery;
  /** Lifecycle state: status, timestamps. */
  lifecycle: AgentLifecycle;
  /** Display-oriented info: type, description, output file, invocation. */
  display: AgentDisplayInfo;
  /** Execution internals: session, abort controller, and output-log lifecycle. */
  execution: AgentExecutionState;
  /** Accumulated statistics: usage, context, and compactions. */
  stats: AgentAccumulatedStats;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

/** Streaming/callback surface shared by the runner and continuation turns. */
export interface RunCallbacks {
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onAssistantUsage?: (usage: AgentUsage) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

/** How many characters of agent ID to show in status output. */
export const SHORT_ID_LENGTH = 8;

/** Reason for a context compaction event. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** Info payload emitted when a session compacts successfully. */
export interface CompactionInfo {
  reason: CompactionReason;
  tokensBefore: number;
  /** Persisted summary identity, when supplied by the session event. */
  summary?: string;
  /** Persisted branch boundary identity, when supplied by the session event. */
  firstKeptEntryId?: string;
}

/** Reason metadata retained with an AgentRecord for execution diagnostics. */
export interface CompactionReasonMetadata {
  reason: CompactionReason;
  tokensBefore: number;
  summary?: string;
  firstKeptEntryId?: string;
  /** The active-branch CompactionEntry id, when it could be read after compaction. */
  entryId?: string;
}

// ---------------------------------------------------------------------------
// Sub-object interfaces for decomposed AgentRecord
// ---------------------------------------------------------------------------

/** Possible agent lifecycle statuses. */
export type AgentStatus = "queued" | "running" | "completed" | "aborted" | "stopped" | "error";

/** Who initiated an agent stop: a control tool, the agent, or its parent turn. */
export type StopInitiator = "user" | "agent" | "parent";

/** Background-result delivery state; `accepted` only means no synchronous throw, while `failed` records a diagnostic error until session shutdown. */
export type BackgroundDeliveryState = "pending" | "accepted" | "failed" | "abandoned";

/** Whether an execution runs in the foreground (awaited) or background (notification). */
export type AgentExecutionMode = "foreground" | "background";

/** Whether an execution starts a new session or continues an existing one. */
export type AgentExecutionKind = "new" | "continued";

/**
 * Per-execution summary retained on the record for each prompt execution on
 * an agent session (the initial spawn plus each AgentContinue execution). Each
 * entry carries its own generation (response text), delivery (text handed to
 * the caller), usage delta, and compaction data so continuation history stays
 * inspectable after the session is gone.
 */
export interface AgentExecutionSummary {
  /** Manager-assigned execution id; unique within the record. */
  id: string;
  /** Retained prompt projection, capped at 64 KiB UTF-8; active tasks may hold the full accepted input separately. */
  prompt: string;
  mode: AgentExecutionMode;
  /** Optional so records persisted before this field was introduced remain valid. */
  kind?: AgentExecutionKind;
  /** "queued" | "running" while active; terminal status after completion. */
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  /** Retained assistant text projection, UTF-8 bounded at 64 KiB. */
  responseText?: string;
  /** Retained caller-delivery projection, UTF-8 bounded at 64 KiB. */
  deliveredText?: string;
  /** Usage delta accumulated during this execution only. */
  usage?: AgentUsage;
  /** Compactions that occurred during this execution only. */
  compactionCount?: number;
  /** Retained terminal error projection, UTF-8 bounded at 8 KiB. */
  error?: string;
}

/** Payload-free failure projection retained on a record across delivery generations. */
export interface BackgroundDeliveryFailure {
  /** Execution whose automatic delivery failed. */
  executionId: string;
  attempts: number;
  lastAttemptAt?: number;
  /** UTF-8-bounded to 4 KiB; oversized values carry `[TRUNCATED]`. */
  lastError: string;
}

/** Delivery diagnostics retained with a background result while its record is retained. */
export interface BackgroundDelivery {
  state: BackgroundDeliveryState;
  /** Number of automatic sendMessage attempts; failed delivery is not retried. */
  attempts: number;
  lastAttemptAt?: number;
  /** UTF-8-bounded delivery diagnostic for the current/latest claim. */
  lastError?: string;
  /** Latest claim-ordered failure, including failures from older claims. */
  lastFailure?: BackgroundDeliveryFailure;
}

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager for lifecycle control and session lifetime.
 */
export interface AgentLifecycle {
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  stoppedBy?: StopInitiator;
  /**
   * Whether the result was delivered to the LLM, or has no remaining delivery
   * path (for example, its parent tool call was already aborted). This is
   * delivery telemetry only; it does not control the session-lifetime record.
   */
  resultConsumed?: boolean;
  /**
   * True only after all runner/queue work has settled. A stopped running agent is
   * terminal for status reporting before its runner has actually released its
   * session; session shutdown may release its handles immediately.
   */
  settled?: boolean;
}

/**
 * Record metadata: type name, description, output file, and invocation params.
 * Agent identity and output metadata retained for tool results and diagnostics.
 */
export interface AgentDisplayInfo {
  type: SubagentType;
  /** Retained description projection, UTF-8 bounded at 8 KiB. */
  description: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Resolved spawn params, captured for tool details. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Resolved absolute path of the worktree this agent is running in. */
  worktreePath?: string;
  /** Short display label for the worktree (e.g., "feature" or "feature/packages/web"). */
  worktreeLabel?: string;
}

/**
 * Execution internals: session handle, abort controller, and output-log lifecycle.
 */
export interface AgentExecutionState {
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Lifecycle wrapper for the output file stream. */
  outputLog?: AgentOutputLog;
}

/**
 * Accumulated usage and context statistics used by lifecycle tracking and tool
 * results.
 */
export interface AgentAccumulatedStats {
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite + cost (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Previous input token count for delta estimation (vLLM doesn't report cache hits). */
  /** Pi-style cumulative cache reads (each request's cache prefix is counted). */
  cacheRead: number;
  /** Cumulative cache hit rate for this agent session. Retains its legacy field name for compatibility. */
  latestCacheHitRate?: number;
  /** Final context/auth snapshot, retained after the live session is gone. */
  contextPercent?: number | null;
  contextWindow?: number;
  autoCompactionEnabled?: boolean;
  usingSubscription?: boolean;
  /** Context telemetry kept separate from cumulative billing usage. */
  contextStats?: ContextStats;
  /** Newest bounded compaction reasons; retained string fields are UTF-8-capped. */
  compactionReasons?: CompactionReasonMetadata[];
  /** Per-execution summaries: the initial run plus every AgentContinue execution. */
  executions?: AgentExecutionSummary[];
}


