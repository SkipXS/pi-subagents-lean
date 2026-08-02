import { describe, expect, it } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.ts";
import type { AgentManager } from "../../src/agents/agent-manager.ts";
import type { SubagentsConfig } from "../../src/models/model-precedence.ts";

function defaultConfig(): SubagentsConfig {
  return {
    agent: {
      default: null,
      forceBackground: false,
      graceTurns: 6,
      systemPromptMode: "replace",
      includeContextFiles: true,
      disableDefaultAgents: false,
      orchestrationPrompt: true,
      outputThinkingBufferSize: 0,
      finishedRetentionMinutes: 60,
    },
    thinkingOverrides: {},
    ecoModelOverrides: {},
    ecoThinkingOverrides: {},
    concurrency: { default: 4 },
  };
}

function memIO(initial: Partial<SubagentsConfig> = {}): {
  io: ConfigIO;
  saves: SubagentsConfig[];
  current: () => SubagentsConfig;
} {
  let current = structuredClone({
    ...defaultConfig(),
    ...initial,
    agent: { ...defaultConfig().agent, ...(initial.agent ?? {}) },
    concurrency: { ...defaultConfig().concurrency, ...(initial.concurrency ?? {}) },
  });
  const saves: SubagentsConfig[] = [];
  return {
    io: {
      load: () => structuredClone(current),
      save: (config) => {
        current = structuredClone(config);
        saves.push(structuredClone(config));
      },
    },
    saves,
    current: () => current,
  };
}

function managerStub(): {
  manager: AgentManager;
  concurrencies: unknown[];
  retentions: number[];
} {
  const concurrencies: unknown[] = [];
  const retentions: number[] = [];
  const manager = {
    setConcurrency: (config: unknown) => concurrencies.push(config),
    setRetentionMinutes: (minutes: number) => retentions.push(minutes),
  } as unknown as AgentManager;
  return { manager, concurrencies, retentions };
}

