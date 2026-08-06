import { describe, expect, it } from "vitest";
import { acceptResolvedSpawn, snapshotResolvedSpawn } from "../../src/spawn/spawn-contract.js";

describe("AcceptedSpawn immutability", () => {
  it("materializes an immutable trust snapshot and defaults legacy absence to false", () => {
    const trusted = snapshotResolvedSpawn({
      type: "trusted",
      prompt: "task",
      description: "Trusted",
      runInBackground: false,
      agentConfig: { name: "trusted", description: "Trusted", systemPrompt: "" },
      runtimeSettings: {
        agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      },
      projectTrusted: true,
    });
    const legacy = snapshotResolvedSpawn({
      type: "legacy",
      prompt: "task",
      description: "Legacy",
      runInBackground: false,
      agentConfig: { name: "legacy", description: "Legacy", systemPrompt: "" },
      runtimeSettings: {
        agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      },
    });

    expect(trusted.projectTrusted).toBe(true);
    expect(legacy.projectTrusted).toBe(false);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(acceptResolvedSpawn(trusted))).toBe(true);
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
    });
    const accepted = acceptResolvedSpawn(resolved);

    const acceptedAny = accepted as any;
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig.tools)).toBe(true);
    expect(Object.isFrozen(acceptedAny.agentConfig.tools[0])).toBe(true);
    expect(Object.isFrozen(acceptedAny.runtimeSettings.agents)).toBe(true);
    expect(Object.isFrozen(acceptedAny.runtimeSettings.agents.nested.extra[0])).toBe(true);
    expect(Object.isFrozen(acceptedAny.invocation.nested[0])).toBe(true);

    agentConfig.tools[0].push("write");
    runtimeSettings.agents.nested.extra[0].push("later");
    invocation.nested[0].push("later");
    expect(acceptedAny.agentConfig.tools).toEqual([["read"]]);
    expect(acceptedAny.runtimeSettings.agents.nested.extra).toEqual([["mutable"]]);
    expect(acceptedAny.invocation.nested).toEqual([["metadata"]]);
  });
});
