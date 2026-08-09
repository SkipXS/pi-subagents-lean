import type { AgentSettingsOverride, SubagentsConfig } from "./types.js";
import {
  normalizeAgentEntries,
  normalizeAgentSettingsOverrides,
  normalizeConcurrencyDefault,
} from "./types.js";
import { loadConfig } from "./config-io.js";

/** Read-only adapter for the manually maintained configuration file. */
export interface ConfigIO {
  load(): SubagentsConfig;
}

/** Production adapter wrapping the real config file. */
export const fileConfigIO: ConfigIO = {
  load: () => loadConfig(),
};

/** Agent settings with all scalar defaults resolved. */
export interface ResolvedAgentSettings {
  /** Whether to skip bundled default agents during catalog discovery. */
  readonly disableDefaultAgents: boolean;
}

/** Detached per-agent model/thinking overrides captured for one root spawn. */
export interface SubagentRuntimeSettings {
  /** Normalized per-agent model/thinking overrides, when any are configured. */
  readonly agents?: Readonly<Record<string, Readonly<AgentSettingsOverride>>>;
}

const DEFAULT_AGENT_SETTINGS: Required<ResolvedAgentSettings> = {
  disableDefaultAgents: false,
};

export class ConfigStore {
  private config: SubagentsConfig;

  constructor(private readonly io: ConfigIO = fileConfigIO) {
    this.config = this.readConfig();
  }

  // ── Reads ──────────────────────────────────────────────────────

  get agent(): ResolvedAgentSettings {
    const agent = this.config.agent;
    return {
      disableDefaultAgents: agent.disableDefaultAgents ?? DEFAULT_AGENT_SETTINGS.disableDefaultAgents,
    };
  }

  get concurrency(): { default: number } {
    return { default: normalizeConcurrencyDefault(this.config.concurrency?.default) };
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
      ...(agents ? { agents: Object.freeze(agents) } : {}),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read the manually maintained file for the next session or spawn. */
  reload(): void {
    this.config = this.readConfig();
  }

  private readConfig(): SubagentsConfig {
    return normalizeStoreConfig(this.io.load());
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
