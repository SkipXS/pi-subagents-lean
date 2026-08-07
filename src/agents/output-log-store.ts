/**
 * output-log-store.ts — secure roots, paths, and descriptor-based file I/O.
 *
 * Security boundary: private roots, safe agent-id path segments, descriptor-
 * relative POSIX writes, and post-open identity checks on Windows. Root markers
 * and persistent retention live in output-log-retention.ts; this module keeps
 * the established facade exports for existing callers.
 */

import { lstat, mkdir, open as openFile } from "node:fs/promises";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  OUTPUT_DIRECTORY_FD_PREFIX,
  OUTPUT_DIRECTORY_MODE,
  OUTPUT_FILE_MODE,
  OUTPUT_O_DIRECTORY,
  OUTPUT_O_NOFOLLOW,
  POSIX_DESCRIPTOR_IO,
  directoryIdentity,
  hasUsableIdentity,
  isLinkLike,
  sameDirectoryIdentity,
  samePath,
  type OutputRootIdentity,
} from "./output-log-constants.js";
import {
  createActiveRootMarker,
  MAX_OUTPUT_ROOTS,
  MAX_OUTPUT_ROOT_RETENTION_BYTES,
  MAX_OUTPUT_ROOT_ENTRIES,
  MAX_OUTPUT_ROOT_DEPTH,
  MAX_OUTPUT_PARENT_ENTRIES,
  MAX_OUTPUT_GLOBAL_PASS_ENTRIES,
  MAX_OUTPUT_JANITOR_PASS_ENTRIES,
  MAX_OUTPUT_GLOBAL_ENTRIES,
  OUTPUT_ROOT_MAX_AGE_MS,
  OUTPUT_ROOT_PREFIX,
  registerOutputRoot,
  releaseActiveOutputRoot,
  releaseOutputRootMarker as releaseRetentionOutputRootMarker,
  scheduleOutputRootCleanup,
} from "./output-log-retention.js";

// Keep the established retention API at this facade for internal callers/tests.
export {
  cleanupOutputRoots,
  MAX_OUTPUT_ROOTS,
  MAX_OUTPUT_ROOT_RETENTION_BYTES,
  MAX_OUTPUT_ROOT_ENTRIES,
  MAX_OUTPUT_ROOT_DEPTH,
  MAX_OUTPUT_PARENT_ENTRIES,
  MAX_OUTPUT_GLOBAL_PASS_ENTRIES,
  MAX_OUTPUT_JANITOR_PASS_ENTRIES,
  MAX_OUTPUT_GLOBAL_ENTRIES,
  OUTPUT_ROOT_MAX_AGE_MS,
  OUTPUT_ROOT_PREFIX,
  scheduleOutputRootCleanup,
} from "./output-log-retention.js";
export type {
  OutputPathCanonicalizer,
  OutputRootCleanupOptions,
  OutputRootCleanupResult,
} from "./output-log-retention.js";
export type { OutputRootIdentity } from "./output-log-constants.js";

/** Identities of roots created by this module, used to reject root exchange. */
const outputRootIdentities = new Map<string, OutputRootIdentity>();

/**
 * The identity captured for a log immediately after its exclusive create.
 * `nlink` is intentionally retained with dev/ino: an otherwise identical
 * inode is unsafe once it has acquired a second hard link.
 */
interface OutputFileIdentity extends OutputRootIdentity {
  nlink: number;
}

const outputFileIdentities = new Map<string, OutputFileIdentity>();

