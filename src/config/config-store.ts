/**
 * config-store.ts — Deep module owning persisted config + per-session overrides.
 *
 * Absorbs config-io.ts and config-mutator.ts. See
 * docs/adr/0004-composition-root-over-shared-state.md.
 *
 * - Reads return defaults baked in (no `?? 6` at call sites).
 * - Each persisted mutate method is mutate + persist + its side effect, so a
 *   side effect cannot be forgotten.
 * - The manager is injected after construction (it is created lazily).
 *
 * Lifecycle: per-session. `reload()` re-reads disk + resets session overrides
 * at session_start. `dispose()` drops the manager dependency at session_shutdown.
 */

import type {
  AgentMode,
  EcoSessionOverrides,
  ResolvedEcoSetting,
  ResolvedSetting,
  SessionModelOverrides,
  SessionThinkingOverrides,
  SubagentsConfig,
} from "../models/model-precedence.js";
import { resolveEcoModelSetting, resolveEcoThinkingSetting, resolveModelSetting, resolveThinkingSetting } from "../models/model-precedence.js";
import type { AgentManager } from "../agents/agent-manager.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "./types.js";
import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";
import { parseThinkingLevel } from "../utils.js";
import {
  VALID_SYSTEM_PROMPT_MODES,
  DEFAULT_CONCURRENCY,
  normalizeMaxNestingDepth,
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
  readonly graceTurns: number;
  /** System prompt mode: replace (default), inherit parent, or custom file. */
  readonly systemPromptMode: SystemPromptMode;
  /** Whether to include AGENTS.md context files in the subagent system prompt. */
  readonly includeContextFiles: boolean;
  /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
  readonly defaultThinking: ThinkingLevel | undefined;
  /** Default max turns for spawned agents. Undefined = unlimited. */
  readonly defaultMaxTurns: number | undefined;
  /** Global default for skills loading: true (load all) or false (none). */
  readonly loadSkillsImplicitly: boolean;
  /** Global default for extensions loading: true (load all) or false (none). */
  readonly loadExtensionsImplicitly: boolean;
  /** Whether to skip built-in default agents at registration. */
  readonly disableDefaultAgents: boolean;
  /** Whether to append dynamic parent-agent orchestration guidance. */
  readonly orchestrationPrompt: boolean;
  /** Buffer size for streaming thinking blocks to output file. 0 = disabled. */
  readonly outputThinkingBufferSize: number;
  /** Minutes to retain finished agents before cleanup eviction. */
  readonly finishedRetentionMinutes: number;
  /** Maximum subagent depth; valid values are 1 or 2. */
  readonly maxNestingDepth: number;
}

/** Side-effect targets, injected after construction. */
/**
 * Detached settings available to a child agent runtime. This deliberately
 * contains values and pure resolvers only: it is not a ConfigStore view and
 * cannot reach persistence, dependencies, or session mutation methods.
 */
export interface SubagentRuntimeSettings {
  readonly agent: Readonly<ResolvedAgentSettings>;
  /** Added with Eco mode; absent on snapshots captured by older runtimes. */
  readonly mode?: AgentMode;
  /** Backwards-compatible Default-mode resolver. */
  modelFor(type: string, parentModelId: string, agentConfig?: { model?: string }, explicitModel?: string): string;
  /** Backwards-compatible Default-mode thinking resolver. */
  thinkingSettingFor(type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel): ResolvedSetting<ThinkingLevel | undefined>;
  modelSettingForMode?(
    type: string,
    parentModelId: string,
    agentConfig?: { model?: string; ecoModel?: string },
    explicitModel?: string,
  ): ResolvedEcoSetting<string>;
  thinkingSettingForMode?(
    type: string,
    parentThinking: ThinkingLevel | undefined,
    agentConfig?: { thinkingLevel?: ThinkingLevel; ecoThinkingLevel?: ThinkingLevel },
    explicitThinking?: ThinkingLevel,
  ): ResolvedEcoSetting<ThinkingLevel | undefined>;
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
  private sessionEcoOverrides: EcoSessionOverrides = { models: {}, thinking: {} };
  private sessionMode: AgentMode | undefined;
  // These are shell-owned control collaborators. ECMAScript private fields
  // keep getStore() from becoming an indirect route to them in child runtimes.
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
    const a = this.config.agent;

