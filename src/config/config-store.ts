/**
 * config-store.ts — Deep module owning persisted config + per-session overrides.
 *
 * Absorbs config-io.ts and config-mutator.ts. See
 * docs/adr/0004-composition-root-over-shared-state.md.
 *
 * - Reads return defaults baked in rather than duplicating fallback logic at call sites.
 * - Each persisted mutate method is mutate + persist + its side effect, so a
 *   side effect cannot be forgotten.
 * - The manager is injected after construction (it is created lazily).
 *
 * Lifecycle: per-session. `reload()` re-reads disk + resets session overrides
 * at session_start. `dispose()` drops the manager dependency at session_shutdown.
 */

import type {
  ResolvedSetting,
  SessionModelOverrides,
  SessionThinkingOverrides,
  SubagentsConfig,
} from "../models/model-precedence.js";
import { resolveModelSetting, resolveThinkingSetting } from "../models/model-precedence.js";
import type { AgentManager } from "../agents/agent-manager.js";
import { CONFIG_AGENT_NON_MODEL_KEYS, normalizeAgentEntries } from "./types.js";
import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";
import { parseThinkingLevel } from "../utils.js";
import {
  VALID_SYSTEM_PROMPT_MODES,
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
  save: (c) => { saveConfigAtomic(c); },
  update: (change) => updateConfigAtomic(change),
  repair: () => repairConfig(),
};

/** Agent settings with all scalar defaults resolved. Model fields stay nullable. */
export interface ResolvedAgentSettings {
  /** null = inherit parent. Kept nullable to preserve resolveModel's null-skip. */
  readonly defaultModel: string | null;
  readonly forceBackground: boolean;
  /** System prompt mode: replace (default), inherit parent, or custom file. */
  readonly systemPromptMode: SystemPromptMode;
  /** Whether to include AGENTS.md context files in the subagent system prompt. */
  readonly includeContextFiles: boolean;
  /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
  readonly defaultThinking: ThinkingLevel | undefined;
  /** Global default for skills loading: true (load all) or false (none). */
  readonly loadSkillsImplicitly: boolean;
  /** Global default for extensions loading: true (load all) or false (none). */
  readonly loadExtensionsImplicitly: boolean;
  /** Whether to skip built-in default agents at registration. */
  readonly disableDefaultAgents: boolean;
  /** Whether to append dynamic parent-agent orchestration guidance. */
  readonly orchestrationPrompt: boolean;
  /** Minutes to retain finished agents before cleanup eviction. */
  readonly finishedRetentionMinutes: number;
}

/** Side-effect targets, injected after construction. */
/**
 * Detached settings captured for one accepted root execution. This deliberately
 * contains values and pure resolvers only: it is not a ConfigStore view and
 * cannot reach persistence, dependencies, or session mutation methods.
 */
export interface SubagentRuntimeSettings {
  readonly agent: Readonly<ResolvedAgentSettings>;
  /** Backwards-compatible value-only model resolver. */
  modelFor(type: string, parentModelId: string, agentConfig?: { model?: string }, explicitModel?: string): string;
  /** Backwards-compatible thinking resolver. */
  thinkingSettingFor(type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel): ResolvedSetting<ThinkingLevel | undefined>;
}

export interface ConfigStoreDeps {
  manager?: AgentManager;
}

export class ConfigStore {
  private config: SubagentsConfig;
  /** Last successfully loaded or saved config; used to roll back failed writes. */
  private persistedConfig: SubagentsConfig;
  private configHealth: ConfigHealth = "healthy";
  private repairAvailable = false;
  private sessionOverrides: SessionModelOverrides = { default: null };
  private sessionThinkingOverrides: SessionThinkingOverrides = {};
  // These are shell-owned control collaborators. ECMAScript private fields
  // keep getStore() from becoming an indirect route to them in child runtimes.
  #manager?: AgentManager;

  constructor(private readonly io: ConfigIO = fileConfigIO) {
    const loaded = this.readConfig();
    this.config = stripRemovedAgentFields(loaded.config);
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
    const a = this.config.agent;

    return {
      defaultModel: a.default ?? null,
      forceBackground: a.forceBackground === true,
      systemPromptMode: VALID_SYSTEM_PROMPT_MODES.has(a.systemPromptMode as string) ? (a.systemPromptMode as SystemPromptMode) : "replace",
      includeContextFiles: a.includeContextFiles ?? true,
      defaultThinking: parseThinkingLevel(a.defaultThinking),
      loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
      loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
      disableDefaultAgents: a.disableDefaultAgents === true,
      orchestrationPrompt: a.orchestrationPrompt !== false,
      finishedRetentionMinutes: a.finishedRetentionMinutes ?? 60,
    };
  }

