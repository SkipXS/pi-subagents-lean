/**
 * Agent Markdown frontmatter parsing.
 *
 * This parser intentionally handles the flat YAML subset used by agent
 * definitions. Nested YAML structures and complex values are not part of the
 * agent file format.
 */

import type { ThinkingLevel } from "../types.js";
import { parseThinkingLevel } from "../utils.js";
import {
  isAgentModelWithinLimit,
  isUtf8WithinLimit,
  MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES,
  MAX_AGENT_FRONTMATTER_ITEM_BYTES,
  MAX_AGENT_MODEL_BYTES,
  MAX_AGENT_NAME_BYTES,
  MAX_AGENT_SYSTEM_PROMPT_BYTES,
  retainAgentDescription,
} from "./agent-string-limits.js";

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

/**
 * Split a Markdown file into its flat frontmatter fields and body.
 *
 * Handles triple-dash delimited frontmatter blocks, flat key/value pairs, and
 * YAML array syntax (lines starting with "- ").
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

  // Check for triple-dash delimited frontmatter.
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }

  // Find the closing delimiter.
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

    // Skip empty lines.
    if (!trimmed) continue;

    // Array item (continuation of the previous key).
    if (trimmed.startsWith("- ")) {
      if (currentKey) {
        if (!currentValues) currentValues = [];
        currentValues.push(trimmed.slice(2).trim());
      }
      continue;
    }

    // Flush a previous array before processing a new key.
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
      // It may be followed by array items.
      currentValues = [];
      continue;
    }

    // Strip surrounding quotes if present (YAML convention).
    frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, "");
    currentValues = null;
  }

  // Flush trailing array items.
  if (currentKey && currentValues) {
    frontmatter[currentKey] = currentValues;
  }

  return { frontmatter, body };
}

/** Split a comma-separated string while bounding selection metadata. */
function splitCommaList(value: string): string[] | undefined {
  const parts = value
    .split(",")
    .map((s) => s.trim().replace(/^\[|\]$/g, "").trim())
    .filter((s) => s.length > 0);
  return boundedStringArray(parts);
}

/** Keep frontmatter arrays finite before a parsed definition reaches a cache. */
function boundedStringArray(values: readonly unknown[]): string[] | undefined {
  if (values.length > MAX_AGENT_FRONTMATTER_ARRAY_ENTRIES) return undefined;
  const result: string[] = [];
  for (const value of values) {
    const item = String(value).trim();
    if (item.length === 0 || !isUtf8WithinLimit(item, MAX_AGENT_FRONTMATTER_ITEM_BYTES)) {
      return undefined;
    }
    result.push(item);
  }
  return result;
}

/**
 * Parse the extensions/skills/tools selection field.
 *
 * false / "false" / "none" → false; true / "true" / "all" → true;
 * comma-separated strings and arrays become string arrays.
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
    return boundedStringArray(raw);
  }
  return undefined;
}

/** Extract a non-empty, UTF-8-bounded string value from frontmatter. */
function parseString(
  frontmatter: Record<string, unknown>,
  key: string,
  maxBytes = MAX_AGENT_FRONTMATTER_ITEM_BYTES,
): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.length > 0 && isUtf8WithinLimit(value, maxBytes)
    ? value
    : undefined;
}

/** Extract a bounded string array from an array or comma-separated value. */
function parseStringArray(
  frontmatter: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return boundedStringArray(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return splitCommaList(value);
  }
  return undefined;
}

/** Extract a boolean from a boolean or string frontmatter value. */
function parseBoolean(
  frontmatter: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = frontmatter[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

/** Parse a single agent Markdown file into its raw discovery config. */
export function parseAgentFile(
  content: string,
  source: "default" | "user" | "project",
): AgentConfigFromMd {
  const { frontmatter, body } = parseFrontmatter(content);

  return {
    // Names and model keys are identifiers, so oversized values are rejected
    // rather than truncated into a different role/model.
    name: (() => {
      const value = parseString(frontmatter, "name", MAX_AGENT_NAME_BYTES)?.trim();
      return value && isUtf8WithinLimit(value, MAX_AGENT_NAME_BYTES) ? value : undefined;
    })(),
    description: (() => {
      const value = frontmatter.description;
      return typeof value === "string" && value.length > 0
        ? retainAgentDescription(value)
        : undefined;
    })(),
    tools: parseExtensions(frontmatter.tools),
    exclude_tools: parseStringArray(frontmatter, "exclude_tools"),
    extensions: parseExtensions(frontmatter.extensions),
    exclude_extensions: parseStringArray(frontmatter, "exclude_extensions"),
    skills: parseExtensions(frontmatter.skills),
    exclude_skills: parseStringArray(frontmatter, "exclude_skills"),
    model: (() => {
      const value = parseString(frontmatter, "model", MAX_AGENT_MODEL_BYTES);
      return value !== undefined && isAgentModelWithinLimit(value) ? value : undefined;
    })(),
    thinking: parseThinkingLevel(parseString(frontmatter, "thinking", 64)),
    hidden: parseBoolean(frontmatter, "hidden"),
    // An absent body is not an override: retain a lower-precedence prompt.
    systemPrompt: body && isUtf8WithinLimit(body, MAX_AGENT_SYSTEM_PROMPT_BYTES)
      ? body
      : undefined,
    source,
  };
}
