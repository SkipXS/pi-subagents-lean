import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentActivitySnapshot } from "./agent-manager.js";
import type { DeliveryActivitySnapshot } from "../spawn/spawn-coordinator.js";
import { SHORT_ID_LENGTH } from "../types.js";

/** Stable key used for the subagent activity entry in the host footer. */
export const AGENT_FOOTER_STATUS_KEY = "subagents" as const;

/** The only host modes in which this presentation status is installed. */
export function supportsAgentFooterStatus(
  context: Pick<ExtensionContext, "mode">,
): boolean {
  return context.mode === "tui" || context.mode === "rpc";
}

interface FooterActivityProjection {
  readonly agentId: string;
  readonly type: string;
  readonly mode: "foreground" | "background";
  readonly state: "running" | "queued" | "delivering";
}

/**
 * Deterministically combine current executions with completed pending
 * deliveries. A current execution wins for an agent id so an old background
 * delivery cannot make a continued/rerun agent look like two active agents.
 */
export function formatAgentFooterStatus(
  executions: AgentActivitySnapshot,
  deliveries: DeliveryActivitySnapshot,
): string | undefined {
  const byAgent = new Map<string, FooterActivityProjection>();

  for (const execution of executions) {
    if (execution.status !== "running" && execution.status !== "queued") continue;
    byAgent.set(execution.agentId, {
      agentId: execution.agentId,
      type: execution.type,
      mode: execution.mode,
      state: execution.status,
    });
  }

  for (const delivery of deliveries) {
    if (byAgent.has(delivery.agentId)) continue;
    byAgent.set(delivery.agentId, {
      agentId: delivery.agentId,
      type: delivery.type,
      mode: "background",
      state: "delivering",
    });
  }

  const active = [...byAgent.values()];
  if (active.length === 0) return undefined;

  if (active.length === 1) {
    const [entry] = active;
    return `Agent: ${entry.type} [${shortAgentId(entry.agentId)}] · ${formatMode(entry.mode)} · ${formatState(entry.state)}`;
  }

  const foregroundRunning = active.filter((entry) => entry.mode === "foreground" && entry.state === "running").length;
  const backgroundRunning = active.filter((entry) => entry.mode === "background" && entry.state === "running").length;
  const queued = active.filter((entry) => entry.state === "queued").length;
  const delivering = active.filter((entry) => entry.state === "delivering").length;
  const parts = [
    `Agents: ${active.length} active`,
    `FG ${foregroundRunning} running`,
    `BG ${backgroundRunning} running`,
    `${queued} queued`,
  ];
  if (delivering > 0) parts.push(`${delivering} delivering`);
  return parts.join(" · ");
}

function shortAgentId(agentId: string): string {
  return agentId.slice(0, SHORT_ID_LENGTH);
}

function formatMode(mode: "foreground" | "background"): string {
  return mode === "foreground" ? "Foreground" : "Background";
}

function formatState(state: "running" | "queued" | "delivering"): string {
  return state === "running" ? "Running" : state === "queued" ? "Queued" : "Delivering";
}

/** Minimal manager-side source required by the per-session controller. */
export interface AgentFooterActivitySource {
  subscribeActivity(observer: (snapshot: AgentActivitySnapshot) => void): () => void;
}

/** Minimal coordinator-side source required by the per-session controller. */
export interface AgentFooterDeliverySource {
  subscribeDeliveryActivity(observer: (snapshot: DeliveryActivitySnapshot) => void): () => void;
}

interface AgentFooterStatusUi {
  setStatus(key: string, text: string | undefined): void;
}

/**
 * Per-session bridge from lifecycle projections to the host footer.
 *
 * It owns no timer and never reads mutable AgentRecord or delivery internals.
 * Each observer and host call is isolated so a stale/partial host cannot
 * strand execution or delivery cleanup.
 */
export class AgentFooterStatusController {
  private managerSnapshot: AgentActivitySnapshot = Object.freeze([]);
  private deliverySnapshot: DeliveryActivitySnapshot = Object.freeze([]);
  private renderedText: string | undefined;
  private disposed = false;
  private unsubscribeManager: (() => void) | undefined;
  private unsubscribeCoordinator: (() => void) | undefined;

  constructor(
    private readonly ui: AgentFooterStatusUi,
    manager: AgentFooterActivitySource,
    coordinator: AgentFooterDeliverySource,
    private readonly ownsStatus: () => boolean = () => true,
  ) {
    this.subscribeManager(manager);
    this.subscribeCoordinator(coordinator);
  }

  /** Stop both observers and clear only this session's status entry. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.safeUnsubscribe(this.unsubscribeManager);
    this.safeUnsubscribe(this.unsubscribeCoordinator);
    this.unsubscribeManager = undefined;
    this.unsubscribeCoordinator = undefined;

    // A newer session may already own the shared status key. Never clear it
    // from a stale controller's late disposal path.
    if (!this.isCurrent()) return;
    if (this.renderedText === undefined) return;
    this.renderedText = undefined;
    this.safeSetStatus(undefined);
  }

  private subscribeManager(manager: AgentFooterActivitySource): void {
    try {
      this.unsubscribeManager = manager.subscribeActivity((snapshot) => {
        if (this.disposed) return;
        this.managerSnapshot = snapshot;
        this.refresh();
      });
    } catch {
      // A presentation subscription is optional and must not block a session.
    }
  }

  private subscribeCoordinator(coordinator: AgentFooterDeliverySource): void {
    try {
      this.unsubscribeCoordinator = coordinator.subscribeDeliveryActivity((snapshot) => {
        if (this.disposed) return;
        this.deliverySnapshot = snapshot;
        this.refresh();
      });
    } catch {
      // A presentation subscription is optional and must not block a session.
    }
  }

  private refresh(): void {
    const text = formatAgentFooterStatus(this.managerSnapshot, this.deliverySnapshot);
    if (text === this.renderedText) return;
    this.renderedText = text;
    if (!this.isCurrent()) return;
    this.safeSetStatus(text);
  }

  private safeSetStatus(text: string | undefined): void {
    try {
      this.ui.setStatus(AGENT_FOOTER_STATUS_KEY, text);
    } catch {
      // A detached TUI/RPC host must not affect agent lifecycle or delivery.
    }
  }

  private isCurrent(): boolean {
    try {
      return this.ownsStatus();
    } catch {
      return false;
    }
  }

  private safeUnsubscribe(unsubscribe: (() => void) | undefined): void {
    if (!unsubscribe) return;
    try { unsubscribe(); } catch { /* observer cleanup is best effort */ }
  }
}