function outputFileKey(filePath: string): string {
  const normalized = resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function outputRootKey(root: string): string {
  const normalized = resolve(root);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function fileIdentity(stats: { dev: number; ino: number; nlink: number }): OutputFileIdentity {
  return { dev: stats.dev, ino: stats.ino, nlink: stats.nlink };
}

function hasAcceptableFileIdentity(stats: {
  isFile: () => boolean;
  isSymbolicLink?: () => boolean;
  dev: number;
  ino: number;
  nlink?: number;
}): boolean {
  return stats.isFile()
    && !(stats.isSymbolicLink?.() ?? false)
    && hasUsableIdentity(stats)
    // A log is private to its selected path. nlink !== 1 means either a
    // hardlink swap or that the original log has been linked elsewhere.
    && stats.nlink === 1;
}

function sameOutputFileIdentity(
  expected: OutputFileIdentity,
  actual: { dev: number; ino: number; nlink?: number },
): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && actual.nlink === 1;
}

function rememberOutputFileIdentity(filePath: string, stats: {
  isFile: () => boolean;
  isSymbolicLink?: () => boolean;
  dev: number;
  ino: number;
  nlink: number;
}): void {
  if (!hasAcceptableFileIdentity(stats)) {
    throw new Error("Output log file does not expose a private stable identity");
  }
  outputFileIdentities.set(outputFileKey(filePath), fileIdentity(stats));
}

export function releaseOutputFileIdentities(root: string): void {
  const rootKey = resolve(root);
  for (const filePath of outputFileIdentities.keys()) {
    if (samePath(dirname(filePath), rootKey)) outputFileIdentities.delete(filePath);
  }
}

function directoryOpenFlags(): number {
  if (POSIX_DESCRIPTOR_IO && OUTPUT_O_NOFOLLOW === undefined) {
    throw new Error("Secure output directory no-follow is unavailable");
  }
  if (POSIX_DESCRIPTOR_IO && OUTPUT_DIRECTORY_FD_PREFIX === undefined) {
    throw new Error("Secure descriptor-relative output is unavailable");
  }
  return constants.O_RDONLY | OUTPUT_O_DIRECTORY | (OUTPUT_O_NOFOLLOW ?? 0);
}

function fileOpenFlags(append: boolean): number {
  const base = append
    ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  return base | (OUTPUT_O_NOFOLLOW ?? 0);
}

function rememberOutputRootIdentity(root: string, stats: { dev: number; ino: number }): void {
  if (!hasUsableIdentity(stats)) {
    throw new Error("Output filesystem does not expose a stable file identity");
  }
  outputRootIdentities.set(outputRootKey(root), directoryIdentity(stats));
}

/**
 * Assert the identity relationship required by the Windows path-based fallback.
 * This pure boundary is also used by deterministic tests when native junctions
 * are unavailable on the host.
 */
export function assertWindowsOpenedFileIdentity(
  opened: Pick<Stats, "isFile" | "isSymbolicLink" | "dev" | "ino"> & { nlink?: number },
  named: Pick<Stats, "isFile" | "isSymbolicLink" | "dev" | "ino"> & { nlink?: number },
  directory: Pick<Stats, "isDirectory" | "isSymbolicLink" | "dev" | "ino">,
  expectedRoot: OutputRootIdentity | undefined,
): void {
  // Check the root first so a root exchange is never hidden by incomplete
  // metadata from a stale/opened file object.
  if (!directory.isDirectory() || isLinkLike(directory)) {
    throw new Error("Output log root was exchanged");
  }
  if (!expectedRoot || !sameDirectoryIdentity(expectedRoot, directoryIdentity(directory))) {
    throw new Error("Output log root was exchanged");
  }
  if (
    !opened.isFile()
    || !named.isFile()
    || isLinkLike(named)
    || !hasUsableIdentity(opened)
    || opened.nlink !== 1
    || named.nlink !== 1
    || !sameDirectoryIdentity(directoryIdentity(opened), directoryIdentity(named))
  ) {
    throw new Error("Output log file was exchanged");
  }
}

export async function releaseOutputRootMarker(root: string): Promise<void> {
  const normalized = resolve(root);
  await releaseRetentionOutputRootMarker(normalized, outputRootIdentities.get(outputRootKey(normalized)));
}

export function releaseOutputRootIdentity(root: string): void {
  const normalized = resolve(root);
  outputRootIdentities.delete(outputRootKey(normalized));
  releaseOutputFileIdentities(normalized);
  releaseActiveOutputRoot(normalized, isCanonicalOutputRoot(normalized));
}

/**
 * Create a fresh private output root. `mkdtempSync` publishes a newly-created
 * directory rather than opening a predictable/pre-existing path. POSIX mode
 * enforcement uses an opened directory descriptor; Windows inherits the
 * isolation/ACL behavior of the OS temporary directory without a portable
 * DACL claim.
 */
let resolvedOutputTempParent: string | undefined;

function exactOutputTempParentSync(): string {
  if (resolvedOutputTempParent) return resolvedOutputTempParent;
  const parent = resolve(realpathSync(tmpdir()));
  const stats = lstatSync(parent);
  if (!stats.isDirectory() || isLinkLike(stats)) {
    throw new Error("OS temporary directory is not a real directory");
  }
  resolvedOutputTempParent = parent;
  return parent;
}

function resolveOutputRootParent(parentDir: string | undefined): string {
  // Production roots are always placed under the canonical OS temp parent.
  // Explicit parents remain supported for isolated tests and hosts that need
  // to supply an already-selected fixture directory.
  const selected = parentDir === undefined ? exactOutputTempParentSync() : resolve(parentDir);
  try {
    return resolve(realpathSync(selected));
  } catch {
    // mkdtempSync gives the caller the same fail-closed behavior as before if
    // an explicit fixture parent does not exist or is not accessible.
    return selected;
  }
}

function isCanonicalOutputRoot(root: string): boolean {
  try {
    return samePath(dirname(root), exactOutputTempParentSync());
  } catch {
    return false;
  }
}

export function createOutputRoot(parentDir?: string): string {
  const parent = resolveOutputRootParent(parentDir);
  const root = resolve(mkdtempSync(join(parent, OUTPUT_ROOT_PREFIX)));
  if (!POSIX_DESCRIPTOR_IO) {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || isLinkLike(stats)) throw new Error("Output root is not a directory");
    rememberOutputRootIdentity(root, stats);
    createActiveRootMarker(root);
    registerOutputRoot(root, isCanonicalOutputRoot(root));
    return root;
  }

  let fd: number | undefined;
  try {
    fd = openSync(root, directoryOpenFlags());
    const stats = fstatSync(fd);
    if (!stats.isDirectory() || isLinkLike(stats)) throw new Error("Output root is not a directory");
    fchmodSync(fd, OUTPUT_DIRECTORY_MODE);
    rememberOutputRootIdentity(root, stats);
    createActiveRootMarker(root);
    registerOutputRoot(root, isCanonicalOutputRoot(root));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return root;
}

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeAgentId(agentId: string): void {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID.test(agentId)) {
    throw new Error("Invalid agent id for output log path");
  }
}

