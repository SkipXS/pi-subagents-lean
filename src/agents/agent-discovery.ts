/**
 * agent-discovery.ts — Agent file discovery, parsing, and config merging.
 *
 * Scans:
 *   ~/.pi/agent/agents/*.md     (user agents)
 *   <project>/.agents/agents/*.md (shared workspace agents)
 *   <project>/.pi/agents/*.md   (project agents)
 *
 * Parses YAML frontmatter, extracts all fields, produces AgentConfig objects.
 * Merges with per-field precedence: default < user < shared < project.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./types.js";
import type { ThinkingLevel } from "../types.js";
import { parseThinkingLevel } from "../utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/** Raw agent config as parsed from .md frontmatter. */
export interface AgentConfigFromMd {
  name?: string;
  description?: string;
  tools?: boolean | string[];
  exclude_tools?: string[];
  extensions?: boolean | string[];
  exclude_extensions?: string[];
  skills?: boolean | string[];
  exclude_skills?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  hidden?: boolean;
  /** Prompt body, when the Markdown file contains non-empty content after frontmatter. */
  systemPrompt?: string;
  source: "default" | "user" | "project";
}

/* ------------------------------------------------------------------ */
/*  Simple frontmatter parser                                          */
/* ------------------------------------------------------------------ */

/**
 * Naive YAML frontmatter splitter.
 *
 * Handles triple-dash delimited frontmatter blocks. Does NOT parse nested
 * YAML structures or complex types — only flat key: value pairs and
 * YAML array syntax (lines starting with "- ").
 *
 * Returns { frontmatter: Record<string, unknown>, body: string }.
 */
function parseFrontmatter(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  if (!content) {
    return { frontmatter: {}, body: "" };
  }

  // Normalize Windows line endings so delimiter detection and body slicing
  // use one consistent representation.
  content = content.replace(/\r\n/g, "\n");

  // Check for triple-dash delimited frontmatter
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }

  // Find closing ---
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmRaw = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5).trim();

  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentValues: string[] | null = null;

  for (const line of fmRaw.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Array item (continuation of previous key)
    if (trimmed.startsWith("- ")) {
      if (currentKey) {
        if (!currentValues) currentValues = [];
        currentValues.push(trimmed.slice(2).trim());
      }
      continue;
    }

    // Flush previous array before processing a new key
    if (currentKey && currentValues) {
      frontmatter[currentKey] = currentValues;
      currentValues = null;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      currentKey = trimmed;
      continue;
    }

    currentKey = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (!rawValue) {
      // Might be followed by array items
      currentValues = [];
      continue;
    }

    // Strip surrounding quotes if present (YAML convention)
    frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
    currentValues = null;
  }

  // Flush trailing array items
  if (currentKey && currentValues) {
    frontmatter[currentKey] = currentValues;
  }

  return { frontmatter, body };
}

/* ------------------------------------------------------------------ */
/*  parseExtensions                                                    */
/* ------------------------------------------------------------------ */

/** Split comma-separated string, trim whitespace, strip brackets, and remove empty entries. */
function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().replace(/^\[|\]$/g, "").trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the extensions/skills field from frontmatter.
 *
 * - false / "false" / "none" → false
 * - true / "true" / "all" → true
 * - Comma-separated string → string[]
 * - undefined → undefined
 */
