/**
 * agent-manager.ts — Tracks agents, global concurrency, background execution.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent-runner.js";
import { AgentOutputLog } from "./output-file.js";
import {
  type AgentRecord,
  type AgentHierarchy,
  type AgentStatus,
  type CompactionInfo,
  type CompactionReasonMetadata,
  type RunCallbacks,
  type StopInitiator,
  SHORT_ID_LENGTH,
  type SpawnConfig,
  type ToolActivity,
} from "../types.js";
import { resolveTypeInCatalog, snapshotAgentConfig, snapshotRegisteredAgentCatalog } from "./agent-types.js";
import { getEffectiveMaxChildAgents, type AgentConfig, type SubagentType } from "./types.js";
import {
  addUsage,
  createContextStats,
  getLifetimeTotal,
  getSessionUsageSnapshot,
  observeContextStats,
  readSessionContextUsage,
  type AgentUsage,
  type SessionStatsContextUsage,
} from "./usage.js";
import { errorMessage } from "../utils.js";
import { getSubagentRuntimeContext, type NestedAgentExecutor } from "../shell.js";
import type { SubagentRuntimeSettings } from "../config/config-store.js";

/** How often to check for expired agent records (milliseconds). */
const CLEANUP_INTERVAL_MS = 60_000;

/** Age after which a completed agent record is evicted (milliseconds). Default: 10 min. */
const DEFAULT_RETENTION_MINUTES = 10;

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;

/** Detach all mutable config fields before retaining a worktree catalog. */
function snapshotAgentCatalog(catalog?: ReadonlyMap<string, AgentConfig>): ReadonlyMap<string, AgentConfig> | undefined {
  if (!catalog) return undefined;
  return new Map([...catalog].map(([name, config]) => [name, snapshotAgentConfig(config)]));
}

/** Default global concurrency limit when not specified in config. */
const DEFAULT_CONCURRENCY_LIMIT = 4;

/** Nested execution is permanently limited to root children and their children. */
const HARD_MAX_NESTING_DEPTH = 2;

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

/** Configuration for the global concurrency limit. */
export interface ConcurrencyConfig {
  default: number;
}

export type OnAgentComplete = (record: AgentRecord) => void;
/**
 * Internal records always carry the hierarchy projection; public AgentRecord
 * remains compatible with records created before nested delegation.
 */
type ManagedAgentRecord = AgentRecord & { hierarchy: AgentHierarchy };
/** Invoked immediately before a settled record is evicted. */
export type OnAgentEvicted = (record: AgentRecord) => void;
type OnAgentStart = (record: AgentRecord) => void;

/** Internal global concurrency state. */
interface ConcurrencySlot {
  limit: number;
  running: number;
}

/** Cheap identity of the live session state last used for record telemetry. */
interface SessionRevision {
  session: AgentSession;
  sessionManager: unknown;
  leafId: string | null | undefined;
  model: unknown;
  modelKey: string;
  thinkingLevel: unknown;
  autoCompactionEnabled: boolean | undefined;
}

/**
 * Manager-only nested execution state. AgentRecord is intentionally a mutable
 * UI projection, so no authorization, ownership, or slot decision may read it.
 */
interface NestedControl {
  id: string;
  depth: number;
  parentId?: string;
  childIds: Set<string>;
  waitingOnChildId?: string;
  delegateTo: readonly string[];
  maxChildAgents: number;
  agentCatalog: ReadonlyMap<string, AgentConfig>;
  slotOwnerId?: string;
  usesParentSlot: boolean;
  worktreePath?: string;
  worktreeLabel?: string;
  /** Parent cwd retained with the selected worktree for runner-boundary validation. */
  worktreeParentCwd?: string;
  /** Original path retained to detect a retargeted symlink at runner start. */
  worktreeSelectionPath?: string;
  status: AgentStatus;
  settled: boolean;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions extends SpawnConfig, RunCallbacks {
  isBackground?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Internal coordinator capability factory, invoked only after the manager assigns the parent ID. */
  nestedExecutorFactory?: (parentId: string) => NestedAgentExecutor;
  /** Detached settings captured by the coordinator before child ALS setup. */
  runtimeSettings?: SubagentRuntimeSettings;
}

/** Validated nested-spawn policy and catalog resolution owned by AgentManager. */
export type NestedSpawnPreflight =
  /** agentConfig is a detached copy; the manager never exposes its catalog or parent control. */
  | { ok: true; type: SubagentType; agentConfig: AgentConfig }
  | { ok: false; error: string };

/** Normalize the trusted configured cap without exceeding the runtime hard cap. */
function nestedDepthLimit(value: unknown): number {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(numberValue)) return HARD_MAX_NESTING_DEPTH;
  return Math.min(HARD_MAX_NESTING_DEPTH, Math.max(1, Math.floor(numberValue)));
}

/** Update the session-level cache hit rate retained for the UI. */
function updateCumulativeCacheHitRate(record: ManagedAgentRecord): void {
  const { lifetimeUsage, cacheRead } = record.stats;
  const promptTokens = lifetimeUsage.input + cacheRead + lifetimeUsage.cacheWrite;
  record.stats.latestCacheHitRate = promptTokens > 0
    ? (cacheRead / promptTokens) * 100
    : undefined;
}

