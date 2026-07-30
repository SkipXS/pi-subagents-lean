import { describe, expect, it } from "vitest";
import {
  agentContinuationPrefix,
  agentHierarchyPrefix,
  agentHierarchyRolePrefix,
  orderAgentsByHierarchy,
  visibleNestedAgentIds,
} from "../../src/ui/agent-hierarchy.js";
import type { AgentRecord } from "../../src/types.js";

function record(id: string, parentId?: string): AgentRecord {
  return { id, hierarchy: { parentId } } as AgentRecord;
}

describe("orderAgentsByHierarchy", () => {
  it("keeps orphaned and cyclic records visible while grouping valid descendants", () => {
    const agents = [
      record("orphan", "evicted-parent"),
      record("child", "parent"),
      record("parent"),
      record("cycle-a", "cycle-b"),
      record("cycle-b", "cycle-a"),
    ];

    expect(orderAgentsByHierarchy(agents).map((agent) => agent.id)).toEqual([
      "orphan",
      "parent",
      "child",
      "cycle-a",
      "cycle-b",
    ]);
  });
});

describe("visible hierarchy prefixes", () => {
  it("renders orphaned, self-referential, and cyclic records as roots", () => {
    const agents = [
      record("root"),
      record("child", "root"),
      record("orphan", "gone"),
      record("self", "self"),
      record("cycle-a", "cycle-b"),
      record("cycle-b", "cycle-a"),
    ];

    expect(visibleNestedAgentIds(agents)).toEqual(new Set(["child"]));
    expect(agentHierarchyPrefix(agents[1]!, agents)).toBe("  ");
    expect(agentHierarchyRolePrefix(agents[1]!, agents)).toBe(" ↳ ");
    expect(agentContinuationPrefix(agents[1]!, agents)).toBe("   ");
    for (const agent of [agents[2]!, agents[3]!, agents[4]!, agents[5]!]) {
      expect(agentHierarchyPrefix(agent, agents)).toBe("  ");
      expect(agentHierarchyRolePrefix(agent, agents)).toBe(" ");
      expect(agentContinuationPrefix(agent, agents)).toBe("  ");
    }
  });
});
