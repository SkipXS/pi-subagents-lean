/** Shared filesystem and path invariants for the output-log security boundary. */

import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const optionalFsConstants = fsConstants as typeof fsConstants & {
  O_NOFOLLOW?: number;
  O_DIRECTORY?: number;
};

export const OUTPUT_DIRECTORY_MODE = 0o700;
export const OUTPUT_FILE_MODE = 0o600;
export const OUTPUT_O_NOFOLLOW = optionalFsConstants.O_NOFOLLOW;
export const OUTPUT_O_DIRECTORY = optionalFsConstants.O_DIRECTORY ?? 0;
export const OUTPUT_DIRECTORY_FD_PREFIX = process.platform === "linux"
  ? "/proc/self/fd"
  : process.platform === "darwin" || process.platform.endsWith("bsd")
    ? "/dev/fd"
    : undefined;
export const POSIX_DESCRIPTOR_IO = process.platform !== "win32";

export interface OutputRootIdentity {
  dev: number;
  ino: number;
}

export function directoryIdentity(stats: { dev: number; ino: number }): OutputRootIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

export function sameDirectoryIdentity(left: OutputRootIdentity, right: OutputRootIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function isLinkLike(stats: Pick<Stats, "isSymbolicLink">): boolean {
  if (stats.isSymbolicLink()) return true;
  // Node currently reports Windows junctions as symbolic links through lstat.
  // Keep this defensive branch for hosts that expose a native reparse-point
  // predicate without making it part of the public Stats type.
  const reparse = (stats as unknown as { isReparsePoint?: () => boolean }).isReparsePoint;
  return typeof reparse === "function" && reparse();
}

export function hasPrivatePosixMetadata(
  stats: Pick<Stats, "uid" | "mode">,
  kind: "directory" | "file",
): boolean {
  if (process.platform === "win32") return true;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined || stats.uid !== uid) return false;
  const mode = stats.mode & 0o777;
  return kind === "directory" ? mode === OUTPUT_DIRECTORY_MODE : mode === OUTPUT_FILE_MODE;
}

export function hasUsableIdentity(stats: { dev: number; ino: number }): boolean {
  return Number.isFinite(stats.dev)
    && Number.isFinite(stats.ino)
    && (stats.dev !== 0 || stats.ino !== 0);
}

export function safeEntryPath(parent: string, name: string): string | undefined {
  if (
    !name
    || name === "."
    || name === ".."
    || name.includes("/")
    || (process.platform === "win32" && name.includes("\\"))
  ) return undefined;
  const child = resolve(parent, name);
  const childRelative = relative(resolve(parent), child);
  if (
    !childRelative
    || childRelative.startsWith("..")
    || isAbsolute(childRelative)
    || childRelative.includes("/")
    || (process.platform === "win32" && childRelative.includes("\\"))
  ) return undefined;
  return child;
}

export function pathInside(root: string, child: string): boolean {
  const childRelative = relative(resolve(root), resolve(child));
  return Boolean(
    childRelative
    && !childRelative.startsWith("..")
    && !isAbsolute(childRelative)
    && !childRelative.split(/[\\/]/u).includes(".."),
  );
}

export function validOutputTreeEntry(
  stats: Stats,
  kind: "directory" | "file",
): boolean {
  if (isLinkLike(stats)) return false;
  if (kind === "directory" && !stats.isDirectory()) return false;
  if (kind === "file" && (!stats.isFile() || stats.nlink !== 1)) return false;
  return hasPrivatePosixMetadata(stats, kind);
}
