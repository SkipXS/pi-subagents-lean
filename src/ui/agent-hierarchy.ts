import type { AgentRecord } from "../types.js";

/**
 * Keep each visible root in its existing order while placing its visible
 * descendants immediately after it. Child ordering follows the input order.
 */
export function orderAgentsByHierarchy(agents: AgentRecord[]): AgentRecord[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, AgentRecord[]>();
  const roots: AgentRecord[] = [];

  for (const agent of agents) {
    const parentId = agent.hierarchy?.parentId;
    if (parentId && parentId !== agent.id && byId.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(agent);
      children.set(parentId, siblings);
    } else {
      roots.push(agent);
    }
  }

  const ordered: AgentRecord[] = [];
  const visited = new Set<string>();
  const visit = (agent: AgentRecord): void => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    ordered.push(agent);
    for (const child of children.get(agent.id) ?? []) visit(child);
  };

  for (const root of roots) visit(root);
  // Retain malformed cyclic records rather than omitting them from the UI.
  for (const agent of agents) visit(agent);
  return ordered;
}

/**
 * Identify visible records whose parent relationship reaches a real root.
 * Orphans, self-references, cycles, and descendants of a cycle are roots for
 * rendering purposes, even though orderAgentsByHierarchy still keeps them.
 */
export function visibleNestedAgentIds(agents: Iterable<AgentRecord>): Set<string> {
  const visible = [...agents];
  const byId = new Map(visible.map((agent) => [agent.id, agent]));
  const parentById = new Map<string, string>();
  for (const agent of visible) {
    const parentId = agent.hierarchy?.parentId;
    if (parentId && parentId !== agent.id && byId.has(parentId)) parentById.set(agent.id, parentId);
  }

  const nested = new Set<string>();
  for (const agent of visible) {
    const path = new Set<string>();
    let currentId = agent.id;
    let valid = parentById.has(currentId);
    while (valid) {
      if (path.has(currentId)) {
        valid = false;
        break;
      }
      path.add(currentId);
      const parentId = parentById.get(currentId);
      if (!parentId) break;
      currentId = parentId;
    }
    if (valid) nested.add(agent.id);
  }
  return nested;
}

/** A nested agent gets a compact branch marker; roots keep their existing prefix. */
export function agentHierarchyPrefix(agent: AgentRecord, visibleAgents: Iterable<AgentRecord>): string {
  return visibleNestedAgentIds(visibleAgents).has(agent.id) ? " └" : "  ";
}

/** Indent continuation rows beneath a root or nested agent header. */
export function agentContinuationPrefix(agent: AgentRecord, visibleAgents: Iterable<AgentRecord>): string {
  return visibleNestedAgentIds(visibleAgents).has(agent.id) ? "   " : "  ";
}
