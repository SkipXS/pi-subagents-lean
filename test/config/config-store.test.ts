import { describe, expect, it } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.ts";
import type { SubagentsConfig } from "../../src/config/types.ts";

function defaultConfig(): SubagentsConfig {
  return {
    agent: {
      includeContextFiles: true,
      disableDefaultAgents: false,
      orchestrationPrompt: true,
    },
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

function managerStub(): { manager: any; concurrencies: unknown[] } {
  const concurrencies: unknown[] = [];
  const manager = { setConcurrency: (config: unknown) => concurrencies.push(config) };
  return { manager, concurrencies };
}

describe("ConfigStore runtime settings", () => {
  it("captures a frozen stable snapshot of current settings", () => {
    const { io } = memIO({ agent: { includeContextFiles: false } });
    const store = new ConfigStore(io);
    const snapshot = store.createSubagentRuntimeSettings();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.agent)).toBe(true);
    expect(snapshot.agent).toEqual({
      includeContextFiles: false,
      disableDefaultAgents: false,
      orchestrationPrompt: true,
    });

    store.mutate.agent.setIncludeContextFiles(true);
    expect(snapshot.agent.includeContextFiles).toBe(false);
  });
});

describe("ConfigStore persistence and manager effects", () => {
  it("persists only current runtime settings", () => {
    const { io, current, saves } = memIO();
    const store = new ConfigStore(io);

    store.mutate.agent.setIncludeContextFiles(false);
    store.mutate.agent.setDisableDefaultAgents(true);
    store.mutate.agent.setOrchestrationPrompt(false);

    expect(saves).toHaveLength(3);
    expect(current()).toEqual({
      agent: { includeContextFiles: false, disableDefaultAgents: true, orchestrationPrompt: false },
      concurrency: { default: 4 },
    });
  });

  it("updates concurrency through the manager", () => {
    const { io } = memIO();
    const { manager, concurrencies } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager });
    concurrencies.length = 0;

    store.mutate.concurrency.setDefault(2);
    expect(concurrencies.at(-1)).toEqual({ default: 2 });
  });

  it("rolls back in-memory state when persistence fails", () => {
    const store = new ConfigStore({
      load: () => structuredClone(defaultConfig()),
      save: () => { throw new Error("disk full"); },
    });

    expect(() => store.mutate.agent.setIncludeContextFiles(false)).toThrow("disk full");
    expect(store.agent.includeContextFiles).toBe(true);
  });

  it("rolls back an update failure and refreshes persistence health", () => {
    const { io, current } = memIO();
    let updateFailed = false;
    io.load = () => updateFailed
      ? { config: structuredClone(current()), health: "using-backup", canRepair: true }
      : { config: structuredClone(current()), health: "healthy", canRepair: false };
    io.update = () => {
      updateFailed = true;
      throw new Error("disk full");
    };
    const store = new ConfigStore(io);

    expect(() => store.mutate.agent.setIncludeContextFiles(false)).toThrow("disk full");

    expect(store.agent.includeContextFiles).toBe(true);
    expect(store.health).toBe("using-backup");
    expect(store.canRepair).toBe(true);
  });

  it("does not persist unknown agent keys or interpret them as models", () => {
    const { io, current } = memIO();
    const store = new ConfigStore(io);
    (store as any).config.agent.ignoredRole = "provider/model";
    store.mutate.agent.setOrchestrationPrompt(false);

    expect(current().agent).not.toHaveProperty("ignoredRole");
    expect(store.agent).not.toHaveProperty("defaultModel");
  });
});

describe("ConfigStore lifecycle", () => {
  it("re-reads settings on reload", () => {
    const { io, current } = memIO();
    const store = new ConfigStore(io);
    store.mutate.agent.setIncludeContextFiles(false);
    current().agent.includeContextFiles = true;
    store.reload();
    expect(store.agent.includeContextFiles).toBe(true);
  });

  it("reloads health and concurrency and re-syncs the manager", () => {
    const { io, current } = memIO();
    let useBackup = false;
    io.load = () => useBackup
      ? { config: structuredClone(current()), health: "using-backup", canRepair: true }
      : { config: structuredClone(current()), health: "healthy", canRepair: false };
    const { manager, concurrencies } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager });
    concurrencies.length = 0;

    current().concurrency.default = 2;
    useBackup = true;
    store.reload();

    expect(store.health).toBe("using-backup");
    expect(store.canRepair).toBe(true);
    expect(store.concurrency).toEqual({ default: 2 });
    expect(concurrencies).toEqual([{ default: 2 }]);
  });

  it("preserves a newer disk snapshot during a transactional update", () => {
    const { io, current } = memIO();
    io.update = (change) => {
      const latest = current();
      change(latest);
      return { config: structuredClone(latest), health: "healthy", canRepair: false };
    };
    const store = new ConfigStore(io);

    current().agent.disableDefaultAgents = true;
    current().agent.orchestrationPrompt = false;
    current().concurrency.default = 9;
    store.mutate.agent.setIncludeContextFiles(false);

    expect(current()).toEqual({
      agent: { includeContextFiles: false, disableDefaultAgents: true, orchestrationPrompt: false },
      concurrency: { default: 9 },
    });
  });

  it("drops the manager dependency on dispose", () => {
    const { io } = memIO();
    const { manager, concurrencies } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager });
    store.dispose();
    concurrencies.length = 0;
    store.mutate.concurrency.setDefault(10);
    expect(concurrencies).toEqual([]);
  });
});
