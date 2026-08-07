/**
 * output-log-retention.ts — active-root markers and the global output janitor.
 *
 * Every inspection and deletion is fail-closed: the complete visible tree is
 * lstat-validated and no link-like entry is followed. Cleanup is best-effort,
 * asynchronous, coalesced, and never part of the session lifecycle gate.
 */

import {
  lstat,
  open as openFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { closeSync, constants, openSync, promises as fsPromises, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  OUTPUT_FILE_MODE,
  OUTPUT_O_NOFOLLOW,
  directoryIdentity,
  hasUsableIdentity,
  isLinkLike,
  safeEntryPath,
  sameDirectoryIdentity,
  validOutputTreeEntry,
  type OutputRootIdentity,
} from "./output-log-constants.js";
import {
  consumeGlobalJanitorBudget,
  createGlobalJanitorBudget,
  deleteVerifiedOutputRoot,
  inspectOutputTree,
  type GlobalJanitorBudget,
  type OutputTreeBudget,
} from "./output-log-retention-tree.js";

export const OUTPUT_ROOT_PREFIX = "pi-subagents-outputs-";
export const MAX_OUTPUT_ROOTS = 4;
export const MAX_OUTPUT_ROOT_RETENTION_BYTES = 256 * 1024 * 1024;
export const OUTPUT_ROOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OUTPUT_ROOT_NAME = /^pi-subagents-outputs-[A-Za-z0-9_-]+$/;
/** Maximum entries consumed while finding candidate roots in the parent. */
export const MAX_OUTPUT_PARENT_ENTRIES = 10_000;
export {
  MAX_OUTPUT_GLOBAL_ENTRIES,
  MAX_OUTPUT_GLOBAL_PASS_ENTRIES,
  MAX_OUTPUT_JANITOR_PASS_ENTRIES,
  MAX_OUTPUT_ROOT_DEPTH,
  MAX_OUTPUT_ROOT_ENTRIES,
} from "./output-log-retention-tree.js";
const ACTIVE_ROOT_MARKER_NAME = ".pi-subagents-active";
const ACTIVE_ROOT_MARKER_TOKEN = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

function isDirectoryAlreadyClosed(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ERR_DIR_CLOSED";
}

/** Roots owned by a live parent runtime and therefore protected from cleanup. */
const activeOutputRoots = new Set<string>();
const activeOutputRootIdentities = new Map<string, OutputRootIdentity>();

function captureActiveRootIdentity(root: string): void {
  try {
    const stats = statSync(root) as Stats;
    if (stats.isDirectory() && hasUsableIdentity(stats)) {
      activeOutputRootIdentities.set(resolve(root), directoryIdentity(stats));
    }
  } catch {
    // The marker remains the cross-process protection when metadata is unclear.
  }
}

/** Create the marker before a root is published to the janitor's live set. */
export function createActiveRootMarker(root: string): void {
  const marker = join(root, ACTIVE_ROOT_MARKER_NAME);
  let fd: number | undefined;
  try {
    fd = openSync(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (OUTPUT_O_NOFOLLOW ?? 0),
      OUTPUT_FILE_MODE,
    );
    writeSync(fd, `${process.pid}\n${ACTIVE_ROOT_MARKER_TOKEN}\n`, undefined, "utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Register a root and optionally trigger the canonical-parent janitor pass. */
export function registerOutputRoot(root: string, shouldSchedule: boolean): void {
  const normalized = resolve(root);
  activeOutputRoots.add(normalized);
  captureActiveRootIdentity(normalized);
  if (shouldSchedule) scheduleOutputRootCleanup();
}

/** Remove one live-root protection without touching queued writers. */
export function releaseActiveOutputRoot(root: string, shouldSchedule: boolean): void {
  const normalized = resolve(root);
  activeOutputRoots.delete(normalized);
  const identity = activeOutputRootIdentities.get(normalized);
  if (identity) {
    for (const [activeRoot, activeIdentity] of activeOutputRootIdentities) {
      if (sameDirectoryIdentity(identity, activeIdentity)) {
        activeOutputRootIdentities.delete(activeRoot);
        activeOutputRoots.delete(activeRoot);
      }
    }
  } else {
    try {
      const stats = statSync(normalized) as Stats;
      if (hasUsableIdentity(stats)) {
        for (const [activeRoot, activeIdentity] of activeOutputRootIdentities) {
          if (sameDirectoryIdentity(directoryIdentity(stats), activeIdentity)) {
            activeOutputRootIdentities.delete(activeRoot);
            activeOutputRoots.delete(activeRoot);
          }
        }
      }
    } catch {
      // Keep an unclear active root protected rather than guessing at aliases.
    }
  }
  activeOutputRootIdentities.delete(normalized);
  if (shouldSchedule) scheduleOutputRootCleanup();
}

/**
 * Remove the cross-process live-root marker after queued output writes drain.
 * An exchanged or unclear root is left untouched so cleanup remains fail-closed.
 */
export async function releaseOutputRootMarker(
  root: string,
  expectedRoot?: OutputRootIdentity,
): Promise<void> {
  const normalized = resolve(root);
  try {
    const rootStats = await lstat(normalized);
    if (
      !rootStats.isDirectory()
      || isLinkLike(rootStats)
      || (expectedRoot && !sameDirectoryIdentity(expectedRoot, directoryIdentity(rootStats)))
    ) return;
    const marker = join(normalized, ACTIVE_ROOT_MARKER_NAME);
    const markerStats = await lstat(marker);
    if (!validOutputTreeEntry(markerStats, "file")) return;
    await unlink(marker);
  } catch {
    // A missing marker or an exchanged/permission-protected root remains
    // persistent and is safer to skip than to remove through an uncertain path.
  }
}

export type OutputPathCanonicalizer = (path: string) => string | Promise<string>;

export interface OutputRootCleanupOptions {
  /** Test/host override for the one exact parent that is scanned. */
  parentDir?: string;
  now?: () => number;
  currentRoot?: string;
  protectedRoots?: Iterable<string>;
  /** Optional deterministic alias resolver used by hosts and boundary tests. */
  canonicalizePath?: OutputPathCanonicalizer;
}

export interface OutputRootCleanupResult {
  scannedRoots: number;
  skippedRoots: number;
  deletedRoots: string[];
}

interface VerifiedOutputRoot {
  name: string;
  /** Canonical path used for all security-sensitive filesystem operations. */
  path: string;
  /** Path spelling returned to callers, rooted at their supplied parent. */
  reportedPath: string;
  canonicalKey: string;
  identity: OutputRootIdentity;
  size: number;
  /** Entries consumed by the complete pre-delete validation snapshot. */
  treeEntries: number;
  modifiedAt: number;
  active: boolean;
}


type ActiveRootMarkerState = "none" | "active" | "stale" | "unclear";

function markerProcessState(pid: number): Exclude<ActiveRootMarkerState, "none" | "unclear"> | "unclear" {
  if (pid === process.pid) return "active";
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "unclear";
  }
}

async function inspectActiveRootMarker(
  root: string,
  expectedRoot: OutputRootIdentity,
): Promise<ActiveRootMarkerState> {
  const marker = join(root, ACTIVE_ROOT_MARKER_NAME);
  let markerStats: Stats;
  try {
    markerStats = await lstat(marker);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unclear";
  }
  if (
    !validOutputTreeEntry(markerStats, "file")
    || !hasUsableIdentity(markerStats)
    || markerStats.size > 4096
  ) return "unclear";

  let handle: FileHandle | undefined;
  try {
    handle = await openFile(marker, constants.O_RDONLY | (OUTPUT_O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (
      !validOutputTreeEntry(opened, "file")
      || !hasUsableIdentity(opened)
      || opened.size > 4096
      || !sameDirectoryIdentity(directoryIdentity(opened), directoryIdentity(markerStats))
    ) return "unclear";
    // Read only the bounded marker payload. A marker that grows after the
    // pre-open lstat is unclear rather than an unbounded read.
    const markerBuffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(markerBuffer, 0, markerBuffer.length, 0);
    if (bytesRead > 4096) return "unclear";
    const content = markerBuffer.subarray(0, bytesRead).toString("utf8");
    const currentRoot = await lstat(root);
    if (
      !validOutputTreeEntry(currentRoot, "directory")
      || !sameDirectoryIdentity(expectedRoot, directoryIdentity(currentRoot))
    ) return "unclear";
    const lines = content.trim().split(/\r?\n/u);
    if (
      lines.length !== 2
      || !/^[1-9][0-9]*$/u.test(lines[0]!)
      || !/^[A-Za-z0-9:.~-]{1,256}$/u.test(lines[1]!)
    ) return "unclear";
    const pid = Number(lines[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return "unclear";
    return markerProcessState(pid);
  } catch {
    return "unclear";
  } finally {
    try { await handle?.close(); } catch { /* preserve fail-closed marker state */ }
  }
}

async function inspectOutputRoot(
  parent: string,
  reportedParent: string,
  name: string,
  global: GlobalJanitorBudget,
  canonicalizePath: OutputPathCanonicalizer | undefined,
): Promise<VerifiedOutputRoot | undefined> {
  if (!OUTPUT_ROOT_NAME.test(name)) return undefined;
  const root = safeEntryPath(parent, name);
  const reportedPath = safeEntryPath(reportedParent, name);
  if (!root || !reportedPath) return undefined;
  let stats: Stats;
  try {
    // Root metadata is an inspection in addition to the tree entry itself.
    consumeGlobalJanitorBudget(global);
    stats = await lstat(root);
  } catch { return undefined; }
  if (
    !validOutputTreeEntry(stats, "directory")
    || !hasUsableIdentity(stats)
    || !Number.isFinite(stats.mtimeMs)
  ) return undefined;
  const markerState = await inspectActiveRootMarker(root, directoryIdentity(stats));
  if (markerState === "unclear") return undefined;
  const treeBudget: OutputTreeBudget = { entries: 0, global };
  const size = await inspectOutputTree(root, root, treeBudget);
  if (size === undefined) return undefined;
  return {
    name,
    path: root,
    reportedPath,
    canonicalKey: pathKey(await canonicalPath(root, canonicalizePath)),
    identity: directoryIdentity(stats),
    size,
    treeEntries: treeBudget.entries,
    modifiedAt: stats.mtimeMs,
    active: markerState === "active",
  };
}

function pathKey(root: string): string {
  const normalized = resolve(root);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function identityKey(identity: OutputRootIdentity): string {
  return `${identity.dev}:${identity.ino}`;
}

interface ProtectedRootSet {
  identities: Set<string>;
  paths: Set<string>;
}

async function canonicalPath(
  path: string,
  canonicalizePath: OutputPathCanonicalizer | undefined,
): Promise<string> {
  const normalized = resolve(path);
  try {
    return resolve(await (canonicalizePath ? canonicalizePath(normalized) : realpath(normalized)));
  } catch {
    // A missing protection path still gets a bounded textual fallback. A
    // present candidate always has an identity and canonical key of its own.
    return normalized;
  }
}

async function addProtectedRoot(
  protectedRoots: ProtectedRootSet,
  root: string,
  canonicalizePath: OutputPathCanonicalizer | undefined,
): Promise<void> {
  const normalized = resolve(root);
  protectedRoots.paths.add(pathKey(normalized));
  protectedRoots.paths.add(pathKey(await canonicalPath(normalized, canonicalizePath)));
  try {
    const stats = await fsPromises.stat(normalized);
    if (stats.isDirectory() && hasUsableIdentity(stats)) {
      protectedRoots.identities.add(identityKey(directoryIdentity(stats)));
    }
  } catch {
    // The canonical path fallback above remains useful for an already-removed
    // or synthetic protection path.
  }
}

async function protectedRootSet(options: OutputRootCleanupOptions): Promise<ProtectedRootSet> {
  const protectedRoots: ProtectedRootSet = { identities: new Set(), paths: new Set() };
  const roots = [
    ...activeOutputRoots,
    ...(options.currentRoot ? [options.currentRoot] : []),
    ...(options.protectedRoots ?? []),
  ];
  for (const root of roots) {
    await addProtectedRoot(protectedRoots, root, options.canonicalizePath);
  }
  return protectedRoots;
}

function isProtectedRoot(candidate: VerifiedOutputRoot, protectedRoots: ProtectedRootSet): boolean {
  return protectedRoots.identities.has(identityKey(candidate.identity))
    || protectedRoots.paths.has(candidate.canonicalKey)
    || protectedRoots.paths.has(pathKey(candidate.path));
}

interface CanonicalCleanupParent {
  path: string;
  reportedPath: string;
}

async function canonicalCleanupParent(
  parentDir: string | undefined,
  canonicalizePath: OutputPathCanonicalizer | undefined,
): Promise<CanonicalCleanupParent | undefined> {
  try {
    const selected = resolve(parentDir ?? tmpdir());
    const canonical = await canonicalPath(selected, canonicalizePath);
    const stats = await lstat(canonical);
    if (!stats.isDirectory() || isLinkLike(stats)) return undefined;
    return {
      path: canonical,
      reportedPath: parentDir === undefined ? canonical : selected,
    };
  } catch {
    return undefined;
  }
}


/** Run the best-effort global janitor against one canonical parent. */
export async function cleanupOutputRoots(
  options: OutputRootCleanupOptions = {},
): Promise<OutputRootCleanupResult> {
  const parent = await canonicalCleanupParent(options.parentDir, options.canonicalizePath);
  if (!parent) return { scannedRoots: 0, skippedRoots: 0, deletedRoots: [] };
  const globalBudget = createGlobalJanitorBudget();

  // Candidate discovery is itself bounded. An over-wide temporary parent is
  // left untouched rather than materializing an unbounded name list or making
  // deletion decisions from an incomplete view.
  const candidateNames: string[] = [];
  let parentHandle: Awaited<ReturnType<typeof fsPromises.opendir>> | undefined;
  let parentScanFailed = false;
  try {
    parentHandle = await fsPromises.opendir(parent.path);
    let entryCount = 0;
    for await (const entry of parentHandle) {
      consumeGlobalJanitorBudget(globalBudget);
      entryCount++;
      if (entryCount > MAX_OUTPUT_PARENT_ENTRIES) {
        parentScanFailed = true;
        break;
      }
      if (OUTPUT_ROOT_NAME.test(entry.name)) candidateNames.push(entry.name);
    }
  } catch {
    parentScanFailed = true;
  } finally {
    try {
      await parentHandle?.close();
    } catch (error) {
      if (!isDirectoryAlreadyClosed(error)) parentScanFailed = true;
    }
  }
  if (parentScanFailed) return { scannedRoots: 0, skippedRoots: 0, deletedRoots: [] };
  candidateNames.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  // Candidate names are sorted before inspection. A sequential pass makes
  // exhaustion deterministic: the same prefix is inspected and the remaining
  // roots are skipped on every run, independent of filesystem timing.
  const inspected: Array<VerifiedOutputRoot | undefined> = [];
  let skippedRoots = 0;
  for (let index = 0; index < candidateNames.length; index++) {
    if (globalBudget.exhausted) {
      skippedRoots += candidateNames.length - index;
      break;
    }
    const candidate = await inspectOutputRoot(
      parent.path,
      parent.reportedPath,
      candidateNames[index]!,
      globalBudget,
      options.canonicalizePath,
    );
    inspected.push(candidate);
    if (candidate === undefined) skippedRoots++;
  }
  const candidates = inspected.filter((candidate): candidate is VerifiedOutputRoot => candidate !== undefined);
  const protectedRoots = await protectedRootSet(options);
  for (const candidate of candidates) {
    if (candidate.active) {
      protectedRoots.identities.add(identityKey(candidate.identity));
      protectedRoots.paths.add(candidate.canonicalKey);
    }
  }
  const sorted = [...candidates].sort((left, right) => {
    if (left.modifiedAt !== right.modifiedAt) return left.modifiedAt - right.modifiedAt;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  const planned = new Set<string>();
  let nextRemovableIndex = 0;
  const nextRemovable = (): VerifiedOutputRoot | undefined => {
    while (nextRemovableIndex < sorted.length) {
      const candidate = sorted[nextRemovableIndex++]!;
      if (!planned.has(candidate.path) && !isProtectedRoot(candidate, protectedRoots)) return candidate;
    }
    return undefined;
  };

  const now = options.now?.() ?? Date.now();
  for (const candidate of sorted) {
    if (now - candidate.modifiedAt > OUTPUT_ROOT_MAX_AGE_MS && !isProtectedRoot(candidate, protectedRoots)) {
      planned.add(candidate.path);
    }
  }
  let remainingCount = candidates.length - planned.size;
  let remainingBytes = candidates.reduce((sum, candidate) => sum + candidate.size, 0)
    - sorted.filter((candidate) => planned.has(candidate.path)).reduce((sum, candidate) => sum + candidate.size, 0);
  while (remainingCount > MAX_OUTPUT_ROOTS || remainingBytes > MAX_OUTPUT_ROOT_RETENTION_BYTES) {
    const candidate = nextRemovable();
    if (!candidate) break;
    planned.add(candidate.path);
    remainingCount--;
    remainingBytes -= candidate.size;
  }

  const deleteCandidates = sorted.filter((candidate) =>
    planned.has(candidate.path) && !isProtectedRoot(candidate, protectedRoots));
  const deletedRoots: string[] = [];
  for (const candidate of deleteCandidates) {
    if (globalBudget.exhausted) break;
    try {
      if (await deleteVerifiedOutputRoot(
        candidate.path,
        candidate.identity,
        candidate.treeEntries,
        globalBudget,
      )) deletedRoots.push(candidate.reportedPath);
    } catch {
      // A failed/racing root remains persistent; the reserved budget is
      // intentionally not returned, preserving deterministic exhaustion.
    }
  }
  return { scannedRoots: candidates.length, skippedRoots, deletedRoots };
}

let cleanupTimer: ReturnType<typeof setImmediate> | undefined;
let cleanupRunning = false;
let cleanupRequested = false;

/** Schedule one coalesced, non-blocking janitor pass. */
export function scheduleOutputRootCleanup(): void {
  cleanupRequested = true;
  if (cleanupRunning || cleanupTimer !== undefined) return;
  cleanupTimer = setImmediate(() => {
    cleanupTimer = undefined;
    void runScheduledOutputRootCleanup();
  });
}

async function runScheduledOutputRootCleanup(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;
  do {
    cleanupRequested = false;
    try { await cleanupOutputRoots({ protectedRoots: activeOutputRoots }); }
    catch { /* retention is optional hygiene and never blocks session startup */ }
  } while (cleanupRequested);
  cleanupRunning = false;
  if (cleanupRequested) scheduleOutputRootCleanup();
}