export function parseExtensions(
  raw: unknown,
): boolean | string[] | undefined {
  if (raw === false || raw === "false" || raw === "none") {
    return false;
  }
  if (raw === true || raw === "true" || raw === "all") {
    return true;
  }
  if (typeof raw === "string" && raw.length > 0) {
    return splitCommaList(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Frontmatter value helpers                                          */
/* ------------------------------------------------------------------ */

/** Extract a non-empty string value from frontmatter. */
function parseString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = frontmatter[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Extract a string array from frontmatter (array or comma-separated string). */
function parseStringArray(
  frontmatter: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = frontmatter[key];
  if (Array.isArray(v)) {
    return v.map(String);
  }
  if (typeof v === "string" && v.length > 0) {
    return splitCommaList(v);
  }
  return undefined;
}

/** Extract a boolean from frontmatter (true/false or "true"/"false"). */
function parseBoolean(
  frontmatter: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = frontmatter[key];
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return undefined;
}

/**
 * Build an object containing only the entries whose value is not undefined.
 * Used to transform AgentConfigFromMd fields into a Partial<AgentConfig>
 * without 14 repetitive `if (x !== undefined)` blocks.
 */
function compactDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined),
  ) as Partial<T>;
}

/* ------------------------------------------------------------------ */
/*  parseAgentFile                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse a single agent .md file into AgentConfigFromMd.
 */
export function parseAgentFile(
  content: string,
  source: "default" | "user" | "project",
): AgentConfigFromMd {
  const { frontmatter, body } = parseFrontmatter(content);

  return {
    name: parseString(frontmatter, "name"),
    description: parseString(frontmatter, "description"),
    tools: parseExtensions(frontmatter.tools),
    exclude_tools: parseStringArray(frontmatter, "exclude_tools"),
    extensions: parseExtensions(frontmatter.extensions),
    exclude_extensions: parseStringArray(frontmatter, "exclude_extensions"),
    skills: parseExtensions(frontmatter.skills),
    exclude_skills: parseStringArray(frontmatter, "exclude_skills"),
    model: parseString(frontmatter, "model"),
    thinking: parseThinkingLevel(parseString(frontmatter, "thinking")),
    hidden: parseBoolean(frontmatter, "hidden"),
    // An absent body is not an override: retain a lower-precedence prompt.
    systemPrompt: body || undefined,
    source: source,
  };
}

/* ------------------------------------------------------------------ */
/*  scanAgentFilesInDir                                                */
/* ------------------------------------------------------------------ */

interface AgentFileCacheEntry {
  fingerprint: string;
  config: AgentConfigFromMd;
}

interface AgentDirectoryCacheEntry {
  fingerprint: string;
  agents: AgentConfigFromMd[];
}

/**
 * Parsed agent files are process-local input caches. The cache is deliberately
 * keyed by source as well as path because the same directory can be used in a
 * parent catalog and an invocation-local worktree catalog with different
 * source metadata.
 */
const agentFileCache = new Map<string, AgentFileCacheEntry>();
const agentDirectoryCache = new Map<string, AgentDirectoryCacheEntry>();
const MAX_AGENT_FILE_CACHE_ENTRIES = 256;
const MAX_AGENT_DIRECTORY_CACHE_ENTRIES = 128;

/** Keep cache hits hot while bounding process-wide path retention. */
function getAgentCacheEntry<T>(cache: Map<string, T>, key: string): T | undefined {
  const entry = cache.get(key);
  if (entry !== undefined) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

function setAgentCacheEntry<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Remove direct-file entries left behind by a deleted or renamed directory child. */
function removeAgentFileEntriesForDirectory(
  source: "user" | "project",
  resolvedDir: string,
  activeFiles?: Set<string>,
): void {
  for (const [key] of agentFileCache) {
    const separator = key.indexOf("\u0000");
    if (separator < 0 || key.slice(0, separator) !== source) continue;
    const filePath = key.slice(separator + 1);
    if (path.dirname(filePath) !== resolvedDir) continue;
    if (activeFiles?.has(filePath)) continue;
    agentFileCache.delete(key);
  }
}

/**
 * Use filesystem metadata rather than file contents to decide whether a
 * definition needs parsing. ctime/mode/inode are conservative additions to the
 * stable path/type/size/mtime core: replacement and permission changes should
 * not accidentally retain an old parsed definition.
 */
function agentFileFingerprint(filePath: string, stats: fs.Stats): string {
  return JSON.stringify([
    path.resolve(filePath),
    stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
    stats.mode,
    stats.ino,
  ]);
}

/** Return a detached parsed agent value for cache publication. */
function cloneAgentFileConfig(config: AgentConfigFromMd): AgentConfigFromMd {
  return {
    ...config,
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    exclude_tools: config.exclude_tools && [...config.exclude_tools],
    extensions: Array.isArray(config.extensions) ? [...config.extensions] : config.extensions,
    exclude_extensions: config.exclude_extensions && [...config.exclude_extensions],
    skills: Array.isArray(config.skills) ? [...config.skills] : config.skills,
    exclude_skills: config.exclude_skills && [...config.exclude_skills],
  };
}

/**
 * Scan a directory for .md files and parse them into AgentConfigFromMd[].
 * Returns empty array if directory doesn't exist.
 *
 * Directory entries are fingerprinted on every call so additions, removals,
 * and renames invalidate negative and positive results. Files whose metadata
 * is unchanged reuse their parsed frontmatter and body.
 */
export async function scanAgentFilesInDir(
  dirPath: string,
  source: "user" | "project" = "user",
): Promise<AgentConfigFromMd[]> {
  const resolvedDir = path.resolve(dirPath);
  const directoryKey = `${source}\0${resolvedDir}`;
  try {
    await fs.promises.access(dirPath);
  } catch {
    // Do not retain a missing-directory result: a later file creation must be
    // visible without an explicit cache reset.
    agentDirectoryCache.delete(directoryKey);
    removeAgentFileEntriesForDirectory(source, resolvedDir);
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    // A path can be accessible yet unlistable (ACL/race); discovery is best effort.
    agentDirectoryCache.delete(directoryKey);
    removeAgentFileEntriesForDirectory(source, resolvedDir);
    return [];
  }
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    // Do not rely on filesystem enumeration order. Relational string
    // comparison is based on UTF-16 code units and is locale-independent.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const descriptors: Array<{ filePath: string; fingerprint: string }> = [];
  let cacheable = true;

  for (const entry of mdFiles) {
    const filePath = path.join(dirPath, entry.name);
    try {
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile()) {
        cacheable = false;
        continue;
      }
      descriptors.push({
        filePath,
        fingerprint: agentFileFingerprint(filePath, stats),
      });
    } catch {
      // A file can disappear between readdir and stat. Do not cache this
      // unstable snapshot so the next turn retries it.
      cacheable = false;
    }
  }

  const activeFiles = new Set(descriptors.map(({ filePath }) => path.resolve(filePath)));
  removeAgentFileEntriesForDirectory(source, resolvedDir, activeFiles);

  const directoryFingerprint = descriptors
    .map(({ fingerprint }) => fingerprint)
    .join("\n");
  const cachedDirectory = getAgentCacheEntry(agentDirectoryCache, directoryKey);
  if (cacheable && cachedDirectory?.fingerprint === directoryFingerprint) {
    return cachedDirectory.agents.map(cloneAgentFileConfig);
  }

  const agents: AgentConfigFromMd[] = [];
  for (const { filePath, fingerprint } of descriptors) {
    const fileKey = `${source}\0${path.resolve(filePath)}`;
    const cachedFile = getAgentCacheEntry(agentFileCache, fileKey);
    if (cachedFile?.fingerprint === fingerprint) {
      agents.push(cloneAgentFileConfig(cachedFile.config));
      continue;
    }

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const info = parseAgentFile(content, source);
      // The documented filename fallback makes a minimal `reviewer.md`
      // definition usable without broadening the frontmatter parser.
      const config = { ...info, name: info.name ?? path.basename(filePath, ".md") };
      setAgentCacheEntry(agentFileCache, fileKey, {
        fingerprint,
        config: cloneAgentFileConfig(config),
      }, MAX_AGENT_FILE_CACHE_ENTRIES);
      agents.push(config);
    } catch {
      // Skip files that can't be read. An unreadable snapshot must not be
      // reused forever because ACLs and races can resolve on a later turn.
      agentFileCache.delete(fileKey);
      cacheable = false;
    }
  }

  if (cacheable) {
    setAgentCacheEntry(agentDirectoryCache, directoryKey, {
      fingerprint: directoryFingerprint,
      agents: agents.map(cloneAgentFileConfig),
    }, MAX_AGENT_DIRECTORY_CACHE_ENTRIES);
  } else {
    agentDirectoryCache.delete(directoryKey);
  }
  return agents.map(cloneAgentFileConfig);
}

