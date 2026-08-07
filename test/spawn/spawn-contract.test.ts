import { describe, expect, it } from "vitest";
import { acceptResolvedSpawn, snapshotResolvedSpawn } from "../../src/spawn/spawn-contract.js";
import {
  MAX_AGENT_PROMPT_BYTES,
  MAX_AGENT_SYSTEM_PROMPT_BYTES,
  MAX_DESCRIPTION_BYTES,
  utf8ByteLength,
} from "../../src/agents/agent-string-limits.js";

describe("AcceptedSpawn immutability", () => {
  it("materializes an immutable trust snapshot", () => {
    const trusted = snapshotResolvedSpawn({
      type: "trusted",
      prompt: "task",
      description: "Trusted",
      runInBackground: false,
      agentConfig: { name: "trusted", description: "Trusted", systemPrompt: "" },
      projectTrusted: true,
      runtimeSettings: {
        agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      },
    });
    const untrusted = snapshotResolvedSpawn({
      type: "untrusted",
      prompt: "task",
      description: "Untrusted",
      runInBackground: false,
      agentConfig: { name: "untrusted", description: "Untrusted", systemPrompt: "" },
      runtimeSettings: {
        agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      },
      projectTrusted: false,
    });

    expect(trusted.projectTrusted).toBe(true);
    expect(untrusted.projectTrusted).toBe(false);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(acceptResolvedSpawn(trusted))).toBe(true);
  });

  it("rejects oversized prompt/systemPrompt before AcceptedSpawn can be queued", () => {
    const base = {
      type: "bounded",
      prompt: "task",
      description: "description",
      runInBackground: false,
      agentConfig: { name: "bounded", description: "description", systemPrompt: "instructions" },
      runtimeSettings: {
        agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      },
      projectTrusted: false,
    } as const;

    expect(() => acceptResolvedSpawn(snapshotResolvedSpawn({
      ...base,
      prompt: "a".repeat(MAX_AGENT_PROMPT_BYTES + 1),
    }))).toThrow("Agent prompt exceeds");
    expect(() => acceptResolvedSpawn(snapshotResolvedSpawn({
      ...base,
      agentConfig: { ...base.agentConfig, systemPrompt: "b".repeat(MAX_AGENT_SYSTEM_PROMPT_BYTES + 1) },
    }))).toThrow("AgentConfig systemPrompt exceeds");

    const accepted = acceptResolvedSpawn(snapshotResolvedSpawn({
      ...base,
      description: "界".repeat(MAX_DESCRIPTION_BYTES / 3 + 1),
    }));
    expect(utf8ByteLength(accepted.description)).toBeLessThanOrEqual(MAX_DESCRIPTION_BYTES);
    expect(accepted.description).toContain("[TRUNCATED]");
  });

  it("detaches and recursively freezes nested contract data", () => {
    const agentConfig = {
      name: "nested",
      description: "Nested",
      systemPrompt: "Instructions",
      tools: [["read"]],
      excludeSkills: [["private"]],
    } as any;
    const runtimeSettings = {
      agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      agents: { nested: { model: "provider/model", extra: [["mutable"]] } },
    } as any;
    const invocation = { modelName: "model", nested: [["metadata"]] } as any;
    const resolved = snapshotResolvedSpawn({
      type: "nested",
      prompt: "task",
      description: "Nested",
      runInBackground: false,
      agentConfig,
      runtimeSettings,
      invocation,
      projectTrusted: false,
    });
    const accepted = acceptResolvedSpawn(resolved);

    const acceptedAny = accepted as any;
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig.tools)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig.tools[0])).toBe(true);
    expect(Object.isFrozen(acceptedAny.runtimeSettings.agents)).toBe(true);
    expect(acceptedAny.runtimeSettings.agents.nested).toEqual({ model: "provider/model" });
    expect(Object.isFrozen(acceptedAny.invocation.nested[0])).toBe(true);

    agentConfig.tools[0].push("write");
    invocation.nested[0].push("later");
    expect(acceptedAny.agentConfig.tools).toEqual([["read"]]);
    expect(acceptedAny.invocation.nested).toEqual([["metadata"]]);
  });
});