  get concurrency(): { default: number } {
    return { default: this.config.concurrency.default };
  }

  get sessionDefaultModel(): string | null {
    return this.sessionOverrides.default ?? null;
  }

  sessionModelOverride(type: string): string | null {
    return this.sessionOverrides[type] ?? null;
  }

  get sessionDefaultThinking(): ThinkingLevel | undefined {
    return this.sessionThinkingOverrides.default;
  }

  sessionThinkingOverride(type: string): ThinkingLevel | undefined {
    return this.sessionThinkingOverrides[type];
  }

  persistedThinkingOverride(type: string): ThinkingLevel | undefined {
    return this.config.thinkingOverrides?.[type] ?? undefined;
  }

  /** Whether persisted thinking entries exist, including entries for removed agent types. */
  hasPersistedThinkingOverrides(): boolean {
    return Object.keys(this.config.thinkingOverrides ?? {}).length > 0;
  }

  /** Raw agent config including dynamic per-type model keys. */
  agentConfigSnapshot(): Readonly<SubagentsConfig["agent"]> {
    return this.config.agent;
  }

  modelSettingFor(
    type: string,
    parentModelId: string,
    agentConfig?: { model?: string },
    explicitModel?: string,
  ): ResolvedSetting<string> {
    return resolveModelSetting({
      subagentType: type,
      explicitModel,
      agentConfig,
      config: this.config,
      parentModelId,
      sessionOverrides: this.sessionOverrides,
    });
  }

  modelFor(type: string, parentModelId: string, agentConfig?: { model?: string }, explicitModel?: string): string {
    return this.modelSettingFor(type, parentModelId, agentConfig, explicitModel).value;
  }

  /** Capture immutable model/thinking settings at the accepted root spawn boundary. */
  createSubagentRuntimeSettings(): SubagentRuntimeSettings {
    const config = structuredClone(this.config);
    const sessionOverrides = structuredClone(this.sessionOverrides);
    const sessionThinkingOverrides = structuredClone(this.sessionThinkingOverrides);
    const agent = Object.freeze({ ...this.agent });
    const defaultModel = (type: string, parentModelId: string, agentConfig?: { model?: string }, explicitModel?: string) => resolveModelSetting({
      subagentType: type, explicitModel, agentConfig, config, parentModelId, sessionOverrides,
    });
    const defaultThinking = (type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel) => resolveThinkingSetting({
      subagentType: type, explicitThinking, agentConfig, config, parentThinking, sessionOverrides: sessionThinkingOverrides,
    });
    return Object.freeze({
      agent,
      modelFor: (type: string, parentModelId: string, agentConfig?: { model?: string }, explicitModel?: string) => defaultModel(type, parentModelId, agentConfig, explicitModel).value,
      thinkingSettingFor: (type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel) => defaultThinking(type, parentThinking, agentConfig, explicitThinking),
    });
  }

  thinkingSettingFor(
    type: string,
    parentThinking: ThinkingLevel | undefined,
    agentConfig?: { thinkingLevel?: ThinkingLevel },
    explicitThinking?: ThinkingLevel,
  ): ResolvedSetting<ThinkingLevel | undefined> {
    return resolveThinkingSetting({
      subagentType: type,
      explicitThinking,
      agentConfig,
      config: this.config,
      parentThinking,
      sessionOverrides: this.sessionThinkingOverrides,
    });
  }

  // ── Mutations ──────────────────────────────────────────────────
  // Each persisted method = mutate + persist (+ side effect). Session methods
  // are in-memory only: never persisted, no side effects.

