/**
 * utils.ts — Security helpers and general utilities.
 *
 * Security helpers (isUnsafeName, isSymlink, safeReadFile) protect against
 * path traversal and symlink attacks in agent/skill name resolution.
 */

import { lstatSync, readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./types.js";
import { truncateUtf8, utf8ByteLength } from "./agents/agent-string-limits.js";

export { TRUNCATED_TEXT_MARKER, truncateUtf8, utf8ByteLength } from "./agents/agent-string-limits.js";

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  return !name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Returns true if the given path is a symlink (defense against symlink attacks).
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Safely read a file, rejecting symlinks.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
  try {
    if (isSymlink(filePath)) return undefined;
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/** All valid thinking levels. */
export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

/**
 * Validate and narrow a raw string value to ThinkingLevel.
 * Returns undefined if the value is not a valid thinking level.
 */
export function parseThinkingLevel(raw: unknown): ThinkingLevel | undefined {
  return typeof raw === "string" && VALID_THINKING_LEVELS.includes(raw as ThinkingLevel)
    ? raw as ThinkingLevel
    : undefined;
}

/**
 * Safely extract a human-readable error message from an unknown exception.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Clone JSON-shaped metadata while capping only its string fields. Arrays and
 * plain records retain their keys/order/shape; other values pass through.
 */
export function capUtf8Strings<T>(value: T, maxBytes: number): T {
  return capUtf8StringsInternal(value, maxBytes, new WeakMap<object, unknown>()) as T;
}

/**
 * Clone JSON-shaped metadata while sharing one UTF-8 budget across all string
 * fields. This is used for a message's secondary details object so a large
 * result cannot be retained a second time there.
 */
export function capUtf8StringsToBudget<T>(value: T, maxBytes: number): T {
  const state = {
    remaining: Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : maxBytes,
  };
  return capUtf8StringsWithinBudget(value, state, new WeakMap<object, unknown>()) as T;
}

function capUtf8StringsInternal(
  value: unknown,
  maxBytes: number,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") return truncateUtf8(value, maxBytes);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(capUtf8StringsInternal(item, maxBytes, seen));
    return copy;
  }
  if (!isPlainRecord(value)) return value;

  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = capUtf8StringsInternal(value[key], maxBytes, seen);
  }
  return copy;
}

function capUtf8StringsWithinBudget(
  value: unknown,
  state: { remaining: number },
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") {
    if (utf8ByteLength(value) <= state.remaining) {
      state.remaining -= utf8ByteLength(value);
      return value;
    }
    const bounded = truncateUtf8(value, state.remaining);
    state.remaining = Math.max(0, state.remaining - utf8ByteLength(bounded));
    return bounded;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(capUtf8StringsWithinBudget(item, state, seen));
    return copy;
  }
  if (!isPlainRecord(value)) return value;

  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = capUtf8StringsWithinBudget(value[key], state, seen);
  }
  return copy;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Parse a "provider/model-id" string into { provider, modelId }.
 * Returns null if the format is invalid (no slash or empty provider).
 */
export function parseModelKey(modelStr: string): { provider: string; modelId: string } | null {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx <= 0) return null;
  return { provider: modelStr.slice(0, slashIdx), modelId: modelStr.slice(slashIdx + 1) };
}

/**
 * Find a model in the registry by "provider/model-id" string.
 * Returns the found model, or the fallback if the string is unparseable or not in registry.
 */
export function findModelInRegistry(
  modelStr: string | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined },
  fallback: Model<any> | undefined,
): Model<any> | undefined {
  if (!modelStr) return fallback;
  const parsed = parseModelKey(modelStr);
  if (!parsed) return fallback;
  return registry.find(parsed.provider, parsed.modelId) ?? fallback;
}

/** Max length for a truncated command in tool argument summaries. */
const MAX_COMMAND_DISPLAY_LENGTH = 350;

/** Max length for a truncated string value in default tool argument summaries. */
const MAX_DEFAULT_STRING_DISPLAY_LENGTH = 350;

/**
 * Summarize tool arguments for log-friendly, non-visual output.
 *
 * Heavy tools (read, write, edit, bash, grep, rg) get compact summaries.
 * Other tools fall back to the default JSON formatting.
 */
export function summarizeToolArgs(name: string, rawArgs: Record<string, unknown> | undefined): string {
  if (!rawArgs || typeof rawArgs !== "object" || Object.keys(rawArgs).length === 0) return "";

  switch (name) {
    case "read": {
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      return `(${JSON.stringify(path)})`;
    }
    case "write": {
      const path = typeof rawArgs.file_path === "string" ? rawArgs.file_path : "";
      const content = rawArgs.content;
      const size = typeof content === "string" ? content.length : 0;
      return `(${JSON.stringify(path)}, ${size} chars)`;
    }
    case "edit": {
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      const edits = rawArgs.edits;
      const editCount = Array.isArray(edits) ? edits.length : 0;
      return `(${JSON.stringify(path)}, ${editCount} edits)`;
    }
    case "bash": {
      const cmd = typeof rawArgs.command === "string" ? rawArgs.command : "";
      const heredocIdx = cmd.search(/<<\s*['\"]?\w+['\"]?/);
      const cleanCmd = heredocIdx >= 0 ? cmd.slice(0, heredocIdx).trim() : cmd.trim();
      const display = cleanCmd.length > MAX_COMMAND_DISPLAY_LENGTH
        ? cleanCmd.slice(0, MAX_COMMAND_DISPLAY_LENGTH) + "…" : cleanCmd;
      return `(${JSON.stringify(display)})`;
    }
    case "grep":
    case "rg": {
      const pattern = typeof rawArgs.pattern === "string" ? rawArgs.pattern : "";
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      return `(${JSON.stringify(pattern)}, ${JSON.stringify(path)})`;
    }
    default: {
      const keys = Object.keys(rawArgs);
      if (keys.length === 1) {
        const val = rawArgs[keys[0]!];
        const display = typeof val === "string" && val.length > MAX_DEFAULT_STRING_DISPLAY_LENGTH
          ? JSON.stringify(val.slice(0, MAX_DEFAULT_STRING_DISPLAY_LENGTH) + "...")
          : JSON.stringify(val);
        return `(${display})`;
      }
      return ` ${JSON.stringify(rawArgs)}`;
    }
  }
}

/** Timeout for git commands (ms). Shared by agent-runner and worktree-validator. */
export const GIT_EXEC_TIMEOUT_MS = 5000;