describe("ConfigStore runtime settings", () => {
  it("captures a frozen, stable child snapshot", () => {
    const { io } = memIO({
      agent: { ...defaultConfig().agent, default: "persisted/model", graceTurns: 3 },
      thinkingOverrides: { scout: "low" as any },
    });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("scout", "session/model");
    store.mutate.session.setThinkingOverride("scout", "high" as any);
    const snapshot = store.createSubagentRuntimeSettings();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.agent)).toBe(true);
    expect(snapshot.modelFor("scout", "parent/model")).toBe("session/model");
    expect(snapshot.thinkingSettingFor("scout", undefined).value).toBe("high");

    store.mutate.session.setOverride("scout", "later/model");
    store.mutate.agent.setGraceTurns(9);
    expect(snapshot.modelFor("scout", "parent/model")).toBe("session/model");
    expect(snapshot.agent.graceTurns).toBe(3);
    expect(snapshot).not.toHaveProperty("mutate");
  });

  it("retains Eco resolution independently from the removed UI", () => {
    const { io, current } = memIO({
      ecoModelOverrides: { scout: "saved/eco" },
      ecoThinkingOverrides: { scout: "low" },
    });
    const store = new ConfigStore(io);
    expect(store.mode).toBe("default");
    store.mutate.agent.setMode("eco");
    store.mutate.session.setEcoModelOverride("scout", "session/eco");
    const snapshot = store.createSubagentRuntimeSettings();

    expect(current().mode).toBe("eco");
    expect(snapshot.mode).toBe("eco");
    expect(snapshot.modelSettingForMode!("scout", "parent/model").value).toBe("session/eco");
    expect(snapshot.thinkingSettingForMode!("scout", "high").value).toBe("low");
  });

  it("keeps session Eco overrides above persisted values without saving them", () => {
    const { io, saves } = memIO({
      ecoModelOverrides: { scout: "saved/eco" },
      ecoThinkingOverrides: { scout: "low" },
    });
    const store = new ConfigStore(io);

    expect(store.hasPersistedEcoOverrides()).toBe(true);
    expect(store.ecoModelOverride("scout")).toBe("saved/eco");
    expect(store.ecoThinkingOverride("scout")).toBe("low");

    store.mutate.session.setEcoModelOverride("scout", "session/eco");
    store.mutate.session.setEcoThinkingOverride("scout", "high");
    expect(store.ecoModelOverride("scout")).toBe("session/eco");
    expect(store.ecoThinkingOverride("scout")).toBe("high");

    store.mutate.session.clearEcoModelOverride("scout");
    store.mutate.session.clearEcoThinkingOverride("scout");
    expect(store.ecoModelOverride("scout")).toBe("saved/eco");
    expect(store.ecoThinkingOverride("scout")).toBe("low");
    expect(saves).toHaveLength(0);
  });

  it("resolves scalar defaults without exposing legacy UI fields", () => {
    const { io } = memIO({
      agent: {
        default: null,
        forceBackground: false,
        // Legacy files may still contain these; runtime settings do not
        // expose or recreate presentation-only fields.
        widgetMaxLines: 20,
        showCost: true,
      },
    });
    const settings = new ConfigStore(io).agent;
    expect(settings).toMatchObject({
      defaultModel: null,
      forceBackground: false,
      graceTurns: 6,
      systemPromptMode: "replace",
      includeContextFiles: true,
      outputThinkingBufferSize: 0,
      finishedRetentionMinutes: 60,
    });
    expect(settings).not.toHaveProperty("widgetMaxLines");
    expect(settings).not.toHaveProperty("showCost");
  });

  it("does not recreate removed delegation fields through dynamic writes", () => {
    const { io, current } = memIO({
      agent: {
        default: null,
        forceBackground: false,
        delegate_to: ["scout"] as any,
        max_child_agents: 2,
        maxNestingDepth: 2,
      },
    });
    const store = new ConfigStore(io);

    store.mutate.agent.setModelOverride("delegate_to", "reviewer");
    store.mutate.agent.setModelOverride("max_child_agents", "4");
    store.mutate.agent.setModelOverride("maxNestingDepth", "2");

    expect(current().agent).not.toHaveProperty("delegate_to");
    expect(current().agent).not.toHaveProperty("max_child_agents");
    expect(current().agent).not.toHaveProperty("maxNestingDepth");
  });
});

