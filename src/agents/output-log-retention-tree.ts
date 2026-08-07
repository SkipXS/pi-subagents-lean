/**
 * Bounded, fail-closed output-tree inspection and deletion primitives.
 *
 * This module deliberately knows nothing about root selection, live markers, or
 * scheduling. It only validates complete visible trees and consumes the shared
 * janitor pass budget before any destructive operation.
 */

import { lstat, rmdir, unlink } from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import type { Stats } from "node:fs";
import {
  directoryIdentity,
  isLinkLike,
  pathInside,
  safeEntryPath,
  sameDirectoryIdentity,
  samePath,
  validOutputTreeEntry,
  type OutputRootIdentity,
} from "./output-log-constants.js";

/** Maximum visible entries inspected under one output root. */
export const MAX_OUTPUT_ROOT_ENTRIES = 10_000;
/** Maximum descendant depth inspected under one output root; root is depth 0. */
export const MAX_OUTPUT_ROOT_DEPTH = 64;
/** Maximum tree-entry inspections reserved by one complete janitor pass. */
export const MAX_OUTPUT_GLOBAL_PASS_ENTRIES = 50_000;
/** Descriptive aliases for hosts/tests that expose the janitor policy. */
export const MAX_OUTPUT_JANITOR_PASS_ENTRIES = MAX_OUTPUT_GLOBAL_PASS_ENTRIES;
export const MAX_OUTPUT_GLOBAL_ENTRIES = MAX_OUTPUT_GLOBAL_PASS_ENTRIES;

export interface GlobalJanitorBudget {
  used: number;
  exhausted: boolean;
  remaining: number;
}

export function createGlobalJanitorBudget(): GlobalJanitorBudget {
  return { used: 0, exhausted: false, remaining: MAX_OUTPUT_GLOBAL_PASS_ENTRIES };
}

export function consumeGlobalJanitorBudget(global: GlobalJanitorBudget, amount = 1): void {
  if (amount < 0 || global.used + amount > MAX_OUTPUT_GLOBAL_PASS_ENTRIES) {
    global.exhausted = true;
    global.remaining = 0;
    throw new Error("Global output janitor pass budget exhausted");
  }
  global.used += amount;
  global.remaining = MAX_OUTPUT_GLOBAL_PASS_ENTRIES - global.used;
}

/** Reserve a deterministic delete validation budget before any unlink occurs. */
export function reserveGlobalJanitorBudget(global: GlobalJanitorBudget, amount: number): boolean {
  if (amount < 0 || global.used + amount > MAX_OUTPUT_GLOBAL_PASS_ENTRIES) {
    global.exhausted = true;
    global.remaining = 0;
    return false;
  }
  global.used += amount;
  global.remaining = MAX_OUTPUT_GLOBAL_PASS_ENTRIES - global.used;
  return true;
}

export interface OutputTreeBudget {
  entries: number;
  global?: GlobalJanitorBudget;
  /** A delete pass may spend the exact count reserved from its snapshot. */
  reservedEntries?: number;
}

export function consumeOutputTreeEntry(budget: OutputTreeBudget, depth: number): void {
  if (depth > MAX_OUTPUT_ROOT_DEPTH) {
    throw new Error("Output root depth limit exceeded");
  }
  if (budget.entries >= (budget.reservedEntries ?? MAX_OUTPUT_ROOT_ENTRIES)) {
    if (budget.reservedEntries !== undefined) {
      throw new Error("Output root grew after its inspection snapshot");
    }
    throw new Error("Output root entry limit exceeded");
  }
  budget.entries++;
  if (budget.entries > MAX_OUTPUT_ROOT_ENTRIES) {
    throw new Error("Output root entry limit exceeded");
  }
  // A delete pass has already reserved this exact number of entries from the
  // shared global budget. Do not charge them a second time while validating;
  // the reservation is the pass-wide accounting record.
  if (budget.global && budget.reservedEntries === undefined) consumeGlobalJanitorBudget(budget.global);
}

function isDirectoryAlreadyClosed(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ERR_DIR_CLOSED";
}

/** Inspect a root without following any link-like entry. */
export async function inspectOutputTree(
  directory: string,
  root: string,
  budget: OutputTreeBudget = { entries: 0 },
  depth = 0,
  countDirectory = true,
): Promise<number | undefined> {
  try {
    if (countDirectory) consumeOutputTreeEntry(budget, depth);
    let stats: Stats;
    try { stats = await lstat(directory); } catch { return undefined; }
    if (!pathInside(root, directory) && !samePath(root, directory)) return undefined;
    if (!validOutputTreeEntry(stats, "directory")) return undefined;

    let handle: Awaited<ReturnType<typeof fsPromises.opendir>> | undefined;
    let size = 0;
    try {
      handle = await fsPromises.opendir(directory);
      for await (const entry of handle) {
        const childDepth = depth + 1;
        consumeOutputTreeEntry(budget, childDepth);
        const child = safeEntryPath(directory, entry.name);
        if (!child || !pathInside(root, child)) return undefined;
        let childStats: Stats;
        try { childStats = await lstat(child); } catch { return undefined; }
        // Dirent is only a hint; lstat is the security decision.
        if (isLinkLike(childStats)) return undefined;
        if (childStats.isDirectory()) {
          const childSize = await inspectOutputTree(child, root, budget, childDepth, false);
          if (childSize === undefined) return undefined;
          size += childSize;
        } else {
          if (!validOutputTreeEntry(childStats, "file")) return undefined;
          if (!Number.isSafeInteger(childStats.size) || childStats.size < 0) return undefined;
          size += childStats.size;
        }
      }
    } finally {
      // The explicit close is required both on normal completion and on the
      // first over-limit/race return; no directory cursor survives a skip.
      try {
        await handle?.close();
      } catch (error) {
        if (!isDirectoryAlreadyClosed(error)) return undefined;
      }
    }
    return size;
  } catch {
    // Limits, ACL failures, and iterator races make the whole root unsafe.
    return undefined;
  }
}

