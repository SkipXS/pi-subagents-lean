/**
 * Config persistence and recovery. Writes are serialized locally with a
 * directory lock; this is not a distributed-filesystem locking guarantee.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "../models/model-precedence.js";
import { parseThinkingLevel } from "../utils.js";

const CONFIG_DIR = getAgentDir();
const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lean.json");

export const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, "subagents-lean-prompt.md");
export const DEFAULT_GRACE_TURNS = 6;
/** Initial subagents are depth 1; the default permits one nested layer. */
export const DEFAULT_MAX_NESTING_DEPTH = 2;
export const MAX_NESTING_DEPTH = 2;
export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };
/** Persisted menu changes must fail promptly rather than freeze Pi's synchronous TUI on lock contention. */
export const UI_CONFIG_LOCK_TIMEOUT_MS = 0;

const DEFAULT_AGENT: SubagentsConfig["agent"] = {
  default: null,
  forceBackground: false,
  graceTurns: DEFAULT_GRACE_TURNS,
  widgetMaxLines: 12,
  widgetDescLengthFull: 50,
  widgetDescLengthCompact: 30,
  widgetCompact: false,
  widgetShortcut: false,
  widgetShowModelThinking: true,
  widgetShowStartTime: true,
  systemPromptMode: "replace",
  includeContextFiles: true,
  disableDefaultAgents: false,
  orchestrationPrompt: true,
  showTools: true,
  showTurns: true,
  showInput: true,
  showOutput: true,
  showContext: true,
  showCost: false,
  showTime: true,
  outputThinkingBufferSize: 0,
  finishedRetentionMinutes: 10,
  maxNestingDepth: DEFAULT_MAX_NESTING_DEPTH,
};

export type ConfigHealth = "healthy" | "using-backup" | "unrecoverable";

export interface ConfigLoadResult {
  config: SubagentsConfig;
  health: ConfigHealth;
  /** A corrupt, readable primary can be archived and restored from .bak. */
  canRepair: boolean;
}

export interface ConfigFileOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => void;
  hostname?: () => string;
  pid?: () => number;
  kill?: (pid: number, signal: 0) => void;
}

export interface ConfigFileIO {
  load(): ConfigLoadResult;
  update(change: (config: SubagentsConfig) => void): ConfigLoadResult;
  repair(): ConfigLoadResult;
}

export class ConfigLockTimeoutError extends Error {
  constructor() {
    super("Config is busy; retry the setting in a moment.");
    this.name = "ConfigLockTimeoutError";
  }
}

export class ConfigPersistenceUnavailableError extends Error {
  constructor(message = "Cannot save config: the primary config is corrupt or unreadable and was left unchanged.") {
    super(message);
    this.name = "ConfigPersistenceUnavailableError";
  }
}

