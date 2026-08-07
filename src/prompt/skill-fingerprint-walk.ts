/**
 * Bounded streaming walkers for skill-source fingerprints.
 *
 * The walker owns filesystem metadata, path records, and shared sync/async
 * budgets. The public fingerprint facade only serializes the returned record
 * snapshot and keeps the established API stable.
 */

import { lstatSync, opendirSync, realpathSync, statSync, promises as fsPromises } from "node:fs";
import type { Stats } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface ResourceFingerprintOptions {
  /** Whether direct root `*.md` files are read by the Pi source. */
  allowRootMarkdown?: boolean;
  /** Whether direct root Markdown counts toward the published skill quota. */
  countRootMarkdown?: boolean;
}

export interface ResolvedResourceFingerprintOptions {
  allowRootMarkdown: boolean;
  /** Byte limits still include root Markdown when this is false. */
  countRootMarkdown?: boolean;
}

/** Maximum number of filesystem entries visited for one root fingerprint. */
export const MAX_RESOURCE_FINGERPRINT_ENTRIES = 10_000;
/** Maximum descendant depth for one root fingerprint; the root is depth 0. */
export const MAX_RESOURCE_FINGERPRINT_DEPTH = 64;
/** Maximum bytes in one SKILL.md or allowed root Markdown file. */
export const MAX_SKILL_MARKDOWN_BYTES = 512 * 1024;
/** Maximum bytes in one Pi ignore file. */
export const MAX_SKILL_IGNORE_BYTES = 256 * 1024;
/** Maximum relevant bytes observed for one skill source root. */
export const MAX_SKILL_RELEVANT_BYTES_PER_ROOT = 32 * 1024 * 1024;

export const MAX_SKILL_FILE_BYTES = MAX_SKILL_MARKDOWN_BYTES;
export const MAX_SKILL_IGNORE_FILE_BYTES = MAX_SKILL_IGNORE_BYTES;
export const MAX_RESOURCE_RELEVANT_BYTES = MAX_SKILL_RELEVANT_BYTES_PER_ROOT;
export const MAX_SKILL_ROOT_BYTES = MAX_SKILL_RELEVANT_BYTES_PER_ROOT;

export type ResourceFingerprintLimit =
  | "entries"
  | "depth"
  | "skill-markdown"
  | "ignore-file"
  | "bytes";

/** Deterministic fail-closed error for a pathological resource tree. */
export class ResourceFingerprintLimitError extends Error {
  readonly root: string;
  readonly limit: ResourceFingerprintLimit;

  constructor(root: string, limit: ResourceFingerprintLimit) {
    const message = limit === "entries"
      ? `Resource fingerprint limit exceeded for root "${root}": maximum ${MAX_RESOURCE_FINGERPRINT_ENTRIES} visited entries`
      : limit === "depth"
        ? `Resource fingerprint depth limit exceeded for root "${root}": maximum depth ${MAX_RESOURCE_FINGERPRINT_DEPTH}`
        : limit === "skill-markdown"
          ? `Skill Markdown limit exceeded for root "${root}": maximum ${MAX_SKILL_MARKDOWN_BYTES} bytes per skill Markdown file`
          : limit === "ignore-file"
            ? `Skill ignore-file limit exceeded for root "${root}": maximum ${MAX_SKILL_IGNORE_BYTES} bytes per ignore file`
            : `Skill resource-byte limit exceeded for root "${root}": maximum ${MAX_SKILL_RELEVANT_BYTES_PER_ROOT} relevant bytes`;
    super(message);
    this.name = "ResourceFingerprintLimitError";
    this.root = root;
    this.limit = limit;
  }
}

export interface FingerprintWalkResult {
  records: string[];
  stable: boolean;
  relevantBytes: number;
  skillCount: number;
}

class FingerprintBudget {
  private visitedEntries = 0;
  private relevantBytes = 0;
  private skillCount = 0;

  constructor(
    private readonly root: string,
    private readonly options: ResolvedResourceFingerprintOptions,
  ) {}

  enter(depth: number): void {
    if (depth > MAX_RESOURCE_FINGERPRINT_DEPTH) {
      throw new ResourceFingerprintLimitError(this.root, "depth");
    }
    this.visitedEntries++;
    if (this.visitedEntries > MAX_RESOURCE_FINGERPRINT_ENTRIES) {
      throw new ResourceFingerprintLimitError(this.root, "entries");
    }
  }

