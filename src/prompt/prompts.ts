/**
 * prompts.ts — System prompt builder for agents.
 *
 * Every agent gets a fresh context — no inherited parent identity.
 * EnvInfo is imported from types.ts — branch is a string (empty when unknown).
 */

import type { EnvInfo } from "../types.js";
import type { AgentConfig } from "../agents/types.js";
import type { SkillMeta } from "./skill-loader.js";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

/** Extra sections to inject into the system prompt (skills). */
export interface PromptExtras {
  /** Skill metadata for display (name, description, location only). */
  skillMetas?: SkillMeta[];
  /** Project context files (AGENTS.md). */
  contextFiles?: Array<{ path: string; content: string }>;
}

/**
 * Build the system prompt for an agent from its config.
 *
 * The prompt base is always replaced with the extension's generic header.
 * The agent body is always included in <agent_instructions> tags.
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
  const envLines = [
    "# Environment",
    `Working directory: ${cwd}`,
    env.isGitRepo ? "Git repository: yes" : "Not a git repository",
  ];
  if (env.isGitRepo && env.branch) {
    envLines.push(`Branch: ${env.branch}`);
  }
  envLines.push(`Platform: ${env.platform}`);
  const envBlock = envLines.join("\n");

  // Unified skill index — all skills in one <available_skills> block. Keep
  // this boundary defensive as callers may construct PromptExtras directly.
  const excludedSkillNames = new Set(config.excludeSkills ?? []);
  const skillMetas = extras?.skillMetas?.filter((skill) => !excludedSkillNames.has(skill.name));
  const hasSkills = skillMetas?.length;
  let extrasSuffix = "";
  if (hasSkills) {
    const skillLines: string[] = [];

    // Location-based skills: use Pi's formatSkillsForPrompt for XML escaping and
    // disable-model-invocation filtering, then extract the <skill> elements.
    if (skillMetas?.length) {
      const piSkills: Skill[] = skillMetas.map((m) => ({
        name: m.name,
        description: m.description,
        filePath: m.location,
        baseDir: "",
        sourceInfo: {} as any,
        disableModelInvocation: m.disableModelInvocation,
      }));
      const formatted = formatSkillsForPrompt(piSkills);
      const skillElements = formatted.match(/<skill>[\s\S]*?<\/skill>/g);
      if (skillElements) skillLines.push(...skillElements);
    }

    const lines = [
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
      ...skillLines,
      "</available_skills>",
    ];
    extrasSuffix = `\n\n${lines.join("\n")}`;
  }

  // Agent's own system prompt wrapped in <agent_instructions> tags
  const agentInstructions = `\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`;

  // Project context files (AGENTS.md) — placed after agent_instructions, before extras
  let contextSuffix = "";
  if (extras?.contextFiles?.length) {
    const lines = [
      "<project_context>",
      "",
      "Project-specific instructions and guidelines:",
      "",
    ];
    for (const file of extras.contextFiles) {
      lines.push(`<project_instructions path="${escapeXml(file.path)}">`);
      lines.push(file.content);
      lines.push(`</project_instructions>`);
      lines.push("");
    }
    lines.push("</project_context>");
    contextSuffix = `\n\n${lines.join("\n")}`;
  }

  // Every agent gets the same replacement base; no parent prompt is loaded
  // into the child session.
  const activeAgentTag = `<active_agent name="${config.name}"/>`;
  const basePrompt = `You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously.\n\n${envBlock}`;

  // active_agent goes AFTER shared prefix (header + env + context) for KV cache
  return `${basePrompt}${contextSuffix}\n${activeAgentTag}\n${agentInstructions}${extrasSuffix}`;
}

function escapeXml(value: string): string {
  // Only escape < and > — enough for XML-like tags, keeps text readable for LLMs
  return value
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
