/**
 * Agent directory discovery with bounded, process-local caches.
 *
 * This module owns filesystem snapshots, metadata fingerprints, cache LRU
 * policy, and refresh coalescing. It delegates Markdown semantics to the
 * frontmatter parser and never imports the merge/catalog facade.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseAgentFile } from "./agent-frontmatter.js";
import type { AgentConfigFromMd } from "./agent-frontmatter.js";
import {
  isAgentNameWithinLimit,
  MAX_AGENT_MARKDOWN_BYTES,
  utf8ByteLength,
} from "./agent-string-limits.js";

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
interface InFlightAgentScan {
  promise: Promise<AgentConfigFromMd[]>;
  /** True once the directory iterator has captured the snapshot for this scan. */
  snapshotCaptured: boolean;
}

const inFlightAgentScans = new Map<string, InFlightAgentScan>();
const latestAgentScanGeneration = new Map<string, number>();
let nextAgentScanGeneration = 0;
const MAX_AGENT_FILE_CACHE_ENTRIES = 256;
const MAX_AGENT_DIRECTORY_CACHE_ENTRIES = 128;
/** Maximum Markdown files accepted from one source directory. */
export const MAX_AGENT_FILES_PER_SOURCE = 256;
/** Maximum total directory entries inspected for one source directory. */
export const MAX_AGENT_DIRECTORY_ENTRIES = 10_000;
/** Descriptive alias for callers/tests that name this a source bound. */
export const MAX_AGENT_SOURCE_DIRECTORY_ENTRIES = MAX_AGENT_DIRECTORY_ENTRIES;
const MAX_AGENT_METADATA_CONCURRENCY = 8;

function isDirectoryAlreadyClosed(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ERR_DIR_CLOSED";
}

