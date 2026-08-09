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
      agentConfig: { name: "trusted", description: "Trusted", systemPrompt: "" },
      projectTrusted: true,
    });
    const untrusted = snapshotResolvedSpawn({
      type: "untrusted",
      prompt: "task",
      description: "Untrusted",
      agentConfig: { name: "untrusted", description: "Untrusted", systemPrompt: "" },
      projectTrusted: false,
    });

    expect(trusted.projectTrusted).toBe(true);
    expect(untrusted.projectTrusted).toBe(false);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(acceptResolvedSpawn(trusted))).toBe(true);
  });

  it("retains resolved model, model key, and thinking on accepted spawns", () => {
    const model = { provider: "provider", id: "resolved-model" } as any;
    const accepted = acceptResolvedSpawn(snapshotResolvedSpawn({
      type: "resolved",
      prompt: "task",
      description: "Resolved",
      agentConfig: { name: "resolved", description: "Resolved", systemPrompt: "" },
      projectTrusted: false,
      model,
      modelKey: "provider/resolved-model",
      thinkingLevel: "high",
    }));

    expect(accepted.model).toBe(model);
    expect(accepted.modelKey).toBe("provider/resolved-model");
    expect(accepted.thinkingLevel).toBe("high");
  });

  it("rejects oversized prompt/systemPrompt before AcceptedSpawn can be queued", () => {
    const base = {
      type: "bounded",
      prompt: "task",
      description: "description",
      agentConfig: { name: "bounded", description: "description", systemPrompt: "instructions" },
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
    const invocation = { modelName: "model", nested: [["metadata"]] } as any;
    const resolved = snapshotResolvedSpawn({
      type: "nested",
      prompt: "task",
      description: "Nested",
      agentConfig,
      invocation,
      projectTrusted: false,
    });
    const accepted = acceptResolvedSpawn(resolved);

    const acceptedAny = accepted as any;
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig.tools)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig.tools[0])).toBe(true);
    expect(acceptedAny).not.toHaveProperty("runtimeSettings");
    expect(Object.isFrozen(acceptedAny.invocation.nested[0])).toBe(true);

    agentConfig.tools[0].push("write");
    invocation.nested[0].push("later");
    expect(acceptedAny.agentConfig.tools).toEqual([["read"]]);
    expect(acceptedAny.invocation.nested).toEqual([["metadata"]]);
  });
});