    return {
      defaultModel: a.default ?? null,
      forceBackground: a.forceBackground === true,
      graceTurns: a.graceTurns ?? 6,
      systemPromptMode: VALID_SYSTEM_PROMPT_MODES.has(a.systemPromptMode as string) ? (a.systemPromptMode as SystemPromptMode) : "replace",
      includeContextFiles: a.includeContextFiles ?? true,
      defaultThinking: parseThinkingLevel(a.defaultThinking),
      defaultMaxTurns: a.defaultMaxTurns,
      loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
      loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
      disableDefaultAgents: a.disableDefaultAgents === true,
      orchestrationPrompt: a.orchestrationPrompt !== false,
      outputThinkingBufferSize: a.outputThinkingBufferSize ?? 0,
      finishedRetentionMinutes: a.finishedRetentionMinutes ?? 60,
      maxNestingDepth: normalizeMaxNestingDepth(a.maxNestingDepth),
    };
  }

  get concurrency(): { default: number } {
    return { default: this.config.concurrency.default };
  }

  get mode(): AgentMode {
    return this.sessionMode ?? this.config.mode ?? "default";
  }

  get modeSource(): "session" | "saved" | "default" {
    return this.sessionMode ? "session" : this.config.mode ? "saved" : "default";
  }

  ecoModelOverride(type: string): string | undefined {
    return this.sessionEcoOverrides.models[type] ?? this.config.ecoModelOverrides?.[type] ?? undefined;
  }

  ecoThinkingOverride(type: string): ThinkingLevel | undefined {
    return this.sessionEcoOverrides.thinking[type] ?? parseThinkingLevel(this.config.ecoThinkingOverrides?.[type]);
  }

  sessionEcoModelOverride(type: string): string | undefined { return this.sessionEcoOverrides.models[type]; }
  sessionEcoThinkingOverride(type: string): ThinkingLevel | undefined { return this.sessionEcoOverrides.thinking[type]; }
  persistedEcoModelOverride(type: string): string | undefined { return this.config.ecoModelOverrides?.[type] ?? undefined; }
  persistedEcoThinkingOverride(type: string): ThinkingLevel | undefined { return parseThinkingLevel(this.config.ecoThinkingOverrides?.[type]); }

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

  hasPersistedEcoOverrides(): boolean {
    return Object.keys(this.config.ecoModelOverrides ?? {}).length > 0
      || Object.keys(this.config.ecoThinkingOverrides ?? {}).length > 0;
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

  /** Capture immutable mode/settings at the accepted root spawn boundary. */
  createSubagentRuntimeSettings(): SubagentRuntimeSettings {
    const config = structuredClone(this.config);
    const sessionOverrides = structuredClone(this.sessionOverrides);
    const sessionThinkingOverrides = structuredClone(this.sessionThinkingOverrides);
    const ecoOverrides = structuredClone(this.sessionEcoOverrides);
    const mode = this.mode;
    const agent = Object.freeze({ ...this.agent });
    const defaultModel = (type: string, parentModelId: string, agentConfig?: { model?: string }, explicitModel?: string) => resolveModelSetting({
      subagentType: type, explicitModel, agentConfig, config, parentModelId, sessionOverrides,
    });
    const defaultThinking = (type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel) => resolveThinkingSetting({
      subagentType: type, explicitThinking, agentConfig, config, parentThinking, sessionOverrides: sessionThinkingOverrides,
    });
    return Object.freeze({
      agent, mode,
      modelFor: (type: string, parentModelId: string, agentConfig?: { model?: string }, explicitModel?: string) => defaultModel(type, parentModelId, agentConfig, explicitModel).value,
      thinkingSettingFor: (type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel) => defaultThinking(type, parentThinking, agentConfig, explicitThinking),
      modelSettingForMode: (type: string, parentModelId: string, agentConfig?: { model?: string; ecoModel?: string }, explicitModel?: string) => {
        const base = defaultModel(type, parentModelId, agentConfig, explicitModel);
        return mode === "eco" ? resolveEcoModelSetting({ subagentType: type, explicitModel, agentConfig, config, sessionOverrides: ecoOverrides, defaultSetting: base }) : { ...base, ecoConfigured: false };
      },
      thinkingSettingForMode: (type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel; ecoThinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel) => {
        const base = defaultThinking(type, parentThinking, agentConfig, explicitThinking);
        return mode === "eco" ? resolveEcoThinkingSetting({ subagentType: type, explicitThinking, agentConfig, config, sessionOverrides: ecoOverrides, defaultSetting: base }) : { ...base, ecoConfigured: false };
      },
    });
  }

  ecoModelSettingFor(type: string, parentModelId: string, agentConfig?: { model?: string; ecoModel?: string }, explicitModel?: string): ResolvedEcoSetting<string> {
    const base = this.modelSettingFor(type, parentModelId, agentConfig, explicitModel);
    return resolveEcoModelSetting({ subagentType: type, explicitModel, agentConfig, config: this.config, sessionOverrides: this.sessionEcoOverrides, defaultSetting: base });
  }

  modelSettingForMode(type: string, parentModelId: string, agentConfig?: { model?: string; ecoModel?: string }, explicitModel?: string): ResolvedEcoSetting<string> {
    const base = this.modelSettingFor(type, parentModelId, agentConfig, explicitModel);
    return this.mode === "eco" ? this.ecoModelSettingFor(type, parentModelId, agentConfig, explicitModel) : { ...base, ecoConfigured: false };
  }

  ecoThinkingSettingFor(type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel; ecoThinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel): ResolvedEcoSetting<ThinkingLevel | undefined> {
    const base = this.thinkingSettingFor(type, parentThinking, agentConfig, explicitThinking);
    return resolveEcoThinkingSetting({ subagentType: type, explicitThinking, agentConfig, config: this.config, sessionOverrides: this.sessionEcoOverrides, defaultSetting: base });
  }

  thinkingSettingForMode(type: string, parentThinking: ThinkingLevel | undefined, agentConfig?: { thinkingLevel?: ThinkingLevel; ecoThinkingLevel?: ThinkingLevel }, explicitThinking?: ThinkingLevel): ResolvedEcoSetting<ThinkingLevel | undefined> {
    const base = this.thinkingSettingFor(type, parentThinking, agentConfig, explicitThinking);
    return this.mode === "eco" ? this.ecoThinkingSettingFor(type, parentThinking, agentConfig, explicitThinking) : { ...base, ecoConfigured: false };
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
      setMode: (mode: AgentMode | undefined): void => {
        if (mode === undefined) delete this.config.mode;
        else this.config.mode = mode;
        this.persist();
        // A permanent choice takes effect immediately only after the save is durable.
        this.sessionMode = undefined;
      },
      setEcoModelOverride: (type: string, value: string): void => {
        this.config.ecoModelOverrides = { ...(this.config.ecoModelOverrides ?? {}), [type]: value };
        this.persist();
      },
      clearEcoModelOverride: (type: string): void => {
        if (this.config.ecoModelOverrides) delete this.config.ecoModelOverrides[type];
        this.persist();
      },
      setEcoThinkingOverride: (type: string, value: ThinkingLevel): void => {
        this.config.ecoThinkingOverrides = { ...(this.config.ecoThinkingOverrides ?? {}), [type]: value };
        this.persist();
      },
      clearEcoThinkingOverride: (type: string): void => {
        if (this.config.ecoThinkingOverrides) delete this.config.ecoThinkingOverrides[type];
        this.persist();
      },
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
        this.config.ecoModelOverrides = {};
        this.config.ecoThinkingOverrides = {};
        this.persist();
      },
      setForceBackground: (enabled: boolean): void => {
        this.config.agent.forceBackground = enabled;
        this.persist();
      },
      setGraceTurns: (n: number): void => {
        this.config.agent.graceTurns = n;
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
      setDefaultMaxTurns: (n: number | undefined): void => {
        if (n === undefined) {
          delete this.config.agent.defaultMaxTurns;
        } else {
          this.config.agent.defaultMaxTurns = n;
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
      setOutputThinkingBufferSize: (size: number): void => {
        this.config.agent.outputThinkingBufferSize = size;
        this.persist();
      },
      setFinishedRetentionMinutes: (minutes: number): void => {
        const n = Math.max(1, minutes);
        this.config.agent.finishedRetentionMinutes = n;
        this.persist();
        this.#manager?.setRetentionMinutes(n);
      },
      setMaxNestingDepth: (depth: number): void => {
        this.config.agent.maxNestingDepth = normalizeMaxNestingDepth(depth);
        this.persist();
        this.#manager?.setMaxNestingDepth(this.config.agent.maxNestingDepth);
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
      setMode: (mode: AgentMode | undefined): void => { this.sessionMode = mode; },
      setEcoModelOverride: (type: string, model: string): void => { this.sessionEcoOverrides.models[type] = model; },
      clearEcoModelOverride: (type: string): void => { delete this.sessionEcoOverrides.models[type]; },
      setEcoThinkingOverride: (type: string, level: ThinkingLevel): void => { this.sessionEcoOverrides.thinking[type] = level; },
      clearEcoThinkingOverride: (type: string): void => { delete this.sessionEcoOverrides.thinking[type]; },
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
        this.sessionEcoOverrides = { models: {}, thinking: {} };
      },
    },
  };

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read disk, reset session overrides + toggle state, re-sync deps. Called at session_start. */
  reload(): void {
    const loaded = this.readConfig();
    this.config = loaded.config;
    this.persistedConfig = structuredClone(this.config);
    this.configHealth = loaded.health;
    this.repairAvailable = loaded.canRepair;
    this.sessionOverrides = { default: null };
    this.sessionThinkingOverrides = {};
    this.sessionEcoOverrides = { models: {}, thinking: {} };
    this.sessionMode = undefined;
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
    this.config = structuredClone(repaired.config);
    this.persistedConfig = structuredClone(repaired.config);
    this.configHealth = repaired.health;
    this.repairAvailable = repaired.canRepair;
    this.syncAllDeps();
  }

  /** Save current config, restoring the last durable state if the write fails. */
  private persist(): void {
    const before = structuredClone(this.persistedConfig);
    const desired = structuredClone(this.config);
    try {
      if (this.io.update) {
        const saved = this.io.update((latest) => applyConfigDelta(latest, before, desired));
        this.config = structuredClone(saved.config);
        this.persistedConfig = structuredClone(saved.config);
        this.configHealth = saved.health;
        this.repairAvailable = saved.canRepair;
      } else {
        this.io.save(desired);
        this.persistedConfig = structuredClone(desired);
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
    this.#manager?.setMaxNestingDepth(this.agent.maxNestingDepth);
  }
}

/** Apply only this store mutation's changed fields to a freshly locked snapshot. */
function applyConfigDelta(latest: SubagentsConfig, before: SubagentsConfig, desired: SubagentsConfig): void {
  applyObjectDelta(latest.agent as Record<string, unknown>, before.agent as Record<string, unknown>, desired.agent as Record<string, unknown>);
  applyObjectDelta(latest.concurrency as Record<string, unknown>, before.concurrency as Record<string, unknown>, desired.concurrency as Record<string, unknown>);
  if (!Object.is(before.mode, desired.mode)) {
    if (desired.mode === undefined) delete latest.mode;
    else latest.mode = desired.mode;
  }
  latest.ecoModelOverrides ??= {};
  applyObjectDelta(latest.ecoModelOverrides as Record<string, unknown>, (before.ecoModelOverrides ?? {}) as Record<string, unknown>, (desired.ecoModelOverrides ?? {}) as Record<string, unknown>);
  latest.ecoThinkingOverrides ??= {};
  applyObjectDelta(latest.ecoThinkingOverrides as Record<string, unknown>, (before.ecoThinkingOverrides ?? {}) as Record<string, unknown>, (desired.ecoThinkingOverrides ?? {}) as Record<string, unknown>);
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
