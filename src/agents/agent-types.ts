/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { scanAgentFilesInDir, mergeAgents } from "./agent-discovery.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

/**
 * All tool names that Pi can provide to a session.
 *
 * Note: only `read`, `bash`, `edit`, `write` are active by default.
 * `find` and `grep` must be explicitly activated via setActiveToolsByName().
 * `ls` was removed — it's a thin wrapper over bash that adds ~180 tokens/turn
 * with no real benefit.
 */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep", "find"];

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

/** Scan user, shared, and project agent directories, merge with defaults. Returns the merged Map. */
export async function scanAndMerge(options?: { disableDefaultAgents?: boolean }): Promise<Map<string, AgentConfig>> {
  const [userAgents, sharedAgents, projectAgents] = await Promise.all([
    scanAgentFilesInDir(userAgentDir, "user"),
    scanAgentFilesInDir(sharedAgentDir, "project"),
    scanAgentFilesInDir(projectAgentDir, "project"),
  ]);
  const defaults = options?.disableDefaultAgents ? new Map<string, AgentConfig>() : DEFAULT_AGENTS;
  return mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
}
/**
 * Scan the parent directories and refresh the global registry. Worktree
 * definitions deliberately never pass through this function: a worktree is a
 * spawn-local overlay, not session-global state. Returns the number of names
 * newly added to the parent registry.
 */