/** Resolve an absolute log path without opening the log file itself. */
export function resolveOutputFilePath(agentId: string, baseDir?: string): string {
  assertSafeAgentId(agentId);
  const dir = resolve(baseDir ?? createOutputRoot());
  const path = resolve(dir, `${agentId}.log`);
  // The agent id is a single safe segment, so this check documents and
  // enforces that callers cannot escape the selected private root.
  if (dirname(path) !== dir) throw new Error("Output log path escaped its root");
  return path;
}

async function ensureOutputDirectory(directory: string): Promise<void> {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || isLinkLike(stats)) {
      throw new Error("Output log directory is not a private directory");
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // A single non-recursive mkdir prevents following a pre-existing link.
  await mkdir(directory, { mode: OUTPUT_DIRECTORY_MODE });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || isLinkLike(stats)) {
    throw new Error("Output log directory is not a private directory");
  }
}

async function openOutputDirectory(directory: string): Promise<FileHandle | undefined> {
  await ensureOutputDirectory(directory);

  if (!POSIX_DESCRIPTOR_IO) {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || isLinkLike(stats)) {
      throw new Error("Output log directory is not a private directory");
    }
    const root = resolve(directory);
    const expected = outputRootIdentities.get(outputRootKey(root));
    if (expected && !sameDirectoryIdentity(expected, directoryIdentity(stats))) {
      throw new Error("Output log root was exchanged");
    }
    if (!expected) rememberOutputRootIdentity(root, stats);
    return undefined;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await openFile(directory, directoryOpenFlags());
    const stats = await handle.stat();
    if (!stats.isDirectory()) throw new Error("Output log directory is not a directory");
    const expected = outputRootIdentities.get(outputRootKey(directory));
    if (expected && !sameDirectoryIdentity(expected, directoryIdentity(stats))) {
      throw new Error("Output log root was exchanged");
    }
    await handle.chmod(OUTPUT_DIRECTORY_MODE);
    return handle;
  } catch (err) {
    try { await handle?.close(); } catch { /* preserve the secure-open error */ }
    throw err;
  }
}

