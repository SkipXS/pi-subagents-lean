/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 * Adapted for pi-subagents-lean type shapes.
 */

import type {
  AgentSession,
  AgentSessionEvent,
  BranchSummaryEntry,
  CompactionEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { type Component, Input, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRecord, CompactionReason, CompactionReasonMetadata } from "../types.js";
import { formatTokens, getSessionUsageSnapshot, type SessionUsageSnapshot } from "../agents/usage.js";
import { extractText } from "../prompt/context.js";
import type { Theme } from "./types.js";
import { makeMarkdownTheme } from "./markdown-theme.js";
import {
  buildInvocationTags,
  buildStatsCells,
  formatStatsRow,
  describeActivity,
  fgPreservingNestedStyles,
  getAgentStatusDisplay,
  getDisplayName,
  summarizeToolArgs,
  type StatsVisibility,
} from "./format.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Fixed chrome lines: top border + 2 header rows + 2 separators + footer + bottom border. */
const CHROME_LINES_BASE = 7;
const MIN_VIEWPORT = 3;
/** Cap viewport height at this % of terminal rows so the bordered box fits without clipping. */
export const VIEWPORT_HEIGHT_PCT = 70;
/** Shared overlay geometry for every agent viewer entry point. */
export const VIEWER_OVERLAY_OPTIONS = {
  anchor: "center",
  width: "90%",
  maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
} as const;
/** Maximum characters for a single tool result before truncation. */
const TOOL_RESULT_MAX_CHARS = 500;
/** Maximum lines to show from a large tool result. */
const TOOL_RESULT_MAX_LINES = 5;
/** Debounce interval for streaming renders — reduces CPU during fast token arrival. */
const STREAM_RENDER_DEBOUNCE_MS = 100;
/** Bound lifecycle/history refreshes to one responsive frame-sized window. */
const POST_EVENT_REFRESH_THROTTLE_MS = 16;
/** Cheap leaf checks keep branch navigation live without rescanning history. */
const LEAF_POLL_INTERVAL_MS = 250;
/**
 * Never turn an append hint into an unbounded parent walk. A larger tail is
 * unusual (ordinary turns append only a few entries) and must use the
 * authoritative branch path instead.
 */
const MAX_APPEND_TAIL_ENTRIES = 256;

type ViewerMessage = SessionMessageEntry["message"];

type ViewerSessionManager = {
  getLeafEntry?: () => SessionEntry | undefined;
  getLeafId?: () => string | null;
  getEntry?: (id: string) => SessionEntry | undefined;
};

type ViewerHistoryItem =
  | { key: string; kind: "message"; message: ViewerMessage }
  | { key: string; kind: "customMessage"; entry: CustomMessageEntry }
  | { key: string; kind: "compaction"; entry: CompactionEntry; order: number; count: number; reason?: CompactionReason }
  | { key: string; kind: "compactionFallback"; summary: string; tokensBefore: number; timestamp?: number; order: number; count: number }
  | { key: string; kind: "branchSummary"; entry: BranchSummaryEntry };

type PrefetchedBranch = {
  entries: SessionEntry[];
  leafId: string | null;
};

/** Build the two identity/metadata rows shared by conversation and result viewers. */
export function buildAgentViewerHeaderRows(
  record: AgentRecord,
  theme: Theme,
  statsVisibility?: StatsVisibility,
  session?: AgentSession,
  liveUsageSnapshot?: SessionUsageSnapshot | null,
): [string, string] {
  const name = getDisplayName(record.display.type);
  const { icon, color } = getAgentStatusDisplay(record.lifecycle.status);
  const statusIcon = theme.fg(color, icon);
  const durationMs = (record.lifecycle.completedAt ?? Date.now()) - record.lifecycle.startedAt;
  const terminal = record.lifecycle.status !== "running" && record.lifecycle.status !== "queued";
  const liveSnapshot = liveUsageSnapshot !== undefined
    ? liveUsageSnapshot
    : (!terminal && session ? getSessionUsageSnapshot(session) : undefined);
  const persistedSnapshot = {
    contextPercent: record.stats.contextPercent,
    contextWindow: record.stats.contextWindow,
    autoCompactionEnabled: record.stats.autoCompactionEnabled,
    usingSubscription: record.stats.usingSubscription,
  };
  // A live snapshot with a window or measured percentage is a current sample
  // (including a valid null-after-compaction percentage when the window is
  // present). If a legacy/session double only returns the shape-less
  // `{ contextPercent: null }`, retain the manager's event-bound telemetry
  // instead of erasing it during header assembly.
  const hasLiveSample = liveSnapshot != null
    && (liveSnapshot.contextWindow !== undefined || liveSnapshot.contextPercent !== null);
  const usageSnapshot = terminal
    ? persistedSnapshot
    : {
      contextPercent: hasLiveSample
        ? liveSnapshot!.contextPercent
        : (persistedSnapshot.contextPercent ?? liveSnapshot?.contextPercent ?? null),
      contextWindow: liveSnapshot?.contextWindow ?? persistedSnapshot.contextWindow,
      autoCompactionEnabled: liveSnapshot?.autoCompactionEnabled ?? persistedSnapshot.autoCompactionEnabled,
      usingSubscription: liveSnapshot?.usingSubscription ?? persistedSnapshot.usingSubscription,
    };
  const statsCells = buildStatsCells({
    toolUses: record.stats.toolUses,
    turnCount: record.stats.turnCount,
    maxTurns: record.stats.maxTurns,
    input: record.stats.lifetimeUsage.input,
    output: record.stats.lifetimeUsage.output,
    cacheRead: record.stats.cacheRead,
    cacheWrite: record.stats.lifetimeUsage.cacheWrite,
    latestCacheHitRate: record.stats.latestCacheHitRate,
    cost: record.stats.lifetimeUsage.cost,
    ...usageSnapshot,
    compactionCount: record.stats.compactionCount,
    contextStats: record.stats.contextStats?.count ? record.stats.contextStats : undefined,
    durationMs,
  }, theme, statsVisibility);

  const worktreeTag = record.display.worktreeLabel ? theme.fg("muted", ` @${record.display.worktreeLabel}`) : "";
  const identityRow = `${statusIcon} ${theme.bold(name)}  ${theme.fg("muted", record.display.description)}${worktreeTag}`;

  const { modelName, thinkingTag, tags } = buildInvocationTags({
    ...record.display.invocation,
    thinkingLevel: session?.thinkingLevel ?? record.display.invocation?.thinkingLevel,
  });
  const statsLine = fgPreservingNestedStyles(theme, "dim", formatStatsRow(statsCells) ?? "");
  if (modelName) {
    const parts = [thinkingTag, statsLine, ...tags].filter(Boolean);
    return [identityRow, theme.fg("dim", `  ${modelName} · ${parts.join(" · ")}`)];
  }
  const parts = [thinkingTag, statsLine].filter(Boolean);
  return [identityRow, parts.join(" · ")];
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Refresh only at session event boundaries; getContextUsage() can walk the full branch. */
  private liveUsageSnapshot: SessionUsageSnapshot | null;
  /** Rendered lines per stable session-entry key — avoids re-rendering unchanged items. */
  private messageCache = new Map<string, string[]>();
  /** Width of the last rendered history projection. */
  private cacheMeta = { width: 0 };
  /** Full content lines from the last build — avoids re-iterating cached messages. */
  private cachedContentLines: string[] | undefined;
  /** Stable item key for every cached content line, including streaming suffixes. */
  private cachedContentLineKeys: string[] = [];
  /** Number of non-streaming lines in cachedContentLines. */
  private cachedNonStreamingCount = 0;
  /** Current branch/fallback projection used by the cache fast path. */
  private cachedHistoryItems: ViewerHistoryItem[] = [];
  /** Event/leaf revision of cachedHistoryItems; no full-history signature is retained. */
  private historyRevision = 1;
  private cachedHistoryRevision = 0;
  private cachedHistoryMode: "branch" | "messages" | undefined;
  private cachedLeafId: string | null | undefined;
  private cachedMessagesRef: ViewerMessage[] | undefined;
  private cachedMessagesLength = -1;
  /** Raw active-branch baseline used to validate append-only snapshots. */
  private cachedRawBranchCount = -1;
  private cachedRawBranchLeafId: string | null | undefined;
  private cachedRawBranchIds: string[] = [];
  private cachedRawBranchIdSet = new Set<string>();
  /** Projection indexes retained so a safe append does not rescan history. */
  private cachedCompactionCount = 0;
  private cachedToolResults = new Map<string, { content: unknown[]; isError: boolean; toolName?: string }>();
  private cachedAssistantToolCallKeys = new Map<string, Set<string>>();
  private cachedAssistantToolCallIds = new Set<string>();
  private cachedPendingToolCallIds = new Set<string>();
  /** Recently appended assistant rows that may receive delayed tool results incrementally. */
  private incrementalPendingToolCallRows = new Map<string, {
    key: string;
    message: ViewerMessage;
    start: number;
    count: number;
  }>();
  /** Number of provisional message rows currently included in the projection. */
  private cachedPendingHistoryCount = 0;
  /** An append signal is only a hint; full/unknown invalidation wins conservatively. */
  private historyRefreshKind: "none" | "append" | "pending" | "full" = "full";
  /** Message-end entries observed before SessionManager persistence catches up. */
  private pendingHistoryMessages: Array<{ key: string; message: ViewerMessage }> = [];
  private pendingMessageSequence = 0;
  /** Scroll anchor captured before a source/cache/wrap rebuild. */
  private pendingScrollAnchor: {
    key: string;
    offset: number;
    index: number;
    fromStreaming: boolean;
    streamingSection: "thinking" | "text";
    streamingSectionOffset: number;
    bottomDistance: number;
  } | undefined;
  /** Manual navigation suppresses a later transient-to-history handoff. */
  private suppressStreamingAnchorAfterManualNavigation = false;
  private manualNavigationFinalizationPending = false;
  /** Final message corresponding to the transient streaming suffix, if any. */
  private streamingHandoffMessage: ViewerMessage | undefined;
  private streamingHandoffKey: string | undefined;
  private streamingHadContent = false;
  private cachedStreamingThinkingLineCount = 0;
  /** Reasons arrive from compaction_end; persisted entries do not store them. */
  private compactionReasons = new Map<string, CompactionReason>();
  private compactionReasonSignatures = new Map<string, CompactionReason>();
  private ambiguousCompactionSignatures = new Set<string>();

  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer -- present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Accumulated thinking text from streaming deltas, cleared on thinking_end. */
  private streamingThinking = "";
  /** Accumulated response text from streaming deltas, cleared on text_end. */
  private streamingText = "";
  /** Persistent Markdown instance for streaming thinking — lazily initialized. */
  private streamingThinkingMd: Markdown | undefined;
  /** Persistent Markdown instance for streaming text — lazily initialized. */
  private streamingTextMd: Markdown | undefined;
  /** Debounce timer for streaming renders — avoids fighting the TUI's 16ms loop. */
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  /** Coalesces lifecycle/history refreshes while their throttle timer is pending. */
  private postEventRefreshQueued = false;
  /** Turns an event re-entering the active refresh into one trailing refresh. */
  private postEventRefreshRunning = false;
  private postEventRefreshTrailing = false;
  private postEventRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Branch captured while sampling context, paired with the leaf it represents. */
  private prefetchedBranch: PrefetchedBranch | undefined;
  /** Active legacy sessions validate a constructor prefetch once before first render. */
  private initialBranchPrefetchNeedsValidation = false;
  /** Lightweight branch-leaf watcher, started once the overlay is rendered. */
  private leafPollTimer: ReturnType<typeof setInterval> | undefined;
  private observedLeafId: string | null | undefined;
  /** Invalidated on disposal so late timer callbacks cannot touch a dead viewer. */
  private lifecycleGeneration = 0;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted -> no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted -> hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted -> no compose affordance. */
    private onSteer?: (message: string) => void,
    /** Configured visibility of the shared usage statistics. */
    private statsVisibility?: StatsVisibility,
  ) {
    this.keys = createViewerKeys(keybindings);
    this.refreshLiveUsageSnapshot(true);
    this.initialBranchPrefetchNeedsValidation = this.isActive() && this.prefetchedBranch !== undefined && this.currentLeafId() === undefined;
    this.liveUsageSnapshot ??= null;
    for (const metadata of record.stats.compactionReasons ?? []) {
      this.rememberCompactionMetadata(metadata);
    }
    this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      try {
        if (this.closed) return;
        // Streaming deltas only update the transient suffix. Persisted messages
        // are reconciled from the authoritative active branch once persistence
        // catches up, so the suffix never becomes a second copy of the message.
        if (event.type === "message_update") {
          const me = event.assistantMessageEvent;
          const prevThinking = this.streamingThinking;
          const prevText = this.streamingText;
          switch (me.type) {
            case "thinking_start":
              this.streamingHadContent = false;
              this.streamingHandoffMessage = undefined;
              this.streamingThinking = "";
              this.streamingThinkingMd?.setText("");
              break;
            case "thinking_end":
              this.streamingThinking = "";
              this.streamingThinkingMd?.setText("");
              break;
            case "thinking_delta":
              this.streamingHadContent = true;
              this.streamingThinking += me.delta;
              this.ensureThinkingMd().setText(this.streamingThinking);
              break;
            case "text_start":
              this.streamingHandoffMessage = undefined;
              this.streamingText = "";
              this.streamingTextMd?.setText("");
              break;
            case "text_end":
              this.streamingText = "";
              this.streamingTextMd?.setText("");
              break;
            case "text_delta":
              this.streamingHadContent = true;
              this.streamingText += me.delta;
              this.ensureTextMd().setText(this.streamingText);
              break;
          }
          if (this.streamingThinking !== prevThinking || this.streamingText !== prevText) {
            this.scheduleRender();
          }
          return;
        }

        if (event.type === "message_end") {
          const finalMessage = event.message as ViewerMessage;
          if (this.isDisplayableMessage(finalMessage)) this.queuePendingHistoryMessage(finalMessage);
          if (finalMessage.role === "assistant" && this.streamingHadContent) {
            if (this.suppressStreamingAnchorAfterManualNavigation) {
              // A manual scroll made after the transient anchor was captured
              // owns the next location; do not hand it back to the assistant
              // row when this message is finalized.
              this.manualNavigationFinalizationPending = true;
              this.streamingHandoffMessage = undefined;
            } else {
              this.streamingHandoffMessage = finalMessage;
            }
          }
          this.streamingHadContent = false;
          this.streamingThinking = "";
          this.streamingText = "";
          this.streamingThinkingMd?.setText("");
          this.streamingTextMd?.setText("");
          this.invalidateHistoryCache("pending");
          this.queuePostEventRefresh();
          return;
        }

        if (event.type === "compaction_end" && !event.aborted && event.result) {
          this.rememberCompactionReason(event.reason, event.result);
          this.invalidateHistoryCache("full");
          this.queuePostEventRefresh();
          return;
        }

        // A completed custom entry or agent turn can append to the active
        // branch. The authoritative branch snapshot below decides whether the
        // append shape is actually safe; the event payload is intentionally not
        // consulted because it can race persistence.
        if (event.type === "entry_appended" || event.type === "agent_end" || event.type === "agent_settled") {
          this.invalidateHistoryCache("append");
          this.queuePostEventRefresh();
          return;
        }

        // Keep compatibility with session doubles and newer runtimes that
        // expose tree navigation through a named event not in this SDK's type.
        const eventType = (event as { type?: string }).type;
        if (eventType === "branch_changed" || eventType === "branch_change" || eventType === "session_tree" || eventType === "tree_changed") {
          this.invalidateHistoryCache("full");
          this.queuePostEventRefresh();
        }
      } catch {
        // Swallow — session events after viewer closure must not crash the menu.
      }
    });
  }
  /** Read the active branch once, without falling back to session.messages. */
  private readCurrentBranch(): SessionEntry[] | undefined {
    try {
      const manager = this.session.sessionManager;
      if (manager && typeof manager.getBranch === "function") {
        const candidate = manager.getBranch();
        if (Array.isArray(candidate)) return candidate;
      }
    } catch {
      // Legacy or tearing-down sessions may not expose a usable branch.
    }
    return undefined;
  }

  /**
   * Refresh only header-visible telemetry after a confirmed ordinary append.
   * AgentManager samples context after assistant persistence, so reading the
   * retained record fields avoids asking AgentSession.getContextUsage() to
   * rebuild the full context branch. Session/model/auth fields are cheap
   * metadata reads and remain useful for lightweight session doubles.
   */
  private refreshCheapUsageSnapshot(): void {
    const stats = this.record.stats;
    const contextStats = stats.contextStats;
    let model: { provider?: unknown; contextWindow?: unknown } | undefined;
    let autoCompactionEnabled: boolean | undefined;
    let usingSubscription: boolean | undefined = stats.usingSubscription;
    try {
      const session = this.session as unknown as {
        model?: { provider?: unknown; contextWindow?: unknown };
        state?: { model?: { provider?: unknown; contextWindow?: unknown } };
        autoCompactionEnabled?: unknown;
        modelRuntime?: { isUsingOAuth?: (provider: string) => boolean };
      };
      model = session.model ?? session.state?.model;
      if (typeof session.autoCompactionEnabled === "boolean") {
        autoCompactionEnabled = session.autoCompactionEnabled;
      }
      if (usingSubscription === undefined && typeof model?.provider === "string") {
        usingSubscription = model.provider === "kimi-coding";
        if (!usingSubscription) {
          try {
            usingSubscription = session.modelRuntime?.isUsingOAuth?.(model.provider) ?? false;
          } catch {
            usingSubscription = false;
          }
        }
      }
    } catch {
      // Optional metadata is best effort; retained manager stats remain usable.
    }

    const contextPercent = stats.contextPercent !== undefined
      ? stats.contextPercent
      : (contextStats?.current ?? null);
    const contextWindow = stats.contextWindow
      ?? contextStats?.window
      ?? (typeof model?.contextWindow === "number" ? model.contextWindow : undefined);
    this.liveUsageSnapshot = {
      contextPercent,
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      autoCompactionEnabled: autoCompactionEnabled ?? stats.autoCompactionEnabled,
      usingSubscription,
    };
  }

  /** The last entry is the exact leaf represented by a branch snapshot. */
  private branchLeafId(branch: SessionEntry[]): string | null {
    return branch.length > 0 ? branch[branch.length - 1]!.id : null;
  }

  /** Refresh usage from the exact branch that will be used for history. */
  private refreshUsageSnapshotFromBranch(branch: SessionEntry[]): void {
    this.prefetchedBranch = { entries: branch, leafId: this.branchLeafId(branch) };
    // Terminal records use manager-persisted telemetry. Retain the branch
    // prefetch for history, but never ask a completed session for context.
    if (!this.isActive()) return;
    const snapshot = getSessionUsageSnapshot(this.sessionWithBranch(branch));
    if (snapshot) this.liveUsageSnapshot = snapshot;
  }

  /**
   * Refresh live usage after an event that may have changed persisted context.
   * The installed AgentSession context reader calls sessionManager.getBranch()
   * internally. Read that branch through a shadow manager so history can reuse
   * the same traversal instead of walking it a second time immediately after.
   */
  private refreshLiveUsageSnapshot(initial = false): void {
    if (!initial) this.initialBranchPrefetchNeedsValidation = false;
    const branch = this.readCurrentBranch();
    if (branch !== undefined) {
      this.refreshUsageSnapshotFromBranch(branch);
      return;
    }

    this.prefetchedBranch = undefined;
    if (!this.isActive()) return;
    const snapshot = getSessionUsageSnapshot(this.session);
    if (snapshot) this.liveUsageSnapshot = snapshot;
  }

  /** Create a read-only session view whose context reader reuses one branch. */
  private sessionWithBranch(branch: SessionEntry[]): AgentSession {
    const manager = this.session.sessionManager;
    const managerView = Object.create(manager) as typeof manager;
    Object.defineProperty(managerView, "getBranch", { value: () => branch });
    const sessionView = Object.create(this.session) as AgentSession;
    Object.defineProperty(sessionView, "sessionManager", { value: managerView });
    return sessionView;
  }

  /**
   * Refresh once per responsive throttle window.
   *
   * Session listeners run before SessionManager.appendMessage(), so the timer
   * remains long enough for persistence and for nearby lifecycle callbacks to
   * settle. Events that arrive while the synchronous refresh is running are
   * retained as one trailing refresh instead of being dropped.
   */
  private queuePostEventRefresh(): void {
    if (this.closed) return;
    // The lifecycle refresh owns the next render. Cancel a slower streaming
    // render now, rather than allowing it to render invalidated history before
    // the throttle callback runs.
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.postEventRefreshRunning) {
      this.postEventRefreshTrailing = true;
      return;
    }
    if (this.postEventRefreshQueued) return;
    this.postEventRefreshQueued = true;
    const session = this.session;
    const generation = this.lifecycleGeneration;
    this.postEventRefreshTimer = setTimeout(() => {
      this.postEventRefreshTimer = undefined;
      this.postEventRefreshQueued = false;
      if (this.closed || generation !== this.lifecycleGeneration || this.session !== session) return;

      this.postEventRefreshRunning = true;
      try {
        // Safe append candidates use manager-populated record telemetry. A
        // pending message_end can take the same bounded tail path once a
        // branch baseline exists; defer the authoritative branch/context read
        // until render if that path cannot be proven safe.
        if (this.historyRefreshKind === "append"
          || (this.historyRefreshKind === "pending" && this.canAttemptBoundedTail())) {
          this.refreshCheapUsageSnapshot();
        } else {
          this.refreshLiveUsageSnapshot();
        }
        if (this.closed || generation !== this.lifecycleGeneration || this.session !== session) return;
        // Event-boundary refreshes own one render request. Do not leave a
        // streaming debounce timer behind to issue a second request for the
        // same newly persisted state.
        if (this.renderTimer !== undefined) {
          clearTimeout(this.renderTimer);
          this.renderTimer = undefined;
        }
        this.tui.requestRender();
      } catch {
        // A disposed TUI/session must not let a late timer callback escape.
      } finally {
        this.postEventRefreshRunning = false;
        const needsTrailingRefresh = this.postEventRefreshTrailing;
        this.postEventRefreshTrailing = false;
        if (needsTrailingRefresh && !this.closed && generation === this.lifecycleGeneration && this.session === session) {
          this.queuePostEventRefresh();
        }
      }
    }, POST_EVENT_REFRESH_THROTTLE_MS);
  }

  /** Lazily initialize the Markdown instance for streaming thinking text. */
  private ensureThinkingMd(): Markdown {
    if (!this.streamingThinkingMd) {
      this.streamingThinkingMd = new Markdown("", 1, 0, makeMarkdownTheme(this.theme), {
        color: (text: string) => this.theme.fg("thinkingText", text),
        italic: true,
      });
    }
    return this.streamingThinkingMd;
  }

  /** Lazily initialize the Markdown instance for streaming response text. */
  private ensureTextMd(): Markdown {
    if (!this.streamingTextMd) {
      this.streamingTextMd = new Markdown("", 1, 0, makeMarkdownTheme(this.theme));
    }
    return this.streamingTextMd;
  }
  /** Schedule a debounced render for streaming updates. */
  private scheduleRender(): void {
    if (this.renderTimer !== undefined) return; // already scheduled
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, STREAM_RENDER_DEBOUNCE_MS);
  }

  handleInput(data: string): void {
    if (this.closed) return; // already closing, ignore stray keys
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels -- both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.stopLeafPolling();
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) -- then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "s" arms, second confirms -- any other key disarms.
    if (matchesKey(data, "s")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const scrollUp = this.keys.scrollUp(data);
    const scrollDown = this.keys.scrollDown(data);
    const pageUp = this.keys.pageUp(data);
    const pageDown = this.keys.pageDown(data);
    const home = matchesKey(data, "home") || data === "g";
    const end = matchesKey(data, "end") || data === "G";
    if (scrollUp || scrollDown || pageUp || pageDown || home || end) {
      // Clear before scrollMax() can rebuild a stale projection and restore the
      // transient anchor that this manual input is explicitly superseding.
      this.clearPendingScrollAnchor();
    }

    const viewportHeight = this.viewportHeight();
    const maxScroll = this.scrollMax();

    if (scrollUp) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (scrollDown) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (pageUp) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (pageDown) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (home) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (end) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (this.closed) return []; // closing — framework may still call render after done()
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const row = (content: string) => {
      const padded = content + " ".repeat(Math.max(0, innerW - visibleWidth(content)));
      return th.fg("border", "│") + " " + truncateToWidth(padded, innerW, "...", true) + " " + th.fg("border", "│");
    };
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Build history before the header so a leaf change discovered during the
    // projection refreshes the usage snapshot shown in this same render.
    const contentLines = this.buildContentLines(innerW);

    // Header
    lines.push(hrTop);
    const [identityRow, metadataRow] = buildAgentViewerHeaderRows(
      this.record,
      th,
      this.statsVisibility,
      this.session,
      this.liveUsageSnapshot,
    );
    lines.push(row(identityRow));
    lines.push(row(metadataRow));
    lines.push(hrMid);

    // Content area
    this.ensureLeafPolling();
    const totalContentLines = contentLines.length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalContentLines - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions on the left, navigation on the right.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "s again to STOP") : th.fg("dim", "s stop"));
      }
      const footerRight = th.fg("dim", "↑↓ scroll · g/G top/bottom · PgUp/PgDn · Esc/q close");

      const visibleEnd = Math.min(visibleStart + viewportHeight, totalContentLines);
      const range = totalContentLines === 0
        ? "lines 0/0"
        : `lines ${visibleStart + 1}-${visibleEnd}/${totalContentLines}`;
      const edge = totalContentLines <= viewportHeight
        ? "top · bottom"
        : visibleStart === 0
          ? "top"
          : visibleEnd >= totalContentLines ? "bottom" : "";
      const position = th.fg("dim", [edge, range].filter(Boolean).join(" · "));
      const withCount = [position, ...actions].join(sep);
      // Keep the range/edge readout even on narrow overlays; it is more useful
      // than silently replacing it with actions when the footer is crowded.
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : position;

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  /** Agent is still active (running or queued). */
  private isActive(): boolean {
    return this.record.lifecycle.status === "running" || this.record.lifecycle.status === "queued";
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean { return !!this.onStop && this.isActive(); }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean { return !!this.onSteer && this.isActive(); }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      if (message) this.onSteer?.(message);
      this.closeComposer();
    };
    input.onEscape = () => {
      this.closeComposer();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  private closeComposer(): void {
    this.composer = undefined;
    this.tui.requestRender();
  }

  /** Mark the history portion stale while retaining stable per-entry cache rows. */
  private invalidateHistoryCache(kind: "append" | "pending" | "full" = "full"): void {
    this.historyRevision++;
    if (kind === "full") {
      // A navigation/compaction refresh cannot be weakened by a later event in
      // the same burst.
      this.historyRefreshKind = "full";
      this.cachedContentLines = undefined;
    } else if (kind === "pending") {
      // A message_end may be rendered provisionally before persistence. It can
      // become an append candidate only when the authoritative tail resolves
      // every provisional row; otherwise the full reconciliation remains.
      if (this.historyRefreshKind !== "full") this.historyRefreshKind = "pending";
    } else if (this.historyRefreshKind === "none") {
      this.historyRefreshKind = "append";
    }
  }

  invalidate(): void {
    if (!this.autoScroll) this.captureScrollAnchor();
    this.messageCache.clear();
    this.invalidateHistoryCache("full");
    this.cachedContentLineKeys = [];
    this.cachedHistoryItems = [];
    this.cachedHistoryRevision = 0;
    this.cachedHistoryMode = undefined;
    this.cachedLeafId = undefined;
    this.prefetchedBranch = undefined;
    this.initialBranchPrefetchNeedsValidation = false;
    this.cachedMessagesRef = undefined;
    this.cachedMessagesLength = -1;
    this.cachedRawBranchCount = -1;
    this.cachedRawBranchLeafId = undefined;
    this.cachedRawBranchIds = [];
    this.cachedRawBranchIdSet.clear();
    this.cachedCompactionCount = 0;
    this.cachedToolResults.clear();
    this.cachedAssistantToolCallKeys.clear();
    this.cachedAssistantToolCallIds.clear();
    this.cachedPendingToolCallIds.clear();
    this.incrementalPendingToolCallRows.clear();
    this.cachedPendingHistoryCount = 0;
    this.historyRefreshKind = "full";
    this.cacheMeta = { width: 0 };
    this.cachedNonStreamingCount = 0;
  }

  dispose(): void {
    this.closed = true;
    this.lifecycleGeneration++;
    this.stopLeafPolling();
    this.invalidate();
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.postEventRefreshTimer !== undefined) {
      clearTimeout(this.postEventRefreshTimer);
      this.postEventRefreshTimer = undefined;
    }
    this.postEventRefreshQueued = false;
    this.postEventRefreshTrailing = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight -- otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // Composer adds one extra row (input + hint instead of single footer).
    return CHROME_LINES_BASE + (this.composer ? 1 : 0);
  }

  /** Maximum scroll offset for the current content and viewport. */
  private scrollMax(): number {
    // Derive from a fresh build, not cachedContentLines.length: the cache holds
    // the last slow-path result and goes stale while streaming grows the suffix.
    const terminalColumns = this.tui.terminal.columns;
    const width = this.lastInnerW || (Number.isFinite(terminalColumns) ? Math.max(1, terminalColumns - 4) : 116);
    const totalLines = this.buildContentLines(width).length;
    return Math.max(0, totalLines - this.viewportHeight());
  }

  /** Manual navigation owns the next scroll position, not a transient handoff. */
  private clearPendingScrollAnchor(): void {
    const hasTransientContent = this.pendingScrollAnchor?.fromStreaming
      || this.cachedContentLineKeys.includes("__streaming__")
      || this.streamingHandoffMessage !== undefined;
    if (hasTransientContent) this.suppressStreamingAnchorAfterManualNavigation = true;
    if (this.streamingHandoffMessage !== undefined) this.manualNavigationFinalizationPending = true;
    this.pendingScrollAnchor = undefined;
    this.streamingHandoffKey = undefined;
    this.streamingHandoffMessage = undefined;
  }

  /** Capture the visible line as a stable item-relative anchor. */
  private captureScrollAnchor(): void {
    if (this.cachedContentLineKeys.length === 0) return;
    const index = Math.max(0, Math.min(this.scrollOffset, this.cachedContentLineKeys.length - 1));
    const key = this.cachedContentLineKeys[index];
    if (!key) return;
    let start = index;
    while (start > 0 && this.cachedContentLineKeys[start - 1] === key) start--;
    const itemOffset = index - start;
    const fromStreaming = key === "__streaming__";
    if (fromStreaming && this.suppressStreamingAnchorAfterManualNavigation) return;
    const streamingSection = fromStreaming && this.cachedStreamingThinkingLineCount > 0
      && itemOffset < this.cachedStreamingThinkingLineCount
      ? "thinking"
      : "text";
    const streamingSectionOffset = streamingSection === "thinking"
      ? itemOffset
      : Math.max(0, itemOffset - this.cachedStreamingThinkingLineCount);
    const bottomDistance = Math.max(0, this.cachedContentLineKeys.length - (index + this.viewportHeight()));
    this.pendingScrollAnchor = {
      key,
      offset: itemOffset,
      index,
      fromStreaming,
      streamingSection,
      streamingSectionOffset,
      bottomDistance,
    };
  }

  private finalizedAssistantTextOffset(message: ViewerMessage | undefined, width: number): number {
    if (!message || message.role !== "assistant" || this.pendingScrollAnchor?.streamingSection !== "text") return 0;
    const thinkingParts = (message.content as any[]).filter((part) => part.type === "thinking" && part.thinking);
    if (thinkingParts.length === 0) return 0;
    const thinkingText = thinkingParts.map((part: any) => part.thinking).join("\n\n").trim();
    if (!thinkingText) return 0;
    const md = new Markdown(thinkingText, 1, 0, makeMarkdownTheme(this.theme), {
      color: (text: string) => this.theme.fg("thinkingText", text),
      italic: true,
    });
    const thinkingLines = md.render(width);
    return thinkingLines.length > 0 ? thinkingLines.length + 1 : 0;
  }

  /** Restore a previously visible item-relative anchor after rebuilding lines. */
  private restoreScrollAnchor(lineKeys: string[], width: number): void {
    const anchor = this.pendingScrollAnchor;
    if (!anchor) return;
    let candidate: number;
    if (anchor.fromStreaming) {
      const targetKey = this.streamingHandoffKey;
      const first = targetKey ? lineKeys.indexOf(targetKey) : -1;
      if (first >= 0) {
        let last = first;
        while (last + 1 < lineKeys.length && lineKeys[last + 1] === targetKey) last++;
        const sectionOffset = anchor.streamingSection === "text"
          ? this.finalizedAssistantTextOffset(this.streamingHandoffMessage, width)
          : 0;
        candidate = first + Math.min(sectionOffset + anchor.streamingSectionOffset, Math.max(0, last - first));

      } else {
        // If persistence has not exposed the finalized row yet, preserve the
        // user's distance from the bottom rather than selecting an unrelated
        // historical row by its old numeric index.
        candidate = Math.max(0, lineKeys.length - this.viewportHeight() - anchor.bottomDistance);
      }
    } else {
      const first = lineKeys.indexOf(anchor.key);
      candidate = Math.min(anchor.index, lineKeys.length);
      if (first >= 0) {
        let last = first;
        while (last + 1 < lineKeys.length && lineKeys[last + 1] === anchor.key) last++;
        candidate = first + Math.min(anchor.offset, Math.max(0, last - first));
      }
    }
    const maxScroll = Math.max(0, lineKeys.length - this.viewportHeight());
    this.scrollOffset = Math.min(candidate, maxScroll);
    this.pendingScrollAnchor = undefined;
    this.streamingHandoffKey = undefined;
    this.streamingHandoffMessage = undefined;
  }

  /** Remember the reason for a newly persisted compaction entry. */
  private rememberCompactionReason(
    reason: CompactionReason,
    result: { summary: string; firstKeptEntryId: string; tokensBefore: number },
  ): void {
    // Compaction persistence precedes compaction_end in the upstream session,
    // so the leaf is an O(1) exact identity. Keep the signature fallback for
    // legacy doubles, then sync the manager's record metadata before rendering.
    let entryId: string | undefined;
    try {
      const leaf = this.session.sessionManager?.getLeafEntry?.();
      if (
        leaf?.type === "compaction"
        && leaf.summary === result.summary
        && leaf.firstKeptEntryId === result.firstKeptEntryId
        && leaf.tokensBefore === result.tokensBefore
      ) {
        entryId = leaf.id;
      }
    } catch {
      // Signature metadata remains available when the manager is unavailable.
    }
    this.rememberCompactionMetadata({ ...result, reason, ...(entryId ? { entryId } : {}) });
  }

  /** Reconcile manager-persisted compaction metadata before a live projection. */
  private syncCompactionMetadata(): void {
    for (const metadata of this.record.stats.compactionReasons ?? []) {
      this.rememberCompactionMetadata(metadata);
    }
  }

  /** Register persisted metadata, avoiding ambiguous signature-only matches. */
  private rememberCompactionMetadata(metadata: CompactionReasonMetadata): void {
    if (metadata.entryId) {
      this.compactionReasons.set(metadata.entryId, metadata.reason);
      return;
    }
    if (metadata.summary === undefined || metadata.firstKeptEntryId === undefined) return;
    const signature = this.compactionSignature(metadata.summary, metadata.firstKeptEntryId, metadata.tokensBefore);
    if (this.ambiguousCompactionSignatures.has(signature)) return;
    const previous = this.compactionReasonSignatures.get(signature);
    if (previous !== undefined && previous !== metadata.reason) {
      this.compactionReasonSignatures.delete(signature);
      this.ambiguousCompactionSignatures.add(signature);
      return;
    }
    this.compactionReasonSignatures.set(signature, metadata.reason);
  }

  private compactionSignature(summary: string, firstKeptEntryId: string, tokensBefore: number): string {
    return `${firstKeptEntryId}\u0000${tokensBefore}\u0000${summary}`;
  }
  /** Render an upstream CustomMessageEntry without turning it into a model message. */
  private renderCustomMessage(entry: CustomMessageEntry, width: number): string[] {
    const bodyRows: string[] = [];
    if (typeof entry.content === "string") {
      if (entry.content.trim()) bodyRows.push(...wrapTextWithAnsi(entry.content.trim(), Math.max(1, width - 4)));
    } else if (Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (part.type === "text") {
          if (part.text.trim()) bodyRows.push(...wrapTextWithAnsi(part.text.trim(), Math.max(1, width - 4)));
        } else {
          // The string-only viewer cannot draw terminal graphics, but retaining
          // the MIME identity makes every image content block visible without
          // dumping its potentially huge base64 payload into the transcript.
          bodyRows.push(`[image ${part.mimeType}]`);
        }
      }
    }

    const rows = [this.theme.fg("customMessageLabel", `[${entry.customType}]`), ...bodyRows];
    const styledRows = rows.map((line, index) => {
      const color = index === 0 ? "customMessageLabel" : "customMessageText";
      const padded = ` ${line} `;
      const fill = " ".repeat(Math.max(0, width - visibleWidth(padded)));
      return this.theme.bg("customMessageBg", this.theme.fg(color, padded + fill));
    });
    const fill = this.theme.bg("customMessageBg", " ".repeat(width));
    return [fill, ...styledRows, fill, ""];
  }

  /** Wrap text to the inner width and return each line as a tool-output row with bg padding. */
  private wrapToolOutput(bg: string, text: string, width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    for (const wl of wrapTextWithAnsi(text, width - 4)) {
      const pad = Math.max(0, width - visibleWidth(`  ${wl} `));
      lines.push(th.bg(bg, th.fg("toolOutput", `  ${wl}${" ".repeat(pad)}`)));
    }
    return lines;
  }

  /** Wrap inner lines with bg-filled top and bottom padding. */
  private wrapInBg(bg: string, inner: string[], width: number): string[] {
    const fill = this.theme.bg(bg, " ".repeat(width));
    return [fill, ...inner, fill];
  }

  private renderUserMessage(msg: any, width: number): string[] {
    const th = this.theme;
    const text = typeof msg.content === "string"
      ? msg.content
      : extractText(msg.content);
    if (!text.trim()) return [];
    const wrapped = wrapTextWithAnsi(text.trim(), width - 2);
    const inner: string[] = [];
    for (const line of wrapped) {
      const padNeeded = Math.max(0, width - 2 - visibleWidth(line));
      inner.push(th.bg("userMessageBg", th.fg("userMessageText", ` ${line}${" ".repeat(padNeeded)} `)));
    }
    return [...this.wrapInBg("userMessageBg", inner, width), ""];
  }

  private renderAssistantMessage(
    msg: any,
    width: number,
    toolResults: Map<string, { content: unknown[]; isError: boolean; toolName?: string }>,
    renderedToolResults: Set<string>,
  ): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<{ id?: string; name: string; args?: Record<string, unknown> }> = [];
    for (const c of msg.content) {
      if (c.type === "text" && c.text) textParts.push(c.text);
      else if (c.type === "thinking" && c.thinking) thinkingParts.push(c.thinking);
      else if (c.type === "toolCall") {
        toolCalls.push({ id: c.id, name: c.name, args: c.arguments });
      }
    }
    // Thinking blocks — italic Markdown, matching Pi's assistant-message.ts
    if (thinkingParts.length > 0) {
      const md = new Markdown(thinkingParts.join("\n\n").trim(), 1, 0, makeMarkdownTheme(th), {
        color: (text: string) => th.fg("thinkingText", text),
        italic: true,
      });
      lines.push(...md.render(width));
      lines.push("");
    }
    // Assistant text
    if (textParts.length > 0) {
      const md = new Markdown(textParts.join("\n\n").trim(), 1, 0, makeMarkdownTheme(th));
      const textLines = md.render(width);
      if (textLines.length > 0) {
        lines.push(...textLines);
        lines.push("");
      }
    }
    // Tool calls
    for (const tc of toolCalls) {
      lines.push(...this.renderToolCall(tc, width, toolResults, renderedToolResults));
      lines.push("");
    }
    return lines;
  }

  private renderToolResult(msg: any, width: number, assistantToolCallIds: Set<string>): string[] {
    // A result with a matching assistant call is always rendered inline by
    // that call. This remains correct when the assistant row came from cache.
    if (msg.toolCallId && assistantToolCallIds.has(msg.toolCallId)) return [];
    const th = this.theme;
    const text = extractText(msg.content);
    if (!text.trim()) return [];
    const bg = msg.isError ? "toolErrorBg" : "toolSuccessBg";
    const name = msg.toolName ?? "tool";
    const toolLine = ` ${th.bold(name)} `;
    const titlePad = Math.max(0, width - visibleWidth(toolLine));
    const inner = [th.bg(bg, th.fg("toolTitle", `${toolLine}${" ".repeat(titlePad)}`))];
    inner.push(...this.wrapToolOutput(bg, text.trim(), width));
    return [...this.wrapInBg(bg, inner, width), ""];
  }

  private renderToolCall(
    tc: { id?: string; name: string; args?: Record<string, unknown> },
    width: number,
    toolResults: Map<string, { content: unknown[]; isError: boolean; toolName?: string }>,
    renderedToolResults: Set<string>,
  ): string[] {
    const th = this.theme;
    const argsSummary = tc.args ? summarizeToolArgs(tc.name, tc.args) : "";
    const label = argsSummary ? `${tc.name}${argsSummary}` : tc.name;
    const result = tc.id ? toolResults.get(tc.id) : undefined;
    const bg = result
      ? (result.isError ? "toolErrorBg" : "toolSuccessBg")
      : "toolPendingBg";
    const inner: string[] = [];
    const toolLine = ` ${th.bold(label)} `;
    for (const tl of wrapTextWithAnsi(toolLine, width - 2)) {
      const padNeeded = Math.max(0, width - visibleWidth(tl));
      inner.push(th.bg(bg, th.fg("toolTitle", `${tl}${" ".repeat(padNeeded)}`)));
    }
    if (result && tc.id) {
      inner.push(th.bg(bg, " ".repeat(width)));
      renderedToolResults.add(tc.id);
      inner.push(...this.renderToolCallResult(result, bg, width));
    }
    return this.wrapInBg(bg, inner, width);
  }

  /** Render the output of a tool call result, with truncation for large outputs. */
  private renderToolCallResult(
    result: { content: unknown[]; isError: boolean },
    bg: string,
    width: number,
  ): string[] {
    const th = this.theme;
    const resultText = extractText(result.content);
    if (!resultText.trim()) return [];

    if (resultText.length > TOOL_RESULT_MAX_CHARS) {
      const resultLines = resultText.split("\n");
      const linesToShow = Math.min(TOOL_RESULT_MAX_LINES, resultLines.length);
      const lines: string[] = [];
      for (let i = 0; i < linesToShow; i++) {
        lines.push(...this.wrapToolOutput(bg, resultLines[i] || " ", width));
      }
      if (resultLines.length > linesToShow) {
        const more = th.fg("dim", `  … ${resultLines.length - linesToShow} more lines`);
        lines.push(th.bg(bg, more + " ".repeat(Math.max(0, width - visibleWidth(more)))));
      }
      return lines;
    }
    return this.wrapToolOutput(bg, resultText.trim(), width);
  }

  /** True for messages represented by displayable SessionManager entries. */
  private isDisplayableMessage(message: ViewerMessage): boolean {
    return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
  }

  /** Queue a message_end row until SessionManager persistence catches up. */
  private queuePendingHistoryMessage(message: ViewerMessage): void {
    if (this.pendingHistoryMessages.some((pending) => pending.message === message)) return;
    this.pendingHistoryMessages.push({
      key: `pending-message:${++this.pendingMessageSequence}`,
      message,
    });
  }

  /** Start a cheap leaf watcher once the live overlay is actually visible. */
  private ensureLeafPolling(): void {
    if (!this.isActive()) return;
    if (this.leafPollTimer !== undefined) return;
    const leafId = this.currentLeafId();
    if (leafId === undefined) return;
    this.observedLeafId = leafId;
    this.leafPollTimer = setInterval(() => this.pollLeaf(), LEAF_POLL_INTERVAL_MS);
  }

  /** Detect branch navigation without asking the manager for its full branch. */
  private pollLeaf(): void {
    if (this.closed || !this.isActive()) {
      this.stopLeafPolling();
      return;
    }
    try {
      const leafId = this.currentLeafId();
      if (leafId === undefined || leafId === this.observedLeafId) return;
      this.observedLeafId = leafId;
      this.invalidateHistoryCache();
      // A lifecycle refresh already owns the next branch/context read. Keep
      // polling's synchronous invalidation, but let that refresh see the new
      // leaf instead of walking the branch a second time.
      if (this.postEventRefreshQueued || this.postEventRefreshRunning) {
        this.queuePostEventRefresh();
        return;
      }
      this.refreshLiveUsageSnapshot();
      this.scheduleRender();
    } catch {
      // A session being torn down must not break the polling lifecycle.
    }
  }

  private stopLeafPolling(): void {
    if (this.leafPollTimer === undefined) return;
    clearInterval(this.leafPollTimer);
    this.leafPollTimer = undefined;
  }

  /** Read the cheap branch revision without reading the branch contents. */
  private currentLeafId(): string | null | undefined {
    try {
      const manager = this.session.sessionManager;
      if (manager && typeof manager.getLeafId === "function") return manager.getLeafId();
    } catch {
      // Legacy session doubles may not expose a usable leaf.
    }
    return undefined;
  }

  /** Whether a pending refresh has the O(1) manager surface needed for a tail attempt. */
  private canAttemptBoundedTail(): boolean {
    if (this.cachedHistoryMode !== "branch") return false;
    if (this.cachedRawBranchCount < 0
      || this.cachedRawBranchIds.length !== this.cachedRawBranchCount
      || this.cachedRawBranchIdSet.size !== this.cachedRawBranchCount
      || this.cachedLeafId !== this.cachedRawBranchLeafId) return false;
    try {
      const manager = this.session.sessionManager as unknown as ViewerSessionManager | undefined;
      return !!manager
        && typeof manager.getLeafEntry === "function"
        && typeof manager.getEntry === "function";
    } catch {
      return false;
    }
  }

  private historyNeedsRefresh(): boolean {
    if (this.cachedHistoryRevision !== this.historyRevision) return true;
    if (!this.cachedHistoryMode) return true;

    if (this.cachedHistoryMode === "branch") {
      const leafId = this.currentLeafId();
      if (leafId !== undefined && leafId !== this.cachedLeafId) return true;
      return false;
    }

    const messages = (this.session.messages ?? []) as ViewerMessage[];
    return messages !== this.cachedMessagesRef || messages.length !== this.cachedMessagesLength;
  }

  /** Project only the active branch's displayable entries; never merge it with messages. */
  private historyItemsFromBranch(branch: SessionEntry[]): ViewerHistoryItem[] {
    const compactions = branch.filter((entry): entry is CompactionEntry => entry.type === "compaction");
    const count = compactions.length;
    const signatureCounts = new Map<string, number>();
    for (const entry of compactions) {
      const signature = this.compactionSignature(entry.summary, entry.firstKeptEntryId, entry.tokensBefore);
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
    }
    let order = 0;
    const items: ViewerHistoryItem[] = [];
    const seen = new Set<string>();
    for (const entry of branch) {
      if (seen.has(entry.id)) continue;
      if (entry.type === "message") {
        seen.add(entry.id);
        items.push({ key: entry.id, kind: "message", message: entry.message });
      } else if (entry.type === "compaction") {
        seen.add(entry.id);
        order++;
        const signature = this.compactionSignature(entry.summary, entry.firstKeptEntryId, entry.tokensBefore);
        items.push({
          key: entry.id,
          kind: "compaction",
          entry,
          order,
          count,
          reason: this.compactionReasons.get(entry.id)
            ?? (signatureCounts.get(signature) === 1 ? this.compactionReasonSignatures.get(signature) : undefined),
        });
      } else if (entry.type === "custom_message" && entry.display) {
        seen.add(entry.id);
        items.push({ key: entry.id, kind: "customMessage", entry });
      } else if (entry.type === "branch_summary") {
        seen.add(entry.id);
        items.push({ key: entry.id, kind: "branchSummary", entry });
      }
    }
    return items;
  }

  /** Fallback for lightweight/legacy session doubles without a session manager. */
  private historyItemsFromMessages(messages: ViewerMessage[]): ViewerHistoryItem[] {
    const compactionMessages = messages.filter((message) => message.role === "compactionSummary");
    const count = compactionMessages.length;
    let order = 0;
    const items: ViewerHistoryItem[] = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === "compactionSummary") {
        order++;
        items.push({
          key: `fallback-compaction:${index}`,
          kind: "compactionFallback",
          summary: message.summary,
          tokensBefore: message.tokensBefore,
          timestamp: message.timestamp,
          order,
          count,
        });
      } else {
        items.push({ key: this.fallbackMessageKey(index, message), kind: "message", message });
      }
    }
    return items;
  }

  private fallbackMessageKey(index: number, message?: ViewerMessage): string {
    if (!message) return `fallback-message:${index}`;
    const rawContent = "content" in message ? message.content : undefined;
    let prefix = "";
    if (typeof rawContent === "string") {
      prefix = rawContent.slice(0, 32);
    } else if (Array.isArray(rawContent)) {
      const first = rawContent[0] as { text?: unknown; type?: unknown } | string | undefined;
      prefix = typeof first === "string"
        ? first.slice(0, 32)
        : first && typeof first.text === "string"
          ? first.text.slice(0, 32)
          : `${rawContent.length}:${String(first?.type ?? "")}`;
    } else if (rawContent != null) {
      prefix = typeof rawContent === "object" ? String((rawContent as { type?: unknown }).type ?? "") : String(rawContent);
    }
    return `fallback-message:${index}:${message.role}:${message.timestamp ?? ""}:${prefix}`;
  }

  private messageToolCallIds(message: ViewerMessage): Set<string> {
    const ids = new Set<string>();
    if (message.role !== "assistant") return ids;
    for (const part of message.content) {
      if (part.type === "toolCall" && part.id) ids.add(part.id);
    }
    return ids;
  }

  /** Compare only references and bounded display metadata; never serialize message content. */
  private historyItemChanged(previous: ViewerHistoryItem, next: ViewerHistoryItem): boolean {
    if (previous.kind !== next.kind) return true;
    if (previous.kind === "message" && next.kind === "message") return previous.message !== next.message;
    if (previous.kind === "customMessage" && next.kind === "customMessage") return previous.entry !== next.entry;
    if (previous.kind === "compaction" && next.kind === "compaction") {
      return previous.entry !== next.entry
        || previous.reason !== next.reason
        || previous.order !== next.order
        || previous.count !== next.count;
    }
    if (previous.kind === "compactionFallback" && next.kind === "compactionFallback") {
      return previous.summary !== next.summary
        || previous.tokensBefore !== next.tokensBefore
        || previous.timestamp !== next.timestamp
        || previous.order !== next.order
        || previous.count !== next.count;
    }
    if (previous.kind === "branchSummary" && next.kind === "branchSummary") return previous.entry !== next.entry;
    return true;
  }

  /** Prefer exact objects, then tool identity, then role/timestamp metadata. */
  private pendingMessageMatchRank(a: ViewerMessage, b: ViewerMessage): number {
    if (a === b) return 3;
    if (a.role !== b.role) return -1;

    const aToolCallId = "toolCallId" in a ? a.toolCallId : undefined;
    const bToolCallId = "toolCallId" in b ? b.toolCallId : undefined;
    const aTimestamp = "timestamp" in a ? a.timestamp : undefined;
    const bTimestamp = "timestamp" in b ? b.timestamp : undefined;
    const timestampsMatch = aTimestamp !== undefined
      && bTimestamp !== undefined
      && aTimestamp === bTimestamp;

    // When both messages carry a tool identity, never fall back to a
    // colliding timestamp if those identities disagree. If one side omitted
    // the optional id, the role/timestamp fallback remains available.
    if (aToolCallId !== undefined && bToolCallId !== undefined) {
      if (aToolCallId !== bToolCallId) return -1;
      return 2;
    }
    return timestampsMatch ? 1 : -1;
  }

  private pendingMessageTimestampKey(message: ViewerMessage): string | undefined {
    const timestamp = "timestamp" in message ? message.timestamp : undefined;
    return timestamp === undefined ? undefined : `${message.role}\u0000${String(timestamp)}`;
  }

  /**
   * Match every provisional message to a message entry in one bounded tail.
   * Exact message identity wins; metadata matching is accepted only when the
   * best existing safe criterion identifies one unused entry. Nothing is
   * consumed here so a failed/ambiguous handoff can use the full fallback.
   */
  private matchPendingMessagesToTail(entries: SessionEntry[]): Map<string, string> | undefined {
    const tailMessages = entries
      .filter((entry): entry is SessionMessageEntry => entry.type === "message" && this.isDisplayableMessage(entry.message))
      .map((entry) => ({ id: entry.id, message: entry.message }));
    const matches = new Map<string, string>();
    const usedEntryIds = new Set<string>();

    // Reserve exact objects first. This prevents a later weak metadata match
    // from stealing the entry belonging to an exact pending object.
    for (const pending of this.pendingHistoryMessages) {
      const exact = tailMessages.filter((candidate) => candidate.message === pending.message);
      if (exact.length > 1) return undefined;
      if (exact.length === 1) {
        const candidate = exact[0]!;
        if (usedEntryIds.has(candidate.id)) return undefined;
        matches.set(pending.key, candidate.id);
        usedEntryIds.add(candidate.id);
      }
    }

    // Resolve the remaining rows one-to-one. A row with multiple equally good
    // candidates is ambiguous even if a later greedy choice could happen to
    // produce a complete matching; the authoritative branch is safer there.
    for (const pending of this.pendingHistoryMessages) {
      if (matches.has(pending.key)) continue;
      const candidates = tailMessages
        .filter((candidate) => !usedEntryIds.has(candidate.id))
        .map((candidate) => ({ candidate, rank: this.pendingMessageMatchRank(pending.message, candidate.message) }))
        .filter((candidate) => candidate.rank > 0);
      if (candidates.length === 0) return undefined;
      const bestRank = Math.max(...candidates.map((candidate) => candidate.rank));
      const best = candidates.filter((candidate) => candidate.rank === bestRank);
      if (best.length !== 1) return undefined;
      const candidate = best[0]!.candidate;
      matches.set(pending.key, candidate.id);
      usedEntryIds.add(candidate.id);
    }

    return matches.size === this.pendingHistoryMessages.length ? matches : undefined;
  }

  /** Add pre-persistence message_end rows, removing them once the real entry appears. */
  private withPendingHistoryMessages(items: ViewerHistoryItem[], weakMatchKeys?: Set<string>): ViewerHistoryItem[] {
    if (this.pendingHistoryMessages.length === 0) return items;

    const matchedPendingKeys = new Set<string>();
    const identityMatchedItems = new Set<ViewerHistoryItem>();
    const pendingByIdentity = new Map<ViewerMessage, { key: string; message: ViewerMessage }>();
    const pendingByToolId = new Map<string, Array<{ key: string; message: ViewerMessage }>>();
    const pendingByTimestamp = new Map<string, Array<{ key: string; message: ViewerMessage }>>();
    const pendingByTimestampWithoutTool = new Map<string, Array<{ key: string; message: ViewerMessage }>>();
    for (const pending of this.pendingHistoryMessages) {
      pendingByIdentity.set(pending.message, pending);
      if ("toolCallId" in pending.message && pending.message.toolCallId !== undefined) {
        const key = `${pending.message.role}\u0000${pending.message.toolCallId}`;
        const matches = pendingByToolId.get(key);
        if (matches) matches.push(pending);
        else pendingByToolId.set(key, [pending]);
      }
      const timestampKey = this.pendingMessageTimestampKey(pending.message);
      if (timestampKey !== undefined) {
        const matches = pendingByTimestamp.get(timestampKey);
        if (matches) matches.push(pending);
        else pendingByTimestamp.set(timestampKey, [pending]);
        if (!("toolCallId" in pending.message) || pending.message.toolCallId === undefined) {
          const withoutTool = pendingByTimestampWithoutTool.get(timestampKey);
          if (withoutTool) withoutTool.push(pending);
          else pendingByTimestampWithoutTool.set(timestampKey, [pending]);
        }
      }
    }

    const messageItems = items.filter((item): item is Extract<ViewerHistoryItem, { kind: "message" }> => item.kind === "message");

    // Resolve identity first so an ambiguous fallback copy cannot consume the
    // pending object which will later be recognized exactly.
    for (const item of messageItems) {
      const pending = pendingByIdentity.get(item.message);
      if (!pending || matchedPendingKeys.has(pending.key)) continue;
      matchedPendingKeys.add(pending.key);
      identityMatchedItems.add(item);
    }

    // Indexed queues keep matching one-to-one while avoiding a scan of every
    // pending message for every persisted row. Cursors skip entries consumed
    // by the identity pass or an earlier row in the same projection.
    const toolCursors = new Map<string, number>();
    const timestampCursors = new Map<string, number>();
    const timestampWithoutToolCursors = new Map<string, number>();
    const takeAvailable = (
      index: Map<string, Array<{ key: string; message: ViewerMessage }>>,
      cursors: Map<string, number>,
      key: string,
    ): { key: string; message: ViewerMessage } | undefined => {
      const candidates = index.get(key);
      if (!candidates) return undefined;
      let cursor = cursors.get(key) ?? 0;
      while (cursor < candidates.length && matchedPendingKeys.has(candidates[cursor]!.key)) cursor++;
      cursors.set(key, cursor);
      const candidate = candidates[cursor];
      if (!candidate) return undefined;
      cursors.set(key, cursor + 1);
      return candidate;
    };

    for (const item of messageItems) {
      if (identityMatchedItems.has(item)) continue;
      const message = item.message;
      let best: { key: string; message: ViewerMessage; rank: number } | undefined;
      if ("toolCallId" in message && message.toolCallId !== undefined) {
        const toolKey = `${message.role}\u0000${message.toolCallId}`;
        const candidate = takeAvailable(pendingByToolId, toolCursors, toolKey);
        if (candidate) best = { ...candidate, rank: 2 };
      }

      // A role/timestamp match is only a safe persistence handoff for a raw
      // entry that was appended since the last branch baseline. Older rows can
      // legitimately share a timestamp with the in-flight message.
      if (!best && (!weakMatchKeys || weakMatchKeys.has(item.key))) {
        const timestampKey = this.pendingMessageTimestampKey(message);
        if (timestampKey !== undefined) {
          const timestampIndex = "toolCallId" in message && message.toolCallId !== undefined
            ? pendingByTimestampWithoutTool
            : pendingByTimestamp;
          const timestampCursorsForMessage = "toolCallId" in message && message.toolCallId !== undefined
            ? timestampWithoutToolCursors
            : timestampCursors;
          const candidate = takeAvailable(timestampIndex, timestampCursorsForMessage, timestampKey);
          if (candidate) best = { ...candidate, rank: 1 };
        }
      }
      if (best) matchedPendingKeys.add(best.key);
    }

    if (matchedPendingKeys.size > 0) {
      this.pendingHistoryMessages = this.pendingHistoryMessages.filter((pending) => !matchedPendingKeys.has(pending.key));
    }
    const pendingItems = this.pendingHistoryMessages.map(({ key, message }) => ({ key, kind: "message" as const, message }));
    return pendingItems.length === 0 ? items : [...items, ...pendingItems];
  }

  /** Project only newly-appended display entries; raw metadata entries are skipped. */
  private historyItemsFromBranchTail(branch: SessionEntry[], start: number): ViewerHistoryItem[] {
    const items: ViewerHistoryItem[] = [];
    for (let index = start; index < branch.length; index++) {
      const entry = branch[index]!;
      if (entry.type === "message") {
        items.push({ key: entry.id, kind: "message", message: entry.message });
      } else if (entry.type === "custom_message" && entry.display) {
        items.push({ key: entry.id, kind: "customMessage", entry });
      } else if (entry.type === "branch_summary") {
        items.push({ key: entry.id, kind: "branchSummary", entry });
      }
    }
    return items;
  }

  /** Rebuild indexes once after a full projection. */
  private rebuildProjectionIndexes(items: ViewerHistoryItem[]): void {
    this.cachedToolResults.clear();
    this.cachedAssistantToolCallKeys.clear();
    this.cachedAssistantToolCallIds.clear();
    this.cachedPendingToolCallIds.clear();
    this.incrementalPendingToolCallRows.clear();
    for (const item of items) {
      if (item.kind !== "message") continue;
      if (item.message.role === "toolResult" && item.message.toolCallId) {
        this.cachedToolResults.set(item.message.toolCallId, item.message);
      }
      if (item.message.role !== "assistant") continue;
      for (const id of this.messageToolCallIds(item.message)) {
        const keys = this.cachedAssistantToolCallKeys.get(id);
        if (keys) keys.add(item.key);
        else this.cachedAssistantToolCallKeys.set(id, new Set([item.key]));
        this.cachedAssistantToolCallIds.add(id);
      }
    }
    for (const id of this.cachedAssistantToolCallKeys.keys()) {
      if (!this.cachedToolResults.has(id)) this.cachedPendingToolCallIds.add(id);
    }
  }

  /** Extend indexes for a safe tail without revisiting historical items. */
  private extendProjectionIndexes(items: ViewerHistoryItem[]): void {
    const touchedIds = new Set<string>();
    for (const item of items) {
      if (item.kind !== "message") continue;
      if (item.message.role === "toolResult" && item.message.toolCallId) {
        this.cachedToolResults.set(item.message.toolCallId, item.message);
        touchedIds.add(item.message.toolCallId);
      }
      if (item.message.role !== "assistant") continue;
      for (const id of this.messageToolCallIds(item.message)) {
        const keys = this.cachedAssistantToolCallKeys.get(id);
        if (keys) keys.add(item.key);
        else this.cachedAssistantToolCallKeys.set(id, new Set([item.key]));
        this.cachedAssistantToolCallIds.add(id);
        touchedIds.add(id);
      }
    }
    for (const id of touchedIds) {
      if (this.cachedAssistantToolCallKeys.has(id) && !this.cachedToolResults.has(id)) {
        this.cachedPendingToolCallIds.add(id);
      } else {
        this.cachedPendingToolCallIds.delete(id);
      }
    }
  }

  /**
   * Read a bounded append tail using only SessionManager's O(1) entry lookups.
   * The returned entries are in active-branch order and exclude the cached
   * leaf. Any malformed, ambiguous, or overlong chain is rejected so callers
   * can use the authoritative getBranch() fallback.
   */
  private readAppendTail(): { entries: SessionEntry[]; leafId: string | null } | undefined {
    if (this.cachedHistoryMode !== "branch") return undefined;
    if (this.cachedRawBranchCount < 0 || this.cachedRawBranchIds.length !== this.cachedRawBranchCount) return undefined;
    if (this.cachedRawBranchIdSet.size !== this.cachedRawBranchCount) return undefined;
    if (this.cachedLeafId !== this.cachedRawBranchLeafId) return undefined;

    const manager = this.session.sessionManager as unknown as ViewerSessionManager | undefined;
    if (!manager || typeof manager.getLeafEntry !== "function" || typeof manager.getEntry !== "function") return undefined;

    try {
      const leaf = manager.getLeafEntry();
      const reportedLeafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : undefined;
      if (leaf === undefined) {
        // A null leaf is a valid empty session. It cannot represent a child of
        // a non-empty cached branch, and an absent leaf id is not authoritative.
        if (reportedLeafId !== null || this.cachedRawBranchLeafId !== null) return undefined;
        return { entries: [], leafId: null };
      }
      if (typeof leaf.id !== "string" || leaf.id.length === 0) return undefined;
      if (reportedLeafId !== undefined && reportedLeafId !== leaf.id) return undefined;

      const oldLeafId = this.cachedRawBranchLeafId;
      if (leaf.id === oldLeafId) return { entries: [], leafId: leaf.id };

      const reverseTail: SessionEntry[] = [];
      const tailIds = new Set<string>();
      let current: SessionEntry | undefined = leaf;
      let steps = 0;
      while (current) {
        if (typeof current.id !== "string" || current.id.length === 0) return undefined;
        if (current.id === oldLeafId) {
          const entries = reverseTail.reverse();
          let parentId = oldLeafId;
          for (const entry of entries) {
            if (entry.parentId !== parentId) return undefined;
            parentId = entry.id;
          }
          return { entries, leafId: leaf.id };
        }
        // Seeing any older branch id before the cached leaf means navigation
        // or a rewritten path, not a contiguous append.
        if (this.cachedRawBranchIdSet.has(current.id) || tailIds.has(current.id)) return undefined;
        if (steps >= MAX_APPEND_TAIL_ENTRIES) return undefined;
        tailIds.add(current.id);
        reverseTail.push(current);
        steps++;

        if (current.parentId === null) {
          if (oldLeafId !== null) return undefined;
          const entries = reverseTail.reverse();
          let parentId: string | null = null;
          for (const entry of entries) {
            if (entry.parentId !== parentId) return undefined;
            parentId = entry.id;
          }
          return { entries, leafId: leaf.id };
        }
        if (typeof current.parentId !== "string" || current.parentId.length === 0) return undefined;
        current = manager.getEntry(current.parentId);
      }
    } catch {
      // Disposed managers and legacy doubles use the authoritative fallback.
    }
    return undefined;
  }

  /**
   * Reject append tails whose rows can alter prior projection semantics.
   * New unresolved calls remain eligible so a delayed result can update only
   * that recently appended assistant row. Results targeting older rows still
   * use the full reconciliation path.
   */
  private appendTailIsSafe(
    entries: SessionEntry[],
    transientAssistantToolCallIds = new Set<string>(),
    transientToolResultIds = new Set<string>(),
  ): boolean {
    const tailAssistantCalls = new Map<string, number>();
    const tailToolResults = new Map<string, number>();

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.type === "compaction" || entry.type === "branch_summary") return false;
      if (entry.type !== "message") continue;

      if (entry.message.role === "user") continue;
      if (entry.message.role === "assistant") {
        for (const id of this.messageToolCallIds(entry.message)) {
          // Reusing a historical call/result identity can change an older row.
          if (this.cachedAssistantToolCallIds.has(id) && !transientAssistantToolCallIds.has(id)) return false;
          if (this.cachedToolResults.has(id) && !transientToolResultIds.has(id)) return false;
          if (tailAssistantCalls.has(id)) return false;
          tailAssistantCalls.set(id, index);
        }
        continue;
      }
      if (entry.message.role !== "toolResult" || !entry.message.toolCallId) return false;

      const id = entry.message.toolCallId;
      const targetsIncrementalPending = this.incrementalPendingToolCallRows.has(id);
      if (this.cachedAssistantToolCallIds.has(id)
        && !transientAssistantToolCallIds.has(id)
        && !targetsIncrementalPending) return false;
      if (this.cachedToolResults.has(id) && !transientToolResultIds.has(id)) return false;
      if (tailToolResults.has(id)) return false;
      tailToolResults.set(id, index);
    }

    // Unresolved historical calls may remain pending independently of this
    // tail. The identity checks above still force a full path when a new row
    // actually targets one of those historical calls.
    for (const [id, assistantIndex] of tailAssistantCalls) {
      const resultIndex = tailToolResults.get(id);
      // An unresolved newly appended call is safe: remember its exact row so a
      // later result can update that row without revisiting historical items.
      if (resultIndex !== undefined && resultIndex <= assistantIndex) return false;
    }
    for (const [id, resultIndex] of tailToolResults) {
      const assistantIndex = tailAssistantCalls.get(id);
      if (assistantIndex !== undefined) {
        if (assistantIndex >= resultIndex) return false;
      } else if (!this.incrementalPendingToolCallRows.has(id)) {
        return false;
      }
    }
    return true;
  }

  /** Remove provisional rows/indexes without walking historical projection items. */
  private removePendingProjection(pendingKeys: Set<string>): void {
    if (pendingKeys.size === 0 || this.cachedPendingHistoryCount === 0) return;

    const removed = this.cachedHistoryItems.filter((item) => pendingKeys.has(item.key));
    if (removed.length > 0) {
      this.cachedHistoryItems = this.cachedHistoryItems.filter((item) => !pendingKeys.has(item.key));
      for (const item of removed) {
        this.messageCache.delete(item.key);
        if (item.kind !== "message") continue;
        if (item.message.role === "toolResult" && item.message.toolCallId) {
          const id = item.message.toolCallId;
          if (this.cachedToolResults.get(id) === item.message) this.cachedToolResults.delete(id);
          this.cachedPendingToolCallIds.delete(id);
          if (this.cachedAssistantToolCallKeys.has(id) && !this.cachedToolResults.has(id)) {
            this.cachedPendingToolCallIds.add(id);
          }
        } else if (item.message.role === "assistant") {
          for (const id of this.messageToolCallIds(item.message)) {
            const keys = this.cachedAssistantToolCallKeys.get(id);
            keys?.delete(item.key);
            if (!keys || keys.size === 0) {
              this.cachedAssistantToolCallKeys.delete(id);
              this.cachedAssistantToolCallIds.delete(id);
              this.cachedPendingToolCallIds.delete(id);
            } else if (!this.cachedToolResults.has(id)) {
              this.cachedPendingToolCallIds.add(id);
            }
          }
        }
      }
    }

    if (this.cachedContentLines && this.cachedContentLineKeys.length === this.cachedContentLines.length) {
      const keptLines: string[] = [];
      const keptKeys: string[] = [];
      for (let index = 0; index < this.cachedContentLines.length; index++) {
        if (pendingKeys.has(this.cachedContentLineKeys[index]!)) continue;
        keptLines.push(this.cachedContentLines[index]!);
        keptKeys.push(this.cachedContentLineKeys[index]!);
      }
      this.cachedContentLines.splice(0, this.cachedContentLines.length, ...keptLines);
      this.cachedContentLineKeys.splice(0, this.cachedContentLineKeys.length, ...keptKeys);
      this.cachedNonStreamingCount = keptKeys.filter((key) => key !== "__streaming__").length;
    }
    this.cachedPendingHistoryCount = 0;
  }

  /** Project an append candidate without reading the full branch. */
  private tryProjectAppendTail(width: number): boolean {
    const pendingRefresh = this.historyRefreshKind === "pending";
    if ((!pendingRefresh && this.historyRefreshKind !== "append") || this.cachedHistoryMode !== "branch") return false;
    if (width !== this.cacheMeta.width || this.cachedContentLines === undefined) return false;
    if (this.cachedContentLineKeys.length !== this.cachedContentLines.length) return false;
    if (!pendingRefresh && (this.cachedPendingHistoryCount !== 0 || this.pendingHistoryMessages.length !== 0)) return false;
    if (!pendingRefresh && (this.streamingHandoffMessage !== undefined || this.pendingScrollAnchor?.fromStreaming)) return false;

    const tail = this.readAppendTail();
    if (!tail) return false;

    const pendingMatches = pendingRefresh
      ? this.matchPendingMessagesToTail(tail.entries)
      : new Map<string, string>();
    if (!pendingMatches) return false;

    const transientAssistantToolCallIds = new Set<string>();
    const transientToolResultIds = new Set<string>();
    if (pendingRefresh) {
      for (const pending of this.pendingHistoryMessages) {
        if (!pendingMatches.has(pending.key)) return false;
        if (pending.message.role === "assistant") {
          for (const id of this.messageToolCallIds(pending.message)) transientAssistantToolCallIds.add(id);
        } else if (pending.message.role === "toolResult" && pending.message.toolCallId) {
          transientToolResultIds.add(pending.message.toolCallId);
        }
      }
    }
    if (!this.appendTailIsSafe(tail.entries, transientAssistantToolCallIds, transientToolResultIds)) return false;

    const pendingKeys = new Set(pendingMatches.keys());
    let anchorWasRemapped = false;
    if (pendingRefresh && pendingKeys.size > 0) {
      const anchor = this.pendingScrollAnchor;
      if (anchor && !anchor.fromStreaming) {
        const replacementKey = pendingMatches.get(anchor.key);
        if (replacementKey) {
          this.pendingScrollAnchor = { ...anchor, key: replacementKey };
          anchorWasRemapped = true;
        }
      }
      if (this.streamingHandoffMessage !== undefined) {
        const handoff = this.pendingHistoryMessages.find((pending) => pending.message === this.streamingHandoffMessage);
        const replacementKey = handoff ? pendingMatches.get(handoff.key) : undefined;
        if (replacementKey) this.streamingHandoffKey = replacementKey;
      }
      // A provisional projection, if one was rendered before persistence,
      // must be removed before the durable tail is appended in place.
      this.removePendingProjection(pendingKeys);
    }

    let insertedLines = 0;
    if (tail.entries.length > 0) {
      const tailItems = this.historyItemsFromBranchTail(tail.entries, 0);
      const resolvedIncrementalIds = new Set<string>();
      for (const item of tailItems) {
        if (item.kind === "message" && item.message.role === "toolResult"
          && item.message.toolCallId && this.incrementalPendingToolCallRows.has(item.message.toolCallId)) {
          resolvedIncrementalIds.add(item.message.toolCallId);
        }
      }
      insertedLines = this.appendProjectedTail(tailItems, width);
      const rowUpdates = this.refreshIncrementalAssistantRows(resolvedIncrementalIds, width);
      insertedLines += rowUpdates.reduce((total, update) => total + update.delta, 0);
      const anchor = this.pendingScrollAnchor;
      if (anchor && !anchor.fromStreaming) {
        for (const update of rowUpdates) {
          if (anchor.key === update.key) {
            const offset = Math.min(anchor.offset, Math.max(0, update.newCount - 1));
            anchor.index = update.start + offset;
          } else if (update.start < anchor.index) {
            anchor.index += update.delta;
          }
        }
      }
      for (const entry of tail.entries) {
        this.cachedRawBranchIds.push(entry.id);
        this.cachedRawBranchIdSet.add(entry.id);
      }
      this.cachedRawBranchCount += tail.entries.length;
      this.cachedRawBranchLeafId = tail.leafId;
    }
    if (pendingRefresh) {
      this.pendingHistoryMessages = [];
    }
    this.cachedHistoryMode = "branch";
    this.cachedLeafId = tail.leafId;
    this.cachedMessagesRef = (this.session.messages ?? []) as ViewerMessage[];
    this.cachedMessagesLength = this.cachedMessagesRef.length;
    this.cachedPendingHistoryCount = 0;
    this.cachedHistoryRevision = this.historyRevision;
    this.historyRefreshKind = "none";
    this.observedLeafId = tail.leafId;
    this.refreshCheapUsageSnapshot();
    this.restoreAppendScrollAnchor(insertedLines, width, anchorWasRemapped);
    return true;
  }

  /** Re-render only recently appended assistant rows whose delayed results arrived. */
  private refreshIncrementalAssistantRows(
    resolvedIds: Set<string>,
    width: number,
  ): Array<{ key: string; start: number; newCount: number; delta: number }> {
    if (resolvedIds.size === 0 || !this.cachedContentLines) return [];

    const rows = new Map<string, { message: ViewerMessage; start: number; count: number }>();
    for (const id of resolvedIds) {
      const row = this.incrementalPendingToolCallRows.get(id);
      if (row) rows.set(row.key, row);
    }

    const updates: Array<{ key: string; start: number; newCount: number; delta: number }> = [];
    for (const [key, row] of [...rows].sort((a, b) => a[1].start - b[1].start)) {
      const newLines = this.renderAssistantMessage(row.message, width, this.cachedToolResults, new Set<string>());
      const delta = newLines.length - row.count;
      this.cachedContentLines.splice(row.start, row.count, ...newLines);
      this.cachedContentLineKeys.splice(row.start, row.count, ...newLines.map(() => key));
      this.messageCache.set(key, newLines);
      this.cachedNonStreamingCount += delta;
      updates.push({ key, start: row.start, newCount: newLines.length, delta });

      for (const pendingRow of this.incrementalPendingToolCallRows.values()) {
        if (pendingRow.key === key) {
          pendingRow.start = row.start;
          pendingRow.count = newLines.length;
        } else if (pendingRow.start > row.start) {
          pendingRow.start += delta;
        }
      }
    }
    for (const id of resolvedIds) this.incrementalPendingToolCallRows.delete(id);
    return updates;
  }

  /** Append rendered tail rows in place, keeping the streaming suffix last. */
  private appendProjectedTail(items: ViewerHistoryItem[], width: number): number {
    if (items.length === 0) return 0;
    const oldNonStreamingCount = this.cachedNonStreamingCount;
    const wasWaiting = this.cachedHistoryItems.length === 0;
    this.cachedHistoryItems.push(...items);
    this.extendProjectionIndexes(items);

    const tailLines: string[] = [];
    const tailKeys: string[] = [];
    const pendingRows: Array<{ item: Extract<ViewerHistoryItem, { kind: "message" }>; offset: number; count: number }> = [];
    const renderedToolResults = new Set<string>();
    for (const item of items) {
      const itemOffset = tailLines.length;
      const cached = this.messageCache.get(item.key);
      let itemLines = cached;
      if (itemLines === undefined) {
        switch (item.kind) {
          case "message":
            switch (item.message.role) {
              case "user": itemLines = this.renderUserMessage(item.message, width); break;
              case "assistant": itemLines = this.renderAssistantMessage(item.message, width, this.cachedToolResults, renderedToolResults); break;
              case "toolResult": itemLines = this.renderToolResult(item.message, width, this.cachedAssistantToolCallIds); break;
              default: itemLines = []; break;
            }
            break;
          case "customMessage": itemLines = this.renderCustomMessage(item.entry, width); break;
          case "compaction": itemLines = []; break;
          case "compactionFallback": itemLines = []; break;
          case "branchSummary": itemLines = this.renderBranchSummaryMarker(item.entry, width); break;
        }
        this.messageCache.set(item.key, itemLines);
      }
      tailLines.push(...itemLines);
      for (let line = 0; line < itemLines.length; line++) tailKeys.push(item.key);
      if (item.kind === "message" && item.message.role === "assistant") {
        const unresolved = [...this.messageToolCallIds(item.message)]
          .some((id) => !this.cachedToolResults.has(id));
        if (unresolved) pendingRows.push({ item, offset: itemOffset, count: itemLines.length });
      }
    }

    if (!this.cachedContentLines) return 0;
    let nonStreamingCount = this.cachedNonStreamingCount;
    if (wasWaiting && this.cachedContentLineKeys[0] === "__waiting__") {
      this.cachedContentLines.splice(0, 1);
      this.cachedContentLineKeys.splice(0, 1);
      nonStreamingCount--;
    }
    this.cachedContentLines.length = nonStreamingCount;
    this.cachedContentLineKeys.length = nonStreamingCount;
    this.cachedContentLines.push(...tailLines);
    this.cachedContentLineKeys.push(...tailKeys);
    this.cachedNonStreamingCount = nonStreamingCount + tailLines.length;
    for (const row of pendingRows) {
      for (const id of this.messageToolCallIds(row.item.message)) {
        if (!this.cachedToolResults.has(id)) {
          this.incrementalPendingToolCallRows.set(id, {
            key: row.item.key,
            message: row.item.message,
            start: nonStreamingCount + row.offset,
            count: row.count,
          });
        }
      }
    }
    const streamingLines = this.buildStreamingLines(width);
    this.cachedContentLines.push(...streamingLines);
    this.cachedContentLineKeys.push(...streamingLines.map(() => "__streaming__"));
    return this.cachedNonStreamingCount - oldNonStreamingCount;
  }

  /** Restore an append anchor using the known inserted line count, except for handoffs. */
  private restoreAppendScrollAnchor(insertedLines: number, width: number, anchorWasRemapped = false): void {
    const anchor = this.pendingScrollAnchor;
    if (anchor && (anchor.fromStreaming || anchorWasRemapped)) {
      this.restoreScrollAnchor(this.cachedContentLineKeys, width);
      return;
    }
    if (!anchor) {
      this.streamingHandoffKey = undefined;
      this.streamingHandoffMessage = undefined;
      return;
    }
    const maxScroll = Math.max(0, this.cachedContentLineKeys.length - this.viewportHeight());
    const candidate = anchor.key === "__waiting__"
      ? Math.max(0, this.cachedContentLineKeys.length - this.viewportHeight() - anchor.bottomDistance)
      : anchor.index + (anchor.fromStreaming ? insertedLines : 0);
    this.scrollOffset = Math.min(candidate, maxScroll);
    this.pendingScrollAnchor = undefined;
    this.streamingHandoffKey = undefined;
    this.streamingHandoffMessage = undefined;
    if (this.manualNavigationFinalizationPending) {
      this.suppressStreamingAnchorAfterManualNavigation = false;
      this.manualNavigationFinalizationPending = false;
    }
  }

  private refreshHistoryProjection(width: number, widthChanged: boolean): void {
    const previousItems = this.cachedHistoryItems;
    const currentLeafId = this.currentLeafId();

    // Append and post-persistence pending hints are deliberately attempted
    // before any branch/context read. A failed O(1) validation is conservative:
    // discard a possibly stale constructor prefetch and use the full path.
    if (!widthChanged && (this.historyRefreshKind === "append" || this.historyRefreshKind === "pending")) {
      if (this.tryProjectAppendTail(width)) {
        this.prefetchedBranch = undefined;
        this.initialBranchPrefetchNeedsValidation = false;
        return;
      }
      this.prefetchedBranch = undefined;
      this.initialBranchPrefetchNeedsValidation = false;
    }

    const prefetched = this.prefetchedBranch;
    let branch: SessionEntry[] | undefined;

    // A context sample can be prefetched before the first render. Never use it
    // after navigation has moved the leaf; the replacement branch also owns
    // the live usage sample used by the header.
    if (prefetched && (
      (currentLeafId !== undefined && currentLeafId === prefetched.leafId)
      || (currentLeafId === undefined && !this.initialBranchPrefetchNeedsValidation)
    )) {
      branch = prefetched.entries;
    } else {
      branch = this.readCurrentBranch();
      if (branch !== undefined) {
        this.refreshUsageSnapshotFromBranch(branch);
      } else {
        this.prefetchedBranch = undefined;
        if (this.isActive()) {
          const snapshot = getSessionUsageSnapshot(this.session);
          if (snapshot) this.liveUsageSnapshot = snapshot;
        }
      }
    }
    this.prefetchedBranch = undefined;
    this.initialBranchPrefetchNeedsValidation = false;

    // AgentManager records the exact entry id once compaction persistence has
    // completed. Resync that metadata immediately before projection so a live
    // duplicate signature cannot make reasons stick to the wrong marker.
    this.syncCompactionMetadata();

    let mode: "branch" | "messages";
    let baseItems: ViewerHistoryItem[];
    const messages = (this.session.messages ?? []) as ViewerMessage[];
    if (branch !== undefined) {
      mode = "branch";
      baseItems = this.historyItemsFromBranch(branch);
    } else {
      mode = "messages";
      baseItems = this.historyItemsFromMessages(messages);
    }
    let weakPendingMatchKeys: Set<string> | undefined;
    if (branch !== undefined && this.cachedRawBranchCount >= 0) {
      weakPendingMatchKeys = new Set<string>();
      for (let index = this.cachedRawBranchCount; index < branch.length; index++) {
        weakPendingMatchKeys.add(branch[index]!.id);
      }
    }
    const items = this.withPendingHistoryMessages(baseItems, weakPendingMatchKeys);

    // The fallback source exposes a mutable messages array and lightweight test
    // sessions may mutate message objects in place. An invalidating event is
    // the only reliable freshness signal, so conservatively rebuild all
    // fallback rows instead of serializing every message to detect changes.
    if (mode === "messages") this.messageCache.clear();

    this.reconcileHistoryCache(items, previousItems);
    this.rebuildProjectionIndexes(items);
    this.cachedHistoryItems = items;
    this.cachedHistoryMode = mode;
    this.cachedLeafId = branch !== undefined ? this.branchLeafId(branch) : currentLeafId;
    if (currentLeafId !== undefined) this.observedLeafId = currentLeafId;
    else if (this.cachedLeafId !== undefined) this.observedLeafId = this.cachedLeafId;
    this.cachedMessagesRef = messages;
    this.cachedMessagesLength = messages.length;
    this.cachedPendingHistoryCount = this.pendingHistoryMessages.length;
    this.cachedCompactionCount = mode === "branch"
      ? branch!.reduce((count, entry) => count + (entry.type === "compaction" ? 1 : 0), 0)
      : items.reduce((count, item) => count + (item.kind === "compactionFallback" ? 1 : 0), 0);

    if (mode === "branch") {
      this.cachedRawBranchCount = branch!.length;
      this.cachedRawBranchLeafId = this.branchLeafId(branch!);
      this.cachedRawBranchIds = branch!.map((entry) => entry.id);
      this.cachedRawBranchIdSet = new Set(this.cachedRawBranchIds);
    } else {
      this.cachedRawBranchCount = -1;
      this.cachedRawBranchLeafId = undefined;
      this.cachedRawBranchIds = [];
      this.cachedRawBranchIdSet.clear();
    }

    // message_end is delivered before appendMessage(). Keep the projection
    // dirty until the real entry is observable, so a render immediately after
    // persistence cannot leave the provisional row in place. Retain the
    // pending hint too: a later render can retry the bounded tail after a
    // timer happened to run before persistence caught up.
    const hasPendingHistory = this.pendingHistoryMessages.length > 0;
    this.cachedHistoryRevision = hasPendingHistory ? this.historyRevision - 1 : this.historyRevision;
    this.cachedContentLines = undefined;
    this.historyRefreshKind = hasPendingHistory ? "pending" : "none";

    if (this.streamingHandoffMessage) {
      const exact = items.find((item) => item.kind === "message" && item.message === this.streamingHandoffMessage);
      const target = exact ?? items.find((item) =>
        (!weakPendingMatchKeys || weakPendingMatchKeys.has(item.key))
        && item.kind === "message"
        && this.pendingMessageMatchRank(item.message, this.streamingHandoffMessage!) >= 0,
      );
      this.streamingHandoffKey = target?.key;
    }
  }

  private reconcileHistoryCache(items: ViewerHistoryItem[], previousItems: ViewerHistoryItem[]): void {
    const newKeys = new Set(items.map((item) => item.key));
    for (const key of this.messageCache.keys()) {
      if (!newKeys.has(key)) this.messageCache.delete(key);
    }
    const oldItemsByKey = new Map(previousItems.map((item) => [item.key, item]));
    for (const item of items) {
      const previous = oldItemsByKey.get(item.key);
      if (previous && this.historyItemChanged(previous, item)) this.messageCache.delete(item.key);
    }

    const oldResults = new Map<string, ViewerMessage>();
    for (const item of previousItems) {
      if (item.kind === "message" && item.message.role === "toolResult" && item.message.toolCallId) {
        oldResults.set(item.message.toolCallId, item.message);
      }
    }
    const newResults = new Map<string, ViewerMessage>();
    for (const item of items) {
      if (item.kind === "message" && item.message.role === "toolResult" && item.message.toolCallId) {
        newResults.set(item.message.toolCallId, item.message);
      }
    }
    const changedResultIds = new Set<string>();
    for (const id of new Set([...oldResults.keys(), ...newResults.keys()])) {
      if (oldResults.get(id) !== newResults.get(id)) changedResultIds.add(id);
    }
    if (changedResultIds.size === 0) return;
    for (const item of items) {
      if (item.kind !== "message" || item.message.role !== "assistant") continue;
      const ids = this.messageToolCallIds(item.message);
      if ([...ids].some((id) => changedResultIds.has(id))) this.messageCache.delete(item.key);
    }
  }

  private renderCompactionMarker(
    summary: string,
    tokensBefore: number,
    timestamp: string | number | undefined,
    order: number,
    count: number,
    reason: CompactionReason | undefined,
    width: number,
  ): string[] {
    const time = timestamp == null ? "time unknown" : this.formatHistoryTime(timestamp);
    const reasonPart = reason ? ` · ${reason}` : "";
    const header = `⟳ compaction ${order}/${count}${reasonPart} · ${formatTokens(tokensBefore)} tokens before · ${time}`;
    const lines = [this.theme.fg("accent", header)];
    if (summary.trim()) {
      for (const line of wrapTextWithAnsi(`summary: ${summary.trim()}`, Math.max(1, width - 2))) {
        lines.push(this.theme.fg("dim", `  ${line}`));
      }
    }
    lines.push("");
    return lines;
  }

  private renderBranchSummaryMarker(entry: BranchSummaryEntry, width: number): string[] {
    const lines = [this.theme.fg("accent", `↪ branch summary · ${this.formatHistoryTime(entry.timestamp)}`)];
    if (entry.summary.trim()) {
      for (const line of wrapTextWithAnsi(`summary: ${entry.summary.trim()}`, Math.max(1, width - 2))) {
        lines.push(this.theme.fg("dim", `  ${line}`));
      }
    }
    lines.push("");
    return lines;
  }

  private formatHistoryTime(timestamp: string | number): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? "time unknown" : date.toISOString().slice(11, 19);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const historyChanged = this.historyNeedsRefresh();
    const widthChanged = width !== this.cacheMeta.width;
    if (historyChanged || widthChanged) {
      if (this.cachedContentLineKeys.length > 0 && !this.pendingScrollAnchor && !this.autoScroll) this.captureScrollAnchor();
      if (historyChanged) this.refreshHistoryProjection(width, widthChanged);
      if (widthChanged) {
        this.messageCache.clear();
        this.cacheMeta.width = width;
        this.cachedContentLines = undefined;
      }
    }

    // Fast path: the projection and width are stable, so only replace the
    // transient suffix. This does not read the branch or inspect old messages.
    if (this.cachedContentLines) {
      // Preserve a transient-row anchor before text_end removes the suffix;
      // message_end will attach it to the finalized assistant row.
      if (!this.pendingScrollAnchor && !this.autoScroll && this.cachedContentLineKeys.length > 0) {
        const anchorIndex = Math.max(0, Math.min(this.scrollOffset, this.cachedContentLineKeys.length - 1));
        if (this.cachedContentLineKeys[anchorIndex] === "__streaming__") this.captureScrollAnchor();
      }
      // Streaming fields are intentionally private, but rebuilding this small
      // suffix also keeps lightweight test/session doubles that mutate them
      // directly correct without touching the cached history projection.
      const streamingLines = this.buildStreamingLines(width);
      this.cachedContentLines.length = this.cachedNonStreamingCount;
      this.cachedContentLines.push(...streamingLines);
      this.cachedContentLineKeys.length = this.cachedNonStreamingCount;
      this.cachedContentLineKeys.push(...streamingLines.map(() => "__streaming__"));
      return this.cachedContentLines;
    }

    const th = this.theme;
    const items = this.cachedHistoryItems;
    const lines: string[] = [];
    const lineKeys: string[] = [];
    const append = (key: string, itemLines: string[]) => {
      lines.push(...itemLines);
      lineKeys.push(...itemLines.map(() => key));
    };

    if (items.length === 0) {
      append("__waiting__", [th.fg("dim", "(waiting for first message...)")]);
    } else {
      const toolResults = this.cachedToolResults;
      const assistantToolCallIds = this.cachedAssistantToolCallIds;
      const renderedToolResults = new Set<string>();

      for (const item of items) {
        const cached = this.messageCache.get(item.key);
        if (cached !== undefined) {
          append(item.key, cached);
          continue;
        }
        let itemLines: string[];
        switch (item.kind) {
          case "message":
            switch (item.message.role) {
              case "user": itemLines = this.renderUserMessage(item.message, width); break;
              case "assistant": itemLines = this.renderAssistantMessage(item.message, width, toolResults, renderedToolResults); break;
              case "toolResult": itemLines = this.renderToolResult(item.message, width, assistantToolCallIds); break;
              default: itemLines = []; break;
            }
            break;
          case "customMessage":
            itemLines = this.renderCustomMessage(item.entry, width);
            break;
          case "compaction":
            itemLines = this.renderCompactionMarker(item.entry.summary, item.entry.tokensBefore, item.entry.timestamp, item.order, item.count, item.reason, width);
            break;
          case "compactionFallback":
            itemLines = this.renderCompactionMarker(item.summary, item.tokensBefore, item.timestamp, item.order, item.count, undefined, width);
            break;
          case "branchSummary":
            itemLines = this.renderBranchSummaryMarker(item.entry, width);
            break;
        }
        this.messageCache.set(item.key, itemLines);
        append(item.key, itemLines);
      }
    }

    const streamingLines = this.buildStreamingLines(width);
    this.cachedNonStreamingCount = lines.length;
    lines.push(...streamingLines);
    lineKeys.push(...streamingLines.map(() => "__streaming__"));
    this.cachedContentLines = lines;
    this.cachedContentLineKeys = lineKeys;
    this.restoreScrollAnchor(lineKeys, width);
    if (this.manualNavigationFinalizationPending) {
      this.suppressStreamingAnchorAfterManualNavigation = false;
      this.manualNavigationFinalizationPending = false;
    }
    return lines;
  }

  /** Build just the streaming portion (thinking + text + indicator). */
  private buildStreamingLines(width: number): string[] {
    const lines: string[] = [];
    this.cachedStreamingThinkingLineCount = 0;

    // Streaming thinking text — rendered before text, matching assistant message order
    if (this.streamingThinking.trim()) {
      const thinkingLines = this.ensureThinkingMd().render(width);
      this.cachedStreamingThinkingLineCount = thinkingLines.length;
      lines.push(...thinkingLines);
    }

    // Streaming text — rendered live as deltas arrive
    if (this.streamingText.trim()) {
      lines.push(...this.ensureTextMd().render(width));
    }

    return lines;
  }
}
