/**
 * Resource limits for skill metadata crossing the Pi worker boundary.
 *
 * Pi follows the Agent Skills shape (64-character names and 1,024-character
 * descriptions). Runtime checks use UTF-8 byte limits so structured-clone and
 * cache retention cannot be expanded by multibyte input. Paths use a separate
 * practical bound for long Windows and package paths.
 */

import type { Skill } from "@earendil-works/pi-coding-agent";
import { utf8ByteLength } from "../agents/agent-string-limits.js";

/** Maximum number of skills in one serialized worker result and catalog merge. */
export const MAX_SERIALIZED_WORKER_SKILLS = 10_000;
/** Descriptive catalog-wide alias for the same hard total. */
export const MAX_SKILLS_TOTAL = MAX_SERIALIZED_WORKER_SKILLS;
/** Maximum UTF-8 bytes in one serialized skill metadata result. */
export const MAX_SKILL_METADATA_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** Maximum UTF-8 bytes in the generated available-skills metadata section. */
export const MAX_SKILL_METADATA_PROMPT_BYTES = 1 * 1024 * 1024;
/** Stable aliases for callers that describe these boundaries explicitly. */
export const MAX_SKILL_PROMPT_BYTES = MAX_SKILL_METADATA_PROMPT_BYTES;
/** Stable aliases for callers that describe this boundary as a result. */
export const MAX_SKILL_RESULT_BYTES = MAX_SKILL_METADATA_PAYLOAD_BYTES;
export const MAX_SERIALIZED_SKILL_METADATA_BYTES = MAX_SKILL_METADATA_PAYLOAD_BYTES;
/** Agent Skills name limit (names are lowercase ASCII in the standard). */
export const MAX_SKILL_NAME_BYTES = 64;
/** Agent Skills description limit expressed as a UTF-8 byte budget. */
export const MAX_SKILL_DESCRIPTION_BYTES = 1024;
/** Practical UTF-8 byte limit for a skill file or base directory path. */
export const MAX_SKILL_PATH_BYTES = 4 * 1024;

function invalidSkillResult(context: string, index?: number): Error {
  const suffix = index === undefined ? "" : ` at index ${index}`;
  return new Error(`${context} returned invalid skill metadata${suffix}`);
}

function assertBoundedString(
  value: unknown,
  field: string,
  maxBytes: number,
  context: string,
  index: number,
): asserts value is string {
  if (typeof value !== "string") throw invalidSkillResult(context, index);
  if (utf8ByteLength(value) > maxBytes) {
    throw new Error(
      `${context} skill ${index} ${field} exceeds the maximum of ${maxBytes} UTF-8 bytes`,
    );
  }
}

function boundedTransportSkill(skill: Partial<Skill>): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    sourceInfo: skill.sourceInfo,
    disableModelInvocation: skill.disableModelInvocation,
  };
}

function serializedSkillBytes(value: Record<string, unknown>, context: string, index: number): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidSkillResult(context, index);
  }
  if (encoded === undefined) throw invalidSkillResult(context, index);
  return utf8ByteLength(encoded);
}

/**
 * Validate a complete Pi skill result before any caller can publish it into a
 * source cache. The payload budget is accumulated one metadata object at a
 * time so validating a 10,000-skill result never duplicates the complete
 * array with a second `JSON.stringify` allocation.
 *
 * Oversized identifiers are rejected rather than truncated so a different
 * skill cannot be manufactured by a lossy boundary.
 */
export function assertBoundedSkillResult(
  value: unknown,
  context = "Pi skill loader",
): asserts value is Skill[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} returned an invalid skill result`);
  }
  if (value.length > MAX_SERIALIZED_WORKER_SKILLS) {
    throw new Error(
      `${context} returned too many skills: maximum ${MAX_SERIALIZED_WORKER_SKILLS} skills`,
    );
  }

  // Include the JSON array brackets, then add each object and separator as it
  // is validated. This is the exact UTF-8 size of the metadata array that the
  // worker transports, without materializing a duplicate whole-result string.
  let payloadBytes = 2;
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") {
      throw invalidSkillResult(context, index);
    }
    const skill = candidate as Partial<Skill>;
    assertBoundedString(skill.name, "name", MAX_SKILL_NAME_BYTES, context, index);
    assertBoundedString(
      skill.description,
      "description",
      MAX_SKILL_DESCRIPTION_BYTES,
      context,
      index,
    );
    assertBoundedString(skill.filePath, "filePath path", MAX_SKILL_PATH_BYTES, context, index);
    assertBoundedString(skill.baseDir, "baseDir path", MAX_SKILL_PATH_BYTES, context, index);
    if (!skill.sourceInfo || typeof skill.sourceInfo !== "object") {
      throw invalidSkillResult(context, index);
    }
    if (typeof skill.disableModelInvocation !== "boolean") {
      throw invalidSkillResult(context, index);
    }

    // SourceInfo is retained for Pi's normal metadata semantics. Only its
    // optional path fields need the same transport bound; test/host adapters
    // may legitimately provide a minimal metadata object.
    const sourceInfo = skill.sourceInfo as { path?: unknown; baseDir?: unknown };
    if (sourceInfo.path !== undefined) {
      assertBoundedString(sourceInfo.path, "sourceInfo path", MAX_SKILL_PATH_BYTES, context, index);
    }
    if (sourceInfo.baseDir !== undefined) {
      assertBoundedString(sourceInfo.baseDir, "sourceInfo baseDir path", MAX_SKILL_PATH_BYTES, context, index);
    }

    const itemBytes = serializedSkillBytes(boundedTransportSkill(skill), context, index);
    const nextBytes = payloadBytes + itemBytes + (index === 0 ? 0 : 1);
    if (nextBytes > MAX_SKILL_METADATA_PAYLOAD_BYTES) {
      throw new Error(
        `${context} metadata payload exceeds the maximum of ${MAX_SKILL_METADATA_PAYLOAD_BYTES} UTF-8 bytes at skill ${index}`,
      );
    }
    payloadBytes = nextBytes;
  }
}