function descriptorRelativePath(path: string, directory: FileHandle): string {
  if (!OUTPUT_DIRECTORY_FD_PREFIX) throw new Error("Secure descriptor-relative output is unavailable");
  return join(OUTPUT_DIRECTORY_FD_PREFIX, String(directory.fd), basename(path));
}

/** Reject an observable link before the Windows path-based open. */
async function rejectWindowsLinkedFile(path: string): Promise<void> {
  if (POSIX_DESCRIPTOR_IO) return;
  try {
    const stats = await lstat(path);
    if (isLinkLike(stats)) throw new Error("Output log path is a link");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Verify the opened log against the identity captured at exclusive create.
 * This runs for both descriptor-relative POSIX I/O and the Windows fallback:
 * descriptor-relative opens prevent root traversal, but they do not by
 * themselves reject a hardlink replacement of the final log path.
 */
async function verifyOpenedOutputFile(
  path: string,
  file: FileHandle,
  append: boolean,
): Promise<void> {
  const [opened, named, directory] = await Promise.all([
    file.stat(),
    lstat(path),
    lstat(dirname(path)),
  ]);
  const expectedRoot = outputRootIdentities.get(outputRootKey(dirname(path)));
  if (!POSIX_DESCRIPTOR_IO) {
    assertWindowsOpenedFileIdentity(opened, named, directory, expectedRoot);
  } else if (
    !directory.isDirectory()
    || isLinkLike(directory)
    || (expectedRoot && !sameDirectoryIdentity(expectedRoot, directoryIdentity(directory)))
  ) {
    throw new Error("Output log root was exchanged");
  }

  if (!hasAcceptableFileIdentity(opened) || !hasAcceptableFileIdentity(named)) {
    throw new Error("Output log file was exchanged");
  }
  if (!sameDirectoryIdentity(directoryIdentity(opened), directoryIdentity(named))) {
    throw new Error("Output log file was exchanged");
  }

  if (append) {
    const expected = outputFileIdentities.get(outputFileKey(path));
    if (!expected || !sameOutputFileIdentity(expected, opened)) {
      throw new Error("Output log file was exchanged");
    }
  } else {
    // Only an O_EXCL create may establish the baseline. Never let an append or
    // an externally pre-existing file populate the identity map.
    rememberOutputFileIdentity(path, opened);
  }
}

/** Open and use one output file through the secure boundary. */
async function withOutputFile(
  path: string,
  append: boolean,
  operation: (file: FileHandle) => Promise<void>,
): Promise<void> {
  const directory = await openOutputDirectory(dirname(path));
  let file: FileHandle | undefined;
  try {
    await rejectWindowsLinkedFile(path);
    const openPath = directory ? descriptorRelativePath(path, directory) : path;
    file = await openFile(openPath, fileOpenFlags(append), OUTPUT_FILE_MODE);
    await verifyOpenedOutputFile(path, file, append);
    await file.chmod(OUTPUT_FILE_MODE);
    await operation(file);
    await file.chmod(OUTPUT_FILE_MODE);
  } finally {
    try { await file?.close(); } catch { /* best-effort logging */ }
    try { await directory?.close(); } catch { /* best-effort logging */ }
  }
}

/** Open and close the selected directory, preserving queued path setup. */
export async function ensureOutputDirectoryForPath(path: string): Promise<void> {
  const directory = await openOutputDirectory(dirname(path));
  try { await directory?.close(); } catch { /* best-effort logging */ }
}

/** Write one complete content chunk with create-exclusive or append semantics. */
export async function writeOutputFile(path: string, append: boolean, content: string): Promise<void> {
  await withOutputFile(path, append, (file) => file.writeFile(content, { encoding: "utf8" }));
}
