/** Read-only loading of the manually maintained subagents configuration. */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "./types.js";
import {
  MAX_SUBAGENTS_CONFIG_BYTES,
  normalizeAgentEntries,
  normalizeAgentSettingsOverrides,
  normalizeConcurrencyDefault,
} from "./types.js";

const CONFIG_DIR = getAgentDir();

/** Publicly named config-file byte boundary used by loading. */
export const MAX_CONFIG_FILE_BYTES = MAX_SUBAGENTS_CONFIG_BYTES;

const DEFAULT_AGENT: SubagentsConfig["agent"] = {
  disableDefaultAgents: false,
};

export interface ConfigFileIO {
  load(): SubagentsConfig;
}

interface Candidate {
  state: "missing" | "valid" | "invalid" | "unreadable";
  config?: SubagentsConfig;
}

/** Create a read-only file adapter for focused tests. */
export function createConfigFileIO(configDir: string = CONFIG_DIR): ConfigFileIO {
  const configPath = path.join(configDir, "subagents-lean.json");
  const backupPath = `${configPath}.bak`;

  return {
    load: () => loadResult(configPath, backupPath),
  };
}

const fileIO = createConfigFileIO();

/** Load the manually maintained configuration snapshot. */
export function loadConfig(): SubagentsConfig {
  return fileIO.load();
}

function loadResult(configPath: string, backupPath: string): SubagentsConfig {
  const primary = readCandidate(configPath);
  if (primary.state === "valid") return primary.config!;
  // A backup is recovery material only for an existing primary that could not
  // be accepted. A first run must use defaults rather than an old backup.
  if (primary.state === "missing") return defaultConfig();

  const backup = readCandidate(backupPath);
  return backup.state === "valid" ? backup.config! : defaultConfig();
}

function readCandidate(filePath: string): Candidate {
  let bytes: Buffer;
  try {
    // Reject an oversized regular file before reading it when metadata is
    // available. The encoded-buffer check remains authoritative for races and
    // lightweight filesystem adapters.
    const fsAdapter = fs as unknown as Record<string, unknown>;
    const lstat = Object.hasOwn(fsAdapter, "lstatSync")
      ? fsAdapter.lstatSync as ((filePath: string) => unknown) | undefined
      : undefined;
    if (typeof lstat === "function") {
      try {
        const stats = lstat(filePath) as { isFile?: unknown; size?: unknown } | undefined;
        if (typeof stats?.isFile === "function" && stats.isFile() && typeof stats.size === "number") {
          if (!Number.isSafeInteger(stats.size) || stats.size < 0) return { state: "unreadable" };
          if (stats.size > MAX_CONFIG_FILE_BYTES) return { state: "invalid" };
        }
      } catch {
        // Let readFileSync classify missing and unreadable paths.
      }
    }

    bytes = readBytes(filePath);
    if (bytes.byteLength > MAX_CONFIG_FILE_BYTES) return { state: "invalid" };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable" };
  }

  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return isConfigShape(parsed)
      ? { state: "valid", config: normalizeConfig(parsed) }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

function readBytes(filePath: string): Buffer {
  const value = fs.readFileSync(filePath);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function defaultConfig(): SubagentsConfig {
  return normalizeConfig({} as SubagentsConfig);
}

function normalizeConfig(raw: SubagentsConfig): SubagentsConfig {
  const concurrency: SubagentsConfig["concurrency"] = {
    default: normalizeConcurrencyDefault(raw.concurrency?.default),
  };
  const rawAgent = { ...(raw.agent ?? {}) } as Record<string, unknown>;
  const agent = {
    ...DEFAULT_AGENT,
    ...normalizeAgentEntries(rawAgent),
  } as SubagentsConfig["agent"];
  const agents = normalizeAgentSettingsOverrides(raw.agents);
  return {
    agent,
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    concurrency,
  };
}

function isConfigShape(value: unknown): value is SubagentsConfig {
  if (!isRecord(value)) return false;
  return (value.agent === undefined || isRecord(value.agent))
    && (value.agents === undefined || isRecord(value.agents))
    && (value.concurrency === undefined || isRecord(value.concurrency));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
