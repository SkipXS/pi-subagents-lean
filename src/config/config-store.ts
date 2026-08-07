import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentSettingsOverride, AgentSettingsOverrides, SubagentsConfig } from "./types.js";
import {
  normalizeAgentEntries,
  normalizeAgentSettingsOverrides,
  normalizeConcurrencyDefault,
} from "./types.js";
import {
  DEFAULT_CONCURRENCY,
  loadConfig,
  saveConfigAtomic,
  updateConfigAtomic,
  repairConfig,
  type ConfigHealth,
  type ConfigLoadResult,
} from "./config-io.js";

/** Injected persistence adapter. Swap for an in-memory adapter in tests. */
export interface ConfigIO {
  /** Legacy adapters may return a config directly; production returns health too. */
  load(): SubagentsConfig | ConfigLoadResult;
  save(config: SubagentsConfig): void;
  /** Transactionally applies a concrete change to the latest disk snapshot. */
  update?(change: (config: SubagentsConfig) => void): ConfigLoadResult;
  repair?(): ConfigLoadResult;
}

/** Production adapter wrapping the real config file. */
export const fileConfigIO: ConfigIO = {
  load: () => loadConfig(),
  save: (config) => { saveConfigAtomic(config); },
  update: (change) => updateConfigAtomic(change),
  repair: () => repairConfig(),
};

/** Agent settings with all scalar defaults resolved. */
export interface ResolvedAgentSettings {
  /** Whether to include AGENTS.md context files in the subagent system prompt. */
  readonly includeContextFiles: boolean;
  /** Whether to skip bundled default agents during catalog discovery. */
  readonly disableDefaultAgents: boolean;
  /** Whether to append dynamic parent-agent orchestration guidance. */
  readonly orchestrationPrompt: boolean;
}

/** Detached settings captured for one accepted root execution. */
export interface SubagentRuntimeSettings {
  readonly agent: Readonly<ResolvedAgentSettings>;
  /** Normalized per-agent model/thinking overrides, when any are configured. */
  readonly agents?: Readonly<Record<string, Readonly<AgentSettingsOverride>>>;
}

export interface ConfigStoreDeps {
  manager?: AgentManager;
}

const DEFAULT_AGENT_SETTINGS: Required<ResolvedAgentSettings> = {
  includeContextFiles: true,
  disableDefaultAgents: false,
  orchestrationPrompt: true,
};

export class ConfigStore {
  private config: SubagentsConfig;
  /** Last successfully loaded or saved config; used to roll back failed writes. */
  private persistedConfig: SubagentsConfig;
  private configHealth: ConfigHealth = "healthy";
  private repairAvailable = false;
  // This is a shell-owned control collaborator. ECMAScript private fields keep
  // getStore() from becoming an indirect route to it in child runtimes.
  #manager?: AgentManager;

  constructor(private readonly io: ConfigIO = fileConfigIO) {
    const loaded = this.readConfig();
    this.config = loaded.config;
    this.persistedConfig = structuredClone(this.config);
    this.configHealth = loaded.health;
    this.repairAvailable = loaded.canRepair;
  }

  // ── Reads ──────────────────────────────────────────────────────

  /** Health of the source used for this session's durable config. */
  get health(): ConfigHealth {
    return this.configHealth;
  }

  /** True only when a readable corrupt primary can safely be restored from .bak. */
  get canRepair(): boolean {
    return this.repairAvailable;
  }

  get agent(): ResolvedAgentSettings {
    const agent = this.config.agent;
    return {
      includeContextFiles: agent.includeContextFiles ?? DEFAULT_AGENT_SETTINGS.includeContextFiles,
      disableDefaultAgents: agent.disableDefaultAgents ?? DEFAULT_AGENT_SETTINGS.disableDefaultAgents,
      orchestrationPrompt: agent.orchestrationPrompt ?? DEFAULT_AGENT_SETTINGS.orchestrationPrompt,
    };
  }

  get concurrency(): { default: number } {
    return { default: normalizeConcurrencyDefault(this.config.concurrency?.default) };
  }

  /** Persisted per-agent overrides, normalized and detached from the config object. */
  get agents(): Readonly<AgentSettingsOverrides> {
    return this.config.agents ? structuredClone(this.config.agents) : {};
  }

  /** Capture immutable settings at the accepted root spawn boundary. */
  createSubagentRuntimeSettings(): SubagentRuntimeSettings {
    const normalizedAgents = normalizeAgentSettingsOverrides(this.config.agents);
    const agents = Object.keys(normalizedAgents).length > 0
      ? Object.fromEntries(
        Object.entries(normalizedAgents).map(([name, override]) => [name, Object.freeze({ ...override })]),
      )
      : undefined;
    return Object.freeze({
      agent: Object.freeze({ ...this.agent }),
      ...(agents ? { agents: Object.freeze(agents) } : {}),
    });
  }

  // ── Mutations ──────────────────────────────────────────────────

