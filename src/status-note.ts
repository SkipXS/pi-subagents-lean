import type { AgentLifecycle, AgentLifecycleStatus } from "./types.js";

const STATUS_NOTES: Partial<Record<AgentLifecycleStatus, string>> = {
  aborted: "aborted before completion; output may be incomplete",
};

const STOP_NOTE = "parent turn ended before completion — output is partial; the task was NOT finished";

export function getStatusNote(lifecycle: AgentLifecycle): string {
  const note =
    lifecycle.status === "stopped"
      // A stopped agent with no recorded initiator reads as an agent stop.
      ? STOP_NOTE
      : STATUS_NOTES[lifecycle.status];
  return note ? ` (${note})` : "";
}