describe("ConfigStore model and thinking resolution", () => {
  it("uses session per-type overrides before persisted and frontmatter values", () => {
    const { io } = memIO({ agent: { default: "global/model", forceBackground: false, scout: "config/model" } });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("scout", "session/model");

    expect(store.modelSettingFor("scout", "parent/model", { model: "md/model" })).toEqual({
      value: "session/model",
      source: "session-agent",
    });
    expect(store.modelSettingFor("reviewer", "parent/model", { model: "md/model" })).toEqual({
      value: "md/model",
      source: "agent-md",
    });
  });

  it("resolves persisted and session thinking overrides with sources", () => {
    const { io } = memIO({ thinkingOverrides: { scout: "low" as any } });
    const store = new ConfigStore(io);
    expect(store.thinkingSettingFor("scout", "high").value).toBe("low");
    store.mutate.session.setThinkingOverride("scout", "medium" as any);
    expect(store.thinkingSettingFor("scout", "high")).toEqual({ value: "medium", source: "session-agent" });
  });

  it("falls back to the parent when no model is configured", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.modelFor("scout", "parent/model")).toBe("parent/model");
  });

  it("reports the complete model and thinking precedence chain", () => {
    const { io } = memIO({
      agent: {
        default: "config/global-model",
        forceBackground: false,
        reviewer: "config/reviewer-model",
        defaultThinking: "low",
      },
      thinkingOverrides: { reviewer: "medium" },
    });
    const store = new ConfigStore(io);
    const agentMd = { model: "md/model", thinkingLevel: "high" as any };

    store.mutate.session.setOverride("reviewer", "session/reviewer-model");
    store.mutate.session.setThinkingOverride("reviewer", "xhigh" as any);
    store.mutate.session.setOverride("default", "session/global-model");
    store.mutate.session.setThinkingOverride("default", "off" as any);

    expect(store.modelSettingFor("reviewer", "parent/model", agentMd, "spawn/model"))
      .toEqual({ value: "spawn/model", source: "spawn" });
    expect(store.thinkingSettingFor("reviewer", "minimal", agentMd, "max" as any))
      .toEqual({ value: "max", source: "spawn" });

    expect(store.modelSettingFor("reviewer", "parent/model", agentMd))
      .toEqual({ value: "session/reviewer-model", source: "session-agent" });
    expect(store.thinkingSettingFor("reviewer", "minimal", agentMd))
      .toEqual({ value: "xhigh", source: "session-agent" });

    store.mutate.session.clearOverride("reviewer");
    store.mutate.session.clearThinkingOverride("reviewer");
    expect(store.modelSettingFor("reviewer", "parent/model", agentMd))
      .toEqual({ value: "config/reviewer-model", source: "config-agent" });
    expect(store.thinkingSettingFor("reviewer", "minimal", agentMd))
      .toEqual({ value: "medium", source: "config-agent" });

    store.mutate.agent.clearModelOverride("reviewer");
    store.mutate.agent.clearThinkingOverride("reviewer");
    expect(store.modelSettingFor("reviewer", "parent/model", agentMd))
      .toEqual({ value: "md/model", source: "agent-md" });
    expect(store.thinkingSettingFor("reviewer", "minimal", agentMd))
      .toEqual({ value: "high", source: "agent-md" });

    expect(store.modelSettingFor("reviewer", "parent/model"))
      .toEqual({ value: "session/global-model", source: "session-global" });
    expect(store.thinkingSettingFor("reviewer", "minimal"))
      .toEqual({ value: "off", source: "session-global" });

    store.mutate.session.clearOverride("default");
    store.mutate.session.clearThinkingOverride("default");
    expect(store.modelSettingFor("reviewer", "parent/model"))
      .toEqual({ value: "config/global-model", source: "config-global" });
    expect(store.thinkingSettingFor("reviewer", "minimal"))
      .toEqual({ value: "low", source: "config-global" });
  });
});

