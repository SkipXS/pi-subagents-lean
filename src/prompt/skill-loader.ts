/**
 * Async skill metadata facade used by prompts and agent runners.
 *
 * Catalog composition, source fingerprints/caches, and the Pi worker transport
 * live in focused modules; metadata discovery never blocks the parent thread.
 */

import type { Skill } from "@earendil-works/pi-coding-agent";
import { loadAllSkillsAsync } from "./skill-catalog.js";

export { loadAllSkillsAsync };
export {
  MAX_SERIALIZED_WORKER_SKILLS,
  MAX_SKILLS_TOTAL,
  MAX_SKILL_METADATA_PAYLOAD_BYTES,
  MAX_SKILL_METADATA_PROMPT_BYTES,
  MAX_SKILL_RESULT_BYTES,
  MAX_SERIALIZED_SKILL_METADATA_BYTES,
} from "./skill-limits.js";

export interface SkillMeta {
  name: string;
  description: string;
  location: string;
  /** Whether the skill should be excluded from the <available_skills> prompt block. */
  disableModelInvocation: boolean;
}

function toSkillMeta(name: string, match: Skill | undefined): SkillMeta {
  if (!match) {
    return {
      name,
      description: `(Skill "${name}" not found)`,
      location: "",
      disableModelInvocation: false,
    };
  }
  return {
    name,
    description: match.description,
    location: match.filePath,
    disableModelInvocation: match.disableModelInvocation,
  };
}

function selectSkillNames(skillNames: string[], excludeSkills?: string[]): string[] {
  const excluded = new Set(excludeSkills ?? []);
  return skillNames.filter((name) => !excluded.has(name));
}

export type SkillSelection = true | string[];

/**
 * Bounded async metadata path used by the runner. Both explicit lists and
 * `true` (all-skills mode) use the catalog/worker path; no caller needs to
 * invoke Pi's synchronous loader on the foreground event loop.
 */
export async function loadSkillMetaAsync(
  skillNames: string[] | true,
  cwd: string,
  excludeSkills?: string[],
  projectTrusted = true,
): Promise<SkillMeta[]> {
  const explicitNames = skillNames === true ? undefined : selectSkillNames(skillNames, excludeSkills);
  if (explicitNames && explicitNames.length === 0) return [];
  const catalog = await loadAllSkillsAsync(cwd, projectTrusted);
  const selectedNames = explicitNames ?? catalog.map((skill) => skill.name);
  if (selectedNames.length === 0) return [];
  const skillsByName = new Map(catalog.map((skill) => [skill.name, skill]));
  return selectedNames
    .filter((name) => !(excludeSkills ?? []).includes(name))
    .map((name) => toSkillMeta(name, skillsByName.get(name)));
}