interface PendingOutputDeletion {
  path: string;
  stats: Stats;
  directory: boolean;
}

/**
 * Revalidate the complete visible tree and collect deletion targets without
 * mutating the filesystem. A reserved snapshot count makes any newly visible
 * entry fail before the mutation phase can begin.
 */
async function collectOutputTreeForDeletion(
  directory: string,
  root: string,
  expectedRoot: OutputRootIdentity | undefined,
  budget: OutputTreeBudget,
  depth: number,
  countDirectory: boolean,
  pending: PendingOutputDeletion[],
): Promise<boolean> {
  try {
    if (countDirectory) consumeOutputTreeEntry(budget, depth);
    let stats: Stats;
    try { stats = await lstat(directory); } catch { return false; }
    if (!pathInside(root, directory) && !samePath(root, directory)) return false;
    if (!validOutputTreeEntry(stats, "directory")) return false;
    if (expectedRoot && !sameDirectoryIdentity(expectedRoot, directoryIdentity(stats))) return false;
    pending.push({ path: directory, stats, directory: true });

    let handle: Awaited<ReturnType<typeof fsPromises.opendir>> | undefined;
    let closeFailed = false;
    try {
      handle = await fsPromises.opendir(directory);
      for await (const entry of handle) {
        const childDepth = depth + 1;
        consumeOutputTreeEntry(budget, childDepth);
        const child = safeEntryPath(directory, entry.name);
        if (!child || !pathInside(root, child)) return false;
        let childStats: Stats;
        try { childStats = await lstat(child); } catch { return false; }
        if (isLinkLike(childStats)) return false;
        if (childStats.isDirectory()) {
          if (!validOutputTreeEntry(childStats, "directory")) return false;
          if (!await collectOutputTreeForDeletion(
            child,
            root,
            undefined,
            budget,
            childDepth,
            false,
            pending,
          )) return false;
        } else {
          if (!validOutputTreeEntry(childStats, "file")) return false;
          pending.push({ path: child, stats: childStats, directory: false });
        }
      }
    } catch {
      return false;
    } finally {
      try {
        await handle?.close();
      } catch (error) {
        if (!isDirectoryAlreadyClosed(error)) closeFailed = true;
      }
    }
    return !closeFailed;
  } catch {
    // An over-limit, growth, or race-unclear root is never partially selected
    // for a second deletion path; no mutation is attempted by the caller.
    return false;
  }
}

async function deleteOutputTree(
  directory: string,
  root: string,
  expectedRoot: OutputRootIdentity | undefined,
  budget: OutputTreeBudget,
  depth: number,
  countDirectory: boolean,
): Promise<boolean> {
  const pending: PendingOutputDeletion[] = [];
  if (!await collectOutputTreeForDeletion(
    directory,
    root,
    expectedRoot,
    budget,
    depth,
    countDirectory,
    pending,
  )) return false;

  // Every visible entry has now passed the complete second traversal. Recheck
  // each identity immediately before its unlink/rmdir, but do not start this
  // mutation phase until the whole validation phase has succeeded.
  for (let index = pending.length - 1; index >= 0; index--) {
    const entry = pending[index]!;
    try {
      const current = await lstat(entry.path);
      const valid = entry.directory
        ? validOutputTreeEntry(current, "directory")
        : validOutputTreeEntry(current, "file");
      if (!valid || !sameDirectoryIdentity(directoryIdentity(entry.stats), directoryIdentity(current))) {
        return false;
      }
      if (entry.directory) {
        // rmdir removes only this exact directory and never recursively follows
        // a link; children were already removed in reverse traversal order.
        await rmdir(entry.path);
      } else {
        await unlink(entry.path);
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Delete one verified root after reserving its complete second-pass budget. */
export async function deleteVerifiedOutputRoot(
  path: string,
  identity: OutputRootIdentity,
  treeEntries: number,
  global: GlobalJanitorBudget,
): Promise<boolean> {
  // The delete pass repeats complete no-link validation immediately before
  // removal. Reserve the deterministic size of that validation first so an
  // exhausted global budget can only skip a root, never stop halfway through
  // its deletion pass. The local budget still enforces the existing per-root
  // limit; a concurrent tree growth therefore fails closed.
  if (!reserveGlobalJanitorBudget(global, treeEntries)) return false;
  return deleteOutputTree(
    path,
    path,
    identity,
    { entries: 0, reservedEntries: treeEntries },
    0,
    true,
  );
}
