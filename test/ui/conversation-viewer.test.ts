/**
 * conversation-viewer.test.ts — Tests for ConversationViewer.
 *
 * Covers:
 *   - Rendering header with status, duration, tool uses, tokens
 *   - Rendering user/assistant/toolResult messages
 *   - Thinking blocks in assistant messages
 *   - Tool result success/error icons
 *   - Tool result truncation at 4000 chars
 *   - Scroll behavior (up/down/pageup/pagedown/g/G)
 *   - Close on q/Esc
 *   - Stop key two-press confirmation ('s')
 *   - Steering composer (Enter opens, sends on Enter, cancels on Esc)
 *   - Auto-scroll behavior
 *   - Event-driven updates via session.subscribe
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn<(callback: (event?: unknown) => void) => () => void>(() => () => {});
const mockRequestRender = vi.fn();

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: vi.fn((data: string, key: string) => {
    const map: Record<string, string[]> = {
      up: ["\x1b[A", "k"],
      down: ["\x1b[B", "j"],
      pageUp: ["\x1b[5~"],
      pageDown: ["\x1b[6~"],
      home: ["\x1b[H"],
      end: ["\x1b[F"],
      enter: ["\r"],
      escape: ["\x1b"],
      q: ["q"],
      s: ["s"],
    };
    return (map[key] ?? [key]).includes(data);
  }),
  Input: class {
    focused = false;
    onSubmit: ((v: string) => void) | undefined;
    onEscape: (() => void) | undefined;
    handleInput(_data: string) {}
    render(_w: number): string[] { return ["> "]; }
  },
  Markdown: class {
    constructor(
      text: string,
      _padX: number,
      _padY: number,
      _theme: any,
      overrides?: { color?: (t: string) => string; italic?: boolean },
    ) {
      this._text = text;
      this._color = overrides?.color ?? ((t: string) => t);
      this._italic = overrides?.italic ?? false;
    }
    _text: string;
    _color: (t: string) => string;
    _italic: boolean;
    setText(text: string) { this._text = text; }
    render(width: number): string[] {
      const lines = this._text.split("\n");
      const result: string[] = [];
      for (const line of lines) {
        let wrapped = line.length > width ? line.slice(0, width) : line;
        if (this._italic) wrapped = wrapped;
        result.push(this._color(wrapped));
      }
      return result;
    }
  },
  truncateToWidth: vi.fn((s: string, w: number) => s.length > w ? s.slice(0, w - 3) + "..." : s),
  visibleWidth: vi.fn((s: string) => s.length),
  wrapTextWithAnsi: vi.fn((text: string, width: number) => {
    const lines = text.split("\n");
    const result: string[] = [];
    for (const line of lines) {
      if (line.length <= width) {
        result.push(line);
      } else {
        let remaining = line;
        while (remaining.length > 0) {
          result.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
      }
    }
    return result;
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const noopTheme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

function makeMockSession(messages: any[] = [], sessionManager?: any) {
  return {
    messages,
    ...(sessionManager ? { sessionManager } : {}),
    subscribe: mockSubscribe,
  } as any;
}

function makeMockRecord(overrides: Partial<any> = {}) {
  return {
    id: "abc12345",
    lifecycle: {
      status: "running",
      startedAt: Date.now() - 30000,
      completedAt: undefined,
    },
    display: {
      type: "builder",
      description: "test agent",
      invocation: { modelName: "sonnet" },
    },
    stats: {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      toolUses: 5,
      turnCount: 10,
      compactionCount: 0,
    },
    execution: { session: makeMockSession() },
    ...overrides,
  } as any;
}

function makeTui() {
  return {
    terminal: { rows: 40, cols: 120 },
    requestRender: mockRequestRender,
  } as any;
}

const pollingViewers = new Set<ConversationViewer>();
function trackPollingViewer(viewer: ConversationViewer): ConversationViewer {
  pollingViewers.add(viewer);
  return viewer;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const viewer of pollingViewers) viewer.dispose();
    pollingViewers.clear();
    vi.useRealTimers();
  });

  describe("subscription", () => {
    it("subscribes to session events on construction", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      expect(session.subscribe).toHaveBeenCalledTimes(1);
    });

    it("requests render on session events", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void;
      mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      // Non-message_update events should not trigger render
      subscriber!({ type: "other" });
      vi.runAllTimers();
      expect(mockRequestRender).toHaveBeenCalledTimes(0);

      // message_update with text_delta should trigger render (debounced)
      subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
      vi.runAllTimers();
      expect(mockRequestRender).toHaveBeenCalledTimes(1);

      // Rapid deltas only trigger one render (debounce coalesces)
      subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
      vi.runAllTimers();
      expect(mockRequestRender).toHaveBeenCalledTimes(2);

      // Clearing text should trigger render
      subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "done" } });
      vi.runAllTimers();
      expect(mockRequestRender).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it("refreshes context after message_end persistence before agent_end", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void;
      mockSubscribe.mockImplementationOnce((cb: (event?: unknown) => void) => {
        subscriber = cb;
        return () => {};
      });

      let persisted = false;
      const session = {
        ...makeMockSession(),
        getContextUsage: () => persisted
          ? { tokens: 40, percent: 40, contextWindow: 100 }
          : { tokens: 20, percent: 20, contextWindow: 100 },
      } as any;
      const record = makeMockRecord({ execution: { session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      expect(viewer.render(200).join("\n")).toContain("20.0%/100");

      // message_end is observed before the upstream synchronous append.
      subscriber!({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      persisted = true;
      vi.advanceTimersByTime(16);

      expect(viewer.render(200).join("\n")).toContain("40.0%/100");
      expect(viewer.render(200).join("\n")).not.toContain("20.0%/100");
      expect(mockRequestRender).toHaveBeenCalledTimes(1);

      // The running viewer has already updated before this later boundary.
      subscriber!({ type: "agent_end", messages: [], willRetry: false });
      viewer.dispose();
    });

    it("coalesces a same-turn message/entry/settled/branch burst into one usage read, branch walk, and render", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void = () => {};
      mockSubscribe.mockImplementationOnce((callback: (event?: unknown) => void) => {
        subscriber = callback;
        return () => {};
      });
      const branch = [
        { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "user", content: "prompt" } },
      ];
      const getBranch = vi.fn(() => branch);
      const getContextUsage = vi.fn(function (this: { sessionManager: { getBranch: () => unknown } }) {
        this.sessionManager.getBranch();
        return { percent: 25, contextWindow: 100 };
      });
      const session = {
        ...makeMockSession([], { getBranch, getLeafId: () => "u1" }),
        getContextUsage,
      } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(200);
      getBranch.mockClear();
      getContextUsage.mockClear();
      mockRequestRender.mockClear();

      subscriber({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "one" }] } });
      subscriber({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "two" }] } });
      for (const type of ["entry_appended", "agent_end", "agent_settled", "branch_changed", "tree_changed"]) {
        subscriber({ type });
      }
      vi.advanceTimersByTime(16);

      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(mockRequestRender).toHaveBeenCalledTimes(1);
      viewer.render(200);
      expect(getBranch).toHaveBeenCalledTimes(1);
      viewer.dispose();
    });

    it("coalesces lifecycle events separated by awaits into one throttle-window refresh", async () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void = () => {};
      mockSubscribe.mockImplementationOnce((callback: (event?: unknown) => void) => {
        subscriber = callback;
        return () => {};
      });

      const finalMessage = { role: "assistant", content: [{ type: "text", text: "persisted final" }] };
      const branch: any[] = [
        { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "user", content: "prompt" } },
      ];
      const getBranch = vi.fn(() => branch);
      let persisted = false;
      const getContextUsage = vi.fn(function (this: { sessionManager: { getBranch: () => unknown } }) {
        this.sessionManager.getBranch();
        return { percent: persisted ? 40 : 20, contextWindow: 100 };
      });
      const session = {
        ...makeMockSession([], { getBranch, getLeafId: () => "a1" }),
        getContextUsage,
      } as any;
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      getBranch.mockClear();
      getContextUsage.mockClear();
      mockRequestRender.mockClear();

      subscriber({ type: "message_end", message: finalMessage });
      await Promise.resolve();
      persisted = true;
      branch.push({ type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T10:00:01.000Z", message: finalMessage });
      subscriber({ type: "agent_end", messages: [finalMessage], willRetry: false });
      await Promise.resolve();
      subscriber({ type: "agent_settled" });
      await Promise.resolve();

      // Awaiting each listener must not let the refresh run before the final
      // lifecycle boundary; the throttle window owns the completed burst.
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(mockRequestRender).not.toHaveBeenCalled();
      vi.advanceTimersByTime(16);

      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(getBranch).toHaveBeenCalledTimes(1);
      expect(mockRequestRender).toHaveBeenCalledTimes(1);
      expect(viewer.render(200).join("\n")).toContain("40.0%/100");
      expect(viewer.render(200).join("\n")).toContain("persisted final");
      expect(getBranch).toHaveBeenCalledTimes(1);
      viewer.dispose();
      vi.useRealTimers();
    });

    it("does not refresh after a queued message_end timer outlives disposal", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void = () => {};
      mockSubscribe.mockImplementationOnce((callback: (event?: unknown) => void) => {
        subscriber = callback;
        return () => {};
      });
      const getContextUsage = vi.fn(() => ({ percent: 25, contextWindow: 100 }));
      const session = { ...makeMockSession(), getContextUsage } as any;
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      getContextUsage.mockClear();

      subscriber({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }] } });
      viewer.dispose();
      vi.advanceTimersByTime(16);

      expect(getContextUsage).not.toHaveBeenCalled();
      expect(mockRequestRender).not.toHaveBeenCalled();
    });

    it("throttles large branch/context refreshes across nearby macrotask turns", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void = () => {};
      mockSubscribe.mockImplementationOnce((callback: (event?: unknown) => void) => {
        subscriber = callback;
        return () => {};
      });

      const makeBranch = (label: string): any[] => Array.from({ length: 500 }, (_, index) => ({
        type: "message",
        id: `${label}-${index}`,
        parentId: index === 0 ? null : `${label}-${index - 1}`,
        timestamp: `2024-01-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        message: { role: "user", content: `${label} history ${index}` },
      }));
      let branch = makeBranch("initial");
      let contextPercent = 20;
      const getBranch = vi.fn(() => branch);
      const getContextUsage = vi.fn(() => ({ percent: contextPercent, contextWindow: 100 }));
      const session = {
        ...makeMockSession([], { getBranch }),
        getContextUsage,
      } as any;
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      getBranch.mockClear();
      getContextUsage.mockClear();
      mockRequestRender.mockClear();

      subscriber({ type: "entry_appended", entry: branch[1] });
      branch = makeBranch("latest");
      contextPercent = 42;
      const emitOnNextMacrotask = (event: unknown): void => {
        setTimeout(() => subscriber(event), 0);
        vi.advanceTimersByTime(0);
      };
      emitOnNextMacrotask({ type: "agent_end", messages: [], willRetry: false });
      emitOnNextMacrotask({ type: "agent_settled" });

      expect(getBranch).not.toHaveBeenCalled();
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(mockRequestRender).not.toHaveBeenCalled();
      // The nearby timer turns above are still inside the first frame window.
      vi.advanceTimersByTime(5);
      expect(getBranch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);

      expect(getBranch).toHaveBeenCalledTimes(1);
      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(mockRequestRender).toHaveBeenCalledTimes(1);
      const text = viewer.render(120).join("\n");
      expect(text).toContain("latest history 499");
      expect(text).not.toContain("initial history 499");
      expect(getBranch).toHaveBeenCalledTimes(1);
      viewer.dispose();
    });

    it("cancels a pending streaming render when a lifecycle refresh is queued", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void = () => {};
      mockSubscribe.mockImplementationOnce((callback: (event?: unknown) => void) => {
        subscriber = callback;
        return () => {};
      });
      const branch = [{
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2024-01-01T10:00:00.000Z",
        message: { role: "user", content: "history" },
      }];
      const getBranch = vi.fn(() => branch);
      const getContextUsage = vi.fn(() => ({ percent: 42, contextWindow: 100 }));
      const session = {
        ...makeMockSession([], { getBranch }),
        getContextUsage,
      } as any;
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      getBranch.mockClear();
      getContextUsage.mockClear();
      mockRequestRender.mockClear();

      subscriber({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streaming" } });
      vi.advanceTimersByTime(90);
      subscriber({ type: "entry_appended", entry: branch[0] });
      vi.advanceTimersByTime(15);
      expect(getBranch).not.toHaveBeenCalled();
      expect(mockRequestRender).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(getBranch).toHaveBeenCalledTimes(1);
      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(mockRequestRender).toHaveBeenCalledTimes(1);
      viewer.dispose();
    });

    it("runs a trailing refresh for an event during refresh and keeps the latest state", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void = () => {};
      mockSubscribe.mockImplementationOnce((callback: (event?: unknown) => void) => {
        subscriber = callback;
        return () => {};
      });

      const beforeBranch: any[] = [{
        type: "message",
        id: "before",
        parentId: null,
        timestamp: "2024-01-01T10:00:00.000Z",
        message: { role: "user", content: "before refresh" },
      }];
      const afterBranch: any[] = [{
        type: "message",
        id: "after",
        parentId: null,
        timestamp: "2024-01-01T10:00:01.000Z",
        message: { role: "user", content: "latest persisted history" },
      }];
      let branch = beforeBranch;
      let leafId = "before";
      let contextPercent = 20;
      let emitDuringRefresh = false;
      const getBranch = vi.fn(() => {
        const snapshot = branch;
        if (emitDuringRefresh) {
          emitDuringRefresh = false;
          branch = afterBranch;
          leafId = "after";
          contextPercent = 42;
          subscriber({ type: "branch_changed" });
        }
        return snapshot;
      });
      const getContextUsage = vi.fn(() => ({ percent: contextPercent, contextWindow: 100 }));
      const session = {
        ...makeMockSession([], { getBranch, getLeafId: () => leafId }),
        getContextUsage,
      } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(120);
      getBranch.mockClear();
      getContextUsage.mockClear();
      mockRequestRender.mockClear();
      emitDuringRefresh = true;

      subscriber({ type: "entry_appended", entry: beforeBranch[0] });
      vi.advanceTimersByTime(16);
      // The throttle callback refreshes safe-append header telemetry without a
      // branch walk. The TUI render performs the bounded tail attempt/fallback.
      expect(getBranch).not.toHaveBeenCalled();
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(mockRequestRender).toHaveBeenCalledTimes(1);
      viewer.render(120);
      expect(getBranch).toHaveBeenCalledTimes(1);
      expect(getContextUsage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(15);
      expect(getBranch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);

      expect(getBranch).toHaveBeenCalledTimes(2);
      expect(getContextUsage).toHaveBeenCalledTimes(2);
      expect(mockRequestRender).toHaveBeenCalledTimes(2);
      const text = viewer.render(120).join("\n");
      expect(text).toContain("42.0%/100");
      expect(text).toContain("latest persisted history");
      expect(text).not.toContain("before refresh");
      viewer.dispose();
    });

    it("stops processing events after close", () => {
      let subscriber: () => void;
      mockSubscribe.mockImplementation((cb: () => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();
      const done = vi.fn();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done);

      // Close the viewer (via q key)
      viewer.handleInput("q");
      subscriber!();
      // Should not request render after close
      expect(mockRequestRender).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("closes on 'q' key", () => {
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done);
      viewer.handleInput("q");
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape", () => {
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done);
      viewer.handleInput("\x1b");
      expect(done).toHaveBeenCalledTimes(1);
    });
  });

  describe("stop two-press confirmation", () => {
    it("requires two 's' presses to stop", () => {
      const onStop = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, onStop);

      // First 's' — arms the stop
      viewer.handleInput("s");
      expect(onStop).not.toHaveBeenCalled();

      // Second 's' — confirms
      viewer.handleInput("s");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("disarms stop on other key press", () => {
      const onStop = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, onStop);

      viewer.handleInput("s"); // arm
      viewer.handleInput("g"); // disarm (jump to top)
      viewer.handleInput("s"); // arm again (not confirm)
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not stop when agent is not running", () => {
      const onStop = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "completed", startedAt: Date.now() - 10000, completedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, onStop);

      viewer.handleInput("s");
      viewer.handleInput("s");
      expect(onStop).not.toHaveBeenCalled();
    });
  });

  describe("steering", () => {
    it("opens composer on Enter when steerable", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r");

      // Composer should be open (internal state)
      const composer = (viewer as any).composer;
      expect(composer).toBeDefined();
    });

    it("sends steer message on composer submit", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r"); // open composer

      // Simulate submit
      const composer = (viewer as any).composer;
      composer.onSubmit("do this thing");

      expect(onSteer).toHaveBeenCalledWith("do this thing");
    });

    it("does not open composer when agent is not running", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "completed", startedAt: Date.now() - 10000, completedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r");

      const composer = (viewer as any).composer;
      expect(composer).toBeUndefined();
    });

    it("cancels composer on Escape", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r"); // open composer

      const composer = (viewer as any).composer;
      composer.onEscape();

      expect((viewer as any).composer).toBeUndefined();
    });
  });

  describe("scroll behavior", () => {
    it("scrolls down on down arrow", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(3000) }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      (viewer as any).lastInnerW = 116; // normally set by render()
      const initialOffset = (viewer as any).scrollOffset;
      (viewer as any).autoScroll = false; // disable auto-scroll to test raw scroll

      viewer.handleInput("\x1b[B");
      expect((viewer as any).scrollOffset).toBe(initialOffset + 1);
    });

    it("scrolls up on up arrow", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(200) }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      (viewer as any).scrollOffset = 5;

      viewer.handleInput("\x1b[A");
      expect((viewer as any).scrollOffset).toBe(4);
    });

    it("jumps to top on 'g'", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(200) }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      (viewer as any).scrollOffset = 10;

      viewer.handleInput("g");
      expect((viewer as any).scrollOffset).toBe(0);
    });

    it("jumps to bottom on 'G'", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(500) }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      viewer.handleInput("G");
      // Should be at max scroll
      const contentLines = (viewer as any).buildContentLines(116);
      const viewportH = (viewer as any).viewportHeight();
      const maxScroll = Math.max(0, contentLines.length - viewportH);
      expect((viewer as any).scrollOffset).toBe(maxScroll);
    });

    it("does not scroll past start", () => {
      const session = makeMockSession([{ role: "user", content: "hello" }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.handleInput("\x1b[A");
      expect((viewer as any).scrollOffset).toBe(0);
    });
  });

  describe("render", () => {
    it("renders border frame", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);

      expect(lines[0]).toMatch(/[╭]/);
      expect(lines[lines.length - 1]).toMatch(/[╰]/);
    });

    it.each([
      ["completed", "✓"],
      ["turn_limited", "✓"],
      ["stopped", "■"],
      ["error", "✗"],
      ["aborted", "✗"],
    ] as const)("uses the shared %s status icon", (status, icon) => {
      const session = makeMockSession();
      const record = makeMockRecord({ lifecycle: { status, startedAt: Date.now() - 30000, completedAt: Date.now() } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      expect(viewer.render(120)[1]).toContain(icon);
    });

    it("honors configured stats visibility in its header", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const viewer = new ConversationViewer(
        makeTui(), session, record, noopTheme, vi.fn(), undefined, undefined, undefined,
        { showTools: false, showTurns: false, showInput: false, showOutput: false, showContext: false, showCost: false, showTime: false },
      );

      const header = viewer.render(120).slice(1, 3).join("\n");
      expect(header).not.toContain("⚙︎");
      expect(header).not.toContain("⟳");
      expect(header).not.toContain("↑");
      expect(header).not.toContain("↓");
      expect(header).not.toContain("$");
    });

    it("uses the shared single-row stats grouping while retaining metadata separators", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      record.display.invocation = { modelName: "sonnet", thinkingLevel: "high", runInBackground: true };
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const statsLine = viewer.render(120).find(line => line.includes("5⚙︎"))!;

      expect(statsLine).toContain("sonnet · high · 5⚙︎  10⟳ · ↑12k ↓8.0k W3.0k $0.024 · 30s");
      expect(statsLine).not.toContain("5⚙︎ · 10⟳");
      expect(statsLine).toContain("10⟳ · ↑12k");
      expect(statsLine).toContain(" · background");
    });

    it("renders the thinking level immediately after the model", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      record.display.invocation = { modelName: "sonnet", thinkingLevel: "high", runInBackground: true };
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const modelLine = viewer.render(120).find(line => line.includes("sonnet"));

      expect(modelLine).toContain("sonnet · high · 5⚙︎");
      expect(modelLine).toContain("background");
    });

    it("uses the session thinking level over stale invocation metadata", () => {
      const session = makeMockSession();
      session.thinkingLevel = "low";
      const record = makeMockRecord({ execution: { session } });
      record.display.invocation = { modelName: "sonnet", thinkingLevel: "high" };
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const statsLine = viewer.render(120).find(line => line.includes("sonnet"));
      expect(statsLine).toContain("sonnet · low · 5⚙︎");
      expect(statsLine).not.toContain("high");
    });

    it("renders concrete thinking without inventing a model", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      record.display.invocation = { thinkingLevel: "high" };
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const statsLine = viewer.render(120).find(line => line.includes("high · 5⚙︎"));

      expect(statsLine).toContain("high · 5⚙︎");
      expect(statsLine).not.toContain("undefined");
    });

    it("does not render an inherited thinking level", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      record.display.invocation = { modelName: "sonnet", thinkingLevel: "inherit" };
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      expect(viewer.render(120).join("\n")).not.toContain("inherit");
    });

    it("renders user messages", () => {
      const session = makeMockSession([{ role: "user", content: "hello world" }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("hello world");
    });

    it("renders assistant messages", () => {
      const session = makeMockSession([{ role: "assistant", content: [{ type: "text", text: "here is the answer" }] }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");
      expect(text).toContain("here is the answer");
    });

    it("renders tool results with success icon", () => {
      const session = makeMockSession([{
        role: "toolResult",
        content: [{ type: "text", text: "file contents here" }],
        toolName: "read",
        isError: false,
      }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("read");
    });

    it("renders tool results with error icon", () => {
      const session = makeMockSession([{
        role: "toolResult",
        content: [{ type: "text", text: "file not found" }],
        toolName: "read",
        isError: true,
      }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("read");
    });

    it("truncates tool results at 500 chars", () => {
      const longContent = "x".repeat(600); // >500 triggers truncation, but preview fits in viewport
      const session = makeMockSession([{
        role: "toolResult",
        content: [{ type: "text", text: longContent }],
        toolName: "bash",
        isError: false,
      }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      // Should show preview of long result
      expect(text).toContain("bash");
      expect(text).toContain("xxxxx");
    });

    it("renders thinking blocks in assistant messages", () => {
      const session = makeMockSession([{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Here is the answer." },
        ],
      }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("Let me think");
    });

    it("shows waiting message when no messages", () => {
      const session = makeMockSession([]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("waiting");
    });

    it("renders worktree label in header when present", () => {
      const session = makeMockSession([{ role: "user", content: "hello" }]);
      const record = makeMockRecord({
        execution: { session },
        display: { ...makeMockRecord().display, worktreeLabel: "feature" },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("@feature");
    });

    it("omits worktree label when not present", () => {
      const session = makeMockSession([{ role: "user", content: "hello" }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).not.toContain("@");
    });

    it("renders the active branch as the primary history source without duplicating tool results", () => {
      const branch = [
        { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "user", content: "active prompt" } },
        { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T10:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read" }] } },
        { type: "message", id: "t1", parentId: "a1", timestamp: "2024-01-01T10:00:02.000Z", message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [{ type: "text", text: "active result" }] } },
      ];
      const session = makeMockSession(
        [{ role: "user", content: "stale fallback history" }],
        { getBranch: () => branch },
      );
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());

      const text = (viewer as any).buildContentLines(116).join("\n");
      expect(text).toContain("active prompt");
      expect(text).toContain("active result");
      expect(text).not.toContain("stale fallback history");
      expect(count(text, "active result")).toBe(1);
    });

    it("renders only visible active-branch custom messages with compact text/image styling", () => {
      const sessionMessages = [{ role: "user", content: "stale model history" }];
      const branch = [
        { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "user", content: "active prompt" } },
        {
          type: "custom_message",
          id: "c1",
          parentId: "u1",
          timestamp: "2024-01-01T10:00:01.000Z",
          customType: "status-update",
          content: [
            { type: "text", text: "visible status" },
            { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
          ],
          display: true,
        },
        {
          type: "custom_message",
          id: "c2",
          parentId: "c1",
          timestamp: "2024-01-01T10:00:02.000Z",
          customType: "hidden-status",
          content: "must stay hidden",
          display: false,
        },
      ];
      const session = makeMockSession(sessionMessages, { getBranch: () => branch });
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());

      const text = (viewer as any).buildContentLines(80).join("\n");
      expect(text).toContain("[status-update]");
      expect(text).toContain("visible status");
      expect(text).toContain("[image image/png]");
      expect(text).not.toContain("hidden-status");
      expect(text).not.toContain("must stay hidden");
      expect(text).not.toContain("stale model history");
      expect(count(text, "visible status")).toBe(1);
      expect(sessionMessages).toEqual([{ role: "user", content: "stale model history" }]);
      viewer.dispose();
    });

    it("renders chronological compaction markers with count, time, tokens, and live reason", () => {
      let listener: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        listener = callback;
        return () => {};
      });
      const branch = [
        { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "user", content: "before" } },
        { type: "compaction", id: "c1", parentId: "u1", timestamp: "2024-01-01T10:01:02.000Z", summary: "first compact", firstKeptEntryId: "u2", tokensBefore: 1_200 },
        { type: "message", id: "u2", parentId: "c1", timestamp: "2024-01-01T10:01:03.000Z", message: { role: "user", content: "after first" } },
        { type: "compaction", id: "c2", parentId: "u2", timestamp: "2024-01-01T10:02:04.000Z", summary: "second compact", firstKeptEntryId: "a2", tokensBefore: 2_300 },
        { type: "message", id: "a2", parentId: "c2", timestamp: "2024-01-01T10:02:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ];
      const session = makeMockSession([], { getBranch: () => branch });
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      listener?.({
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        willRetry: false,
        result: { summary: "first compact", firstKeptEntryId: "u2", tokensBefore: 1_200 },
      });

      const text = (viewer as any).buildContentLines(116).join("\n");
      expect(text).toContain("compaction 1/2");
      expect(text).toContain("compaction 2/2");
      expect(text).toContain("threshold");
      expect(text).toContain("1.2k tokens before");
      expect(text).toContain("10:01:02");
      expect(session.sessionManager.getBranch()).toHaveLength(5);
    });

    it("uses persisted compaction reasons when opened after the event", () => {
      const branch = [
        { type: "compaction", id: "c1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", summary: "first", firstKeptEntryId: "u1", tokensBefore: 1_000 },
        { type: "message", id: "u1", parentId: "c1", timestamp: "2024-01-01T10:00:01.000Z", message: { role: "user", content: "kept" } },
        { type: "compaction", id: "c2", parentId: "u1", timestamp: "2024-01-01T10:00:02.000Z", summary: "second", firstKeptEntryId: "u2", tokensBefore: 2_000 },
        { type: "message", id: "u2", parentId: "c2", timestamp: "2024-01-01T10:00:03.000Z", message: { role: "user", content: "new kept" } },
      ];
      const session = makeMockSession([], { getBranch: () => branch });
      const record = makeMockRecord({
        execution: { session },
        stats: {
          ...makeMockRecord().stats,
          compactionCount: 2,
          compactionReasons: [
            { entryId: "c1", reason: "threshold", tokensBefore: 1_000, summary: "first", firstKeptEntryId: "u1" },
            { entryId: "c2", reason: "overflow", tokensBefore: 2_000, summary: "second", firstKeptEntryId: "u2" },
          ],
        },
      });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());
      const text = (viewer as any).buildContentLines(116).join("\n");

      expect(text).toContain("compaction 1/2 · threshold");
      expect(text).toContain("compaction 2/2 · overflow");
    });

    it("uses a unique signature fallback but leaves ambiguous entries unlabeled", () => {
      const uniqueEntry = { type: "compaction", id: "unique", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", summary: "unique", firstKeptEntryId: "u1", tokensBefore: 1_000 };
      const uniqueSession = makeMockSession([], { getBranch: () => [uniqueEntry] });
      const uniqueRecord = makeMockRecord({
        execution: { session: uniqueSession },
        stats: {
          ...makeMockRecord().stats,
          compactionReasons: [{ reason: "manual", tokensBefore: 1_000, summary: "unique", firstKeptEntryId: "u1" }],
        },
      });
      const uniqueViewer = new ConversationViewer(makeTui(), uniqueSession, uniqueRecord, noopTheme, vi.fn());
      expect((uniqueViewer as any).buildContentLines(116).join("\n")).toContain("compaction 1/1 · manual");

      const duplicate = { ...uniqueEntry, id: "duplicate" };
      const ambiguousSession = makeMockSession([], { getBranch: () => [uniqueEntry, duplicate] });
      const ambiguousRecord = makeMockRecord({
        execution: { session: ambiguousSession },
        stats: {
          ...makeMockRecord().stats,
          compactionReasons: [{ reason: "threshold", tokensBefore: 1_000, summary: "unique", firstKeptEntryId: "u1" }],
        },
      });
      const ambiguousViewer = new ConversationViewer(makeTui(), ambiguousSession, ambiguousRecord, noopTheme, vi.fn());
      const ambiguousText = (ambiguousViewer as any).buildContentLines(116).join("\n");
      expect(ambiguousText).not.toContain("· threshold");
    });

    it("resynchronizes exact live compaction metadata for duplicate signatures", () => {
      let listener: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        listener = callback;
        return () => {};
      });
      const root = {
        type: "message", id: "root", parentId: null, timestamp: "2024-01-01T10:00:00.000Z",
        message: { role: "user", content: "root" },
      };
      const keep1 = {
        type: "message", id: "keep1", parentId: "c1", timestamp: "2024-01-01T10:00:02.000Z",
        message: { role: "user", content: "kept one" },
      };
      const keep2 = {
        type: "message", id: "keep2", parentId: "c2", timestamp: "2024-01-01T10:00:04.000Z",
        message: { role: "user", content: "kept two" },
      };
      const c1 = {
        type: "compaction", id: "c1", parentId: "root", timestamp: "2024-01-01T10:00:01.000Z",
        summary: "same summary", firstKeptEntryId: "keep1", tokensBefore: 1_000,
      };
      const c2 = {
        type: "compaction", id: "c2", parentId: "keep1", timestamp: "2024-01-01T10:00:03.000Z",
        summary: "same summary", firstKeptEntryId: "keep1", tokensBefore: 1_000,
      };
      let branch: any[] = [root];
      let leafId = "root";
      const session = makeMockSession([], {
        getBranch: () => branch,
        getLeafId: () => leafId,
        getLeafEntry: () => branch.find((entry) => entry.id === leafId),
      });
      const record = makeMockRecord({ execution: { session } });
      record.stats.compactionReasons = [];
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn()));
      viewer.render(116);

      branch = [root, c1];
      leafId = "c1";
      record.stats.compactionReasons.push({
        entryId: "c1", reason: "threshold", summary: c1.summary,
        firstKeptEntryId: c1.firstKeptEntryId, tokensBefore: c1.tokensBefore,
      });
      listener?.({
        type: "compaction_end", reason: "threshold", aborted: false,
        result: { summary: c1.summary, firstKeptEntryId: c1.firstKeptEntryId, tokensBefore: c1.tokensBefore },
      });
      branch.push(keep1);
      leafId = "keep1";
      viewer.render(116);

      branch.push(c2);
      leafId = "c2";
      record.stats.compactionReasons.push({
        entryId: "c2", reason: "overflow", summary: c2.summary,
        firstKeptEntryId: c2.firstKeptEntryId, tokensBefore: c2.tokensBefore,
      });
      listener?.({
        type: "compaction_end", reason: "overflow", aborted: false,
        result: { summary: c2.summary, firstKeptEntryId: c2.firstKeptEntryId, tokensBefore: c2.tokensBefore },
      });
      branch.push(keep2);
      leafId = "keep2";
      const text = viewer.render(116).join("\n");

      expect(text).toContain("compaction 1/2 · threshold");
      expect(text).toContain("compaction 2/2 · overflow");
    });

    it("falls back cleanly to session.messages when the manager is unavailable", () => {
      const session = makeMockSession([{ role: "user", content: "fallback prompt" }], {
        getBranch: () => { throw new Error("legacy manager"); },
      });
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      expect((viewer as any).buildContentLines(116).join("\n")).toContain("fallback prompt");
    });

    it("treats a successful empty branch as authoritative over stale session.messages", () => {
      const session = makeMockSession([{ role: "user", content: "stale fallback history" }], {
        getBranch: () => [],
      });
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      const text = (viewer as any).buildContentLines(116).join("\n");

      expect(text).toContain("waiting for first message");
      expect(text).not.toContain("stale fallback history");
    });

    it("uses explicit top/bottom footer labels and preserves the manual anchor while streaming", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(3000) }]);
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      viewer.render(80);
      viewer.handleInput("g");
      expect(viewer.render(80).join("\n")).toContain("top · lines");
      (viewer as any).autoScroll = false;
      (viewer as any).scrollOffset = 5;
      (viewer as any).streamingText = "a\nb\nc";
      (viewer as any).ensureTextMd().setText("a\nb\nc");
      viewer.render(80);
      expect((viewer as any).scrollOffset).toBe(5);
      viewer.handleInput("G");
      expect(viewer.render(80).join("\n")).toContain("bottom");
    });

    it("uses the same logical item anchor after a wrap-width rebuild", () => {
      const session = makeMockSession([
        { role: "user", content: "first".repeat(400) },
        { role: "user", content: "second".repeat(400) },
      ]);
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      viewer.render(80);
      (viewer as any).autoScroll = false;
      const keys = (viewer as any).cachedContentLineKeys as string[];
      const secondKey = keys.find((key) => key.includes("second"))!;
      (viewer as any).scrollOffset = keys.indexOf(secondKey);
      viewer.render(100);
      expect((viewer as any).cachedContentLineKeys[(viewer as any).scrollOffset]).toBe(secondKey);
    });

    it("shows a distinct terminal peak and compaction count for a null current", () => {
      const session = makeMockSession([{ role: "user", content: "hello" }]);
      const record = makeMockRecord({
        lifecycle: { status: "completed", startedAt: 0, completedAt: 1000 },
        execution: { session },
        stats: {
          ...makeMockRecord().stats,
          contextPercent: null,
          contextWindow: 272_000,
          contextStats: { current: null, lastKnown: 80, peak: 120, window: 272_000, count: 3 },
          compactionCount: 1,
        },
      });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      expect(viewer.render(200).join("\n")).toContain("peak ~120.0% estimated peak · ↻1");
    });

    it("prefers the current model window over historical context telemetry", () => {
      const getContextUsage = vi.fn(() => ({ percent: 34, contextWindow: 272_000 }));
      const session = { ...makeMockSession([{ role: "user", content: "hello" }]), getContextUsage } as any;
      const record = makeMockRecord({
        execution: { session },
        stats: {
          ...makeMockRecord().stats,
          contextPercent: 34,
          contextWindow: 272_000,
          contextStats: { current: 34, lastKnown: 34, peak: 34, window: 128_000, count: 1 },
        },
      });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const text = viewer.render(200).join("\\n");
      expect(text).toContain("34.0%/272k");
      expect(text).not.toContain("34.0%/128k");
    });

    it("does not live-read a terminal session during repeated renders", () => {
      const getContextUsage = vi.fn(() => ({ percent: 25, contextWindow: 100 }));
      const getBranch = vi.fn(() => [{
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "terminal history" },
      }]);
      const session = {
        ...makeMockSession([], { getBranch }),
        getContextUsage,
      } as any;
      const record = makeMockRecord({
        lifecycle: { status: "completed", startedAt: 0, completedAt: 1000 },
        execution: { session },
        stats: { ...makeMockRecord().stats, contextPercent: 25, contextWindow: 100 },
      });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());
      getBranch.mockClear();
      getContextUsage.mockClear();

      for (let i = 0; i < 5; i++) viewer.render(200);

      expect(getContextUsage).not.toHaveBeenCalled();
      expect(getBranch).not.toHaveBeenCalled();
      viewer.dispose();
    });

    it("uses the persisted cumulative Pi usage snapshot after completion", () => {
      const session = makeMockSession([{ role: "user", content: "hello" }]);
      const record = makeMockRecord({
        lifecycle: { status: "completed", startedAt: 0, completedAt: 1000 },
        execution: { session },
        stats: {
          lifetimeUsage: { input: 83000, output: 7100, cacheWrite: 12000, cost: 1.262 },
          cacheRead: 1300000,
          latestCacheHitRate: 93.2,
          contextPercent: 23.4,
          contextWindow: 272000,
          autoCompactionEnabled: true,
          usingSubscription: true,
          toolUses: 5,
          turnCount: 10,
          compactionCount: 7,
        },
      });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());
      expect(viewer.render(200).join("\n"))
        .toContain("↑83k ↓7.1k R1.3M W12k CH93.2% $1.262 (sub) 23.4%/272k (auto)");
    });
  });

  describe("caching", () => {
    it("uses only O(1) manager tail lookups for sustained message_end persistence", () => {
      vi.useFakeTimers();
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });

      const manager = SessionManager.inMemory();
      for (let index = 0; index < 400; index++) {
        manager.appendMessage({ role: "user", content: `historical ${index}` } as any);
      }
      const getBranch = vi.spyOn(manager, "getBranch");
      const getLeafEntry = vi.spyOn(manager, "getLeafEntry");
      const getEntry = vi.spyOn(manager, "getEntry");
      const getContextUsage = vi.fn(() => ({ percent: 99, contextWindow: 100 }));
      const session = { ...makeMockSession([], manager), getContextUsage } as any;
      const record = makeMockRecord({ execution: { session } });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn()));
      const renderUserMessage = vi.spyOn(viewer as any, "renderUserMessage");
      viewer.render(120);

      const historyItemsFromBranch = vi.spyOn(viewer as any, "historyItemsFromBranch");
      const reconcileHistoryCache = vi.spyOn(viewer as any, "reconcileHistoryCache");
      const captureScrollAnchor = vi.spyOn(viewer as any, "captureScrollAnchor");
      getBranch.mockClear();
      getLeafEntry.mockClear();
      getEntry.mockClear();
      getContextUsage.mockClear();
      historyItemsFromBranch.mockClear();
      reconcileHistoryCache.mockClear();
      captureScrollAnchor.mockClear();
      renderUserMessage.mockClear();
      const cachedItems = (viewer as any).cachedHistoryItems;
      const cachedLines = (viewer as any).cachedContentLines;
      const cachedLineKeys = (viewer as any).cachedContentLineKeys;
      const cachedRawBranchIdSet = (viewer as any).cachedRawBranchIdSet;

      // A real SessionManager is authoritative for the deep tree. Make any
      // accidental full walk fail loudly after the initial baseline read.
      getBranch.mockImplementation(() => { throw new Error("append path must not call getBranch"); });
      for (let index = 400; index < 412; index++) {
        const message = { role: "user", content: `historical ${index}` };
        // This is the upstream ordering: message_end reaches the viewer before
        // AgentSession persists the same object through SessionManager.
        subscriber?.({ type: "message_end", message });
        manager.appendMessage(message as any);
        // Keep the test beyond the 16ms throttle window while below the leaf
        // poll interval; every projection still has only a one-entry tail.
        vi.advanceTimersByTime(17);
        viewer.render(120);
      }

      expect(getBranch).not.toHaveBeenCalled();
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(getLeafEntry).toHaveBeenCalledTimes(12);
      expect(getEntry).toHaveBeenCalledTimes(12);
      expect(historyItemsFromBranch).not.toHaveBeenCalled();
      expect(reconcileHistoryCache).not.toHaveBeenCalled();
      expect(captureScrollAnchor).not.toHaveBeenCalled();
      expect(renderUserMessage).toHaveBeenCalledTimes(12);
      expect((viewer as any).cachedHistoryItems).toBe(cachedItems);
      expect((viewer as any).cachedContentLines).toBe(cachedLines);
      expect((viewer as any).cachedContentLineKeys).toBe(cachedLineKeys);
      expect((viewer as any).cachedRawBranchIdSet).toBe(cachedRawBranchIdSet);
      expect(cachedRawBranchIdSet).toHaveLength(412);
      expect((viewer as any).cachedContentLines.join("\n")).toContain("historical 411");
    });

    it("uses the authoritative full path for a pending message_end tail", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const branch: any[] = [{
        type: "message", id: "u1", parentId: null, timestamp: 1,
        message: { role: "user", content: "prompt" },
      }];
      let leafId = "u1";
      const session = makeMockSession([], { getBranch: () => branch, getLeafId: () => leafId });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      const historyItemsFromBranch = vi.spyOn(viewer as any, "historyItemsFromBranch");
      const reconcileHistoryCache = vi.spyOn(viewer as any, "reconcileHistoryCache");
      const cachedLines = (viewer as any).cachedContentLines;
      const finalMessage = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "persisted answer" }] };

      subscriber?.({ type: "message_end", message: finalMessage });
      branch.push({ type: "message", id: "a1", parentId: "u1", timestamp: 2, message: finalMessage });
      leafId = "a1";
      viewer.render(100);
      subscriber?.({ type: "agent_end", messages: [finalMessage], willRetry: false });
      viewer.render(100);

      expect(historyItemsFromBranch).toHaveBeenCalledTimes(2);
      expect(reconcileHistoryCache).toHaveBeenCalledTimes(2);
      expect((viewer as any).cachedContentLines).not.toBe(cachedLines);
      expect((viewer as any).cachedContentLines.join("\n")).toContain("persisted answer");
    });

    it("reconciles the real message_end then appendMessage sequence with only bounded tail reads", () => {
      vi.useFakeTimers();
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });

      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: "user", content: "prompt" } as any);
      const getBranch = vi.spyOn(manager, "getBranch");
      const getContextUsage = vi.fn(() => ({ percent: 42, contextWindow: 100 }));
      const session = { ...makeMockSession([], manager), getContextUsage } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      getBranch.mockClear();
      getContextUsage.mockClear();

      const finalMessage = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "persisted answer" }] };
      subscriber?.({ type: "message_end", message: finalMessage });
      manager.appendMessage(finalMessage as any);
      vi.advanceTimersByTime(16);

      const text = viewer.render(100).join("\n");
      expect(getBranch).not.toHaveBeenCalled();
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(count(text, "persisted answer")).toBe(1);
      expect(text).not.toContain("pending-message:");
      expect((viewer as any).pendingHistoryMessages).toHaveLength(0);
      viewer.dispose();
      vi.useRealTimers();
    });

    it("keeps a new assistant tool call/result pair incremental when both are in the tail", () => {
      vi.useFakeTimers();
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });

      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: "user", content: "prompt" } as any);
      const getBranch = vi.spyOn(manager, "getBranch");
      const getContextUsage = vi.fn(() => ({ percent: 42, contextWindow: 100 }));
      const session = { ...makeMockSession([], manager), getContextUsage } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      getBranch.mockClear();
      getContextUsage.mockClear();

      const assistant = { role: "assistant", content: [{ type: "toolCall", id: "new-tool", name: "read", arguments: {} }] };
      const result = { role: "toolResult", toolCallId: "new-tool", toolName: "read", isError: false, content: [{ type: "text", text: "new result" }] };
      subscriber?.({ type: "message_end", message: assistant });
      manager.appendMessage(assistant as any);
      subscriber?.({ type: "message_end", message: result });
      manager.appendMessage(result as any);
      vi.advanceTimersByTime(16);

      const text = viewer.render(100).join("\n");
      expect(getBranch).not.toHaveBeenCalled();
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(count(text, "new result")).toBe(1);
      expect((viewer as any).pendingHistoryMessages).toHaveLength(0);
      viewer.dispose();
      vi.useRealTimers();
    });

    it("updates a delayed tool result on its incrementally appended assistant row", () => {
      vi.useFakeTimers();
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });

      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: "user", content: "prompt" } as any);
      const getBranch = vi.spyOn(manager, "getBranch");
      const getContextUsage = vi.fn(() => ({ percent: 42, contextWindow: 100 }));
      const session = { ...makeMockSession([], manager), getContextUsage } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      const renderAssistant = vi.spyOn(viewer as any, "renderAssistantMessage");
      viewer.render(100);
      getBranch.mockClear();
      getContextUsage.mockClear();
      renderAssistant.mockClear();

      const assistant = { role: "assistant", content: [{ type: "toolCall", id: "slow-tool", name: "read", arguments: {} }] };
      subscriber?.({ type: "message_end", message: assistant });
      manager.appendMessage(assistant as any);
      vi.advanceTimersByTime(17);
      expect(viewer.render(100).join("\n")).toContain("read");
      expect(renderAssistant).toHaveBeenCalledTimes(1);

      const result = { role: "toolResult", toolCallId: "slow-tool", toolName: "read", isError: false, content: [{ type: "text", text: "delayed result" }] };
      subscriber?.({ type: "message_end", message: result });
      manager.appendMessage(result as any);
      vi.advanceTimersByTime(17);

      const text = viewer.render(100).join("\n");
      expect(getBranch).not.toHaveBeenCalled();
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(renderAssistant).toHaveBeenCalledTimes(2);
      expect(count(text, "delayed result")).toBe(1);
      expect((viewer as any).pendingHistoryMessages).toHaveLength(0);
      viewer.dispose();
      vi.useRealTimers();
    });

    it("keeps an unrelated historical pending tool call out of a new safe pair", () => {
      vi.useFakeTimers();
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });

      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: "user", content: "prompt" } as any);
      manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "old-tool", name: "read" }] } as any);
      const getBranch = vi.spyOn(manager, "getBranch");
      const getContextUsage = vi.fn(() => ({ percent: 42, contextWindow: 100 }));
      const session = { ...makeMockSession([], manager), getContextUsage } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      getBranch.mockClear();
      getContextUsage.mockClear();

      const assistant = { role: "assistant", content: [{ type: "toolCall", id: "new-tool", name: "read", arguments: {} }] };
      const result = { role: "toolResult", toolCallId: "new-tool", toolName: "read", isError: false, content: [{ type: "text", text: "new result" }] };
      subscriber?.({ type: "message_end", message: assistant });
      manager.appendMessage(assistant as any);
      subscriber?.({ type: "message_end", message: result });
      manager.appendMessage(result as any);
      vi.advanceTimersByTime(16);

      const text = viewer.render(100).join("\n");
      expect(getBranch).not.toHaveBeenCalled();
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(count(text, "new result")).toBe(1);
      viewer.dispose();
      vi.useRealTimers();
    });

    it("falls back to getBranch when pending tail metadata is ambiguous", () => {
      vi.useFakeTimers();
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });

      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: "user", content: "prompt" } as any);
      const getBranch = vi.spyOn(manager, "getBranch");
      const getContextUsage = vi.fn(() => ({ percent: 42, contextWindow: 100 }));
      const session = { ...makeMockSession([], manager), getContextUsage } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      getBranch.mockClear();
      getContextUsage.mockClear();

      const pendingA = { role: "user", timestamp: 7, content: "pending A" };
      const pendingB = { role: "user", timestamp: 7, content: "pending B" };
      subscriber?.({ type: "message_end", message: pendingA });
      subscriber?.({ type: "message_end", message: pendingB });
      manager.appendMessage({ role: "user", timestamp: 7, content: "persisted one" } as any);
      manager.appendMessage({ role: "user", timestamp: 7, content: "persisted two" } as any);
      vi.advanceTimersByTime(16);

      viewer.render(100);
      expect(getBranch).toHaveBeenCalledTimes(1);
      expect(getContextUsage).toHaveBeenCalledTimes(1);
      viewer.dispose();
      vi.useRealTimers();
    });

    it("falls back to a full projection when a compaction is appended", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const branch: any[] = [{
        type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z",
        message: { role: "user", content: "before compaction" },
      }];
      let leafId = "u1";
      const session = makeMockSession([], { getBranch: () => branch, getLeafId: () => leafId });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      const historyItemsFromBranch = vi.spyOn(viewer as any, "historyItemsFromBranch");
      const reconcileHistoryCache = vi.spyOn(viewer as any, "reconcileHistoryCache");
      branch.push({ type: "compaction", id: "c1", parentId: leafId, timestamp: "2024-01-01T10:00:01.000Z", summary: "compact", firstKeptEntryId: "u2", tokensBefore: 1000 });
      leafId = "c1";
      subscriber?.({ type: "entry_appended", entry: branch[1] });
      const text = viewer.render(100).join("\n");

      expect(historyItemsFromBranch).toHaveBeenCalledTimes(1);
      expect(reconcileHistoryCache).toHaveBeenCalledTimes(1);
      expect(text).toContain("compaction 1/1");
    });

    it("falls back when a tail tool result would change a historical assistant row", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const branch: any[] = [{
        type: "message", id: "a1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read" }] },
      }];
      let leafId = "a1";
      const session = makeMockSession([], { getBranch: () => branch, getLeafId: () => leafId });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      const historyItemsFromBranch = vi.spyOn(viewer as any, "historyItemsFromBranch");
      const reconcileHistoryCache = vi.spyOn(viewer as any, "reconcileHistoryCache");
      branch.push({
        type: "message", id: "r1", parentId: leafId, timestamp: "2024-01-01T10:00:01.000Z",
        message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [{ type: "text", text: "historical result" }] },
      });
      leafId = "r1";
      subscriber?.({ type: "entry_appended", entry: branch[1] });
      const text = viewer.render(100).join("\n");

      expect(historyItemsFromBranch).toHaveBeenCalledTimes(1);
      expect(reconcileHistoryCache).toHaveBeenCalledTimes(1);
      expect(count(text, "historical result")).toBe(1);
    });

    it("falls back on an explicit branch switch even when the new path has a tail", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const root = { type: "message", id: "root", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "user", content: "root" } };
      const first = { type: "message", id: "first", parentId: "root", timestamp: "2024-01-01T10:00:01.000Z", message: { role: "user", content: "first branch" } };
      const second = { type: "message", id: "second", parentId: "root", timestamp: "2024-01-01T10:00:02.000Z", message: { role: "user", content: "second branch" } };
      let branch: any[] = [root, first];
      let leafId = "first";
      const session = makeMockSession([], { getBranch: () => branch, getLeafId: () => leafId });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      const historyItemsFromBranch = vi.spyOn(viewer as any, "historyItemsFromBranch");
      const reconcileHistoryCache = vi.spyOn(viewer as any, "reconcileHistoryCache");
      branch = [root, second];
      leafId = "second";
      subscriber?.({ type: "branch_changed" });
      const text = viewer.render(100).join("\n");

      expect(historyItemsFromBranch).toHaveBeenCalledTimes(1);
      expect(reconcileHistoryCache).toHaveBeenCalledTimes(1);
      expect(text).toContain("second branch");
      expect(text).not.toContain("first branch");
    });

    it("validates an active legacy branch prefetch before the first render", () => {
      const oldBranch = [{
        type: "message", id: "old", parentId: null, timestamp: "2024-01-01T10:00:00.000Z",
        message: { role: "user", content: "OLD PREFETCH" },
      }];
      let branch: any[] = oldBranch;
      const getBranch = vi.fn(() => branch);
      const session = makeMockSession([], { getBranch });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      branch = [{
        type: "message", id: "new", parentId: null, timestamp: "2024-01-01T10:00:01.000Z",
        message: { role: "user", content: "NEW AUTHORITATIVE" },
      }];

      const text = viewer.render(100).join("\n");
      expect(getBranch).toHaveBeenCalledTimes(2);
      expect(text).toContain("NEW AUTHORITATIVE");
      expect(text).not.toContain("OLD PREFETCH");
    });

    it("keeps a pending message when only an older same-timestamp row matches", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const branch = [{
        type: "message", id: "old", parentId: null, timestamp: 42,
        message: { role: "user", timestamp: 42, content: "older row" },
      }];
      const session = makeMockSession([], { getBranch: () => branch, getLeafId: () => "old" });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(100);
      subscriber?.({ type: "message_end", message: { role: "user", timestamp: 42, content: "new pending row" } });

      const text = viewer.render(100).join("\n");
      expect(text).toContain("older row");
      expect(text).toContain("new pending row");
      expect((viewer as any).pendingHistoryMessages).toHaveLength(1);
    });

    it("does not reread or serialize history during unchanged streaming renders", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const branch = [
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2024-01-01T10:00:00.000Z",
          message: { role: "user", content: "large historical prompt" },
        },
      ];
      const getBranch = vi.fn(() => branch);
      const getContextUsage = vi.fn(() => ({ percent: 20, contextWindow: 100 }));
      const session = {
        ...makeMockSession([], {
          getBranch,
          getLeafId: () => "u1",
        }),
        getContextUsage,
      } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));

      viewer.render(80);
      getBranch.mockClear();
      getContextUsage.mockClear();
      const stringify = vi.spyOn(JSON, "stringify");
      const renderUser = vi.spyOn(viewer as any, "renderUserMessage");

      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streaming" } });
      viewer.render(80);
      viewer.render(80);

      expect(getBranch).not.toHaveBeenCalled();
      expect(getContextUsage).not.toHaveBeenCalled();
      expect(stringify).not.toHaveBeenCalled();
      expect(renderUser).not.toHaveBeenCalled();
      stringify.mockRestore();
    });

    it("polls O(1) leaf changes without events and refreshes history plus context", () => {
      vi.useFakeTimers();
      let leafId = "u1";
      let contextPercent = 20;
      let branch: any[] = [
        { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "user", content: "before branch" } },
      ];
      const getBranch = vi.fn(() => branch);
      const getLeafId = vi.fn(() => leafId);
      const getContextUsage = vi.fn(() => ({ percent: contextPercent, contextWindow: 100 }));
      const session = {
        ...makeMockSession([], { getBranch, getLeafId }),
        getContextUsage,
      } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(200);
      getBranch.mockClear();
      getContextUsage.mockClear();
      mockRequestRender.mockClear();

      branch = [{ type: "message", id: "u2", parentId: null, timestamp: "2024-01-01T10:01:00.000Z", message: { role: "user", content: "after branch" } }];
      leafId = "u2";
      contextPercent = 42;
      vi.advanceTimersByTime(250);
      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(getBranch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100);
      expect(mockRequestRender).toHaveBeenCalledTimes(1);

      const text = viewer.render(200).join("\n");
      expect(text).toContain("42.0%/100");
      expect(text).toContain("after branch");
      expect(text).not.toContain("before branch");
      expect(getBranch).toHaveBeenCalledTimes(1);

      viewer.dispose();
      const requestCount = mockRequestRender.mock.calls.length;
      leafId = "u3";
      vi.advanceTimersByTime(1_000);
      expect(mockRequestRender).toHaveBeenCalledTimes(requestCount);
      vi.useRealTimers();
    });

    it("coalesces a leaf poll with a pending lifecycle refresh", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void = () => {};
      mockSubscribe.mockImplementationOnce((callback: (event?: unknown) => void) => {
        subscriber = callback;
        return () => {};
      });
      let leafId = "u1";
      let branch: any[] = [{
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2024-01-01T10:00:00.000Z",
        message: { role: "user", content: "before poll" },
      }];
      const getBranch = vi.fn(() => branch);
      const getLeafId = vi.fn(() => leafId);
      const getContextUsage = vi.fn(() => ({ percent: leafId === "u2" ? 42 : 20, contextWindow: 100 }));
      const session = {
        ...makeMockSession([], { getBranch, getLeafId }),
        getContextUsage,
      } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(120);
      getBranch.mockClear();
      getContextUsage.mockClear();
      mockRequestRender.mockClear();

      vi.advanceTimersByTime(240);
      branch = [{
        type: "message",
        id: "u2",
        parentId: null,
        timestamp: "2024-01-01T10:00:01.000Z",
        message: { role: "user", content: "after poll" },
      }];
      leafId = "u2";
      subscriber({ type: "branch_changed" });
      vi.advanceTimersByTime(10);
      vi.advanceTimersByTime(6);

      expect(getBranch).toHaveBeenCalledTimes(1);
      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(mockRequestRender).toHaveBeenCalledTimes(1);
      expect(viewer.render(120).join("\n")).toContain("after poll");
      expect(getBranch).toHaveBeenCalledTimes(1);
      viewer.dispose();
    });

    it("rejects a constructor prefetch when the leaf changes before the first render", () => {
      let leafId = "u1";
      let contextPercent = 20;
      let branch: any[] = [
        { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "user", content: "before first render" } },
      ];
      const getBranch = vi.fn(() => branch);
      const getLeafId = vi.fn(() => leafId);
      const getContextUsage = vi.fn(() => ({ percent: contextPercent, contextWindow: 100 }));
      const session = {
        ...makeMockSession([], { getBranch, getLeafId }),
        getContextUsage,
      } as any;
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      getBranch.mockClear();
      getContextUsage.mockClear();

      branch = [{ type: "message", id: "u2", parentId: null, timestamp: "2024-01-01T10:01:00.000Z", message: { role: "user", content: "after first render" } }];
      leafId = "u2";
      contextPercent = 42;

      const text = viewer.render(200).join("\n");
      expect(text).toContain("42.0%/100");
      expect(text).toContain("after first render");
      expect(text).not.toContain("before first render");
      expect(getBranch).toHaveBeenCalledTimes(1);
      expect(getContextUsage).toHaveBeenCalledTimes(1);
    });

    it("hands a manual streaming anchor to the finalized persisted assistant row", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      let leafId = "u1";
      const finalMessage = {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "thinking", thinking: "think\n".repeat(25) },
          { type: "text", text: "answer\n".repeat(25) },
        ],
      };
      const branch: any[] = [{
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "history\n".repeat(50) },
      }];
      const session = makeMockSession([], {
        getBranch: () => branch,
        getLeafId: () => leafId,
      });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(80);
      (viewer as any).autoScroll = false;

      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking\n".repeat(25) } });
      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stream\n".repeat(25) } });
      viewer.render(80);
      const streamingStart = (viewer as any).cachedNonStreamingCount as number;
      expect((viewer as any).cachedContentLineKeys[streamingStart]).toBe("__streaming__");
      (viewer as any).scrollOffset = streamingStart + 2;

      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "stream" } });
      subscriber?.({ type: "message_end", message: finalMessage });
      viewer.render(80);

      expect((viewer as any).cachedContentLines.join("\n")).toContain("think");
      expect((viewer as any).cachedContentLines.join("\n")).toContain("answer");
      expect((viewer as any).cachedContentLineKeys).not.toContain("__streaming__");
      expect((viewer as any).cachedContentLineKeys[(viewer as any).scrollOffset]).toBe("pending-message:1");
      expect((viewer as any).cachedContentLines[(viewer as any).scrollOffset]).toContain("answer");

      branch.push({ type: "message", id: "a1", parentId: "u1", timestamp: 2, message: finalMessage });
      leafId = "a1";
      subscriber?.({ type: "agent_end", messages: [finalMessage], willRetry: false });
      viewer.render(80);

      expect((viewer as any).cachedContentLines.join("\n")).toContain("answer");
      expect((viewer as any).cachedContentLineKeys).not.toContain("__streaming__");
      expect((viewer as any).cachedContentLineKeys[(viewer as any).scrollOffset]).toBe("a1");
    });

    it("preserves a thinking-only manual anchor across an empty text phase", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const finalMessage = {
        role: "assistant",
        timestamp: 2,
        content: [{ type: "thinking", thinking: "final think\n".repeat(40) }],
      };
      const branch: any[] = [{
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "history\n".repeat(50) },
      }];
      const session = makeMockSession([], {
        getBranch: () => branch,
        getLeafId: () => "u1",
      });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(80);
      (viewer as any).autoScroll = false;

      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "stream think\n".repeat(25) } });
      viewer.render(80);
      const streamingStart = (viewer as any).cachedNonStreamingCount as number;
      expect((viewer as any).cachedContentLineKeys[streamingStart]).toBe("__streaming__");
      (viewer as any).scrollOffset = streamingStart + 2;

      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
      subscriber?.({ type: "message_end", message: finalMessage });
      viewer.render(80);

      expect((viewer as any).cachedContentLines.join("\n")).toContain("final think");
      expect((viewer as any).cachedContentLineKeys).not.toContain("__streaming__");
      const pendingStart = (viewer as any).cachedContentLineKeys.indexOf("pending-message:1");
      expect((viewer as any).scrollOffset).toBe(pendingStart + 2);
    });

    it("lets manual navigation supersede a captured transient anchor before finalization", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const finalMessage = {
        role: "assistant",
        timestamp: 2,
        content: [{ type: "text", text: "final answer" }],
      };
      const branch: any[] = [{
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "history\n".repeat(50) },
      }];
      const session = makeMockSession([], {
        getBranch: () => branch,
        getLeafId: () => "u1",
      });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      viewer.render(80);
      (viewer as any).autoScroll = false;
      subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stream\n".repeat(30) } });
      viewer.render(80);
      const streamStart = (viewer as any).cachedNonStreamingCount as number;
      (viewer as any).scrollOffset = streamStart + 2;
      viewer.render(80);
      expect((viewer as any).pendingScrollAnchor?.fromStreaming).toBe(true);

      viewer.handleInput("g");
      expect((viewer as any).scrollOffset).toBe(0);
      expect((viewer as any).pendingScrollAnchor).toBeUndefined();

      subscriber?.({ type: "message_end", message: finalMessage });
      viewer.render(80);

      expect((viewer as any).scrollOffset).toBe(0);
      expect((viewer as any).cachedContentLineKeys[(viewer as any).scrollOffset]).toBe("u1");
      expect((viewer as any).cachedContentLines.join("\n")).toContain("final answer");
    });

    it("rerenders an in-place fallback message mutation after a history refresh", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const message = { role: "user", timestamp: 1, content: "unchanged prefix: old content" };
      const messages = [message];
      const session = makeMockSession(messages);
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());

      expect((viewer as any).buildContentLines(116).join("\n")).toContain("old content");
      message.content = "unchanged prefix: new content";
      subscriber?.({ type: "entry_appended", entry: {} });

      const text = (viewer as any).buildContentLines(116).join("\\n");
      expect(text).toContain("new content");
      expect(text).not.toContain("old content");
    });

    it("reconciles colliding pending timestamps one-to-one", () => {
      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        subscriber = callback;
        return () => {};
      });
      const pendingA = { role: "user", timestamp: 10, content: "pending A" };
      const pendingB = { role: "user", timestamp: 10, content: "pending B" };
      const messages: any[] = [];
      const session = makeMockSession(messages);
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());

      subscriber?.({ type: "message_end", message: pendingA });
      subscriber?.({ type: "message_end", message: pendingB });
      messages.push({ role: "user", timestamp: 10, content: "persisted one" });
      subscriber?.({ type: "entry_appended", entry: {} });
      (viewer as any).buildContentLines(116);

      expect((viewer as any).pendingHistoryMessages).toHaveLength(1);
      expect((viewer as any).pendingHistoryMessages[0].message).toBe(pendingB);
    });

    it("renders a tool result once, inline under its call (no standalone duplicate)", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
        { role: "toolResult", toolCallId: "t1", toolName: "uniqtool", isError: false, content: [{ type: "text", text: "UNIQRESULT" }] },
      ]);
      const record = makeMockRecord({ execution: { session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const text = viewer.render(80).join("\n");
      expect(count(text, "UNIQRESULT")).toBe(1);
      expect(count(text, "uniqtool")).toBe(1);
    });

    it("invalidates inline tool output when switching to a branch that removes its result", () => {
      let listener: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        listener = callback;
        return () => {};
      });
      let leafId = "r1";
      let branch: any[] = [
        { type: "message", id: "a1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] } },
        { type: "message", id: "r1", parentId: "a1", timestamp: "2024-01-01T10:00:01.000Z", message: { role: "toolResult", toolCallId: "t1", toolName: "uniqtool", isError: false, content: [{ type: "text", text: "OFF-BRANCH-RESULT" }] } },
      ];
      const session = makeMockSession([], { getBranch: () => branch, getLeafId: () => leafId });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      expect((viewer as any).buildContentLines(80).join("\n")).toContain("OFF-BRANCH-RESULT");

      branch = [branch[0]!];
      leafId = "a1";
      listener?.({ type: "branch_changed" });
      const text = (viewer as any).buildContentLines(80).join("\n");
      expect(text).not.toContain("OFF-BRANCH-RESULT");
      expect(text).toContain("uniqtool");
    });

    it("updates cached fallback compaction order and total when a later summary is appended", () => {
      const messages: any[] = [
        { role: "compactionSummary", summary: "first fallback", tokensBefore: 1_000, timestamp: 1_704_110_400_000 },
        { role: "user", content: "kept" },
      ];
      const session = makeMockSession(messages);
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());
      expect((viewer as any).buildContentLines(116).join("\n")).toContain("compaction 1/1");

      messages.push({ role: "compactionSummary", summary: "second fallback", tokensBefore: 2_000, timestamp: 1_704_110_401_000 });
      const text = (viewer as any).buildContentLines(116).join("\n");
      expect(text).toContain("compaction 1/2");
      expect(text).toContain("compaction 2/2");
      expect(text).not.toContain("compaction 1/1");
    });

    it("updates cached compaction order and total when a later marker is appended", () => {
      let listener: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementationOnce((callback: any) => {
        listener = callback;
        return () => {};
      });
      let leafId = "u1";
      const branch: any[] = [
        { type: "compaction", id: "c1", parentId: null, timestamp: "2024-01-01T10:00:00.000Z", summary: "first", firstKeptEntryId: "u1", tokensBefore: 1000 },
        { type: "message", id: "u1", parentId: "c1", timestamp: "2024-01-01T10:00:01.000Z", message: { role: "user", content: "kept" } },
      ];
      const session = makeMockSession([], { getBranch: () => branch, getLeafId: () => leafId });
      const viewer = trackPollingViewer(new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn()));
      expect((viewer as any).buildContentLines(116).join("\n")).toContain("compaction 1/1");

      branch.push(
        { type: "compaction", id: "c2", parentId: "u1", timestamp: "2024-01-01T10:00:02.000Z", summary: "second", firstKeptEntryId: "u2", tokensBefore: 2000 },
        { type: "message", id: "u2", parentId: "c2", timestamp: "2024-01-01T10:00:03.000Z", message: { role: "user", content: "new kept" } },
      );
      leafId = "u2";
      listener?.({ type: "entry_appended", entry: branch[2] });
      const text = (viewer as any).buildContentLines(116).join("\n");
      expect(text).toContain("compaction 1/2");
      expect(text).toContain("compaction 2/2");
      expect(text).not.toContain("compaction 1/1");
    });

    it("re-renders a cached assistant tool call when its result arrives (no duplicate title)", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
      ]);
      const record = makeMockRecord({ execution: { session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      // First render caches the assistant message as a pending tool call.
      viewer.render(80);
      // The tool result then arrives as a new message.
      session.messages.push({ role: "toolResult", toolCallId: "t1", toolName: "uniqtool", isError: false, content: [{ type: "text", text: "UNIQRESULT" }] });

      const text = viewer.render(80).join("\n");
      expect(count(text, "UNIQRESULT")).toBe(1);
      expect(count(text, "uniqtool")).toBe(1);
    });

    it("scrolls to the true bottom when streaming adds lines (scrollMax not stale)", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(3000) }]);
      const record = makeMockRecord({ execution: { session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      // Populates the cache; autoScroll parks scrollOffset at the bottom of the
      // non-streaming content.
      viewer.render(80);
      const baseline = (viewer as any).scrollOffset;
      expect(baseline).toBeGreaterThan(0);

      // Streaming text arrives (5 rendered lines) without a new session message,
      // so only the streaming suffix changes.
      (viewer as any).streamingText = "a\nb\nc\nd\ne";
      (viewer as any).ensureTextMd().setText("a\nb\nc\nd\ne");

      viewer.handleInput("G"); // jump to bottom
      expect((viewer as any).scrollOffset).toBe(baseline + 5);
    });
  });

  describe("dispose", () => {
    it("cancels a pending debounced render", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void = () => {};
      mockSubscribe.mockImplementation((callback: (event?: unknown) => void) => {
        subscriber = callback;
        return () => {};
      });
      const session = makeMockSession();
      const viewer = new ConversationViewer(makeTui(), session, makeMockRecord({ execution: { session } }), noopTheme, vi.fn());

      subscriber({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late" } });
      viewer.dispose();
      vi.advanceTimersByTime(100);

      expect(mockRequestRender).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("unsubscribes from session", () => {
      const unsubscribe = vi.fn();
      mockSubscribe.mockReturnValue(unsubscribe);

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.dispose();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