interface Candidate {
  state: "missing" | "valid" | "invalid" | "unreadable";
  bytes?: Buffer;
  config?: SubagentsConfig;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

/** Create an isolated file adapter. Exported for integration tests and embedders. */
export function createConfigFileIO(configDir: string = CONFIG_DIR, options: ConfigFileOptions = {}): ConfigFileIO {
  const configPath = path.join(configDir, "subagents-lean.json");
  const backupPath = `${configPath}.bak`;
  const lockPath = `${configPath}.lock`;
  const now = options.now ?? Date.now;
  const hostname = options.hostname ?? os.hostname;
  const pid = options.pid ?? (() => process.pid);
  const kill = options.kill ?? process.kill.bind(process);
  const timeout = options.lockTimeoutMs ?? 2_500;
  const staleAfter = options.staleLockMs ?? 30_000;
  const sleep = options.sleep ?? blockingSleep;

  const load = (): ConfigLoadResult => loadResult(configPath, backupPath);

  const acquire = (): LockOwner => {
    fs.mkdirSync(configDir, { recursive: true });
    const deadline = now() + timeout;
    let delay = 25;
    while (true) {
      const owner: LockOwner = { token: randomUUID(), pid: pid(), hostname: hostname(), createdAt: now() };
      const pendingPath = `${lockPath}.pending-${owner.token}`;
      try {
        // Publishing only a directory that already contains owner.json means a
        // crash before rename leaves an ignored pending directory, not a lock.
        fs.mkdirSync(pendingPath);
        try {
          fs.writeFileSync(path.join(pendingPath, "owner.json"), JSON.stringify(owner), "utf8");
        } catch (err) {
          // This directory was named with our unshared token and was never
          // published as the lock, so cleaning it cannot remove another owner.
          try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* preserve the original error */ }
          throw err;
        }
        try {
          fs.renameSync(pendingPath, lockPath);
        } catch (err) {
          try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* preserve the original error */ }
          if (isPendingLockPublishContention(err)) {
            const contention = new Error("Lock was published by another process.") as NodeJS.ErrnoException;
            contention.code = "EEXIST";
            throw contention;
          }
          throw err;
        }
        return owner;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (removeStaleLock(lockPath, hostname(), now(), staleAfter, kill)) continue;
        if (now() >= deadline) throw new ConfigLockTimeoutError();
        sleep(Math.min(delay, Math.max(0, deadline - now())));
        delay = Math.min(delay * 2, 250);
      }
    }
  };

  const release = (owner: LockOwner): void => {
    try {
      const actual = parseOwner(readBytes(path.join(lockPath, "owner.json")));
      if (actual?.token === owner.token) fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // A missing, malformed, or inaccessible lock is deliberately retained.
    }
  };

  const withLock = <T>(operation: () => T): T => {
    const owner = acquire();
    try {
      return operation();
    } finally {
      release(owner);
    }
  };

  return {
    load,
    update(change): ConfigLoadResult {
      return withLock(() => {
        const primary = readCandidate(configPath);
        if (primary.state === "invalid" || primary.state === "unreadable") {
          throw new ConfigPersistenceUnavailableError();
        }
        const next = structuredClone(primary.config ?? defaultConfig());
        change(next);
        if (primary.state === "valid" && primary.bytes) atomicWrite(backupPath, primary.bytes);
        atomicWrite(configPath, Buffer.from(JSON.stringify(next, null, 2), "utf8"));
        return { config: next, health: "healthy", canRepair: false };
      });
    },
    repair(): ConfigLoadResult {
      return withLock(() => {
        const primary = readCandidate(configPath);
        const backup = readCandidate(backupPath);
        // An unreadable primary cannot be archived byte-for-byte and is never overwritten.
        if (primary.state !== "invalid" || !primary.bytes || backup.state !== "valid" || !backup.bytes) {
          throw new ConfigPersistenceUnavailableError("Cannot repair config: no archivable corrupt primary and valid backup are available.");
        }
        const archivePath = `${configPath}.corrupt-${now()}-${randomUUID()}`;
        atomicWrite(archivePath, primary.bytes);
        atomicWrite(configPath, backup.bytes);
        return { config: backup.config!, health: "healthy", canRepair: false };
      });
    },
  };
}

// ConfigStore mutations are invoked from synchronous menu callbacks. Retrying
// here would block Pi's event loop, so surface contention immediately instead.
const fileIO = createConfigFileIO(CONFIG_DIR, { lockTimeoutMs: UI_CONFIG_LOCK_TIMEOUT_MS });

/** Load config plus explicit recovery state. */
export function loadConfig(): ConfigLoadResult {
  return fileIO.load();
}

/** Atomically replace the config. ConfigStore normally uses updateConfigAtomic instead. */
export function saveConfigAtomic(config: SubagentsConfig): ConfigLoadResult {
  return fileIO.update((current) => replaceConfig(current, config));
}

/** Read the latest disk snapshot under the local lock, mutate it, and atomically save it. */
export function updateConfigAtomic(change: (config: SubagentsConfig) => void): ConfigLoadResult {
  return fileIO.update(change);
}

/** Restore a readable corrupt primary from its valid backup under the local lock. */
export function repairConfig(): ConfigLoadResult {
  return fileIO.repair();
}

function loadResult(configPath: string, backupPath: string): ConfigLoadResult {
  const primary = readCandidate(configPath);
  if (primary.state === "valid") return { config: primary.config!, health: "healthy", canRepair: false };
  if (primary.state === "missing") return { config: defaultConfig(), health: "healthy", canRepair: false };

  const backup = readCandidate(backupPath);
  if (backup.state === "valid") {
    return { config: backup.config!, health: "using-backup", canRepair: primary.state === "invalid" };
  }
  return { config: defaultConfig(), health: "unrecoverable", canRepair: false };
}

