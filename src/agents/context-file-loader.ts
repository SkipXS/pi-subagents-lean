/**
 * Bounded project-context loading for child prompts.
 *
 * Pi's public context helper is synchronous and has no file/ancestor budget.
 * This loader keeps its candidate precedence and root-to-cwd ordering while
 * making every filesystem read explicit, trust-aware, and race checked.
 */

import { constants as fsConstants, promises as fsPromises, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { truncateUtf8, utf8ByteLength } from "./agent-string-limits.js";

/** Pi's candidate order for one context directory. */
export const CONTEXT_FILE_NAMES = [
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

/** Maximum context directories inspected, including cwd. */
export const MAX_CONTEXT_ANCESTOR_DIRECTORIES = 64;
/** Maximum UTF-8 bytes read from one context file. */
export const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
/** Maximum UTF-8 bytes retained across one prompt's context files. */
export const MAX_CONTEXT_TOTAL_BYTES = 512 * 1024;
/** Maximum UTF-8 bytes for one supplementary-context warning. */
export const MAX_CONTEXT_WARNING_BYTES = 1024;
/** Maximum warning callbacks emitted by one context load. */
export const MAX_CONTEXT_WARNINGS = 16;

export interface ContextFile {
  path: string;
  content: string;
}

export interface LoadContextFilesOptions {
  cwd: string;
  agentDir: string;
  /** Untrusted callers receive only the global AgentDir candidate. */
  projectTrusted: boolean;
  onWarning?: (warning: string) => void;
}

interface ContextLoadState {
  totalBytes: number;
  warningCount: number;
  seenPaths: Set<string>;
  rejectedPaths: Set<string>;
}

type BoundedReadResult =
  | { kind: "ok"; content: string }
  | { kind: "oversized" }
  | { kind: "changed" };

const CONTEXT_READ_CHUNK_BYTES = 64 * 1024;
const optionalFsConstants = fsConstants as typeof fsConstants & { O_NOFOLLOW?: number };

async function readBoundedContextFile(
  filePath: string,
  before: Stats,
): Promise<BoundedReadResult> {
  let handle: fsPromises.FileHandle | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (optionalFsConstants.O_NOFOLLOW ?? 0);
    handle = await fsPromises.open(filePath, flags);
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) return { kind: "changed" };

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = MAX_CONTEXT_FILE_BYTES + 1 - totalBytes;
      if (remaining <= 0) return { kind: "oversized" };
      const chunk = Buffer.alloc(Math.min(CONTEXT_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_CONTEXT_FILE_BYTES) return { kind: "oversized" };
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { kind: "ok", content: Buffer.concat(chunks, totalBytes).toString("utf8") };
  } finally {
    try { await handle?.close(); } catch { /* post-read lstat remains authoritative */ }
  }
}

function warning(state: ContextLoadState, onWarning: ((warning: string) => void) | undefined, message: string): void {
  if (!onWarning || state.warningCount >= MAX_CONTEXT_WARNINGS) return;
  state.warningCount++;
  onWarning(truncateUtf8(message, MAX_CONTEXT_WARNING_BYTES));
}

function pathKey(filePath: string): string {
  const normalized = resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFileIdentity(before: Stats, after: Stats): boolean {
  // lstat is deliberately used on both sides: a symlink or replacement must
  // never become a trusted context file between the two observations.
  return before.isFile()
    && !before.isSymbolicLink()
    && after.isFile()
    && !after.isSymbolicLink()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.mode === after.mode;
}

async function readContextCandidate(
  directory: string,
  state: ContextLoadState,
  onWarning: ((warning: string) => void) | undefined,
): Promise<ContextFile | undefined> {
  for (const filename of CONTEXT_FILE_NAMES) {
    const filePath = join(directory, filename);
    const candidateKey = pathKey(filePath);
    if (state.seenPaths.has(candidateKey) || state.rejectedPaths.has(candidateKey)) continue;
    let before: Stats;
    try {
      before = await fsPromises.lstat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        state.rejectedPaths.add(candidateKey);
        warning(state, onWarning, `Skipping context file ${filePath}: unable to inspect it`);
      }
      continue;
    }

    if (!before.isFile() || before.isSymbolicLink()) continue;
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_CONTEXT_FILE_BYTES) {
      state.rejectedPaths.add(candidateKey);
      warning(
        state,
        onWarning,
        `Skipping context file ${filePath}: exceeds the maximum of ${MAX_CONTEXT_FILE_BYTES} UTF-8 bytes`,
      );
      continue;
    }
    if (state.totalBytes + before.size > MAX_CONTEXT_TOTAL_BYTES) {
      state.rejectedPaths.add(candidateKey);
      warning(
        state,
        onWarning,
        `Skipping context file ${filePath}: context total exceeds the maximum of ${MAX_CONTEXT_TOTAL_BYTES} UTF-8 bytes`,
      );
      continue;
    }

    let readResult: BoundedReadResult;
    try {
      readResult = await readBoundedContextFile(filePath, before);
    } catch {
      state.rejectedPaths.add(candidateKey);
      warning(state, onWarning, `Skipping context file ${filePath}: unable to read it`);
      continue;
    }
    if (readResult.kind === "changed") {
      state.rejectedPaths.add(candidateKey);
      warning(state, onWarning, `Skipping context file ${filePath}: changed during read`);
      continue;
    }
    if (readResult.kind === "oversized") {
      state.rejectedPaths.add(candidateKey);
      warning(
        state,
        onWarning,
        `Skipping context file ${filePath}: exceeds the maximum of ${MAX_CONTEXT_FILE_BYTES} UTF-8 bytes`,
      );
      continue;
    }

    const content = readResult.content;
    const contentBytes = utf8ByteLength(content);
    if (contentBytes > MAX_CONTEXT_FILE_BYTES) {
      // Defensive adapter guard; the bounded reader already stops before this
      // branch for normal filesystem reads.
      state.rejectedPaths.add(candidateKey);
      warning(
        state,
        onWarning,
        `Skipping context file ${filePath}: exceeds the maximum of ${MAX_CONTEXT_FILE_BYTES} UTF-8 bytes`,
      );
      continue;
    }
    if (state.totalBytes + contentBytes > MAX_CONTEXT_TOTAL_BYTES) {
      state.rejectedPaths.add(candidateKey);
      warning(
        state,
        onWarning,
        `Skipping context file ${filePath}: context total exceeds the maximum of ${MAX_CONTEXT_TOTAL_BYTES} UTF-8 bytes`,
      );
      continue;
    }

    let after: Stats;
    try {
      after = await fsPromises.lstat(filePath);
    } catch {
      state.rejectedPaths.add(candidateKey);
      warning(state, onWarning, `Skipping context file ${filePath}: changed during read`);
      continue;
    }
    if (!sameFileIdentity(before, after)) {
      state.rejectedPaths.add(candidateKey);
      warning(state, onWarning, `Skipping context file ${filePath}: changed during read`);
      continue;
    }

    if (state.seenPaths.has(candidateKey)) continue;
    state.seenPaths.add(candidateKey);
    state.totalBytes += contentBytes;
    return { path: filePath, content };
  }
  return undefined;
}

