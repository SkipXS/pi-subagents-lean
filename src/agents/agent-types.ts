/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { scanAgentFilesInDir, mergeAgents } from "./agent-discovery.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";
import { retainAgentDescription } from "./agent-string-limits.js";
import { resolveAgentConfig } from "./agent-tool-policy.js";
import type { ResolvedAgentConfig } from "./agent-tool-policy.js";
export { BUILTIN_TOOL_NAMES, EXCLUDED_TOOL_NAMES, resolveAgentConfig, resolveSessionAllowedTools, resolveVisibleTools } from "./agent-tool-policy.js";
export type { ResolvedAgentConfig } from "./agent-tool-policy.js";

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/**
 * Directories to scan for agent .md files at startup and on-demand.
 * Set by setAgentScanDirs() during session_start.
 */
let userAgentDir = "";
let projectAgentDir = "";
let sharedAgentDir = "";

/**
 * A scan may outlive the session or scan-directory configuration that started
 * it. The request and directory revisions make publication conditional on the
 * scan still being the newest global scan for the same directory snapshot.
 */
let agentScanDirsRevision = 0;
let latestGlobalScanRequest = 0;

interface MergedCatalogCacheEntry {
  inputFingerprint: string;
  effectiveFingerprint: string;
  catalog: Map<string, AgentConfig>;
}

interface MergedCatalogResult {
  cacheKey: string;
  effectiveFingerprint: string;
  catalog: Map<string, AgentConfig>;
}

const mergedCatalogCache = new Map<string, MergedCatalogCacheEntry>();
const MAX_MERGED_CATALOG_CACHE_ENTRIES = 32;
let lastPublishedCatalog: { effectiveFingerprint: string } | undefined;

interface AgentScanToken {
  readonly request: number;
  readonly dirsRevision: number;
}

function beginGlobalScan(): AgentScanToken {
  return {
    request: ++latestGlobalScanRequest,
    dirsRevision: agentScanDirsRevision,
  };
}

function canPublishGlobalScan(token: AgentScanToken): boolean {
  return token.request === latestGlobalScanRequest
    && token.dirsRevision === agentScanDirsRevision;
}

/** Options for registerAgents. */
export interface RegisterAgentsOptions {
  /** When true, skip built-in DEFAULT_AGENTS. */
  disableDefaultAgents?: boolean;
}

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * When options.disableDefaultAgents is true, DEFAULT_AGENTS are skipped.
 * Hidden agents (hidden === true) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>, options?: RegisterAgentsOptions): void {
  // A direct publication is also a newer global catalog mutation. Invalidate
  // any scan that is still waiting to publish so it cannot roll this state back.
  latestGlobalScanRequest++;
  lastPublishedCatalog = undefined;
  agents.clear();

  // Start with defaults (unless disabled)
  if (!options?.disableDefaultAgents) {
    for (const [name, config] of DEFAULT_AGENTS) {
      agents.set(name, snapshotAgentConfig(config));
    }
  }

  // Overlay user agents (overrides defaults with same name). Keep the
  // registry detached from the discovery/catalog map because callers may
  // retain and mutate those maps after registration.
  for (const [name, config] of userAgents) {
    agents.set(name, snapshotAgentConfig(config));
  }
}

/**
 * Set the agent scan directories for on-demand discovery.
 * Called during session_start alongside scanAndRegisterAgents.
 */
export function setAgentScanDirs(userDir: string, projectDir: string, sharedDir?: string): void {
  userAgentDir = userDir;
  projectAgentDir = projectDir;
  sharedAgentDir = sharedDir ?? "";

  // Any scan started with the previous directory configuration is stale, even
  // if it finishes after this call. Also advance the request revision so a
  // same-directory refresh cannot publish an older result after this change.
  agentScanDirsRevision++;
  latestGlobalScanRequest++;
}

/** Return a detached catalog without exposing cache-owned config arrays. */
function cloneCatalog(catalog: ReadonlyMap<string, AgentConfig>): Map<string, AgentConfig> {
  return new Map([...catalog].map(([name, config]) => [name, snapshotAgentConfig(config)]));
}

/** The effective catalog is also the publication identity for no-op refreshes. */
function catalogFingerprint(catalog: ReadonlyMap<string, AgentConfig>): string {
  return JSON.stringify([...catalog].map(([name, config]) => [name, config]));
}