  readonly mutate = {
    agent: {
      setIncludeContextFiles: (enabled: boolean): void => {
        this.config.agent.includeContextFiles = enabled;
        this.persist();
      },
      setDisableDefaultAgents: (enabled: boolean): void => {
        this.config.agent.disableDefaultAgents = enabled;
        this.persist();
      },
      setOrchestrationPrompt: (enabled: boolean): void => {
        this.config.agent.orchestrationPrompt = enabled;
        this.persist();
      },
    },
    concurrency: {
      setDefault: (n: number): void => {
        this.config.concurrency.default = normalizeConcurrencyDefault(n);
        this.persist();
        this.applyConcurrency();
      },
      reset: (): void => {
        this.config.concurrency = { ...DEFAULT_CONCURRENCY };
        this.persist();
        this.applyConcurrency();
      },
    },
  };

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read disk and re-sync the manager dependency at session_start. */
  reload(): void {
    const loaded = this.readConfig();
    this.config = loaded.config;
    this.persistedConfig = structuredClone(this.config);
    this.configHealth = loaded.health;
    this.repairAvailable = loaded.canRepair;
    this.syncAllDeps();
  }

  /** Inject the manager used by configuration side effects. */
  setDeps(deps: ConfigStoreDeps): void {
    if (deps.manager !== undefined) this.#manager = deps.manager;
    this.syncAllDeps();
  }

  /** Drop the manager dependency at session_shutdown. */
  dispose(): void {
    this.#manager = undefined;
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Restore the durable primary from .bak without changing active settings. */
  repair(): void {
    if (this.configHealth !== "using-backup" || !this.repairAvailable || !this.io.repair) {
      throw new Error("Config repair is unavailable for this persistence adapter.");
    }
    const repaired = this.io.repair();
    const config = normalizeStoreConfig(repaired.config);
    this.config = config;
    this.persistedConfig = structuredClone(config);
    this.configHealth = repaired.health;
    this.repairAvailable = repaired.canRepair;
    this.syncAllDeps();
  }

  /** Save current config, restoring the last durable state if the write fails. */
  private persist(): void {
    const before = this.persistedConfig;
    const desired = this.config;
    try {
      if (this.io.update) {
        const saved = this.io.update((latest) => applyConfigDelta(latest, before, desired));
        this.config = normalizeStoreConfig(saved.config);
        this.persistedConfig = structuredClone(this.config);
        this.configHealth = saved.health;
        this.repairAvailable = saved.canRepair;
      } else {
        const normalized = normalizeStoreConfig(desired);
        this.io.save(normalized);
        this.config = structuredClone(normalized);
        this.persistedConfig = structuredClone(normalized);
      }
    } catch (err) {
      // Keep the last durable in-memory snapshot, but re-read health: the
      // primary may have become corrupt after this store was constructed.
      this.config = structuredClone(this.persistedConfig);
      try {
        const current = this.readConfig();
        this.configHealth = current.health;
        this.repairAvailable = current.canRepair;
      } catch {
        this.configHealth = "unrecoverable";
        this.repairAvailable = false;
      }
      throw err;
    }
  }

  private readConfig(): ConfigLoadResult {
    const loaded = this.io.load();
    const result = "health" in loaded && "canRepair" in loaded
      ? loaded
      : { config: loaded, health: "healthy" as const, canRepair: false };
    return { ...result, config: normalizeStoreConfig(result.config) };
  }

  private applyConcurrency(): void {
    this.#manager?.setConcurrency({
      default: normalizeConcurrencyDefault(this.config.concurrency?.default),
    });
  }

  private syncAllDeps(): void {
    this.applyConcurrency();
  }
}

function normalizeStoreConfig(raw: SubagentsConfig): SubagentsConfig {
  const agent = normalizeAgentEntries((raw.agent ?? {}) as Record<string, unknown>);
  const agents = normalizeAgentSettingsOverrides(raw.agents);
  return {
    agent: { ...DEFAULT_AGENT_SETTINGS, ...agent },
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    concurrency: { default: normalizeConcurrencyDefault(raw.concurrency?.default) },
  };
}

/** Apply only this store mutation's changed fields to a freshly locked snapshot. */
function applyConfigDelta(latest: SubagentsConfig, before: SubagentsConfig, desired: SubagentsConfig): void {
  latest.agent = normalizeAgentEntries((latest.agent ?? {}) as Record<string, unknown>) as SubagentsConfig["agent"];
  applyObjectDelta(
    latest.agent as Record<string, unknown>,
    (before.agent ?? {}) as Record<string, unknown>,
    (desired.agent ?? {}) as Record<string, unknown>,
  );

  latest.concurrency = {
    default: normalizeConcurrencyDefault(latest.concurrency?.default),
  };
  const beforeConcurrency = {
    default: normalizeConcurrencyDefault(before.concurrency?.default),
  };
  const desiredConcurrency = {
    default: normalizeConcurrencyDefault(desired.concurrency?.default),
  };
  applyObjectDelta(latest.concurrency, beforeConcurrency, desiredConcurrency);

  // Per-agent overrides are host-edited configuration, not a ConfigStore
  // mutation. Keep the latest locked snapshot intact so an unrelated scalar
  // setting change cannot overwrite a concurrent agents-map edit.
  const normalizedAgents = normalizeAgentSettingsOverrides(latest.agents);
  if (Object.keys(normalizedAgents).length > 0) latest.agents = normalizedAgents;
  else delete latest.agents;
}

function applyObjectDelta(latest: Record<string, unknown>, before: Record<string, unknown>, desired: Record<string, unknown>): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(desired)]);
  for (const key of keys) {
    if (Object.is(before[key], desired[key])) continue;
    if (Object.hasOwn(desired, key)) latest[key] = structuredClone(desired[key]);
    else delete latest[key];
  }
}