describe("ConfigStore persistence and manager effects", () => {
  it("persists non-visual settings through the injected ConfigIO", () => {
    const { io, current, saves } = memIO();
    const store = new ConfigStore(io);

    store.mutate.agent.setGraceTurns(9);
    store.mutate.agent.setOutputThinkingBufferSize(128);
    store.mutate.concurrency.setDefault(8);

    expect(saves).toHaveLength(3);
    expect(current().agent.graceTurns).toBe(9);
    expect(current().agent.outputThinkingBufferSize).toBe(128);
    expect(current().concurrency).toEqual({ default: 8 });
  });

  it("updates concurrency and retention through the manager", () => {
    const { io, current } = memIO();
    const { manager, concurrencies, retentions } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager });
    concurrencies.length = 0;
    retentions.length = 0;

    store.mutate.concurrency.setDefault(2);
    store.mutate.agent.setFinishedRetentionMinutes(0);

    expect(concurrencies.at(-1)).toEqual({ default: 2 });
    expect(retentions.at(-1)).toBe(1);
    expect(current().agent.finishedRetentionMinutes).toBe(1);
  });

  it("clears model and thinking overrides while preserving runtime settings", () => {
    const { io, current } = memIO({
      agent: { default: "global/model", scout: "scout/model", forceBackground: true },
      thinkingOverrides: { scout: "low" as any },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    store.mutate.agent.clearAllThinkingOverrides();

    expect(current().agent.default).toBe("global/model");
    expect(current().agent.scout).toBeUndefined();
    expect(current().agent.forceBackground).toBe(true);
    expect(current().thinkingOverrides).toEqual({});
  });

  it("rolls back in-memory state when persistence fails", () => {
    let config = defaultConfig();
    const store = new ConfigStore({
      load: () => structuredClone(config),
      save: () => { throw new Error("disk full"); },
    });
    expect(() => store.mutate.agent.setGraceTurns(20)).toThrow("disk full");
    expect(store.agent.graceTurns).toBe(6);
  });

  it("rolls back Eco overrides to the last durable values when saving fails", () => {
    const initial = {
      ...defaultConfig(),
      ecoModelOverrides: { scout: "saved/eco" },
      ecoThinkingOverrides: { scout: "medium" as any },
    };
    const store = new ConfigStore({
      load: () => structuredClone(initial),
      save: () => { throw new Error("disk full"); },
    });

    expect(() => store.mutate.agent.setEcoModelOverride("scout", "new/eco")).toThrow("disk full");
    expect(store.ecoModelOverride("scout")).toBe("saved/eco");
    expect(store.ecoThinkingOverride("scout")).toBe("medium");
    expect(store.persistedEcoModelOverride("scout")).toBe("saved/eco");
    expect(store.persistedEcoThinkingOverride("scout")).toBe("medium");
  });

  it("preserves an independent concurrent change during a transactional update", () => {
    let disk = defaultConfig();
    const io: ConfigIO = {
      load: () => ({ config: structuredClone(disk), health: "healthy", canRepair: false }),
      save: () => { throw new Error("legacy save should not run"); },
      update: (change) => {
        const latest = structuredClone(disk);
        latest.agent.forceBackground = true;
        change(latest);
        disk = structuredClone(latest);
        return { config: latest, health: "healthy", canRepair: false };
      },
    };
    const store = new ConfigStore(io);

    store.mutate.concurrency.setDefault(8);

    expect(disk.agent.forceBackground).toBe(true);
    expect(disk.concurrency).toEqual({ default: 8 });
    expect(store.agent.forceBackground).toBe(true);
  });

  it("merges concurrent Eco-map changes without dropping either update", () => {
    let disk: SubagentsConfig = {
      ...defaultConfig(),
      ecoModelOverrides: { scout: "old/eco" },
      ecoThinkingOverrides: { scout: "low" as any },
    };
    const io: ConfigIO = {
      load: () => ({ config: structuredClone(disk), health: "healthy", canRepair: false }),
      save: () => { throw new Error("legacy save should not run"); },
      update: (change) => {
        const latest = structuredClone(disk);
        latest.ecoModelOverrides = { ...(latest.ecoModelOverrides ?? {}), reviewer: "concurrent/eco" };
        latest.ecoThinkingOverrides = { ...(latest.ecoThinkingOverrides ?? {}), reviewer: "high" as any };
        change(latest);
        disk = structuredClone(latest);
        return { config: latest, health: "healthy", canRepair: false };
      },
    };
    const store = new ConfigStore(io);

    store.mutate.agent.setEcoModelOverride("scout", "new/eco");

    expect(disk.ecoModelOverrides).toEqual({ scout: "new/eco", reviewer: "concurrent/eco" });
    expect(disk.ecoThinkingOverrides).toEqual({ scout: "low", reviewer: "high" });
    expect(store.ecoModelOverride("reviewer")).toBe("concurrent/eco");
    expect(store.ecoThinkingOverride("reviewer")).toBe("high");
  });
});

describe("ConfigStore lifecycle and session overrides", () => {
  it("keeps session model overrides in memory and clears them on reload", () => {
    const { io } = memIO();
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("scout", "session/model");
    expect(store.modelFor("scout", "parent/model")).toBe("session/model");
    store.reload();
    expect(store.modelFor("scout", "parent/model")).toBe("parent/model");
  });

  it("drops the manager dependency on dispose", () => {
    const { io } = memIO();
    const { manager, retentions } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager });
    store.dispose();
    retentions.length = 0;
    store.mutate.agent.setFinishedRetentionMinutes(10);
    expect(retentions).toEqual([]);
  });

  it("persists output-log buffering without a UI dependency", () => {
    const { io, current } = memIO();
    const store = new ConfigStore(io);
    store.mutate.agent.setOutputThinkingBufferSize(200);
    expect(current().agent.outputThinkingBufferSize).toBe(200);
    expect(store.agent.outputThinkingBufferSize).toBe(200);
  });
});