/** Keep cache hits hot while bounding process-wide path retention. */
function getAgentCacheEntry<T>(cache: Map<string, T>, key: string): T | undefined {
  const entry = cache.get(key);
  if (entry !== undefined) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

function setAgentCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function markLatestAgentScan(directoryKey: string): number {
  const generation = ++nextAgentScanGeneration;
  latestAgentScanGeneration.delete(directoryKey);
  latestAgentScanGeneration.set(directoryKey, generation);
  while (latestAgentScanGeneration.size > MAX_AGENT_DIRECTORY_CACHE_ENTRIES) {
    const oldest = latestAgentScanGeneration.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    latestAgentScanGeneration.delete(oldest);
  }
  return generation;
}

function isLatestAgentScan(directoryKey: string, generation: number): boolean {
  return latestAgentScanGeneration.get(directoryKey) === generation;
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
 * definition needs parsing. ctime/mode/inode are conservative additions to
 * the stable path/type/size/mtime core: replacement and permission changes
 * should not accidentally retain an old parsed definition.
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
 * Returns an empty array if the directory does not exist or cannot be listed.
 *
 * Directory entries are fingerprinted on every call so additions, removals,
 * and renames invalidate negative and positive results. Files whose metadata
 * is unchanged reuse their parsed frontmatter and body. Identical scans that
 * overlap in time share one filesystem operation and each caller receives a
 * detached result.
 */
export function scanAgentFilesInDir(
  dirPath: string,
  source: "user" | "project" = "user",
): Promise<AgentConfigFromMd[]> {
  // Empty source paths are explicit "not configured" sentinels during
  // shutdown and untrusted sessions. Never resolve them to process.cwd(),
  // which could turn a disabled project source into an accidental catalog.
  if (dirPath.length === 0) return Promise.resolve([]);
  const resolvedDir = path.resolve(dirPath);
  const directoryKey = `${source}\0${resolvedDir}`;
  // Publication revisions are deliberately not part of this key: concurrent
  // parent turns may share one physical source scan.
  const physicalScanKey = directoryKey;
  const inFlight = inFlightAgentScans.get(physicalScanKey);
  if (inFlight) {
    if (!inFlight.snapshotCaptured) {
      return inFlight.promise.then((agents) => agents.map(cloneAgentFileConfig));
    }
    // The running scan has already observed the directory. A later refresh
    // must not publish that older snapshot, so queue one fresh scan. Multiple
    // late followers converge on the same next physical scan.
    return inFlight.promise.then(() => scanAgentFilesInDir(dirPath, source));
  }

  const generation = markLatestAgentScan(directoryKey);
  const entry: InFlightAgentScan = { promise: undefined!, snapshotCaptured: false };
  entry.promise = scanAgentFilesInDirUncoalesced(
    dirPath,
    source,
    resolvedDir,
    directoryKey,
    generation,
    () => { entry.snapshotCaptured = true; },
  ).finally(() => {
    if (inFlightAgentScans.get(physicalScanKey) === entry) {
      inFlightAgentScans.delete(physicalScanKey);
    }
  });
  inFlightAgentScans.set(physicalScanKey, entry);
  return entry.promise.then((agents) => agents.map(cloneAgentFileConfig));
}

/** Execute one physical scan. The public wrapper above owns coalescing. */
async function scanAgentFilesInDirUncoalesced(
  dirPath: string,
  source: "user" | "project",
  resolvedDir: string,
  directoryKey: string,
  generation: number,
  onSnapshotCaptured: () => void,
): Promise<AgentConfigFromMd[]> {
  /**
   * Keep the source snapshot bounded before any metadata or content work. A
   * streaming Dir iterator is important here: a hostile directory must not
   * first become a complete materialized array just to discover that it is over the
   * source limit. The accepted list is bounded, then sorted for stable merge
   * precedence regardless of filesystem enumeration order.
   */
  let directory: fs.Dir;
  let mdFiles: fs.Dirent[] | undefined;
  try {
    directory = await fs.promises.opendir(dirPath);
    // Opening the iterator is the snapshot boundary. A later caller must not
    // join a scan whose cursor has already started observing the directory.
    onSnapshotCaptured();

    let totalEntries = 0;
    let sourceExceeded = false;
    try {
      const selected: fs.Dirent[] = [];
      for await (const entry of directory) {
        totalEntries++;
        if (totalEntries > MAX_AGENT_DIRECTORY_ENTRIES) {
          sourceExceeded = true;
          break;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        selected.push(entry);
        if (selected.length > MAX_AGENT_FILES_PER_SOURCE) {
          sourceExceeded = true;
          break;
        }
      }
      mdFiles = sourceExceeded ? undefined : selected;
    } catch {
      mdFiles = undefined;
    } finally {
      // Explicit close complements async-iterator return() on the bounded
      // early exit and remains observable to instrumented test iterators.
      try {
        await directory.close();
      } catch (error) {
        if (!isDirectoryAlreadyClosed(error)) mdFiles = undefined;
      }
    }
  } catch {
    onSnapshotCaptured();
    mdFiles = undefined;
  }

  if (!mdFiles) {
    // Do not retain a missing/over-limit/unstable result: a later file creation
    // or directory repair must be visible without an explicit cache reset.
    // The same fail-closed behavior applies to ACL and enumeration races.
    if (isLatestAgentScan(directoryKey, generation)) {
      agentDirectoryCache.delete(directoryKey);
      removeAgentFileEntriesForDirectory(source, resolvedDir);
    }
    return [];
  }

  // Do not rely on filesystem enumeration order. Relational string comparison
  // is based on UTF-16 code units and is locale-independent. This sort is over
  // the already bounded accepted list, never over the source directory.
  mdFiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  type MetadataResult =
    | { filePath: string; fingerprint: string; oversized?: boolean }
    | { unstable: true };
  const metadata = await mapWithConcurrency(
    mdFiles,
    MAX_AGENT_METADATA_CONCURRENCY,
    async (entry): Promise<MetadataResult> => {
      const filePath = path.join(dirPath, entry.name);
      try {
        // lstat preserves the fail-closed rule for a file replaced by a
        // symlink between enumeration and metadata collection.
        const stats = await fs.promises.lstat(filePath);
        if (!stats.isFile()) return { unstable: true };
        const fingerprint = agentFileFingerprint(filePath, stats);
        // This check intentionally happens before readFile. The complete file
        // is bounded, not merely the eventual Markdown body, so an oversized
        // definition is never read into memory or published from a stale cache.
        return {
          filePath,
          fingerprint,
          ...(stats.size > MAX_AGENT_MARKDOWN_BYTES ? { oversized: true } : {}),
        };
      } catch {
        // A file can disappear between enumeration and lstat. Do not cache this
        // unstable snapshot so the next turn retries it.
        return { unstable: true };
      }
    },
  );

  const descriptors: Array<{ filePath: string; fingerprint: string }> = [];
  const oversizedFiles = new Set<string>();
  let cacheable = true;
  for (const result of metadata) {
    if ("unstable" in result) {
      cacheable = false;
      continue;
    }
    descriptors.push({ filePath: result.filePath, fingerprint: result.fingerprint });
    if (result.oversized) {
      const resolvedFilePath = path.resolve(result.filePath);
      oversizedFiles.add(resolvedFilePath);
      // A previous small version must not survive as a cache hit after this
      // file crosses the bound. Do not replace it with an oversized payload.
      agentFileCache.delete(`${source}\0${resolvedFilePath}`);
      cacheable = false;
    }
  }

  const activeFiles = new Set(descriptors.map(({ filePath }) => path.resolve(filePath)));
  if (isLatestAgentScan(directoryKey, generation)) {
    removeAgentFileEntriesForDirectory(source, resolvedDir, activeFiles);
  }

  const directoryFingerprint = descriptors
    .map(({ fingerprint }) => fingerprint)
    .join("\n");
  const cachedDirectory = getAgentCacheEntry(agentDirectoryCache, directoryKey);
  if (cacheable && cachedDirectory?.fingerprint === directoryFingerprint) {
    return cachedDirectory.agents.map(cloneAgentFileConfig);
  }

  const agents: AgentConfigFromMd[] = [];
  for (const { filePath, fingerprint } of descriptors) {
    const resolvedFilePath = path.resolve(filePath);
    if (oversizedFiles.has(resolvedFilePath)) continue;
    const fileKey = `${source}\0${resolvedFilePath}`;
    const cachedFile = getAgentCacheEntry(agentFileCache, fileKey);
    if (cachedFile?.fingerprint === fingerprint) {
      agents.push(cloneAgentFileConfig(cachedFile.config));
      continue;
    }

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      // Re-check the encoded payload for growth/adapter races. The metadata
      // check above avoids normal oversized reads; this check prevents a
      // larger returned string from reaching the parser or cache.
      if (utf8ByteLength(content) > MAX_AGENT_MARKDOWN_BYTES) {
        throw new Error("agent Markdown exceeds the size bound");
      }
      // Verify that the path still names the same regular file after the
      // read. A replacement/deletion/symlink race is never published/cached.
      const afterRead = await fs.promises.lstat(filePath);
      if (!afterRead.isFile() || agentFileFingerprint(filePath, afterRead) !== fingerprint) {
        throw new Error("agent file changed during discovery");
      }
      const info = parseAgentFile(content, source);
      // The documented filename fallback makes a minimal `reviewer.md`
      // definition usable without broadening the frontmatter parser. A long
      // fallback is rejected rather than truncated into a different role.
      const fallbackName = (info.name ?? path.basename(filePath, ".md")).trim();
      if (fallbackName.length === 0 || !isAgentNameWithinLimit(fallbackName)) {
        if (isLatestAgentScan(directoryKey, generation)) agentFileCache.delete(fileKey);
        continue;
      }
      const config = { ...info, name: fallbackName };
      if (isLatestAgentScan(directoryKey, generation)) {
        setAgentCacheEntry(
          agentFileCache,
          fileKey,
          { fingerprint, config: cloneAgentFileConfig(config) },
          MAX_AGENT_FILE_CACHE_ENTRIES,
        );
      }
      agents.push(config);
    } catch {
      // Skip files that can't be read. An unreadable or unstable snapshot must
      // not be reused forever because ACLs and races can resolve later.
      if (isLatestAgentScan(directoryKey, generation)) agentFileCache.delete(fileKey);
      cacheable = false;
    }
  }

  if (cacheable && isLatestAgentScan(directoryKey, generation)) {
    setAgentCacheEntry(
      agentDirectoryCache,
      directoryKey,
      { fingerprint: directoryFingerprint, agents: agents.map(cloneAgentFileConfig) },
      MAX_AGENT_DIRECTORY_CACHE_ENTRIES,
    );
  } else if (isLatestAgentScan(directoryKey, generation)) {
    agentDirectoryCache.delete(directoryKey);
  }
  return agents.map(cloneAgentFileConfig);
}

/** Run a small, deterministic worker pool for bounded metadata collection. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}