function catalogCacheKey(disableDefaultAgents: boolean): string {
  return `${userAgentDir}\0${sharedAgentDir}\0${projectAgentDir}\0${disableDefaultAgents ? "disabled" : "enabled"}`;
}

function getMergedCatalogCache(key: string): MergedCatalogCacheEntry | undefined {
  const entry = mergedCatalogCache.get(key);
  if (entry) {
    mergedCatalogCache.delete(key);
    mergedCatalogCache.set(key, entry);
  }
  return entry;
}

function setMergedCatalogCache(key: string, entry: MergedCatalogCacheEntry): void {
  mergedCatalogCache.delete(key);
  mergedCatalogCache.set(key, entry);
  while (mergedCatalogCache.size > MAX_MERGED_CATALOG_CACHE_ENTRIES) {
    const oldest = mergedCatalogCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    mergedCatalogCache.delete(oldest);
  }
}

async function scanAndMergeDetailed(
  options?: { disableDefaultAgents?: boolean },
): Promise<MergedCatalogResult> {
  const disableDefaultAgents = options?.disableDefaultAgents === true;
  const cacheKey = catalogCacheKey(disableDefaultAgents);
  const [userAgents, sharedAgents, projectAgents] = await Promise.all([
    scanAgentFilesInDir(userAgentDir, "user"),
    scanAgentFilesInDir(sharedAgentDir, "project"),
    scanAgentFilesInDir(projectAgentDir, "project"),
  ]);
  const inputFingerprint = JSON.stringify([userAgents, sharedAgents, projectAgents]);
  const cached = getMergedCatalogCache(cacheKey);
  if (cached?.inputFingerprint === inputFingerprint) {
    return {
      cacheKey,
      effectiveFingerprint: cached.effectiveFingerprint,
      catalog: cloneCatalog(cached.catalog),
    };
  }

  const defaults = disableDefaultAgents ? new Map<string, AgentConfig>() : DEFAULT_AGENTS;
  const merged = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
  const result: MergedCatalogCacheEntry = {
    inputFingerprint,
    effectiveFingerprint: catalogFingerprint(merged),
    catalog: cloneCatalog(merged),
  };
  setMergedCatalogCache(cacheKey, result);
  return {
    cacheKey,
    effectiveFingerprint: result.effectiveFingerprint,
    catalog: cloneCatalog(result.catalog),
  };
}

/** Scan user, shared, and project agent directories, merging unchanged inputs from cache. */
export async function scanAndMerge(options?: { disableDefaultAgents?: boolean }): Promise<Map<string, AgentConfig>> {
  return cloneCatalog((await scanAndMergeDetailed(options)).catalog);
}

/**
 * Resolve only the project-free parent catalog. This deliberately bypasses
 * the mutable global registry and never scans shared/project/worktree paths;
 * it is the catalog authority for an untrusted spawn preflight.
 */
export async function resolveProjectFreeAgentCatalog(
  options?: RegisterAgentsOptions,
): Promise<Map<string, AgentConfig>> {
  const disableDefaultAgents = options?.disableDefaultAgents === true;
  const cacheKey = `project-free\0${userAgentDir}\0${disableDefaultAgents ? "disabled" : "enabled"}`;
  const userAgents = await scanAgentFilesInDir(userAgentDir, "user");
  const inputFingerprint = JSON.stringify(userAgents);
  const cached = getMergedCatalogCache(cacheKey);
  if (cached?.inputFingerprint === inputFingerprint) {
    return cloneCatalog(cached.catalog);
  }

  const defaults = disableDefaultAgents ? new Map<string, AgentConfig>() : DEFAULT_AGENTS;
  const merged = mergeAgents(defaults, userAgents, [], []);
  const result: MergedCatalogCacheEntry = {
    inputFingerprint,
    effectiveFingerprint: catalogFingerprint(merged),
    catalog: cloneCatalog(merged),
  };
  setMergedCatalogCache(cacheKey, result);
  return cloneCatalog(result.catalog);
}

/**
 * Scan the parent directories and refresh the global registry. Worktree
 * definitions deliberately never pass through this function: a worktree is a
 * spawn-local overlay, not session-global state. Returns the number of names
 * newly added to the parent registry.
 */