/**
 * Load the global candidate first, then bounded project ancestors in the same
 * root-to-cwd order as Pi's built-in context semantics. Untrusted calls
 * intentionally stop after the global candidate and never inspect cwd.
 */
export async function loadBoundedContextFiles(
  options: LoadContextFilesOptions,
): Promise<ContextFile[]> {
  const state: ContextLoadState = {
    totalBytes: 0,
    warningCount: 0,
    seenPaths: new Set(),
    rejectedPaths: new Set(),
  };
  const result: ContextFile[] = [];
  // An empty AgentDir is an explicit disabled-global sentinel, not a reason to
  // resolve the process cwd and accidentally treat project files as global.
  if (options.agentDir.length > 0) {
    const resolvedAgentDir = resolve(options.agentDir);
    const globalContext = await readContextCandidate(resolvedAgentDir, state, options.onWarning);
    if (globalContext) result.push(globalContext);
  }
  if (!options.projectTrusted) return result;

  const resolvedCwd = resolve(options.cwd);
  const ancestors: string[] = [];
  let current = resolvedCwd;
  let reachedFilesystemRoot = false;
  for (let index = 0; index < MAX_CONTEXT_ANCESTOR_DIRECTORIES; index++) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) {
      reachedFilesystemRoot = true;
      break;
    }
    current = parent;
  }
  if (!reachedFilesystemRoot) {
    warning(
      state,
      options.onWarning,
      `Skipping context ancestors beyond the maximum of ${MAX_CONTEXT_ANCESTOR_DIRECTORIES} directories`,
    );
  }

  // The bounded walk starts at cwd so it can stop without an unbounded root
  // search, then reverses only the accepted bounded list to preserve Pi order.
  for (const directory of ancestors.reverse()) {
    const context = await readContextCandidate(directory, state, options.onWarning);
    if (context) result.push(context);
  }
  return result;
}
