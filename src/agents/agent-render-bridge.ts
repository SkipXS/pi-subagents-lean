import {
  type AgentCallRenderMetadata,
  type AgentRenderToolName,
  agentCallRenderMetadataEqual,
  getAgentCallRenderMetadata,
  mergeAgentCallRenderMetadata,
  withAgentCallRenderMetadata,
} from "./agent-render-format.js";

interface BridgeEntry {
  metadata?: AgentCallRenderMetadata;
}

interface ToolResultEventLike {
  toolName?: unknown;
  toolCallId?: unknown;
  details?: unknown;
}

interface MessageEndEventLike {
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRenderableToolName(value: unknown): value is AgentRenderToolName {
  return value === "Agent" || value === "AgentContinue" || value === "StopAgent";
}

/**
 * Per-extension/per-session handoff for metadata lost by throwing tool
 * wrappers. The map is owned by this bridge instance, never by a module
 * singleton, and is cleared at both message and session boundaries.
 */
export class AgentRenderMetadataBridge {
  private readonly entries = new Map<string, BridgeEntry>();
  private active = true;

  /** Start a fresh session and discard any stale tool-call ids. */
  startSession(): void {
    this.entries.clear();
    this.active = true;
  }

  /** Drop every pending id during session shutdown/reload. */
  clear(): void {
    this.entries.clear();
    this.active = false;
  }

  /** Begin one rendered agent-family row; AgentStatus stays outside the bridge. */
  start(toolCallId: string, toolName: string): void {
    if (!this.active || !isRenderableToolName(toolName) || !toolCallId) return;
    this.entries.set(toolCallId, {});
  }

  /** Store resolved metadata from an execute callback or partial update. */
  update(toolCallId: string, metadata: AgentCallRenderMetadata): void {
    if (!this.active || !toolCallId) return;
    const entry = this.entries.get(toolCallId);
    // Accept updates only for calls started in this session generation. This
    // prevents a late update from a disposed session recreating stale state.
    if (!entry) return;
    const previous = entry.metadata;
    const merged = mergeAgentCallRenderMetadata(previous, metadata);
    if (!agentCallRenderMetadataEqual(previous, merged)) entry.metadata = merged;
    this.entries.set(toolCallId, entry);
  }

  /** Capture metadata carried by a Pi tool_execution_update event. */
  updateFromPartial(
    toolCallId: string,
    toolName: string,
    partialResult: unknown,
  ): void {
    if (!this.active || !isRenderableToolName(toolName) || !toolCallId) return;
    const metadata = isRecord(partialResult)
      ? getAgentCallRenderMetadata(partialResult.details)
      : undefined;
    if (metadata) this.update(toolCallId, metadata);
  }

  /** Current metadata for tests and the final tool-result hook. */
  metadataFor(toolCallId: string): AgentCallRenderMetadata | undefined {
    const metadata = this.entries.get(toolCallId)?.metadata;
    return metadata ? { ...metadata } : undefined;
  }

  /** Number of ids still waiting for their tool-result message. */
  pendingCount(): number {
    return this.entries.size;
  }

  /**
   * Repair a final tool_result before Pi turns it into a toolResult message.
   * Existing details and content remain untouched; only the private renderer
   * field is added when throwing/abort handling discarded it.
   */
  onToolResult(event: ToolResultEventLike): { details: Record<string, unknown> } | undefined {
    if (!this.active || !isRenderableToolName(event.toolName) || typeof event.toolCallId !== "string") return undefined;
    const eventMetadata = getAgentCallRenderMetadata(event.details);
    if (eventMetadata) this.update(event.toolCallId, eventMetadata);

    const entry = this.entries.get(event.toolCallId);
    // Keep the entry until message_end, the actual persistence boundary.
    // Later tool_result handlers may replace details after this hook runs.
    const metadata = entry?.metadata;
    if (!metadata) return undefined;
    if (agentCallRenderMetadataEqual(eventMetadata, metadata)) return undefined;
    return { details: withAgentCallRenderMetadata(isRecord(event.details) ? event.details : undefined, metadata) };
  }

  /**
   * Ensure the persisted message also carries the metadata, then release its
   * id. This covers hosts that expose message_end without a usable tool_result
   * replacement and makes cleanup atomic per ToolCallId.
   */
  onMessageEnd(event: MessageEndEventLike): { message: Record<string, unknown> } | undefined {
    if (!this.active || !isRecord(event.message) || event.message.role !== "toolResult") return undefined;
    // Hosts differ on whether toolName is repeated on the persisted message.
    // If it is present, keep AgentStatus and every unrelated tool out of the
    // bridge; otherwise the pending id remains the authoritative association.
    if (typeof event.message.toolName === "string" && !isRenderableToolName(event.message.toolName)) return undefined;
    const toolCallId = event.message.toolCallId;
    if (typeof toolCallId !== "string") return undefined;

    const eventMetadata = getAgentCallRenderMetadata(event.message.details);
    if (eventMetadata) this.update(toolCallId, eventMetadata);
    const entry = this.entries.get(toolCallId);
    if (!entry) return undefined;

    const metadata = entry.metadata;
    this.entries.delete(toolCallId);
    if (!metadata || agentCallRenderMetadataEqual(eventMetadata, metadata)) return undefined;

    return {
      message: {
        ...event.message,
        details: withAgentCallRenderMetadata(
          isRecord(event.message.details) ? event.message.details : undefined,
          metadata,
        ),
      },
    };
  }
}

export function createAgentRenderMetadataBridge(): AgentRenderMetadataBridge {
  return new AgentRenderMetadataBridge();
}