export class AgentManager {
  private agents = new Map<string, ManagedAgentRecord>();
  /** Authoritative control ledger, deliberately separate from public records. */
  private nestedControls = new Map<string, NestedControl>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onRecordEvicted?: OnAgentEvicted;
  private onStart?: OnAgentStart;

  /** Session-level cumulative agent cost. Survives agent eviction. */
  private totalAgentCost = 0;

  /** Session-level cumulative accepted agent count. Survives agent eviction. */
  private totalAgentCount = 0;

  /** Retention cutoff in minutes for finished agents. Updated at runtime via setRetentionMinutes. */
  private retentionMinutes = DEFAULT_RETENTION_MINUTES;

  /** All agents share one concurrency slot, regardless of model. */
  private concurrencySlot: ConcurrencySlot;

  /** Queue of agents waiting to start, including completion for foreground waiters. */
  private queue: { id: string; args: SpawnArgs; resolve: (result: string) => void }[] = [];

  /** Parent-signal listeners, retained so they can be removed at terminal states. */
  private parentAbortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();

  /** One post-persistence context read may be queued per live session boundary. */
  private deferredContextSamples = new WeakMap<ManagedAgentRecord, AgentSession>();

  /** Last cheap session identity observed for each retained record. */
  private sessionRevisions = new Map<string, SessionRevision>();

  /** Root records whose slot is retained until their borrowed descendants settle. */
  private heldBorrowedSlots = new Set<string>();

  /** Trusted effective configured cap; nested callers cannot override it. */
  private maxNestingDepth: number;

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
    private bufferSize: number = 0,
    maxNestingDepth?: number,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.maxNestingDepth = nestedDepthLimit(maxNestingDepth);
    this.concurrencySlot = {
      limit: Math.max(1, concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT),
      running: 0,
    };

    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  /** Update the age cutoff for finished agent retention (minutes). Takes effect at the next cleanup tick. */
  setRetentionMinutes(minutes: number): void {
    this.retentionMinutes = Math.max(1, minutes);
  }

  /** Update the global concurrency limit and immediately drain the queue. */
  setConcurrency(config: ConcurrencyConfig): void {
    this.concurrencySlot.limit = Math.max(1, config.default);
    this.drainQueue();
  }

