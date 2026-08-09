import { describe, expect, it } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.ts";
import type { SubagentsConfig } from "../../src/config/types.ts";

function defaultConfig(): SubagentsConfig {
  return {
    agent: {
      disableDefaultAgents: false,
    },
    concurrency: { default: 4 },
  };
}

function mutableIO(initial: Partial<SubagentsConfig> = {}): {
  io: ConfigIO;
  underlying: SubagentsConfig;
} {
  const defaults = defaultConfig();
  const underlying: SubagentsConfig = {
    agent: { ...defaults.agent, ...(initial.agent ?? {}) },
    concurrency: { ...defaults.concurrency, ...(initial.concurrency ?? {}) },
    ...(initial.agents ? { agents: structuredClone(initial.agents) } : {}),
  };
  return {
    // Deliberately return the same mutable object on every load. ConfigStore
    // must detach each accepted snapshot from this host-owned value.
    io: { load: () => underlying },
    underlying,
  };
}

describe("ConfigStore runtime settings", () => {
  it("normalizes scalar and per-agent values from a load-only adapter", () => {
    const { io } = mutableIO({
      agent: {
        disableDefaultAgents: "yes" as any,
        ignoredRole: "provider/model",
      } as any,
      concurrency: { default: 1.5 as any },
      agents: {
        Scout: { model: "provider/first", thinking: "high", ignored: true },
        scout: { thinking: "medium" },
        reviewer: { model: "provider/reviewer", thinking: "invalid" },
      } as any,
    });
    const store = new ConfigStore(io);

    expect(store.agent).toEqual({
      disableDefaultAgents: false,
    });
    expect(store.concurrency).toEqual({ default: 4 });
    expect(store.createSubagentRuntimeSettings().agents).toEqual({
      scout: { thinking: "medium" },
      reviewer: { model: "provider/reviewer" },
    });
  });

  it("captures normalized per-agent overrides in the transient preflight snapshot", () => {
    const { io } = mutableIO({
      agents: {
        Scout: { model: "provider/model", thinking: "high" },
        scout: { thinking: "medium" },
      },
    });
    const store = new ConfigStore(io);
    const snapshot = store.createSubagentRuntimeSettings();

    expect(snapshot.agents).toEqual({ scout: { thinking: "medium" } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).not.toHaveProperty("agent");
    expect(Object.isFrozen(snapshot.agents)).toBe(true);
    expect(Object.isFrozen(snapshot.agents?.scout)).toBe(true);
  });

  it("keeps runtime snapshots bounded for oversized adapter data", () => {
    const many = {
      valid: { model: "m".repeat(257), thinking: "high" },
      ["x".repeat(129)]: { model: "provider/too-long-name" },
      ...Object.fromEntries(Array.from(
        { length: 300 },
        (_, index) => [`agent-${index}`, { model: `provider/model-${index}` }],
      )),
    };
    const { io } = mutableIO({ agents: many as any });
    const snapshot = new ConfigStore(io).createSubagentRuntimeSettings();

    expect(Object.keys(snapshot.agents ?? {}).length).toBeLessThanOrEqual(256);
    expect(snapshot.agents?.["x".repeat(129)]).toBeUndefined();
    expect(snapshot.agents?.valid).toEqual({ thinking: "high" });
    for (const override of Object.values(snapshot.agents ?? {})) {
      expect((override.model ?? "").length).toBeLessThanOrEqual(256);
    }
  });

  it("keeps a preflight snapshot stable while the underlying adapter changes", () => {
    const { io, underlying } = mutableIO({ agent: { disableDefaultAgents: false } });
    const store = new ConfigStore(io);
    const snapshot = store.createSubagentRuntimeSettings();

    underlying.agent.disableDefaultAgents = true;
    underlying.concurrency.default = 2;
    underlying.agents = { reviewer: { thinking: "high" } };

    expect(store.agent.disableDefaultAgents).toBe(false);
    expect(store.concurrency).toEqual({ default: 4 });
    expect(snapshot).toEqual({});
    expect(snapshot).not.toHaveProperty("agent");
    expect(snapshot.agents).toBeUndefined();
  });

  it("reloads a detached normalized snapshot from the mutable adapter", () => {
    const { io, underlying } = mutableIO({ concurrency: { default: 2 } });
    const store = new ConfigStore(io);

    underlying.agent.disableDefaultAgents = true;
    underlying.concurrency.default = 99;
    underlying.agents = { Scout: { thinking: "low" } };
    store.reload();

    expect(store.agent.disableDefaultAgents).toBe(true);
    expect(store.concurrency).toEqual({ default: 4 });
    expect(store.createSubagentRuntimeSettings().agents).toEqual({ scout: { thinking: "low" } });
  });

  it("uses complete defaults for missing scalar sections and unknown keys", () => {
    const { io } = mutableIO({
      agent: { unknown: true } as any,
      concurrency: {} as any,
      agents: { invalid: { unknown: true } } as any,
    });
    const store = new ConfigStore(io);

    expect(store.agent).toEqual({
      disableDefaultAgents: false,
    });
    expect(store.concurrency).toEqual({ default: 4 });
    expect(store.createSubagentRuntimeSettings().agents).toBeUndefined();
  });

  it("accepts an adapter with only load and exposes no runtime controls", () => {
    const io: ConfigIO = { load: defaultConfig };
    const store = new ConfigStore(io);

    expect(Object.keys(io)).toEqual(["load"]);
    expect(store.agent.disableDefaultAgents).toBe(false);
    expect(store.concurrency).toEqual({ default: 4 });
  });
});