  relevantFile(filePath: string, stats: Stats, depth: number, isSkillMarkdown: boolean, isIgnoreFile: boolean): void {
    const name = basename(filePath);
    const isAllowedRootMarkdown = this.options.allowRootMarkdown && depth === 1 && name.endsWith(".md");
    if (!isSkillMarkdown && !isIgnoreFile && !isAllowedRootMarkdown) return;

    const maxBytes = isIgnoreFile ? MAX_SKILL_IGNORE_BYTES : MAX_SKILL_MARKDOWN_BYTES;
    if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > maxBytes) {
      throw new ResourceFingerprintLimitError(this.root, isIgnoreFile ? "ignore-file" : "skill-markdown");
    }
    this.relevantBytes += stats.size;
    if (this.relevantBytes > MAX_SKILL_RELEVANT_BYTES_PER_ROOT) {
      throw new ResourceFingerprintLimitError(this.root, "bytes");
    }
    if (isSkillMarkdown || (isAllowedRootMarkdown && this.options.countRootMarkdown !== false)) {
      this.skillCount++;
    }
  }

  result(): Pick<FingerprintWalkResult, "relevantBytes" | "skillCount"> {
    return { relevantBytes: this.relevantBytes, skillCount: this.skillCount };
  }
}

const IGNORE_FILE_NAMES = new Set([".gitignore", ".ignore", ".fdignore"]);

function isSymlink(stats: Stats): boolean {
  return stats.isSymbolicLink();
}

function statType(stats: Stats): string {
  return stats.isDirectory()
    ? "directory"
    : stats.isFile()
      ? "file"
      : stats.isSymbolicLink()
        ? "symlink"
        : "other";
}

function statMetadata(stats: Stats): unknown[] {
  return [
    statType(stats),
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
    stats.mode,
    stats.dev,
    stats.ino,
    stats.nlink,
  ];
}

/**
 * Record a path relative to the fingerprint root, never its host spelling.
 * Windows can return either the long or 8.3 spelling from otherwise equivalent
 * filesystem calls; relative names and stable metadata keep sync/async values
 * semantic rather than dependent on that spelling.
 */
function statFingerprint(relativePath: string, stats: Stats): string {
  return JSON.stringify([relativePath, ...statMetadata(stats)]);
}

function targetFingerprint(stats: Stats): string {
  // The target path is deliberately absent. Its stable identity and metadata
  // detect retargeting without turning a long-vs-short alias into a change.
  return JSON.stringify(statMetadata(stats));
}

