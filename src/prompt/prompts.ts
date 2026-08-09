/**
 * prompts.ts — System prompt builder for agents.
 *
 * Every agent gets a fresh context — no inherited parent identity.
 * EnvInfo is imported from types.ts — branch is a string (empty when unknown).
 */

import type { EnvInfo } from "../types.js";
import type { AgentConfig } from "../agents/types.js";
import {
  MAX_CHILD_SYSTEM_PROMPT_BYTES,
  utf8ByteLength,
} from "../agents/agent-string-limits.js";
import { MAX_SKILL_METADATA_PROMPT_BYTES } from "./skill-limits.js";
import type { SkillMeta } from "./skill-loader.js";

export { MAX_CHILD_SYSTEM_PROMPT_BYTES } from "../agents/agent-string-limits.js";
export { MAX_SKILL_METADATA_PROMPT_BYTES } from "./skill-limits.js";

/** Shared guidance for context-isolated child sessions. */
export const SHARED_CHILD_CONTEXT_GUIDANCE = `You do not have the parent's full conversation context. If additional context, clarification, evidence, or a decision from the parent would materially help you continue correctly, you may stop and ask for it instead of guessing.

Ask only for information you cannot reasonably obtain from your delegated prompt, existing session context, repository, or available tools. State clearly what you need and why.

The parent may resume this same session with AgentContinue. When resumed, continue from your existing work instead of restarting or repeating completed investigation.`;

/** Extra sections to inject into the system prompt (skills). */
export interface PromptExtras {
  /** Skill metadata for display (name, description, location only). */
  skillMetas?: SkillMeta[];
  /** Project context files (AGENTS.md). */
  contextFiles?: Array<{ path: string; content: string }>;
}

function appendWithinBudget(
  parts: string[],
  usedBytes: number,
  value: string,
  label: string,
  maxBytes: number,
): number {
  const nextBytes = usedBytes + utf8ByteLength(value);
  if (nextBytes > maxBytes) {
    throw new Error(`${label} exceeds the maximum of ${maxBytes} UTF-8 bytes`);
  }
  parts.push(value);
  return nextBytes;
}

function skillXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSkillMetadataPrompt(skillMetas: readonly SkillMeta[]): string {
  const parts: string[] = [];
  let usedBytes = 0;
  const append = (value: string): void => {
    usedBytes = appendWithinBudget(
      parts,
      usedBytes,
      value,
      "Skill metadata prompt",
      MAX_SKILL_METADATA_PROMPT_BYTES,
    );
  };

  append("\n\nThe following skills provide specialized instructions for specific tasks.");
  append("\nUse the read tool to load a skill's file when the task matches its description.");
  append("\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.");
  append("\n\n<available_skills>");

  // Do not select a prefix that happens to fit. Every visible metadata entry is
  // appended and charged, and the complete request fails at the first crossing
  // so callers cannot mistake a partial catalog for the requested one.
  for (const skill of skillMetas) {
    if (skill.disableModelInvocation) continue;
    append(`\n  <skill>\n    <name>${skillXml(skill.name)}</name>\n    <description>${skillXml(skill.description)}</description>\n    <location>${skillXml(skill.location)}</location>\n  </skill>`);
  }
  append("\n</available_skills>");
  return parts.join("");
}

/**
 * Build the system prompt for an agent from its config.
 *
 * The prompt base is always replaced with the extension's generic header.
 * The agent body is always included in <agent_instructions> tags. Metadata and
 * final prompt budgets are checked before this function returns, so callers
 * never receive a partial or silently shortened skill selection.
 *
 * @param config   Agent configuration.
 * @param cwd      Current working directory.
 * @param env      Environment info.
 * @param extras   Optional skill and project-context sections.
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
): string {
  const parts: string[] = [];
  let usedBytes = 0;
  const append = (value: string): void => {
    usedBytes = appendWithinBudget(
      parts,
      usedBytes,
      value,
      "Child system prompt",
      MAX_CHILD_SYSTEM_PROMPT_BYTES,
    );
  };

  const envLines = [
    "# Environment",
    `Working directory: ${cwd}`,
    env.isGitRepo ? "Git repository: yes" : "Not a git repository",
  ];
  if (env.isGitRepo && env.branch) envLines.push(`Branch: ${env.branch}`);
  envLines.push(`Platform: ${env.platform}`);
  const envBlock = envLines.join("\n");

  // Unified skill index — all skills in one <available_skills> block. Keep
  // this boundary defensive as callers may construct PromptExtras directly.
  const excludedSkillNames = new Set(config.excludeSkills ?? []);
  const skillMetas = extras?.skillMetas?.filter((skill) => !excludedSkillNames.has(skill.name));
  // Build and charge the skill section incrementally before assembling the
  // final prompt. It is appended after the role instructions below.
  const skillMetadataPrompt = skillMetas?.length
    ? buildSkillMetadataPrompt(skillMetas)
    : undefined;

  // Every agent gets the same replacement base; no parent system prompt is
  // loaded into the child session.
  const activeAgentTag = `<active_agent name="${config.name}"/>`;
  const basePrompt = `You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously.\n\n${envBlock}`;
  append(basePrompt);
  append(`\n\n${SHARED_CHILD_CONTEXT_GUIDANCE}`);

  // Project context files (AGENTS.md) — placed after the shared prefix and
  // before the role instructions.
  if (extras?.contextFiles?.length) {
    append("\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n");
    for (const file of extras.contextFiles) {
      append(`<project_instructions path="${escapeXml(file.path)}">\n`);
      append(file.content);
      append(`\n</project_instructions>\n\n`);
    }
    append("</project_context>");
  }

  // active_agent goes AFTER the shared prefix (header + env + guidance + context) for KV cache.
  append(`\n${activeAgentTag}\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`);
  if (skillMetadataPrompt !== undefined) append(skillMetadataPrompt);

  // `parts` is joined only after every segment has passed the final budget.
  return parts.join("");
}

function escapeXml(value: string): string {
  // Only escape < and > — enough for XML-like tags, keeps text readable for LLMs.
  return value
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