export async function discoverNewAgents(options?: RegisterAgentsOptions): Promise<number> {
  const token = beginGlobalScan();
  const discovered = await scanAndMerge(options);

  // The scan may have started in an older session, before a newer refresh, or
  // before setAgentScanDirs() changed the source directories. Only the newest
  // scan for the current directory snapshot may replace the parent registry.
  if (!canPublishGlobalScan(token)) return 0;

  const previousNames = new Set(agents.keys());
  registerAgents(discovered, options);
  return [...discovered.keys()].filter((name) => !previousNames.has(name)).length;
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

/** Agent is a root-session control tool and is never registered in agent sessions. */
export const EXCLUDED_TOOL_NAMES = ["Agent"];

/**
 * Resolve tool entries (with ext/* syntax) into concrete tool names.
 * Supports:
 *   - bare tool names: "read" → "read"
 *   - ext/* syntax: "tavily/*" → all tools from the tavily extension
 *   - ext/tool syntax: "tavily/web_search" → "web_search"
 */
function resolveToolEntries(
  entries: string[],
  extToolMap: Map<string, string[]> | undefined,
  notify?: (msg: string) => void,
): Set<string> {
  const resolved = new Set<string>();

  for (const entry of entries) {
    const slashIdx = entry.indexOf("/");
    if (slashIdx !== -1) {
      // ext/* or ext/tool syntax
      const extName = entry.slice(0, slashIdx);
      const toolPart = entry.slice(slashIdx + 1);
      if (toolPart === "*") {
        const extTools = extToolMap?.get(extName);
        if (extTools && extTools.length > 0) {
          for (const t of extTools) resolved.add(t);
        } else {
          notify?.(`extension "${extName}" is not loaded, "${entry}" will have no effect`);
        }
      } else {
        // ext/tool syntax: e.g. "tavily/web_search"
        resolved.add(toolPart);
      }
    } else {
      // Bare tool name
      resolved.add(entry);
    }
  }

  return resolved;
}

/**
 * Resolve the visible tool set for an agent type from its config.
 *
 * Selection is always evaluated first and exclusions are then subtracted:
 *   - `tools: true | undefined` → all active tools
 *   - `tools: string[]` → the selected allowlist (with ext/* expansion)
 *   - `tools: false` → no tools
 *   - `excludeTools` → removed from any of the bases above
 *
 * `EXCLUDED_TOOL_NAMES` remains an unconditional safety exclusion. Returns
 * null when the base selection already equals the active set after policy
 * exclusions; otherwise returns the concrete visible schema names.
 */
export function resolveVisibleTools(opts: {
  activeTools: string[];
  tools?: true | string[] | false;
  excludeTools?: string[];
  extToolMap?: Map<string, string[]>;
  notify?: (msg: string) => void;
}): string[] | null {
  const { activeTools, tools, excludeTools, extToolMap, notify } = opts;
  const excludedToolNames = new Set(EXCLUDED_TOOL_NAMES);
  const selectedTools = tools === false
    ? new Set<string>()
    : Array.isArray(tools)
      ? resolveToolEntries(tools, extToolMap, notify)
      : undefined;
  const excludedTools = tools === false
    ? new Set<string>()
    : resolveToolEntries(excludeTools ?? [], extToolMap, notify);

  if (Array.isArray(tools)) {
    const allBuiltinSet = new Set(BUILTIN_TOOL_NAMES);

    // Warn about unknown entries in the positive selection.
    for (const entry of tools) {
      const slashIdx = entry.indexOf("/");
      if (slashIdx === -1 && !allBuiltinSet.has(entry)) {
        let foundInExt = false;
        for (const [, extToolNames] of extToolMap ?? []) {
          if (extToolNames.includes(entry)) { foundInExt = true; break; }
        }
        if (!foundInExt) {
          notify?.(`tool "${entry}" not found in any loaded extension`);
        }
      }
    }

    // Warn if a loaded extension has none of its tools in the positive
    // selection. Exclusions intentionally do not turn this into a conflict:
    // the extension may be selected while one or more of its tools are removed.
    if (extToolMap) {
      for (const [extName, extTools] of extToolMap) {
        const hasAny = extTools.some(t => selectedTools!.has(t));
        if (!hasAny) {
          notify?.(`extension "${extName}" is loaded but none of its tools are in tools: [${tools.join(", ")}]`);
        }
      }
    }
  }

  const visible = activeTools.filter((toolName) => {
    const selected = selectedTools === undefined || selectedTools.has(toolName);
    return selected && !excludedToolNames.has(toolName) && !excludedTools.has(toolName);
  });

  if (tools === false || Array.isArray(tools)) return visible;
  return visible.length === activeTools.length ? null : visible;
}

/**
 * Resolve the concrete tool names that may enter the session's tool registry.
 *
 * Pi's createAgentSession treats `tools` as an allowlist gate: any tool not
 * listed is filtered out of the registry AND the active set, so a whitelist of
 * built-in names alone silently drops every extension tool. This expands the
 * agent's tool config into concrete names (builtins + referenced extension
 * tools) so pi registers them. Final visibility is still owned by
 * resolveVisibleTools; this only seeds the registry gate.
 */
export function resolveSessionAllowedTools(opts: {
  registeredTools: string[];
  tools?: true | string[] | false;
  excludeTools?: string[];
  extToolMap?: Map<string, string[]>;
}): string[] {
  const excludedToolNames = new Set(EXCLUDED_TOOL_NAMES);
  if (opts.tools === false) return [];

  // This is the registry gate, not the final schema policy. A positive list
  // gates exactly its expansion; true/undefined seed all known active names.
  // Raw wildcard literals never reach pi as bogus allowedToolNames.
  const selected = Array.isArray(opts.tools)
    ? resolveToolEntries(opts.tools, opts.extToolMap)
    : new Set([
      ...opts.registeredTools,
      ...(opts.extToolMap ? [...opts.extToolMap.values()].flat() : []),
    ]);
  const excluded = resolveToolEntries(opts.excludeTools ?? [], opts.extToolMap);

  return [...selected].filter((name) =>
    !excludedToolNames.has(name) && !excluded.has(name),
  );
}

/** Resolved config shape returned by getConfig. */
export interface ResolvedAgentConfig {
  /** Canonical role name used for resolution and rendering. */
  name: string;
  description: string;
  registeredTools: string[];
  /** Controls tool schema visibility. true/undefined = all, list = selected, false = none. */
  tools?: true | string[] | false;
  excludeTools?: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  excludeSkills?: string[];
}

/** Resolve an already-selected agent definition without consulting the registry. */
export function resolveAgentConfig(config: AgentConfig): ResolvedAgentConfig {
  return {
    name: config.name,
    description: config.description,
    registeredTools: config.registeredTools ? [...config.registeredTools] : [...BUILTIN_TOOL_NAMES],
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    excludeTools: config.excludeTools && [...config.excludeTools],
    extensions: config.extensions ?? false,
    excludeExtensions: config.excludeExtensions && [...config.excludeExtensions],
    skills: config.skills ?? false,
    excludeSkills: config.excludeSkills && [...config.excludeSkills],
  };
}

/** Get config for an explicitly selected type (case-insensitive). */
export function getConfig(type: string): ResolvedAgentConfig {
  const config = getAgentConfig(type);
  if (!config) {
    throw new Error(`Unknown agent type: ${type || "(missing)"}`);
  }
  return resolveAgentConfig(config);
}
