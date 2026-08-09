/**
 * Central UTF-8 byte limits for agent inputs and retained record projections.
 *
 * Runtime input checks are authoritative; JSON schemas may only provide an
 * earlier, code-unit-based hint. Retention helpers include the diagnostic
 * marker in their budget and never split a Unicode code point.
 */
import { Buffer } from "node:buffer";

/** Stable marker used whenever diagnostic retention drops content. */
export const TRUNCATED_TEXT_MARKER = "[TRUNCATED]";

/** Maximum UTF-8 bytes for Agent and AgentContinue prompts. */
export const MAX_AGENT_PROMPT_BYTES = 256 * 1024;
/** Maximum UTF-8 bytes for AgentContinue control identifiers. */
export const MAX_AGENT_ID_BYTES = 128;
/** Maximum UTF-8 bytes for an AgentConfig systemPrompt. */
export const MAX_AGENT_SYSTEM_PROMPT_BYTES = 512 * 1024;
/** Maximum UTF-8 bytes for the complete generated child system prompt. */
export const MAX_CHILD_SYSTEM_PROMPT_BYTES = 2 * 1024 * 1024;
export const MAX_SYSTEM_PROMPT_BYTES = MAX_CHILD_SYSTEM_PROMPT_BYTES;
/** Maximum UTF-8 bytes for one discovered Agent Markdown file. */
export const MAX_AGENT_MARKDOWN_BYTES = 512 * 1024;
/** Maximum UTF-8 bytes for a discovered or configured agent name. */
export const MAX_AGENT_NAME_BYTES = 128;
/** Maximum UTF-8 bytes for a discovered or configured model key. */
export const MAX_AGENT_MODEL_BYTES = 256;
/** Maximum entries in one Agent Markdown selection/exclusion array. */
export const MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES = 256;
/** Maximum UTF-8 bytes for one Agent Markdown selection/exclusion item. */
export const MAX_AGENT_FRONTMATTER_ITEM_BYTES = 256;
/** Maximum UTF-8 bytes for retained execution/result text. */
export const MAX_RETAINED_TEXT_BYTES = 64 * 1024;
/** Maximum UTF-8 bytes for one retained execution prompt projection. */
export const MAX_RETAINED_EXECUTION_PROMPT_BYTES = 64 * 1024;
/** Maximum UTF-8 bytes for retained record/execution errors. */
export const MAX_RETAINED_ERROR_BYTES = 8 * 1024;
/** Maximum UTF-8 bytes for retained agent descriptions. */
export const MAX_DESCRIPTION_BYTES = 8 * 1024;

// Descriptive aliases make the contract discoverable without duplicating the
// numeric configuration surface.
export const AGENT_PROMPT_MAX_BYTES = MAX_AGENT_PROMPT_BYTES;
export const MAX_AGENT_CONTINUE_PROMPT_BYTES = MAX_AGENT_PROMPT_BYTES;
export const AGENT_ID_MAX_BYTES = MAX_AGENT_ID_BYTES;
export const AGENT_SYSTEM_PROMPT_MAX_BYTES = MAX_AGENT_SYSTEM_PROMPT_BYTES;
export const AGENT_MARKDOWN_MAX_BYTES = MAX_AGENT_MARKDOWN_BYTES;
export const AGENT_NAME_MAX_BYTES = MAX_AGENT_NAME_BYTES;
export const AGENT_MODEL_MAX_BYTES = MAX_AGENT_MODEL_BYTES;
export const MAX_AGENT_SELECTION_ENTRIES = MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES;
export const MAX_AGENT_SELECTION_ITEM_BYTES = MAX_AGENT_FRONTMATTER_ITEM_BYTES;
export const RETAINED_EXECUTION_TEXT_MAX_BYTES = MAX_RETAINED_TEXT_BYTES;
export const MAX_RETAINED_RESPONSE_BYTES = MAX_RETAINED_TEXT_BYTES;
export const RETAINED_EXECUTION_PROMPT_MAX_BYTES = MAX_RETAINED_EXECUTION_PROMPT_BYTES;
export const RETAINED_ERROR_MAX_BYTES = MAX_RETAINED_ERROR_BYTES;
export const AGENT_DESCRIPTION_MAX_BYTES = MAX_DESCRIPTION_BYTES;

/** Return the exact UTF-8 byte length of a JavaScript string. */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Return a bounded UTF-8 prefix without splitting a code point.
 * The helper is also used when a caller gives a budget smaller than the marker.
 */
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let codeUnitEnd = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (used + codePointBytes > maxBytes) break;
    used += codePointBytes;
    codeUnitEnd += codePoint.length;
  }
  return value.slice(0, codeUnitEnd);
}

