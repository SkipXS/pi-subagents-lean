/**
 * Type definitions for the subagent system.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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
  /** Lifecycle state: status, timestamps. */
  lifecycle: AgentLifecycle;
  /** Display-oriented info: type, description, and invocation. */
  display: AgentDisplayInfo;
  /** Execution internals: session, abort controller, and caller promise. */
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
export type AgentLifecycleStatus = "queued" | "running" | "completed" | "aborted" | "stopped" | "error";

/** Whether an execution starts a new session or continues an existing one. */
export type AgentExecutionKind = "new" | "continued";

/**
 * Per-execution summary retained on the record for each prompt execution on
 * an agent session (the initial spawn plus each AgentContinue execution). Each
 * entry carries its own prompt, response projection, usage delta, and
 * compaction data so continuation history stays inspectable after the session
 * is gone.
 */
export interface AgentExecutionSummary {
  /** Manager-assigned execution id; unique within the record. */
  id: string;
  /** Retained prompt projection, capped at 64 KiB UTF-8; active tasks may hold the full accepted input separately. */
  prompt: string;
  /** Optional so records persisted before this field was introduced remain valid. */
  kind?: AgentExecutionKind;
  /** "queued" | "running" while active; terminal status after completion. */
  status: AgentLifecycleStatus;
  startedAt: number;
  completedAt?: number;
  /** Retained assistant text projection, UTF-8 bounded at 64 KiB. */
  responseText?: string;
  /** Usage delta accumulated during this execution only. */
  usage?: AgentUsage;
  /** Compactions that occurred during this execution only. */
  compactionCount?: number;
  /** Retained terminal error projection, UTF-8 bounded at 8 KiB. */
  error?: string;
}

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager for lifecycle control and session lifetime.
 */
export interface AgentLifecycle {
  status: AgentLifecycleStatus;
  startedAt: number;
  completedAt?: number;
  /** Parent cancellation is retained only to explain a stopped result. */
  stoppedBy?: "parent";
  /**
   * True only after all runner/queue work has settled. A stopped running agent is
   * terminal for status reporting before its runner has actually released its
   * session; session shutdown may release its handles immediately.
   */
  settled?: boolean;
}

/**
 * Record metadata: type name, description, and invocation params.
 * Agent identity and display metadata are retained for tool results and diagnostics.
 */
export interface AgentDisplayInfo {
  type: SubagentType;
  /** Retained description projection, UTF-8 bounded at 8 KiB. */
  description: string;
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
 * Execution internals: session handle, abort controller, and caller promise.
 */
export interface AgentExecutionState {
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
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


