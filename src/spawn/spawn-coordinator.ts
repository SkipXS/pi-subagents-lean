import { getPiInstance, getSessionCtx, getStore, getSubagentRuntimeContext, getWidget } from "../shell.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { normalizeThinkingLevel } from "../models/thinking.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, SpawnConfig, ToolActivity } from "../types.js";
import type { AgentConfig } from "../agents/types.js";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.js";
import type { SubagentRuntimeSettings } from "../config/config-store.js";
import { resolveTypeInCatalog, snapshotRegisteredAgentCatalog } from "../agents/agent-types.js";
import { buildAgentDetails, createNestedAgentExecutor, formatResultContent } from "../agents/tool-execution.js";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for both LLM tool and menu spawn paths. Owns live display
 * state and background-result delivery; AgentManager owns execution and records.
 */

/** Coordinator-owned per-agent live display state. Only transient UI state. */
export interface LiveView {
  activeTools: Map<string, string>;
  responseText: string;
}

/** Input for spawn(). Built by each caller from its own validation. */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /** Parent abort signal forwarded to the agent manager. */
  signal?: AbortSignal;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
  /** Root mode/settings snapshot captured by callers that resolve fields before entering the coordinator. */
  runtimeSettingsSnapshot?: SubagentRuntimeSettings;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
}

/** Batch delay for automatic background-result delivery (ms). */
const NUDGE_DELAY_MS = 200;

type DeliverySource = "auto" | "manual";

/** Copy array-valued fields so queued work cannot observe later config mutation. */
function snapshotAgentConfig(config: AgentConfig | undefined): AgentConfig | undefined {
  if (!config) return undefined;
  return {
    ...config,
    registeredTools: config.registeredTools && [...config.registeredTools],
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    excludeTools: config.excludeTools && [...config.excludeTools],
    extensions: Array.isArray(config.extensions) ? [...config.extensions] : config.extensions,
    excludeExtensions: config.excludeExtensions && [...config.excludeExtensions],
    skills: Array.isArray(config.skills) ? [...config.skills] : config.skills,
    preloadSkills: Array.isArray(config.preloadSkills) ? [...config.preloadSkills] : config.preloadSkills,
    delegateTo: config.delegateTo && [...config.delegateTo],
  };
}

function isTerminal(record: AgentRecord): boolean {
  return record.lifecycle.status !== "running" && record.lifecycle.status !== "queued";
}

function deliveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SpawnCoordinator {
  /** Per-agent live display state. Widget reads from here + record for stats. */
  private liveViews = new Map<string, LiveView>();

  /** Monotonic key prevents same-tool starts in the same clock tick from colliding. */
  private nextActivityId = 0;

  /** Background agents that have not yet completed. */
  private backgroundAgentIds = new Set<string>();

  /** Parent cancellation listeners retained until delivery is accepted or abandoned. */
  private backgroundParentAborts = new Map<string, { signal: AbortSignal; listener: () => void }>();

  /** Pending automatic delivery IDs, batched within the delay window. */
  private pendingNudges = new Set<string>();

  /** IDs that already received their one automatic completion delivery attempt. */
  private autoNudgeIssued = new Set<string>();

  /** Guards synchronous/reentrant delivery calls so no attempt can be duplicated. */
  private deliveryInProgress = new Set<string>();

  /** Active automatic-delivery timer. */
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to prevent delivery through a stale Pi instance. */
  private disposed = false;

  constructor(private manager: AgentManager) {}

  /** Spawn + wire tracking + (foreground) await. */
  async spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
  ): Promise<SpawnResult> {
    if (getSubagentRuntimeContext()) {
      throw new Error("Root agent spawning is unavailable from a child runtime");
    }
    return this.spawnInternal(pi, ctx, intent);
  }

  /** Spawn a foreground child through the root manager's slot handoff. */
  async spawnNested(
    parentId: string,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
  ): Promise<SpawnResult> {
    if (intent.runInBackground) throw new Error("Nested agents must run in the foreground");
    // Resolve against the manager-owned parent snapshot before preparing model
    // settings. spawnNested rechecks this immediately before it starts work.
    const preflight = this.manager.preflightNested(parentId, intent.type);
    if (!preflight.ok) throw new Error(preflight.error);
    return this.spawnInternal(pi, ctx, {
      ...intent,
      type: preflight.type,
      agentConfig: preflight.agentConfig,
      // AgentManager owns and rechecks the parent catalog/worktree at the
      // nested boundary. Do not pass a public parent projection back to it.
    }, parentId);
  }

  private async spawnInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
    parentId?: string,
  ): Promise<SpawnResult> {
    const liveView: LiveView = { activeTools: new Map(), responseText: "" };
    const liveViewCallbacks = this.createLiveViewCallbacks(liveView);
    // A nested coordinator call already runs in its parent's isolated context.
    // Otherwise capture settings before manager execution can enter ALS.
    const inheritedRuntime = getSubagentRuntimeContext();
    let runtimeSettings = inheritedRuntime?.settings ?? intent.runtimeSettingsSnapshot;
    if (!runtimeSettings) {
      // Never fall through to the root store from a malformed child context.
      if (inheritedRuntime) throw new Error("Child runtime is missing detached settings");
      runtimeSettings = getStore().createSubagentRuntimeSettings();
    }

    const model = intent.model ?? ctx.model;
    const thinkingLevel = normalizeThinkingLevel(model, intent.thinkingLevel ?? ctx.thinkingLevel);
    const modelKey = intent.modelKey ?? (model ? `${model.provider}/${model.id}` : undefined);
    // Capture the complete catalog when a root spawn is accepted. A trusted
    // worktree caller supplies its overlay; all other roots snapshot the
    // current registered catalog before any queued execution can begin.
    const agentCatalog = intent.agentCatalog ?? snapshotRegisteredAgentCatalog();
    const canonicalType = resolveTypeInCatalog(agentCatalog, intent.type);
    const agentConfig = snapshotAgentConfig(
      intent.agentConfig ?? (canonicalType ? agentCatalog.get(canonicalType) : undefined),
    );
    const { type, prompt, runInBackground, invocation, signal, runtimeSettingsSnapshot: _runtimeSettingsSnapshot, ...config } = intent;
    const spawnOptions: SpawnOptions = {
      ...config,
      signal,
      model,
      modelKey,
      thinkingLevel,
      agentConfig,
      agentCatalog,
      invocation: { ...invocation, mode: runtimeSettings.mode, thinkingLevel },
      isBackground: runInBackground,
      // This factory closes over trusted coordinator state and detached
      // settings before the manager enters a child AsyncLocalStorage context.
      nestedExecutorFactory: (parentId) => createNestedAgentExecutor(parentId, pi, this.manager, this, runtimeSettings),
      runtimeSettings,
      ...liveViewCallbacks,
    };

    const agentId = parentId
      ? this.manager.spawnNested(parentId, pi, ctx, type, prompt, spawnOptions)
      : this.manager.spawn(pi, ctx, type, prompt, spawnOptions);
    const record = this.manager.getRecord(agentId)!;
    if (runInBackground) this.initializeBackgroundDelivery(record);

    if (isTerminal(record)) {
      // An already-aborted parent can complete synchronously, before coordinator
      // tracking is registered. It has no remaining route for a result.
      if (runInBackground && signal?.aborted) {
        this.abandonBackgroundDelivery(agentId, record);
      } else if (runInBackground) {
        this.backgroundAgentIds.add(agentId);
        this.trackBackgroundParentAbort(agentId, signal);
        this.scheduleNudge(agentId);
      } else {
        record.lifecycle.resultConsumed = true;
      }
      return { agentId, record };
    }

    this.liveViews.set(agentId, liveView);
    if (!inheritedRuntime) getWidget()?.ensureTimer();

    if (runInBackground) {
      this.backgroundAgentIds.add(agentId);
      this.trackBackgroundParentAbort(agentId, signal);
    } else {
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
      this.liveViews.delete(agentId);
    }

    return { agentId, record };
  }

  /** Read the live view for an agent. Widget calls this. */
  liveView(id: string): LiveView | undefined {
    return this.liveViews.get(id);
  }

  /** Check if an agent is still awaiting background completion. */
  isBackground(agentId: string): boolean {
    return this.backgroundAgentIds.has(agentId);
  }

  /**
   * Request the sole automatic delivery attempt for a background completion.
   * Kept public for existing callers/tests; duplicate requests are deliberately
   * ignored, including after a failed attempt.
   */
  scheduleNudge(agentId: string): void {
    const record = this.manager.getRecord(agentId);
    // Public callers can request this at any time. Only a retained terminal
    // background result that is still pending may claim the automatic attempt.
    if (this.disposed || this.autoNudgeIssued.has(agentId)
      || !record || !isTerminal(record) || record.delivery?.state !== "pending") return;
    this.autoNudgeIssued.add(agentId);
    this.pendingNudges.add(agentId);
    if (this.nudgeTimer) return;

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      const batch = [...this.pendingNudges];
      this.pendingNudges.clear();
      for (const id of batch) this.deliver(id, "auto");
    }, NUDGE_DELAY_MS);
  }

  /** Called by AgentManager's completion callback. */
  onAgentComplete(record: AgentRecord): void {
    this.liveViews.delete(record.id);
    if (!this.backgroundAgentIds.has(record.id)) return;

    this.backgroundAgentIds.delete(record.id);
    this.initializeBackgroundDelivery(record);
    if (this.backgroundParentAborts.get(record.id)?.signal.aborted) {
      this.abandonBackgroundDelivery(record.id, record);
      return;
    }
    // Every background completion gets exactly one automatic attempt. The set
    // also protects against accidental duplicate completion notifications.
    this.scheduleNudge(record.id);
  }

  /**
   * Immediately retry a terminal failed background delivery. Returns false when
   * the record is no longer eligible (accepted, abandoned, evicted, or active).
   */
  retryDelivery(agentId: string): boolean {
    if (this.disposed) return false;
    const record = this.manager.getRecord(agentId);
    if (!record || !isTerminal(record) || record.delivery?.state !== "failed") return false;
    return this.deliver(agentId, "manual");
  }

  /** Remove coordinator tracking when AgentManager fully evicts a record. */
  onRecordEvicted(record: AgentRecord): void {
    this.clearBackgroundTracking(record.id, true);
  }

  /** Dispose without delivering any retained pending or failed result. */
  dispose(): void {
    this.disposed = true;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.pendingNudges.clear();

    // Include completed failures and active background records: shutdown has no
    // valid parent session, so none may be delivered if completion races dispose.
    for (const record of this.manager.listAgents()) {
      if (record.delivery?.state === "pending" || record.delivery?.state === "failed") {
        this.abandonBackgroundDelivery(record.id, record);
      }
    }
    this.liveViews.clear();
    this.backgroundAgentIds.clear();
    this.autoNudgeIssued.clear();
    for (const id of [...this.backgroundParentAborts.keys()]) this.clearBackgroundParentAbort(id);
  }

  private initializeBackgroundDelivery(record: AgentRecord): void {
    record.delivery ??= { state: "pending", attempts: 0 };
  }

  /** Create callbacks that bridge manager events to a specific live view. */
  private createLiveViewCallbacks(view: LiveView): Pick<SpawnOptions, "onToolActivity" | "onTextDelta"> {
    return {
      onToolActivity: (activity: ToolActivity) => {
        if (activity.type === "start") {
          view.activeTools.set(`${activity.toolName}_${this.nextActivityId++}`, activity.toolName);
        } else {
          for (const [key, name] of view.activeTools) {
            if (name === activity.toolName) { view.activeTools.delete(key); break; }
          }
        }
      },
      onTextDelta: (_delta: string, fullText: string) => { view.responseText = fullText; },
    };
  }

  /** Keep delivery tied to the parent turn until Pi has accepted it. */
  private trackBackgroundParentAbort(agentId: string, signal?: AbortSignal): void {
    if (!signal || this.backgroundParentAborts.has(agentId)) return;
    const listener = () => this.abandonBackgroundDelivery(agentId, this.manager.getRecord(agentId));
    this.backgroundParentAborts.set(agentId, { signal, listener });
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted && this.backgroundParentAborts.has(agentId)) listener();
  }

  private clearBackgroundParentAbort(agentId: string): void {
    const entry = this.backgroundParentAborts.get(agentId);
    if (!entry) return;
    entry.signal.removeEventListener("abort", entry.listener);
    this.backgroundParentAborts.delete(agentId);
  }

  /** Parent/dispose abandonment is terminal and deliberately has no retry path. */
  private abandonBackgroundDelivery(agentId: string, record?: AgentRecord): void {
    if (record?.delivery && record.delivery.state !== "accepted") {
      record.delivery.state = "abandoned";
      record.lifecycle.resultConsumed = true;
    }
    this.clearBackgroundTracking(agentId, true);
  }

  /** Clear transient tracking; retain parent listener after failure for later parent abort. */
  private clearBackgroundTracking(agentId: string, clearParent: boolean): void {
    this.pendingNudges.delete(agentId);
    this.backgroundAgentIds.delete(agentId);
    this.liveViews.delete(agentId);
    if (clearParent) {
      this.autoNudgeIssued.delete(agentId);
      this.clearBackgroundParentAbort(agentId);
    }
  }

  /** Shared delivery path: auto only from pending, manual only from failed. */
  private deliver(agentId: string, source: DeliverySource): boolean {
    const record = this.manager.getRecord(agentId);
    const delivery = record?.delivery;
    if (!record) {
      this.clearBackgroundTracking(agentId, true);
      return false;
    }
    if (!delivery || this.deliveryInProgress.has(agentId)) return false;
    if (source === "auto" ? delivery.state !== "pending" : delivery.state !== "failed") return false;

    if (this.disposed || this.backgroundParentAborts.get(agentId)?.signal.aborted) {
      this.abandonBackgroundDelivery(agentId, record);
      return false;
    }

    this.deliveryInProgress.add(agentId);
    delivery.attempts++;
    delivery.lastAttemptAt = Date.now();
    delete delivery.lastError;
    try {
      const pi = getPiInstance();
      if (!pi) throw new Error("Pi instance unavailable for background result delivery");
      // Check immediately before the irreversible handoff as well as before
      // preparation, so a queued timer can never send after parent/dispose.
      if (this.disposed || this.backgroundParentAborts.get(agentId)?.signal.aborted) {
        this.abandonBackgroundDelivery(agentId, record);
        return false;
      }

      const details = buildAgentDetails(record, { includeStats: true, includeStatus: true });
      const parentIdle = getSessionCtx()?.isIdle?.() ?? true;
      pi.sendMessage(
        {
          customType: "subagent-result",
          content: `[Subagent "${record.display.type}" ${record.id.slice(0, SHORT_ID_LENGTH)} ${record.lifecycle.status}]\n\n${formatResultContent(record)}`,
          details,
          display: true,
        },
        { deliverAs: parentIdle ? "followUp" : "steer", triggerTurn: true },
      );

      // This intentionally means only that Pi did not synchronously throw. It
      // is not an LLM/provider delivery confirmation.
      delivery.state = "accepted";
      record.lifecycle.resultConsumed = true;
      this.clearBackgroundTracking(agentId, true);
    } catch (error) {
      // Preserve result and terminal status for the explicit manual retry path.
      delivery.state = "failed";
      delivery.lastError = deliveryErrorMessage(error);
      this.clearBackgroundTracking(agentId, false);
    } finally {
      this.deliveryInProgress.delete(agentId);
    }
    return true;
  }
}