/**
 * Keep a diagnostic string within a UTF-8 byte budget.
 * The marker is part of the budget and is appended only when content is lost.
 */
export function truncateUtf8(
  value: string,
  maxBytes: number,
  marker = TRUNCATED_TEXT_MARKER,
): string {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : maxBytes;
  if (utf8ByteLength(value) <= limit) return value;
  if (limit <= 0) return "";

  const markerBytes = utf8ByteLength(marker);
  if (markerBytes >= limit) return utf8Prefix(marker, limit);

  return `${utf8Prefix(value, limit - markerBytes)}${marker}`;
}

/** Retain one execution/result text projection. */
export function retainAgentText(value: string): string {
  return truncateUtf8(value, MAX_RETAINED_TEXT_BYTES);
}

/** Retain one error projection, preserving a diagnostic marker when needed. */
export function retainAgentError(value: string | undefined): string | undefined {
  return value === undefined ? undefined : truncateUtf8(value, MAX_RETAINED_ERROR_BYTES);
}

/** Retain one agent description projection. */
export function retainAgentDescription(value: string): string {
  return truncateUtf8(value, MAX_DESCRIPTION_BYTES);
}

/** Return whether a string fits an authoritative UTF-8 byte bound. */
export function isUtf8WithinLimit(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8ByteLength(value) <= maxBytes;
}

/** Return whether a discovered/configured role name is bounded. */
export function isAgentNameWithinLimit(value: unknown): value is string {
  return isUtf8WithinLimit(value, MAX_AGENT_NAME_BYTES);
}

/** Return whether a discovered/configured model key is bounded. */
export function isAgentModelWithinLimit(value: unknown): value is string {
  return isUtf8WithinLimit(value, MAX_AGENT_MODEL_BYTES);
}

/** Retain the prompt projection stored in an execution summary. */
export function retainExecutionPrompt(value: string): string {
  return truncateUtf8(value, MAX_RETAINED_EXECUTION_PROMPT_BYTES);
}

/** Return a stable control-ID error, or undefined when the UTF-8 limit is satisfied. */
export function validateAgentId(value: unknown, label = "agent_id"): string | undefined {
  if (typeof value !== "string" || value.length === 0) return `${label} is required`;
  if (utf8ByteLength(value) > MAX_AGENT_ID_BYTES) {
    return `${label} exceeds the maximum of ${MAX_AGENT_ID_BYTES} UTF-8 bytes`;
  }
  return value.trim() === "" ? `${label} is required` : undefined;
}

/** Throw before any record lookup, prefix reflection, or render hydration. */
export function assertAgentId(value: unknown, label = "agent_id"): asserts value is string {
  const error = validateAgentId(value, label);
  if (error) throw new Error(error);
}

/** Return a stable input error, or undefined when the UTF-8 limit is satisfied. */
export function validateAgentPrompt(value: unknown, label = "Agent prompt"): string | undefined {
  if (typeof value !== "string") return `${label} is required`;
  return utf8ByteLength(value) <= MAX_AGENT_PROMPT_BYTES
    ? undefined
    : `${label} exceeds the maximum of ${MAX_AGENT_PROMPT_BYTES} UTF-8 bytes (256 KiB)`;
}

/** Return a stable AgentConfig systemPrompt size error, if any. */
export function validateAgentSystemPrompt(value: unknown): string | undefined {
  // Legacy/headless catalog doubles may omit the field; the typed production
  // AgentConfig always supplies it. Only a present non-string is malformed.
  if (value === undefined) return undefined;
  if (typeof value !== "string") return "AgentConfig systemPrompt is required";
  return utf8ByteLength(value) <= MAX_AGENT_SYSTEM_PROMPT_BYTES
    ? undefined
    : `AgentConfig systemPrompt exceeds the maximum of ${MAX_AGENT_SYSTEM_PROMPT_BYTES} UTF-8 bytes (512 KiB)`;
}

/** Throw when a prompt would cross the authoritative runtime input boundary. */
export function assertAgentPrompt(value: unknown, label = "Agent prompt"): asserts value is string {
  const error = validateAgentPrompt(value, label);
  if (error) throw new Error(error);
}

/** Throw when an accepted AgentConfig contains an oversized system prompt. */
export function assertAgentSystemPrompt(value: unknown): asserts value is string {
  const error = value === undefined
    ? "AgentConfig systemPrompt is required"
    : validateAgentSystemPrompt(value);
  if (error) throw new Error(error);
}