  readonly mutate = {
    agent: {
      setDefaultModel: (value: string | null): void => {
        this.config.agent.default = value;
        this.persist();
      },
      setModelOverride: (type: string, value: string | null): void => {
        this.config.agent[type] = value;
        this.persist();
      },
      clearModelOverride: (type: string): void => {
        delete this.config.agent[type];
        this.persist();
      },
      setThinkingOverride: (type: string, value: ThinkingLevel): void => {
        this.config.thinkingOverrides = { ...(this.config.thinkingOverrides ?? {}), [type]: value };
        this.persist();
      },
      clearThinkingOverride: (type: string): void => {
        if (this.config.thinkingOverrides) delete this.config.thinkingOverrides[type];
        this.persist();
      },
      /** Clear all per-type model overrides, preserving non-model settings. */
      clearAllModelOverrides: (): void => {
        const preserved: Record<string, unknown> = {};
        for (const key of CONFIG_AGENT_NON_MODEL_KEYS) {
          const val = this.config.agent[key];
          if (val != null || key === "default" || key === "forceBackground") {
            preserved[key] = val;
          }
        }
        this.config.agent = preserved as SubagentsConfig["agent"];
        this.persist();
      },
      clearAllThinkingOverrides: (): void => {
        this.config.thinkingOverrides = {};
        this.persist();
      },
      /** Atomically clear saved model/thinking overrides and global defaults. */
      resetAllModelAndThinkingOverrides: (): void => {
        const preserved: Record<string, unknown> = {};
        for (const key of CONFIG_AGENT_NON_MODEL_KEYS) {
          const val = this.config.agent[key];
          if (val != null || key === "default" || key === "forceBackground") {
            preserved[key] = val;
          }
        }
        // The preserved list includes these fields for clearAllModelOverrides;
        // reset-all deliberately clears both global defaults too.
        preserved.default = null;
        delete preserved.defaultThinking;
        this.config.agent = preserved as SubagentsConfig["agent"];
        this.config.thinkingOverrides = {};
        this.persist();
      },
      setForceBackground: (enabled: boolean): void => {
        this.config.agent.forceBackground = enabled;
        this.persist();
      },
      setSystemPromptMode: (mode: SystemPromptMode): void => {
        this.config.agent.systemPromptMode = mode;
        this.persist();
      },
      setIncludeContextFiles: (enabled: boolean): void => {
        this.config.agent.includeContextFiles = enabled;
        this.persist();
      },
      setDefaultThinking: (level: ThinkingLevel | undefined): void => {
        if (level === undefined) {
          delete this.config.agent.defaultThinking;
        } else {
          this.config.agent.defaultThinking = level;
        }
        this.persist();
      },
      setLoadSkillsImplicitly: (value: boolean): void => {
        this.config.agent.loadSkillsImplicitly = value;
        this.persist();
      },
      setLoadExtensionsImplicitly: (value: boolean): void => {
        this.config.agent.loadExtensionsImplicitly = value;
        this.persist();
      },
      setDisableDefaultAgents: (value: boolean): void => {
        this.config.agent.disableDefaultAgents = value;
        this.persist();
      },
      setOrchestrationPrompt: (enabled: boolean): void => {
        this.config.agent.orchestrationPrompt = enabled;
        this.persist();
      },
      setFinishedRetentionMinutes: (minutes: number): void => {
        const n = Math.max(1, minutes);
        this.config.agent.finishedRetentionMinutes = n;
        this.persist();
        this.#manager?.setRetentionMinutes(n);
      },
    },
    concurrency: {
      setDefault: (n: number): void => {
        this.config.concurrency.default = n;
        this.persist();
        this.applyConcurrency();
      },
      reset: (): void => {
        this.config.concurrency = { ...DEFAULT_CONCURRENCY };
        this.persist();
        this.applyConcurrency();
      },
    },
    session: {
      /** Set a session model override for a type (or "default"). Not persisted. */
      setOverride: (type: string, model: string): void => {
        this.sessionOverrides[type] = model;
      },
      clearOverride: (type: string): void => {
        delete this.sessionOverrides[type];
      },
      setThinkingOverride: (type: string, level: ThinkingLevel): void => {
        this.sessionThinkingOverrides[type] = level;
      },
      clearThinkingOverride: (type: string): void => {
        delete this.sessionThinkingOverrides[type];
      },
      clearAll: (): void => {
        this.sessionOverrides = { default: null };
        this.sessionThinkingOverrides = {};
      },
    },
  };

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read disk, reset session overrides + toggle state, re-sync deps. Called at session_start. */
  reload(): void {
    const loaded = this.readConfig();
    this.config = stripRemovedAgentFields(loaded.config);
    this.persistedConfig = structuredClone(this.config);
    this.configHealth = loaded.health;
    this.repairAvailable = loaded.canRepair;
    this.sessionOverrides = { default: null };
    this.sessionThinkingOverrides = {};
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

  /** Restore the durable primary from .bak without touching session overrides. */
  repair(): void {
    if (this.configHealth !== "using-backup" || !this.repairAvailable || !this.io.repair) {
      throw new Error("Config repair is unavailable for this persistence adapter.");
    }
    const repaired = this.io.repair();
    this.config = stripRemovedAgentFields(repaired.config);
    this.persistedConfig = structuredClone(this.config);
    this.configHealth = repaired.health;
    this.repairAvailable = repaired.canRepair;
    this.syncAllDeps();
  }

  /** Save current config, restoring the last durable state if the write fails. */
  private persist(): void {
    const before = stripRemovedAgentFields(this.persistedConfig);
    const desired = stripRemovedAgentFields(this.config);
    try {
      if (this.io.update) {
        const saved = this.io.update((latest) => applyConfigDelta(latest, before, desired));
        const sanitized = stripRemovedAgentFields(saved.config);
        this.config = structuredClone(sanitized);
        this.persistedConfig = structuredClone(sanitized);
        this.configHealth = saved.health;
        this.repairAvailable = saved.canRepair;
      } else {
        const sanitized = stripRemovedAgentFields(desired);
        this.io.save(sanitized);
        this.config = structuredClone(sanitized);
        this.persistedConfig = structuredClone(sanitized);
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
    return "health" in loaded && "canRepair" in loaded
      ? loaded
      : { config: loaded, health: "healthy", canRepair: false };
  }

  private applyConcurrency(): void {
    this.#manager?.setConcurrency(this.config.concurrency);
  }

  /** Full re-sync of the manager dependency. Used by reload/setDeps. */
  private syncAllDeps(): void {
    this.applyConcurrency();
    this.#manager?.setRetentionMinutes(this.agent.finishedRetentionMinutes);
  }
}

/** Apply only this store mutation's changed fields to a freshly locked snapshot. */
const REMOVED_AGENT_FIELDS = [
  "maxNestingDepth", "max_nesting_depth", "delegate_to", "delegateTo", "max_child_agents", "maxChildAgents",
] as const;

function stripRemovedAgentFields(config: SubagentsConfig): SubagentsConfig {
  const sanitized = structuredClone(config);
  const agent = sanitized.agent as Record<string, unknown>;
  for (const field of REMOVED_AGENT_FIELDS) delete agent[field];
  sanitized.agent = normalizeAgentEntries(agent) as SubagentsConfig["agent"];
  const root = sanitized as unknown as Record<string, unknown>;
  delete root.mode;
  delete root.ecoModelOverrides;
  delete root.ecoThinkingOverrides;
  return sanitized;
}

function applyConfigDelta(latest: SubagentsConfig, before: SubagentsConfig, desired: SubagentsConfig): void {
  const latestAgent = latest.agent as Record<string, unknown>;
  for (const field of REMOVED_AGENT_FIELDS) delete latestAgent[field];
  latest.agent = normalizeAgentEntries(latestAgent) as SubagentsConfig["agent"];
  const normalizedAgent = latest.agent as Record<string, unknown>;
  const latestRoot = latest as unknown as Record<string, unknown>;
  delete latestRoot.mode;
  delete latestRoot.ecoModelOverrides;
  delete latestRoot.ecoThinkingOverrides;
  applyObjectDelta(normalizedAgent, before.agent as Record<string, unknown>, desired.agent as Record<string, unknown>);
  applyObjectDelta(latest.concurrency as Record<string, unknown>, before.concurrency as Record<string, unknown>, desired.concurrency as Record<string, unknown>);
  latest.thinkingOverrides ??= {};
  applyObjectDelta(
    latest.thinkingOverrides as Record<string, unknown>,
    (before.thinkingOverrides ?? {}) as Record<string, unknown>,
    (desired.thinkingOverrides ?? {}) as Record<string, unknown>,
  );
}

function applyObjectDelta(latest: Record<string, unknown>, before: Record<string, unknown>, desired: Record<string, unknown>): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(desired)]);
  for (const key of keys) {
    if (Object.is(before[key], desired[key])) continue;
    if (Object.hasOwn(desired, key)) latest[key] = structuredClone(desired[key]);
    else delete latest[key];
  }
}