function readCandidate(filePath: string): Candidate {
  let bytes: Buffer;
  try {
    bytes = readBytes(filePath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return isConfigShape(parsed) ? { state: "valid", bytes, config: normalizeConfig(parsed) } : { state: "invalid", bytes };
  } catch {
    return { state: "invalid", bytes };
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
    default: raw.concurrency?.default ?? DEFAULT_CONCURRENCY.default,
  };
  const agent = { ...DEFAULT_AGENT, ...raw.agent };
  if (!Object.hasOwn(raw.agent ?? {}, "scout") && typeof raw.agent?.Explore === "string") agent.scout = raw.agent.Explore;
  const defaultThinking = parseThinkingLevel(agent.defaultThinking);
  if (defaultThinking === undefined) delete agent.defaultThinking;
  else agent.defaultThinking = defaultThinking;
  agent.maxNestingDepth = normalizeMaxNestingDepth(agent.maxNestingDepth);
  const mode = raw.mode === "eco" ? "eco" : raw.mode === "default" ? "default" : undefined;
  const ecoModelOverrides = Object.fromEntries(
    Object.entries(raw.ecoModelOverrides ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
  const ecoThinkingOverrides = Object.fromEntries(
    Object.entries(raw.ecoThinkingOverrides ?? {})
      .map(([key, value]) => [key, parseThinkingLevel(value)] as const)
      .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined),
  );
  return {
    agent,
    thinkingOverrides: { ...(raw.thinkingOverrides ?? {}) },
    ...(mode ? { mode } : {}),
    ecoModelOverrides,
    ecoThinkingOverrides,
    concurrency,
  };
}

/** Keep nesting bounded: 1 permits root children only; 2 permits one child layer. */
export function normalizeMaxNestingDepth(value: unknown): number {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n)
    ? Math.min(MAX_NESTING_DEPTH, Math.max(1, Math.floor(n)))
    : DEFAULT_MAX_NESTING_DEPTH;
}

function replaceConfig(target: SubagentsConfig, source: SubagentsConfig): void {
  target.agent = structuredClone(source.agent);
  target.concurrency = structuredClone(source.concurrency);
  target.thinkingOverrides = structuredClone(source.thinkingOverrides ?? {});
  target.mode = source.mode;
  target.ecoModelOverrides = structuredClone(source.ecoModelOverrides ?? {});
  target.ecoThinkingOverrides = structuredClone(source.ecoThinkingOverrides ?? {});
}

function atomicWrite(targetPath: string, contents: Buffer): void {
  // The file is synced before rename. We intentionally do not claim directory-sync
  // or power-loss durability, which Node cannot provide portably here.
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents);
    const fd = fs.openSync(tempPath, "r+");
    let syncError: unknown;
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      syncError = err;
    }
    try {
      fs.closeSync(fd);
    } catch (err) {
      // A close failure is primary only when fsync itself succeeded.
      if (syncError === undefined) syncError = err;
    }
    if (syncError !== undefined) throw syncError;
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* temp may not exist */ }
    console.error(`[pi-subagents-lean] Failed to save config: ${err}`);
    throw err;
  }
}

function removeStaleLock(lockPath: string, localHostname: string, currentTime: number, staleAfter: number, kill: (pid: number, signal: 0) => void): boolean {
  let owner: LockOwner | undefined;
  try { owner = parseOwner(readBytes(path.join(lockPath, "owner.json"))); } catch { return false; }
  if (!owner || owner.hostname !== localHostname || currentTime - owner.createdAt < staleAfter) return false;
  try {
    kill(owner.pid, 0);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  // Never recursively delete the contested lock path. Exactly one reclaimer
  // can move it to its unique quarantine path; only that winner may remove it.
  const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch {
    return false;
  }
  try { fs.rmSync(quarantinePath, { recursive: true, force: true }); } catch { /* quarantine is harmless */ }
  return true;
}

function isPendingLockPublishContention(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  // rename(directory, existing-directory) is EEXIST on Windows and commonly
  // ENOTEMPTY on POSIX. Bun on Windows reports EPERM for this same publish collision.
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

function parseOwner(bytes: Buffer): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)
      || typeof value.token !== "string" || value.token.length === 0
      || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0
      || typeof value.hostname !== "string" || value.hostname.length === 0
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
    return { token: value.token, pid: value.pid, hostname: value.hostname, createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function blockingSleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isConfigShape(value: unknown): value is SubagentsConfig {
  if (!isRecord(value)) return false;
  return (value.agent === undefined || isRecord(value.agent))
    && (value.concurrency === undefined || isRecord(value.concurrency))
    && (value.thinkingOverrides === undefined || isRecord(value.thinkingOverrides))
    && (value.ecoModelOverrides === undefined || isRecord(value.ecoModelOverrides))
    && (value.ecoThinkingOverrides === undefined || isRecord(value.ecoThinkingOverrides));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
