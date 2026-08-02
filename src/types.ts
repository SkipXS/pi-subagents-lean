/**
 * Type definitions for the subagent system.
 */

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentOutputLog } from "./agents/output-file.js";
import type { ContextStats, LifetimeUsage, AgentUsage } from "./agents/usage.js";
import type { SubagentType, AgentInvocation, AgentConfig } from "./agents/types.js";
export type { AgentConfig } from "./agents/types.js";

/** Thinking level for agent models (sourced from @earendil-works/pi-ai). */
export type ThinkingLevel = ModelThinkingLevel;

/** Tool activity event: start/end of a tool invocation. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

/**
 * Resolved model + run-limit tunables shared by every spawn/run shape
 * (RunOptions, SpawnOptions, SpawnIntent). Add a tunable here once and it
 * flows through the whole chain.
 */
export interface RunTunables {
  model?: Model<any>;
  maxTurns?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  graceTurns?: number;
}

export interface AgentRecord {
  id: string;
  result?: string;
  error?: string;
  /** Background-result handoff state; absent for foreground agents. */
  delivery?: BackgroundDelivery;
  /** Lifecycle state: status, timestamps. */
  lifecycle: AgentLifecycle;
  /** Display-oriented info: type, description, output file, invocation. */
  display: AgentDisplayInfo;
  /** Execution internals: session, abort controller, pending steers. */
  execution: AgentExecutionState;
  /**
   * Parent/child ownership and slot-handoff metadata. Optional for source
   * compatibility with records created before nested delegation existed.
   */
  hierarchy?: AgentHierarchy;
  /** Accumulated statistics: usage, tool uses, turns. */
  stats: AgentAccumulatedStats;
}

/** Mutable UI hierarchy projection. AgentManager retains separate authoritative nested controls. */
export interface AgentHierarchy {
  /** First-level agents are depth 1; each nested generation increments it. */
  depth: number;
  parentId?: string;
  childIds: string[];
  /** Direct foreground child currently awaited by this parent, if any. */
  waitingOnChildId?: string;
  /** Captured parent frontmatter policy, unaffected by later registry refreshes. */
  delegateTo: string[];
  maxChildAgents: number;
  /** Catalog projection captured when this root invocation was accepted; not an authorization source. */
  agentCatalog: ReadonlyMap<string, AgentConfig>;
  /** Root record which owns this borrowed global concurrency slot. */
  slotOwnerId?: string;
  /** Child execution borrows an ancestor's existing global concurrency slot. */
  usesParentSlot?: boolean;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

/**
 * Streaming/callback surface shared by RunOptions and SpawnOptions.
 * Bridges agent-runner events to record tracking and live-view updates.
 */
export interface RunCallbacks {
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: AgentUsage) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

/**
 * Coordinator-side spawn config shared by SpawnOptions and SpawnIntent.
 * The resolved run params that both the manager and coordinator agree on;
 * extends RunTunables with display/identity fields.
 */
export interface SpawnConfig extends RunTunables {
  /** Detached definition resolved at selection/tool invocation time. */
  agentConfig?: AgentConfig;
  description: string;
  modelKey?: string;
  worktreePath?: string;
  worktreeLabel?: string;
  /** Parent repository cwd used to revalidate a selected worktree at runner start. */
  worktreeParentCwd?: string;
  /** Original selected path retained to detect a later symlink/path retarget. */
  worktreeSelectionPath?: string;
  /** Immutable full catalog captured for this invocation, including a trusted worktree overlay when selected. */
  agentCatalog?: ReadonlyMap<string, AgentConfig>;
  invocation?: AgentInvocation;
}

/** How many characters of agent ID to show in display. */
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

/** Reason metadata retained with an AgentRecord for conversation viewers. */
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
export type AgentStatus = "queued" | "running" | "completed" | "turn_limited" | "aborted" | "stopped" | "error";

/** Who initiated an agent stop: UI user, agent tool, or its parent turn. */
export type StopInitiator = "user" | "agent" | "parent";

/** Background-result delivery state. `accepted` only means Pi did not synchronously reject sendMessage. */
export type BackgroundDeliveryState = "pending" | "accepted" | "failed" | "abandoned";

/** Whether an execution runs in the foreground (awaited) or background (notification). */
export type AgentExecutionMode = "foreground" | "background";

/**
 * Per-execution summary retained on the record for every turn executed on an
 * agent session (the initial spawn plus each AgentContinue execution). Each
 * entry carries its own generation (response text), delivery (text handed to
 * the caller), usage delta, and turn count so continuation history stays
 * inspectable after the session is gone.
 */
export interface AgentExecutionSummary {
  /** Manager-assigned execution id; unique within the record. */
  id: string;
  /** Prompt that started this execution. */
  prompt: string;
  mode: AgentExecutionMode;
  /** "queued" | "running" while active; terminal status after completion. */
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  /** Assistant text generated during this execution (trimmed). */
  responseText?: string;
  /** Text delivered to the caller (foreground result or background notification). */
  deliveredText?: string;
  /** Usage delta accumulated during this execution only. */
  usage?: AgentUsage;
  /** Turns consumed by this execution only. */
  turnCount?: number;
  /** Tool uses accumulated during this execution only. */
  toolUses?: number;
  /** Compactions that occurred during this execution only. */
  compactionCount?: number;
  /** Terminal error for this execution, when failed. */
  error?: string;
}

/** Metadata retained with a background agent result for delivery retry and UI status. */
export interface BackgroundDelivery {
  state: BackgroundDeliveryState;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
}

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager (lifecycle control), menus (status display), widget (linger logic).
 */
export interface AgentLifecycle {
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  stoppedBy?: StopInitiator;
  /**
   * Whether the result was delivered to the LLM, or has no remaining delivery path
   * (for example, its parent tool call was already aborted). cleanup() preserves
   * terminal records until this is set so a background result isn't evicted before
   * its nudge can be delivered.
   */
  resultConsumed?: boolean;
  /**
   * True only after all runner/queue work has settled. A stopped running agent is
   * terminal for display purposes before its runner has actually released its
   * session, so retention must not release execution handles until this is true.
   */
  settled?: boolean;
}

/**
 * Display-oriented fields: type name, description, output file, invocation params.
 * Used by widget (rendering), menus (listing), renderer (display).
 */
export interface AgentDisplayInfo {
  type: SubagentType;
  description: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Resolved absolute path of the worktree this agent is running in. */
  worktreePath?: string;
  /** Short display label for the worktree (e.g., "feature" or "feature/packages/web"). */
  worktreeLabel?: string;
}

/**
 * Execution internals: session handle, abort controller, pending steers.
 * Used by agent-manager (session lifecycle), tool-execution (steering, nudge).
 */
export interface AgentExecutionState {
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Lifecycle wrapper for the output file stream. */
  outputLog?: AgentOutputLog;
}

/**
 * Accumulated statistics: usage breakdown, tool uses, turn count.
 * Used by widget (stats display), tool-execution (details building), menus (result viewer).
 */
export interface AgentAccumulatedStats {
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite + cost (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  toolUses: number;
  /** Final turn count (set on completion). Used by widget after activity cleanup. */
  turnCount?: number;
  /** Max turns limit (from invocation or default). */
  maxTurns?: number;
  /** Grace turns limit captured at spawn; continuations reuse it per execution. */
  graceTurns?: number;
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
  /** Compaction reasons retained for viewers opened after the event. */
  compactionReasons?: CompactionReasonMetadata[];
  /** Per-execution summaries: the initial run plus every AgentContinue execution. */
  executions?: AgentExecutionSummary[];
}