export async function discoverNewAgents(options?: RegisterAgentsOptions): Promise<number> {
  const token = beginGlobalScan();
  const discovered = await scanAndMergeDetailed(options);

  // The scan may have started in an older session, before a newer refresh, or
  // before setAgentScanDirs() changed the source directories. Only the newest
  // scan for the current directory snapshot may replace the parent registry.
  if (!canPublishGlobalScan(token)) return 0;

  // A stable effective catalog is already visible in the registry. Avoid
  // clearing/re-snapshotting it; this keeps the existing parent-turn
  // visibility contract while removing no-op registration work.
  if (lastPublishedCatalog?.effectiveFingerprint === discovered.effectiveFingerprint) {
    return 0;
  }

  const previousNames = new Set(agents.keys());
  registerAgents(discovered.catalog, options);
  lastPublishedCatalog = { effectiveFingerprint: discovered.effectiveFingerprint };
  return [...discovered.catalog.keys()].filter((name) => !previousNames.has(name)).length;
}

/** Resolve a type name in an explicit registry without reading global state. */
export function resolveTypeInCatalog(availableAgents: ReadonlyMap<string, AgentConfig>, name: string): string | undefined {
  if (!name) return undefined;
  if (availableAgents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const [key, config] of availableAgents.entries()) {
    if (key.toLowerCase() === lower || config.name.toLowerCase() === lower) return key;
  }
  return undefined;
}

/**
 * Build a fresh, local registry for one worktree. This never mutates the
 * parent registry, so concurrent worktree spawns cannot observe each other's
 * partial overlays.
 */
export async function discoverWorktreeAgents(
  worktreeDir: string,
  options?: RegisterAgentsOptions,
): Promise<Map<string, AgentConfig>> {
  const [parentMerged, worktreeAgents] = await Promise.all([
    scanAndMerge(options),
    scanAgentFilesInDir(worktreeDir, "project"),
  ]);
  return mergeAgents(parentMerged, [], [], worktreeAgents);
}

/** Build an invocation-local catalog, optionally overlaid with a trusted worktree directory. */
export async function resolveAgentCatalog(
  trustedWorktreeDir?: string,
  options?: RegisterAgentsOptions,
): Promise<Map<string, AgentConfig>> {
  return trustedWorktreeDir
    ? discoverWorktreeAgents(trustedWorktreeDir, options)
    : scanAndMerge(options);
}

/** A canonical type plus its worktree-local, fully merged configuration. */
export interface WorktreeAgentResolution {
  type: string;
  config: AgentConfig;
}

/**
 * Resolve an agent against a fresh parent merge plus one worktree overlay.
 * The returned configuration belongs solely to this resolution and must be
 * carried by the spawn rather than looked up in the mutable global registry.
 */
export async function resolveWorktreeAgent(
  name: string,
  worktreeDir: string,
  options?: RegisterAgentsOptions,
): Promise<WorktreeAgentResolution | undefined> {
  const localAgents = await discoverWorktreeAgents(worktreeDir, options);
  const type = resolveTypeInCatalog(localAgents, name);
  return type ? { type, config: localAgents.get(type)! } : undefined;
}

/** Return a detached config snapshot safe to retain while a run is queued. */
export function snapshotAgentConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    description: retainAgentDescription(config.description),
    registeredTools: config.registeredTools && [...config.registeredTools],
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    excludeTools: config.excludeTools && [...config.excludeTools],
    extensions: Array.isArray(config.extensions) ? [...config.extensions] : config.extensions,
    excludeExtensions: config.excludeExtensions && [...config.excludeExtensions],
    skills: Array.isArray(config.skills) ? [...config.skills] : config.skills,
    excludeSkills: config.excludeSkills && [...config.excludeSkills],
  };
}

/** Resolve a canonical role name case-insensitively. Returns the catalog key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveTypeInCatalog(agents, name);
}

/** Get a detached agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveType(name);
  const config = key ? agents.get(key) : undefined;
  return config ? snapshotAgentConfig(config) : undefined;
}

/** Get visible agent configs in registry order. */
export function getAvailableAgents(): Array<{ name: string; description: string }> {
  return [...agents.entries()]
    .filter(([, config]) => config.hidden !== true)
    .map(([name, config]) => ({ name, description: config.description }));
}

/** Get config for an explicitly selected type (case-insensitive). */
export function getConfig(type: string): ResolvedAgentConfig {
  const config = getAgentConfig(type);
  if (!config) {
    throw new Error(`Unknown agent type: ${type || "(missing)"}`);
  }
  return resolveAgentConfig(config);
}