  /** Update the trusted configured nesting cap for subsequent nested spawns. */
  setMaxNestingDepth(depth: number): void {
    this.maxNestingDepth = nestedDepthLimit(depth);
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the global concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }
    return this.spawnInternal(pi, ctx, type, prompt, options);
  }

  /**
   * Start a foreground child under an existing parent. The child borrows the
   * parent's already-counted global slot, so nested work never consumes an
   * additional concurrency slot or waits behind unrelated queued work.
   */
  spawnNested(
    parentId: string,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Foreground policy is enforced here as well as in coordinator/tool input
    // validation so no alternate caller can create a background child.
    if (options.isBackground) throw new Error("Nested agents must run in the foreground");
    const preflight = this.preflightNested(parentId, type);
    if (!preflight.ok) throw new Error(preflight.error);
    // Ignore caller-provided child definitions, catalogs, and worktree. The
    // control ledger resolves all of them from the accepted parent snapshot.
    return this.spawnInternal(pi, ctx, preflight.type, prompt, {
      ...options,
      agentConfig: preflight.agentConfig,
    }, parentId);
  }

  /**
   * Validate every manager-owned nested-spawn constraint against the parent
   * record captured at root acceptance. Callers use this to prepare a child,
   * while spawnNested repeats it immediately before execution to prevent bypass.
   */
  preflightNested(
    parentId: string,
    requestedType: string,
  ): NestedSpawnPreflight {
    const parent = this.nestedControls.get(parentId);
    if (!parent || parent.status !== "running") {
      return { ok: false, error: "Nested agent parent is no longer running" };
    }
    if (parent.depth >= this.maxNestingDepth) {
      return { ok: false, error: "Maximum nesting depth reached" };
    }
    if (parent.maxChildAgents < 1 || parent.delegateTo.length === 0) {
      return { ok: false, error: "This agent is not permitted to delegate" };
    }

    const permittedRoles = parent.delegateTo
      .map((name) => resolveTypeInCatalog(parent.agentCatalog, name))
      .filter((name): name is string => name !== undefined);
    if (permittedRoles.length === 0) {
      return { ok: false, error: "This agent is not permitted to delegate" };
    }

    const type = resolveTypeInCatalog(parent.agentCatalog, requestedType.trim());
    if (!type || !parent.agentCatalog.has(type)) {
      return { ok: false, error: `Unknown agent type: ${requestedType || "(missing)"}` };
    }
    if (!permittedRoles.includes(type)) {
      return { ok: false, error: `Agent "${requestedType}" is not allowed. Allowed child agents: ${permittedRoles.join(", ")}` };
    }
    if ([...parent.childIds].some((id) => {
      const child = this.nestedControls.get(id);
      return child?.status === "running" || child?.status === "queued";
    })) {
      return { ok: false, error: "This agent already has an active child" };
    }
    if (parent.childIds.size >= parent.maxChildAgents) {
      return { ok: false, error: "Child-agent budget exhausted" };
    }
    // Never expose the private catalog's config object to a caller.
    return { ok: true, type, agentConfig: snapshotAgentConfig(parent.agentCatalog.get(type)!) };
  }

  private spawnInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
    parentId?: string,
  ): string {
    const parent = parentId ? this.nestedControls.get(parentId) : undefined;
    // spawnNested always preflights first; keep this invariant explicit for
    // alternate internal callers rather than falling back to public records.
    if (parentId && !parent) throw new Error("Nested agent parent is no longer running");
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const abortController = new AbortController();
    // Copy mutable frontmatter arrays before this request can sit in the queue.
    const frozenOptions: SpawnOptions = {
      ...options,
      agentConfig: options.agentConfig && snapshotAgentConfig(options.agentConfig),
      agentCatalog: snapshotAgentCatalog(options.agentCatalog),
    };
    const args: SpawnArgs = { pi, ctx, type, prompt, options: frozenOptions };

    // Nested foreground children borrow their parent's slot. Root agents use
    // the normal global queue, including all foreground/background variants.
    const queued = !parent && this.concurrencySlot.running >= this.concurrencySlot.limit;
    let resolveQueued: ((result: string) => void) | undefined;
    const queuedPromise = queued
      ? new Promise<string>((resolve) => { resolveQueued = resolve; })
      : undefined;

    const rootCatalog = snapshotAgentCatalog(frozenOptions.agentCatalog ?? snapshotRegisteredAgentCatalog())!;
    // Direct manager callers can omit agentConfig. Resolve the canonical role
    // and its config from the catalog captured at acceptance, not the mutable
    // registry that may change before a queued runner starts.
    const canonicalType = parent ? type : resolveTypeInCatalog(rootCatalog, type) ?? type;
    const resolvedConfig = parent
      ? parent.agentCatalog.get(canonicalType) ?? frozenOptions.agentConfig
      : frozenOptions.agentConfig ?? rootCatalog.get(canonicalType);
    const agentConfig = resolvedConfig && snapshotAgentConfig(resolvedConfig);
    // The queued runner receives a private copy, never a caller's nested
    // config object or the catalog entry itself.
    frozenOptions.agentConfig = agentConfig && snapshotAgentConfig(agentConfig);
    const maxChildAgents = getEffectiveMaxChildAgents(agentConfig ?? {
      delegateTo: [],
      maxChildAgents: undefined,
    });
    const control: NestedControl = {
      id,
      depth: parent ? parent.depth + 1 : 1,
      parentId: parent?.id,
      childIds: new Set(),
      delegateTo: [...(agentConfig?.delegateTo ?? [])],
      maxChildAgents,
      agentCatalog: parent ? snapshotAgentCatalog(parent.agentCatalog)! : rootCatalog,
      slotOwnerId: parent ? (parent.slotOwnerId ?? parent.id) : undefined,
      usesParentSlot: parent !== undefined,
      // Nested callers cannot escape the parent worktree, even when using the
      // manager directly rather than the tool/coordinator path.
      worktreePath: parent ? parent.worktreePath : frozenOptions.worktreePath,
      worktreeLabel: parent ? parent.worktreeLabel : frozenOptions.worktreeLabel,
      worktreeParentCwd: parent ? parent.worktreeParentCwd : frozenOptions.worktreeParentCwd,
      worktreeSelectionPath: parent ? parent.worktreeSelectionPath : frozenOptions.worktreeSelectionPath,
      status: queued ? "queued" : "running",
      settled: false,
    };
    const record: ManagedAgentRecord = {
      id,
      lifecycle: {
        status: control.status,
        startedAt: Date.now(),
        settled: false,
      },
      display: {
        type: canonicalType,
        description: options.description,
        invocation: options.invocation,
        worktreePath: control.worktreePath,
        worktreeLabel: control.worktreeLabel,
      },
      execution: {
        abortController,
        promise: queuedPromise,
      },
      hierarchy: {
        depth: control.depth,
        parentId: control.parentId,
        childIds: [],
        delegateTo: [...control.delegateTo],
        maxChildAgents: control.maxChildAgents,
        // This is UI compatibility only. The ledger owns the private catalog.
        agentCatalog: snapshotAgentCatalog(control.agentCatalog)!,
        slotOwnerId: control.slotOwnerId,
        usesParentSlot: control.usesParentSlot,
      },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        turnCount: 1,
        compactionCount: 0,
        cacheRead: 0,
        maxTurns: options.maxTurns,
        contextStats: createContextStats(),
        compactionReasons: [],
      },
    };
    this.agents.set(id, record);
    this.nestedControls.set(id, control);
    if (parent) {
      parent.childIds.add(id);
      parent.waitingOnChildId = id;
      this.syncHierarchy(this.agents.get(parent.id), parent);
    }

    // Add a queued entry before binding the parent signal: an already-aborted
    // signal must be able to remove and settle it immediately.
    if (queued) {
      this.queue.push({ id, args, resolve: resolveQueued! });
      this.bindParentAbortSignal(id, options.signal);
      this.totalAgentCount++;
      return id;
    }

    this.bindParentAbortSignal(id, options.signal);
    // AbortSignal does not dispatch a past abort event, so bindParentAbortSignal
    // stops an already-aborted parent synchronously. Do not start it afterwards.
    if (control.status !== "running") {
      // No runner was created to reach startAgent's completion handler. This
      // includes an already-aborted nested parent, so clear its waiting state.
      this.setSettled(record, control);
      this.clearParentWaitingChild(control);
      this.safeNotifyComplete(record);
      this.totalAgentCount++;
      return id;
    }

    // startAgent can throw — clean up record so callers don't see an orphan.
    // Count only after a synchronous start succeeds.
    try {
      this.startAgent(id, record, args, this.concurrencySlot);
    } catch (err) {
      if (!control.usesParentSlot) this.concurrencySlot.running--;
      if (parent) {
        parent.childIds.delete(id);
        if (parent.waitingOnChildId === id) parent.waitingOnChildId = undefined;
        this.syncHierarchy(this.agents.get(parent.id), parent);
      }
      this.clearParentAbortSignal(id);
      this.agents.delete(id);
      this.nestedControls.delete(id);
      this.drainQueue();
      throw err;
    }
    this.totalAgentCount++;
    return id;
  }

  /** Update the mutable UI projection without ever reading it for control. */
  private syncHierarchy(record: ManagedAgentRecord | undefined, control: NestedControl): void {
    if (!record) return;
    record.hierarchy = {
      depth: control.depth,
      parentId: control.parentId,
      childIds: [...control.childIds],
      waitingOnChildId: control.waitingOnChildId,
      delegateTo: [...control.delegateTo],
      maxChildAgents: control.maxChildAgents,
      agentCatalog: snapshotAgentCatalog(control.agentCatalog)!,
      slotOwnerId: control.slotOwnerId,
      usesParentSlot: control.usesParentSlot,
    };
  }

  private setStatus(record: ManagedAgentRecord, control: NestedControl, status: AgentStatus): void {
    control.status = status;
    record.lifecycle.status = status;
  }

  private setSettled(record: ManagedAgentRecord, control: NestedControl): void {
    control.settled = true;
    record.lifecycle.settled = true;
  }

  private clearParentWaitingChild(control: NestedControl): void {
    if (!control.parentId) return;
    const parent = this.nestedControls.get(control.parentId);
    if (!parent || parent.waitingOnChildId !== control.id) return;
    parent.waitingOnChildId = undefined;
    this.syncHierarchy(this.agents.get(parent.id), parent);
  }

  /**
   * Actually start an agent (called immediately or from queue drain).
   * The global slot's running count is incremented on start and decremented in finally.
   */
  private startAgent(
    id: string,
    record: ManagedAgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    concurrencySlot: ConcurrencySlot,
  ) {
    const control = this.nestedControls.get(id)!;
    if (!control.usesParentSlot) concurrencySlot.running++;

    this.setStatus(record, control, "running");
    record.lifecycle.startedAt = Date.now();

    // Output logs are optional telemetry. A filesystem failure must not prevent
    // the agent from running or hold a queue slot.
    try {
      record.execution.outputLog = new AgentOutputLog(id, prompt, undefined, this.bufferSize);
      record.display.outputFile = record.execution.outputLog.path;
    } catch { /* ignore output-log initialization failures */ }

    this.onStart?.(record);

    const promise = runAgent(ctx, record.display.type, prompt, {
      pi,
      agentId: id,
      nestingDepth: control.depth,
      agentConfig: options.agentConfig,
      nestedExecutor: options.nestedExecutorFactory?.(id),
      runtimeSettings: options.runtimeSettings,
      model: options.model,
      maxTurns: options.maxTurns,
      maxTokens: options.maxTokens,
      thinkingLevel: options.thinkingLevel,
      cwd: control.worktreePath,
      worktreeParentCwd: control.worktreeParentCwd,
      worktreeSelectionPath: control.worktreeSelectionPath,
      graceTurns: options.graceTurns,
      // The runner/runtime gets its own catalog projection; it must not gain a
      // mutable reference to the manager's authorization ledger.
      agentCatalog: snapshotAgentCatalog(control.agentCatalog),
      signal: record.execution.abortController!.signal,
      ...this.createRecordCallbacks(record, options),
      onTurnEnd: (turnCount) => {
        record.stats.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: options.onTextDelta,
      onSessionCreated: (session) => {
        // Shutdown can win the race with asynchronous session setup. Do not
        // retain or observe a late session for an evicted record.
        if (this.agents.get(record.id) !== record) {
          try { session.dispose(); } catch { /* stale setup cleanup is best-effort */ }
          return;
        }
        record.execution.session = session;
        // Capture one bounded initial sample so the widget and result details
        // never need to read a live session during their render paths. Later
        // samples are taken only at event boundaries.
        this.observeContext(record);
        // Flush any steers that arrived before the session was ready
        if (record.execution.pendingSteers?.length) {
          for (const msg of record.execution.pendingSteers) {
            session.steer(msg).catch(() => {
              // Steer is advisory — a failure here (e.g. session already aborting)
              // is fine; the user can re-send if needed.
            });
          }
          record.execution.pendingSteers = undefined;
        }
        // Attach output log stream to session
        if (record.execution.outputLog) {
          record.execution.outputLog.attach(session);
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, turnLimited }) => {
        // Don't overwrite status if externally stopped via abort()
        if (control.status !== "stopped") {
          this.setStatus(record, control, aborted ? "aborted" : turnLimited ? "turn_limited" : "completed");
        }
        record.result = responseText;
        // A shutdown may evict the record before a late runner resolution.
        // Do not restore execution handles for a record no longer owned here.
        if (this.agents.get(record.id) === record) record.execution.session = session;
        record.lifecycle.completedAt ??= Date.now();
        return responseText;
      })
      .catch((err) => {
        // A failed parent cannot retain an independently running child.
        for (const childId of control.childIds) {
          const child = this.agents.get(childId);
          if (child) this.stopAgent(child, "parent");
        }
        // Don't overwrite status if externally stopped via abort()
        if (control.status !== "stopped") {
          this.setStatus(record, control, "error");
        }
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        return "";
      })
      .finally(() => {
        // Session handles are not guaranteed to remain usable after completion,
        // so retain the footer values that terminal cards need before cleanup.
        // The shared observer always performs one final context/auth snapshot,
        // preserves a valid null-after-compaction sample, and synchronizes the
        // cheap revision tracker without walking history a second time.
        this.observeContext(record, true);

        // Finalize output log with final stats
        if (record.execution.outputLog) {
          try {
            record.execution.outputLog.finalize({
              turnCount: record.stats.turnCount ?? 0,
              toolUseCount: record.stats.toolUses,
              totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
              cost: record.stats.lifetimeUsage.cost,
            });
          } catch { /* ignore */ }
          record.execution.outputLog = undefined;
        }

        // The runner has now fully settled, including after a prior stop().
        // Retention may safely release its execution handles from this point.
        this.setSettled(record, control);
        this.clearParentWaitingChild(control);

        // A stopped parent can settle before its borrowed child has finished
        // observing cancellation. Retain its global slot until every descendant
        // has settled, then drain exactly once.
        const releasedSlot = control.usesParentSlot
          ? this.tryReleaseHeldOwnerSlot(record, concurrencySlot)
          : this.releaseOwnerSlotWhenDescendantsSettle(record, concurrencySlot);
        this.clearParentAbortSignal(id);

        this.safeNotifyComplete(record);
        if (releasedSlot) this.drainQueue();
      });

    record.execution.promise = promise;
    return promise;
  }

  /** Notify completion callback, ignoring any errors. */
  private safeNotifyComplete(record: AgentRecord): void {
    this.totalAgentCost += record.stats.lifetimeUsage.cost;
    try { this.onComplete?.(record); } catch { /* ignore */ }
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  /** Register cleanup for coordinator-owned state tied to retained records. */
  setOnRecordEvicted(cb: OnAgentEvicted): void {
    this.onRecordEvicted = cb;
  }

  /** Get the session-level cumulative agent cost. Survives agent eviction. */
  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  /** Get the session-level cumulative accepted agent count. Survives agent eviction. */
  getTotalAgentCount(): number {
    return this.totalAgentCount;
  }

  /**
   * Refresh telemetry for running sessions whose cheap identity changed.
   *
   * SessionManager.getLeafId() is an O(1) leaf-pointer read. Comparing it
   * (plus model/session metadata) lets the widget notice idle branch/model
   * switches without making an unchanged 80ms tick walk session history.
   * Returns whether a context/auth snapshot was taken.
   */
  refreshActiveSessions(): boolean {
    let refreshed = false;
    for (const [id, record] of this.agents) {
      const control = this.nestedControls.get(id);
      if (!control || control.status !== "running" || control.settled) continue;

      const session = record.execution.session;
      if (!session) {
        this.sessionRevisions.delete(id);
        continue;
      }

      const revision = this.readSessionRevision(session);
      const previous = this.sessionRevisions.get(id);
      if (!previous) {
        // onSessionCreated normally establishes this baseline after its
        // initial observation. Be defensive for lightweight session doubles
        // without repeating a full read on the first widget tick.
        this.sessionRevisions.set(id, revision);
        continue;
      }
      if (!this.sessionRevisionChanged(previous, revision)) continue;

      // Mark the revision before observing so a re-entrant widget update cannot
      // schedule a second read for the same switch.
      this.sessionRevisions.set(id, revision);
      // A normal assistant message queues its post-persistence sample. Let
      // that one coalesced read observe this newer leaf instead of sampling it
      // again from the widget cadence.
      if (this.deferredContextSamples.get(record) === session) continue;

      this.observeContext(record);
      refreshed = true;
    }
    return refreshed;
  }

  /** Read only cheap leaf/model identity; never walk the active branch. */
  private readSessionRevision(session: AgentSession): SessionRevision {
    let sessionManager: unknown;
    let leafId: string | null | undefined;
    try {
      const candidate = (session as unknown as {
        sessionManager?: { getLeafId?: () => string | null };
      }).sessionManager;
      sessionManager = candidate;
      const getLeafId = candidate?.getLeafId;
      if (typeof getLeafId === "function") leafId = getLeafId.call(candidate);
    } catch {
      // A disposed/legacy session may not expose a usable manager. Keep an
      // undefined leaf stable rather than falling back to a history read.
    }

    let model: unknown;
    try {
      const candidate = session as unknown as {
        model?: unknown;
        state?: { model?: unknown };
      };
      model = candidate.model ?? candidate.state?.model;
    } catch {
      model = undefined;
    }

    let provider: unknown;
    let modelId: unknown;
    let contextWindow: unknown;
    try {
      const candidate = model as { provider?: unknown; id?: unknown; contextWindow?: unknown } | undefined;
      provider = candidate?.provider;
      modelId = candidate?.id;
      contextWindow = candidate?.contextWindow;
    } catch {
      // Keep the object identity as the only model signal when a legacy model
      // getter is unavailable.
    }

    let thinkingLevel: unknown;
    let autoCompactionEnabled: boolean | undefined;
    try {
      thinkingLevel = (session as unknown as { thinkingLevel?: unknown }).thinkingLevel;
      const enabled = (session as unknown as { autoCompactionEnabled?: unknown }).autoCompactionEnabled;
      if (typeof enabled === "boolean") autoCompactionEnabled = enabled;
    } catch {
      // Optional compatibility fields are not required for leaf tracking.
    }

    const revisionPart = (value: unknown): string => {
      if (value === undefined) return "<undefined>";
      if (value === null) return "<null>";
      return String(value);
    };
    return {
      session,
      sessionManager,
      leafId,
      model,
      modelKey: [provider, modelId, contextWindow].map(revisionPart).join("\u0000"),
      thinkingLevel,
      autoCompactionEnabled,
    };
  }

  private sessionRevisionChanged(previous: SessionRevision, next: SessionRevision): boolean {
    return previous.session !== next.session
      || previous.sessionManager !== next.sessionManager
      || previous.leafId !== next.leafId
      || previous.model !== next.model
      || previous.modelKey !== next.modelKey
      || previous.thinkingLevel !== next.thinkingLevel
      || previous.autoCompactionEnabled !== next.autoCompactionEnabled;
  }

  /** Record one upstream context sample without touching billing totals. */
  private recordContextSample(
    record: ManagedAgentRecord,
    usage: SessionStatsContextUsage | undefined,
    skipUnchanged = false,
  ): void {
    if (!usage) return;
    const stats = record.stats.contextStats ??= createContextStats();
    if (skipUnchanged && stats.count > 0 && stats.current === usage.percent && stats.window === usage.contextWindow) {
      record.stats.contextPercent = stats.current;
      record.stats.contextWindow = stats.window;
      return;
    }
    observeContextStats(stats, usage);
    record.stats.contextPercent = stats.current;
    record.stats.contextWindow = stats.window;
  }

  /**
   * Persist non-billing context/auth fields alongside a sampled record.
   * `contextSampled` distinguishes a valid null-after-compaction sample from
   * a failed or unavailable context read, so an unavailable read cannot erase
   * the last known current value.
   */
  private persistContextSnapshot(
    record: ManagedAgentRecord,
    snapshot: ReturnType<typeof getSessionUsageSnapshot>,
    contextSampled: boolean,
  ): void {
    if (!snapshot) return;
    if (contextSampled) record.stats.contextPercent = snapshot.contextPercent;
    if (typeof snapshot.contextWindow === "number") {
      record.stats.contextWindow = snapshot.contextWindow;
    } else if (record.stats.contextStats?.window !== undefined) {
      record.stats.contextWindow = record.stats.contextStats.window;
    }
    if (typeof snapshot.autoCompactionEnabled === "boolean") {
      record.stats.autoCompactionEnabled = snapshot.autoCompactionEnabled;
    }
    if (typeof snapshot.usingSubscription === "boolean") {
      record.stats.usingSubscription = snapshot.usingSubscription;
    }
  }

  /** Capture the latest context/auth snapshot at a meaningful boundary. */
  private observeContext(record: ManagedAgentRecord, skipUnchanged = false): void {
    const session = record.execution.session;
    if (!session || this.agents.get(record.id) !== record) return;

    // A direct lifecycle observation supersedes a queued post-persistence
    // observation for this same session. The queued microtask will see the
    // missing marker and return without a duplicate history walk.
    if (this.deferredContextSamples.get(record) === session) {
      this.deferredContextSamples.delete(record);
    }

    try {
      const contextRead = readSessionContextUsage(session);
      if (!contextRead.failed) this.recordContextSample(record, contextRead.usage, skipUnchanged);
      // Pass the already-attempted value explicitly so this second helper call
      // cannot perform another branch walk. It still supplies model/auth
      // metadata when the context reader is unavailable or throws.
      const snapshot = getSessionUsageSnapshot(session, contextRead.usage);
      this.persistContextSnapshot(record, snapshot, !contextRead.failed && contextRead.usage !== undefined);
    } finally {
      // Keep the cheap baseline aligned with every initial, deferred,
      // compaction, idle-switch, and final observation.
      if (record.execution.session === session && this.agents.get(record.id) === record) {
        this.sessionRevisions.set(record.id, this.readSessionRevision(session));
      }
    }
  }

  /**
   * Re-read context after the upstream message_end handler has persisted the
   * assistant entry. The record/session guards make this safe across disposal,
   * eviction, and session replacement. Multiple callbacks in one synchronous
   * boundary share one queued read.
   */
  private deferContextSample(record: ManagedAgentRecord): void {
    const session = record.execution.session;
    if (!session) return;
    const pending = this.deferredContextSamples.get(record);
    if (pending === session) return;
    if (pending) this.deferredContextSamples.delete(record);
    this.deferredContextSamples.set(record, session);
    queueMicrotask(() => {
      if (this.deferredContextSamples.get(record) !== session) return;
      this.deferredContextSamples.delete(record);
      const current = this.agents.get(record.id);
      const control = this.nestedControls.get(record.id);
      if (current !== record || !control || control.settled || control.status !== "running") return;
      if (record.execution.session !== session) return;
      this.observeContext(record);
    });
  }

  /** Retain the reason and, when possible, the exact persisted compaction entry id. */
  private persistCompactionReason(record: ManagedAgentRecord, info: CompactionInfo): void {
    const metadata: CompactionReasonMetadata = {
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      ...(info.summary !== undefined ? { summary: info.summary } : {}),
      ...(info.firstKeptEntryId !== undefined ? { firstKeptEntryId: info.firstKeptEntryId } : {}),
    };

    try {
      // SessionManager appends the CompactionEntry before emitting compaction_end,
      // so the leaf is the exact entry without scanning the full active branch.
      const leaf = record.execution.session?.sessionManager?.getLeafEntry();
      if (
        leaf?.type === "compaction"
        && typeof leaf.id === "string"
        && leaf.tokensBefore === info.tokensBefore
        && (info.summary === undefined || leaf.summary === info.summary)
        && (info.firstKeptEntryId === undefined || leaf.firstKeptEntryId === info.firstKeptEntryId)
      ) {
        metadata.entryId = leaf.id;
      }
    } catch {
      // Older/lightweight session doubles may not expose a usable leaf entry.
      // Keep the identifying fields as a conservative fallback.
    }

    (record.stats.compactionReasons ??= []).push(metadata);
  }

  /**
   * Build common record-tracking callbacks shared by startAgent.
   * Updates the record's toolUses, lifetimeUsage, and compactionCount.
   * When options are provided, also forwards events to the caller.
   */
  private createRecordCallbacks(
    record: ManagedAgentRecord,
    options?: Pick<SpawnOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
  ): {
    onToolActivity: (activity: ToolActivity) => void;
    onAssistantUsage: (usage: AgentUsage) => void;
    onSupplementalUsage: (usage: AgentUsage) => void;
    onCompaction: (info: CompactionInfo) => void;
  } {
    return {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.stats.toolUses++;
        options?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.stats.lifetimeUsage, usage);
        record.stats.cacheRead += usage.cacheRead;
        updateCumulativeCacheHitRate(record);
        options?.onAssistantUsage?.(usage);
        // AgentSession emits message_end before SessionManager persistence.
        // Keep accounting and consumer callbacks synchronous, then take one
        // context-only sample once the event's persistence has run.
        this.deferContextSample(record);
      },
      // Compaction and tool-result usage contributes to the same session-level
      // usage totals displayed by the UI, including its cache hit rate.
      onSupplementalUsage: (usage) => {
        addUsage(record.stats.lifetimeUsage, usage);
        record.stats.cacheRead += usage.cacheRead;
        updateCumulativeCacheHitRate(record);
      },
      onCompaction: (info) => {
        record.stats.compactionCount++;
        this.persistCompactionReason(record, info);
        this.observeContext(record);
        options?.onCompaction?.(info);
      },
    };
  }

  /** True when a retained descendant still has runner work to settle. */
  private hasUnsettledDescendant(record: ManagedAgentRecord): boolean {
    const control = this.nestedControls.get(record.id);
    if (!control) return false;
    for (const childId of control.childIds) {
      const child = this.agents.get(childId);
      const childControl = this.nestedControls.get(childId);
      // Settled terminal children may be evicted by retention while their
      // parent is still running. An absent child therefore cannot retain the
      // parent's borrowed slot; active children are never eviction-eligible.
      if (child && childControl && (!childControl.settled || this.hasUnsettledDescendant(child))) return true;
    }
    return false;
  }

  /** Release a root-owned slot now, or retain it for an in-flight borrowed child. */
  private releaseOwnerSlotWhenDescendantsSettle(record: ManagedAgentRecord, slot: ConcurrencySlot): boolean {
    if (this.hasUnsettledDescendant(record)) {
      this.heldBorrowedSlots.add(record.id);
      return false;
    }
    slot.running--;
    return true;
  }

  /** A nested completion may be the final event needed to release its root's slot. */
  private tryReleaseHeldOwnerSlot(record: ManagedAgentRecord, slot: ConcurrencySlot): boolean {
    const control = this.nestedControls.get(record.id);
    const ownerId = control?.slotOwnerId;
    if (!ownerId || !this.heldBorrowedSlots.has(ownerId)) return false;
    const owner = this.agents.get(ownerId);
    const ownerControl = this.nestedControls.get(ownerId);
    if (!owner || !ownerControl?.settled || this.hasUnsettledDescendant(owner)) return false;
    this.heldBorrowedSlots.delete(ownerId);
    slot.running--;
    return true;
  }

  /** Start queued agents while global capacity is available. */
  private drainQueue() {
    const started = new Set<string>();
    for (const entry of this.queue) {
      if (this.concurrencySlot.running >= this.concurrencySlot.limit) break;
      const record = this.agents.get(entry.id);
      const control = this.nestedControls.get(entry.id);
      if (!record || !control || control.status !== "queued") continue;

      try {
        const promise = this.startAgent(entry.id, record, entry.args, this.concurrencySlot);
        promise.then(entry.resolve);
        started.add(entry.id);
      } catch (err) {
        // Late failure — surface on the record so the user can see it
        if (!control.usesParentSlot) this.concurrencySlot.running--;
        this.setStatus(record, control, "error");
        record.error = errorMessage(err);
        record.lifecycle.completedAt = Date.now();
        this.setSettled(record, control);
        entry.resolve("");
        started.add(entry.id);
        this.clearParentAbortSignal(entry.id);
        this.safeNotifyComplete(record);
      }
    }
    this.queue = this.queue.filter(e => !started.has(e.id));
  }


  /**
   * Send a steering message to a running agent.
   * If the session hasn't been created yet, the message is queued.
   */
  async steer(id: string, message: string): Promise<boolean> {
    const record = this.agents.get(id);
    const control = this.nestedControls.get(id);
    if (!record || control?.status !== "running") return false;

    if (!record.execution.session) {
      // Session not yet created — queue the steer
      if (!record.execution.pendingSteers) record.execution.pendingSteers = [];
      record.execution.pendingSteers.push(message);
      return true;
    }

    try {
      await record.execution.session.steer(message);
      return true;
    } catch {
      // steer failures are surfaced to the caller via the boolean return value
      return false;
    }
  }

  /** Bind a parent abort signal and retain its listener for explicit cleanup. */
  private bindParentAbortSignal(id: string, signal?: AbortSignal): void {
    if (!signal) return;

    const listener = () => this.abort(id, "parent");
    this.parentAbortListeners.set(id, { signal, listener });
    signal.addEventListener("abort", listener, { once: true });
    // AbortSignal does not invoke listeners added after it was aborted.
    if (signal.aborted && this.parentAbortListeners.has(id)) listener();
  }

  /** Remove the parent abort listener once an agent can no longer react to it. */
  private clearParentAbortSignal(id: string): void {
    const entry = this.parentAbortListeners.get(id);
    if (!entry) return;
    entry.signal.removeEventListener("abort", entry.listener);
    this.parentAbortListeners.delete(id);
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt,
    );
  }

  abort(id: string, stoppedBy?: StopInitiator): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    return this.stopAgent(record, stoppedBy);
  }

  /**
   * Stop an agent by aborting its session or removing it from the queue.
   * Returns true if the agent was stopped, false if it wasn't running/queued.
   */
  private stopAgent(record: ManagedAgentRecord, stoppedBy?: StopInitiator): boolean {
    const control = this.nestedControls.get(record.id);
    if (!control) return false;
    // A parent owns every descendant's lifetime. Stop descendants first so a
    // suspended foreground parent can never leave an orphaned child running.
    for (const childId of control.childIds) {
      const child = this.agents.get(childId);
      if (child) this.stopAgent(child, "parent");
    }
    const wasQueued = control.status === "queued";
    if (wasQueued) {
      const queuedEntry = this.queue.find(q => q.id === record.id);
      queuedEntry?.resolve("");
      this.queue = this.queue.filter(q => q.id !== record.id);
    } else if (control.status !== "running") {
      return false;
    } else {
      record.execution.abortController?.abort();
    }
    this.setStatus(record, control, "stopped");
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.completedAt = Date.now();
    // Queued work has no runner to settle. A running agent remains unsettled
    // until startAgent's finally block has observed the runner completion.
    if (wasQueued) {
      this.setSettled(record, control);
      this.clearParentWaitingChild(control);
    }
    this.clearParentAbortSignal(record.id);
    if (wasQueued) this.safeNotifyComplete(record);
    return true;
  }

  /** Release execution-only handles while preserving result, lifecycle, and display metadata. */
  private releaseExecution(record: ManagedAgentRecord): void {
    this.clearParentAbortSignal(record.id);
    try { record.execution.session?.dispose(); } catch { /* disposal must not strand other records */ }
    record.execution.session = undefined;
    record.execution.abortController = undefined;
    record.execution.promise = undefined;
    record.execution.pendingSteers = undefined;
    record.execution.outputLog = undefined;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: ManagedAgentRecord): void {
    try { this.onRecordEvicted?.(record); } catch { /* coordinator cleanup is best-effort */ }
    this.deferredContextSamples.delete(record);
    this.sessionRevisions.delete(id);
    this.releaseExecution(record);
    this.agents.delete(id);
    this.nestedControls.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - this.retentionMinutes * 60_000;
    for (const [id, record] of this.agents) {
      const control = this.nestedControls.get(id);
      if (!control || !isTerminalStatus(control.status)) continue;
      if ((record.lifecycle.completedAt ?? 0) >= cutoff) continue;
      // A stopped runner is terminal before runAgent settles. Never dispose its
      // session or promise early: it still owns the concurrency slot and may be
      // executing final callbacks.
      if (!control.settled || this.heldBorrowedSlots.has(id)) continue;
      // Retention is a hard bound on terminal result text and metadata. Delivery
      // failures remain retryable only until this configured cutoff.
      this.removeRecord(id, record);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    for (const entry of this.queue) entry.resolve("");
    this.queue = [];
    for (const id of [...this.parentAbortListeners.keys()]) this.clearParentAbortSignal(id);
    for (const [id, record] of this.agents) {
      // A session may not exist yet while setup is in progress. Abort the
      // controller as well so every active run is stopped during shutdown.
      record.execution.abortController?.abort();
      // Use the normal eviction path so coordinator-owned parent listeners and
      // maps cannot outlive a manager-only shutdown.
      this.removeRecord(id, record);
    }
    this.agents.clear();
    this.nestedControls.clear();
    this.sessionRevisions.clear();
    this.heldBorrowedSlots.clear();
  }
}