function targetFileStatsSync(filePath: string, stats: Stats): Stats | undefined {
  if (!isSymlink(stats)) return stats;
  try {
    const target = statSync(filePath) as Stats;
    return target.isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

async function targetFileStatsAsync(filePath: string, stats: Stats): Promise<Stats | undefined> {
  if (!isSymlink(stats)) return stats;
  try {
    const target = await fsPromises.stat(filePath) as Stats;
    return target.isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

function recordRelevantSync(
  filePath: string,
  stats: Stats,
  depth: number,
  budget: FingerprintBudget,
  options: ResolvedResourceFingerprintOptions,
): boolean {
  const name = basename(filePath);
  const isSkillMarkdown = name === "SKILL.md";
  const isIgnoreFile = IGNORE_FILE_NAMES.has(name);
  const targetStats = targetFileStatsSync(filePath, stats);
  if (isSkillMarkdown && targetStats === undefined) return false;
  if ((isSkillMarkdown || isIgnoreFile || (options.allowRootMarkdown && depth === 1 && name.endsWith(".md"))) && targetStats) {
    budget.relevantFile(filePath, targetStats, depth, isSkillMarkdown, isIgnoreFile);
  }
  return isSkillMarkdown && targetStats !== undefined;
}

async function recordRelevantAsync(
  filePath: string,
  stats: Stats,
  depth: number,
  budget: FingerprintBudget,
  options: ResolvedResourceFingerprintOptions,
): Promise<boolean> {
  const name = basename(filePath);
  const isSkillMarkdown = name === "SKILL.md";
  const isIgnoreFile = IGNORE_FILE_NAMES.has(name);
  const targetStats = await targetFileStatsAsync(filePath, stats);
  if (isSkillMarkdown && targetStats === undefined) return false;
  if ((isSkillMarkdown || isIgnoreFile || (options.allowRootMarkdown && depth === 1 && name.endsWith(".md"))) && targetStats) {
    budget.relevantFile(filePath, targetStats, depth, isSkillMarkdown, isIgnoreFile);
  }
  return isSkillMarkdown && targetStats !== undefined;
}

function rootRecordMissing(
  records: string[],
  relativePath: string,
  isRoot: boolean,
  stable: { value: boolean },
): void {
  if (!isRoot) stable.value = false;
  records.push(JSON.stringify([relativePath, "missing"]));
}

/** Walk one source synchronously without reading file contents. */
export function walkResourceTree(
  root: string,
  options: ResolvedResourceFingerprintOptions,
): FingerprintWalkResult {
  const records: string[] = [];
  const visitedDirectories = new Set<string>();
  const budget = new FingerprintBudget(root, options);
  const stable = { value: true };

  const visitDirectory = (
    current: string,
    relativeRoot: string,
    depth: number,
    directoryStats: Stats,
  ): void => {
    // Windows can expose file IDs above Number.MAX_SAFE_INTEGER. Do not use a
    // rounded numeric ID for cycle detection; the canonical path fallback is
    // internal and is never serialized into the fingerprint value.
    const identity = Number.isSafeInteger(directoryStats.dev) && Number.isSafeInteger(directoryStats.ino)
      ? `${directoryStats.dev}:${directoryStats.ino}`
      : undefined;
    let visitKey = identity ? `identity:${identity}` : undefined;
    if (!visitKey) {
      try { visitKey = `path:${realpathSync(current)}`; }
      catch { visitKey = `path:${resolve(current)}`; }
    }
    if (visitedDirectories.has(visitKey)) return;
    visitedDirectories.add(visitKey);
    records.push(JSON.stringify([relativeRoot, "directory-target", targetFingerprint(directoryStats)]));

    let directory: ReturnType<typeof opendirSync> | undefined;
    const names: string[] = [];
    let listingFailed = false;
    try {
      directory = opendirSync(current);
      while (true) {
        const entry = directory.readSync();
        if (entry === null) break;
        budget.enter(depth + 1);
        names.push(entry.name);
      }
    } catch (error) {
      if (error instanceof ResourceFingerprintLimitError) throw error;
      listingFailed = true;
    } finally {
      try { directory?.closeSync(); } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ERR_DIR_CLOSED") listingFailed = true;
      }
    }
    if (listingFailed) { stable.value = false; return; }

    names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    let containsSkill = false;
    for (const name of names) {
      const child = join(current, name);
      const childRelative = `${relativeRoot}/${name}`;
      let childStats: Stats;
      try { childStats = lstatSync(child) as Stats; } catch {
        rootRecordMissing(records, childRelative, false, stable);
        continue;
      }
      records.push(statFingerprint(childRelative, childStats));
      if (childStats.isFile() || childStats.isSymbolicLink()) {
        containsSkill ||= recordRelevantSync(child, childStats, depth + 1, budget, options);
      }
    }
    if (containsSkill) return;
    for (const name of names) {
      const child = join(current, name);
      const childRelative = `${relativeRoot}/${name}`;
      let childStats: Stats;
      try { childStats = lstatSync(child) as Stats; } catch { continue; }
      if (childStats.isDirectory()) visit(child, childRelative, false, depth + 1);
      else if (childStats.isSymbolicLink()) {
        let targetStats: Stats;
        try { targetStats = statSync(child) as Stats; } catch { stable.value = false; continue; }
        if (targetStats.isDirectory()) visit(child, childRelative, false, depth + 1, targetStats);
      }
    }
  };

  const visit = (
    current: string,
    relativePath: string,
    isRoot = false,
    depth = 0,
    targetStats?: Stats,
  ): void => {
    // Every descendant is entered through the directory budget before this
    // callback is reached; the budget is the single depth/entry authority.
    if (isRoot) budget.enter(depth);
    let stats: Stats;
    try { stats = lstatSync(current) as Stats; } catch {
      rootRecordMissing(records, relativePath, isRoot, stable);
      return;
    }
    records.push(statFingerprint(relativePath, stats));
    if (stats.isSymbolicLink()) {
      // Resolve only to prove the link is live. The returned spelling is
      // intentionally not serialized because it is alias-dependent on
      // Windows; target metadata below carries the semantic identity.
      try { realpathSync(current); } catch { stable.value = false; return; }
      let linkedStats = targetStats;
      if (!linkedStats) {
        try { linkedStats = statSync(current) as Stats; }
        catch { stable.value = false; return; }
      }
      records.push(JSON.stringify([relativePath, "target", targetFingerprint(linkedStats)]));
      if (linkedStats.isFile()) recordRelevantSync(current, stats, depth, budget, options);
      else if (linkedStats.isDirectory()) visitDirectory(current, relativePath, depth, linkedStats);
    } else if (stats.isFile()) recordRelevantSync(current, stats, depth, budget, options);
    else if (stats.isDirectory()) visitDirectory(current, relativePath, depth, stats);
  };

  visit(root, ".", true, 0);
  return { records, stable: stable.value, ...budget.result() };
}

/** Promise-based equivalent of walkResourceTree. */
export async function walkResourceTreeAsync(
  root: string,
  options: ResolvedResourceFingerprintOptions,
): Promise<FingerprintWalkResult> {
  const records: string[] = [];
  const visitedDirectories = new Set<string>();
  const budget = new FingerprintBudget(root, options);
  const stable = { value: true };

  const visitDirectory = async (
    current: string,
    relativeRoot: string,
    depth: number,
    directoryStats: Stats,
  ): Promise<void> => {
    // The async path uses only promise-based resolution for its internal
    // cycle fallback; no synchronous filesystem call crosses this boundary.
    const identity = Number.isSafeInteger(directoryStats.dev) && Number.isSafeInteger(directoryStats.ino)
      ? `${directoryStats.dev}:${directoryStats.ino}`
      : undefined;
    let visitKey = identity ? `identity:${identity}` : undefined;
    if (!visitKey) {
      try { visitKey = `path:${await fsPromises.realpath(current)}`; }
      catch { visitKey = `path:${resolve(current)}`; }
    }
    if (visitedDirectories.has(visitKey)) return;
    visitedDirectories.add(visitKey);
    records.push(JSON.stringify([relativeRoot, "directory-target", targetFingerprint(directoryStats)]));

    let directory: Awaited<ReturnType<typeof fsPromises.opendir>> | undefined;
    const names: string[] = [];
    let listingFailed = false;
    try {
      directory = await fsPromises.opendir(current);
      for await (const entry of directory) { budget.enter(depth + 1); names.push(entry.name); }
    } catch (error) {
      if (error instanceof ResourceFingerprintLimitError) throw error;
      listingFailed = true;
    } finally {
      try { await directory?.close(); } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ERR_DIR_CLOSED") listingFailed = true;
      }
    }
    if (listingFailed) { stable.value = false; return; }

    names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    let containsSkill = false;
    for (const name of names) {
      const child = join(current, name);
      const childRelative = `${relativeRoot}/${name}`;
      let childStats: Stats;
      try { childStats = await fsPromises.lstat(child) as Stats; } catch {
        rootRecordMissing(records, childRelative, false, stable);
        continue;
      }
      records.push(statFingerprint(childRelative, childStats));
      if (childStats.isFile() || childStats.isSymbolicLink()) {
        containsSkill ||= await recordRelevantAsync(child, childStats, depth + 1, budget, options);
      }
    }
    if (containsSkill) return;
    for (const name of names) {
      const child = join(current, name);
      const childRelative = `${relativeRoot}/${name}`;
      let childStats: Stats;
      try { childStats = await fsPromises.lstat(child) as Stats; } catch { continue; }
      if (childStats.isDirectory()) await visit(child, childRelative, false, depth + 1);
      else if (childStats.isSymbolicLink()) {
        let targetStats: Stats;
        try { targetStats = await fsPromises.stat(child) as Stats; } catch { stable.value = false; continue; }
        if (targetStats.isDirectory()) await visit(child, childRelative, false, depth + 1, targetStats);
      }
    }
  };

  const visit = async (
    current: string,
    relativePath: string,
    isRoot = false,
    depth = 0,
    targetStats?: Stats,
  ): Promise<void> => {
    // Every descendant is entered through the directory budget before this
    // callback is reached; the budget is the single depth/entry authority.
    if (isRoot) budget.enter(depth);
    let stats: Stats;
    try { stats = await fsPromises.lstat(current) as Stats; } catch {
      rootRecordMissing(records, relativePath, isRoot, stable);
      return;
    }
    records.push(statFingerprint(relativePath, stats));
    if (stats.isSymbolicLink()) {
      // Resolve only to prove the link is live. The returned spelling is
      // intentionally not serialized because it is alias-dependent on
      // Windows; target metadata below carries the semantic identity.
      try { await fsPromises.realpath(current); } catch { stable.value = false; return; }
      let linkedStats = targetStats;
      if (!linkedStats) {
        try { linkedStats = await fsPromises.stat(current) as Stats; }
        catch { stable.value = false; return; }
      }
      records.push(JSON.stringify([relativePath, "target", targetFingerprint(linkedStats)]));
      if (linkedStats.isFile()) await recordRelevantAsync(current, stats, depth, budget, options);
      else if (linkedStats.isDirectory()) await visitDirectory(current, relativePath, depth, linkedStats);
    } else if (stats.isFile()) await recordRelevantAsync(current, stats, depth, budget, options);
    else if (stats.isDirectory()) await visitDirectory(current, relativePath, depth, stats);
  };

  await visit(root, ".", true, 0);
  return { records, stable: stable.value, ...budget.result() };
}