/* ------------------------------------------------------------------ */
/*  mergeAgents                                                        */
/* ------------------------------------------------------------------ */

/**
 * Merge default agents with user, shared, and project overrides.
 *
 * Per-field merge precedence (highest to lowest):
 *   1. project agents (.pi/agents/)
 *   2. shared agents (.agents/agents/)
 *   3. user agents (~/.pi/agent/agents/)
 *   4. default agents
 *
 * For each field, if a higher-precedence layer sets the field (not undefined),
 * it wins. Otherwise, the lower layer's value is preserved.
 *
 * @param defaults - Map of default agent configs
 * @param userAgents - User-defined agent configs
 * @param sharedAgents - Shared workspace agent configs (.agents/agents/)
 * @param projectAgents - Project-specific agent configs (.pi/agents/)
 * @returns Merged Map<string, AgentConfig> keyed by agent name
 */
export function mergeAgents(
  defaults: Map<string, AgentConfig>,
  userAgents: AgentConfigFromMd[],
  sharedAgents: AgentConfigFromMd[],
  projectAgents: AgentConfigFromMd[],
): Map<string, AgentConfig> {
  const result = new Map<string, AgentConfig>();

  // Start with detached defaults. Discovery results are retained in the
  // registry, so never let a caller mutate the source map through an array
  // field on the merged config.
  for (const [name, config] of defaults) {
    result.set(name, cloneAgentConfig(config));
  }

  // Apply overrides in precedence order: user, then shared, then project.
  // Names identify roles case-insensitively, while the first layer that creates
  // a role supplies its canonical map key.
  mergeAgentOverrides(result, userAgents);
  mergeAgentOverrides(result, sharedAgents);
  mergeAgentOverrides(result, projectAgents);

  // A missing selection is deliberately closed after all field-wise layers
  // have been merged. This preserves inherited explicit values while making a
  // new/minimal definition deterministic without global implicit settings.
  for (const [name, config] of result) {
    result.set(name, cloneAgentConfig({
      ...config,
      skills: config.skills ?? false,
      extensions: config.extensions ?? false,
    }));
  }

  return result;
}

/**
 * Apply a list of agent configs onto the result map.
 * Existing agents are merged per-field; new agents are built from scratch.
 */
function mergeAgentOverrides(
  result: Map<string, AgentConfig>,
  agents: AgentConfigFromMd[],
): void {
  for (const md of agents) {
    if (!md.name) continue;
    const existingKey = [...result.keys()].find((key) => key.toLowerCase() === md.name!.toLowerCase());
    if (existingKey !== undefined) {
      const existing = result.get(existingKey)!;
      result.set(existingKey, cloneAgentConfig({ ...existing, ...fromMd(md) }));
    } else {
      result.set(md.name, cloneAgentConfig({ ...BASE_DEFAULTS, ...fromMd(md) }));
    }
  }
}

/**
 * Translate AgentConfigFromMd fields to a Partial<AgentConfig> containing
 * only fields that are explicitly set in frontmatter or as a prompt body
 * (not undefined).
 *
 * When merging into an existing AgentConfig, spread this result after the
 * existing config so explicit fields override defaults while undefined fields
 * (including an absent prompt body) fall through to the existing values.
 */
function fromMd(md: AgentConfigFromMd): Partial<AgentConfig> {
  const obj: Record<string, unknown> = {
    name: md.name,
    description: md.description,
    // A tools list seeds the registry and controls visible schemas. Boolean
    // values only control schema selection; the runner supplies its normal
    // built-in registry base for true/undefined.
    registeredTools: md.tools === undefined || typeof md.tools === "boolean" ? undefined : [...md.tools],
    tools: Array.isArray(md.tools) ? [...md.tools] : md.tools,
    excludeTools: md.exclude_tools ? [...md.exclude_tools] : md.exclude_tools,
    extensions: Array.isArray(md.extensions) ? [...md.extensions] : md.extensions,
    excludeExtensions: md.exclude_extensions ? [...md.exclude_extensions] : md.exclude_extensions,
    skills: Array.isArray(md.skills) ? [...md.skills] : md.skills,
    excludeSkills: md.exclude_skills ? [...md.exclude_skills] : md.exclude_skills,
    model: md.model,
    thinkingLevel: md.thinking,
    hidden: md.hidden,
    systemPrompt: md.systemPrompt,
    source: md.source === "user" ? "global" : md.source,
  };
  return compactDefined(obj) as Partial<AgentConfig>;
}

/** Clone every mutable selection field carried by an agent definition. */
function cloneAgentConfig(config: AgentConfig): AgentConfig {
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

/**
 * Defaults used when creating a new AgentConfig from a .md file that has
 * no existing default to merge into. Satisfies all required AgentConfig
 * fields.
 */
const BASE_DEFAULTS: AgentConfig = {
  name: "unknown",
  description: "",
  // Missing selections resolve to false after the field-wise merge.
  extensions: false,
  skills: false,
  systemPrompt: "",
};

/** Convert a parsed Markdown agent into a complete standalone config. */
export function toAgentConfig(md: AgentConfigFromMd): AgentConfig {
  return cloneAgentConfig({ ...BASE_DEFAULTS, ...fromMd(md) } as AgentConfig);
}
