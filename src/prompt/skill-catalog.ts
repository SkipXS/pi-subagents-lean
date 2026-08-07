/**
 * Skill catalog composition: trusted project ancestors, global user skills,
 * and Pi defaults merged with stable precedence and canonical deduplication.
 */

import { opendirSync, promises as fsPromises, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, type Skill } from "@earendil-works/pi-coding-agent";
import {
  cloneSkill,
  createSkillCatalogBudget,
  loadPiDefaultSkillsCached,
  loadPiDefaultSkillsCachedAsync,
  loadSkillsFromDirCached,
  loadSkillsFromDirCachedAsync,
  type SkillCatalogBudget,
} from "./skill-cache.js";
import {
  createPiSkillLoaderWorkerAdapter,
  type PiSkillLoaderRunner,
} from "./skill-loader-worker.js";
import { MAX_RESOURCE_FINGERPRINT_ENTRIES } from "./skill-fingerprint.js";
import { MAX_SKILLS_TOTAL } from "./skill-limits.js";

/** Maximum ancestor `.agents/skills` roots included in one catalog. */
export const MAX_ANCESTOR_SKILL_ROOTS = 64;

function isDirectoryAlreadyClosed(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ERR_DIR_CLOSED";
}

/**
 * Load all skills in precedence order. Ancestor and global agent roots use the
 * exported directory loader; Pi defaults retain Pi's combined-loader call.
 */
export function loadAllSkills(cwd: string, projectTrusted = true): Skill[] {
  const resolvedCwd = resolve(cwd);
  const ancestorsSkills = projectTrusted ? loadAncestorAgentsSkills(resolvedCwd) : [];
  const homeAgentsDir = join(homedir(), ".agents", "skills");
  const homeAgentsSkills = filterRootMdFiles(
    loadSkillsFromDirCached(homeAgentsDir, "agents"),
    homeAgentsDir,
  );
  const defaultsSkills = loadPiDefaultSkillsCached(
    resolvedCwd,
    getAgentDir(),
    projectTrusted,
  );

  return mergeSkills([...ancestorsSkills, ...homeAgentsSkills, ...defaultsSkills]);
}

/**
 * Async catalog path. It mirrors loadAllSkills while keeping all filesystem
 * traversal promise-based and routing Pi's synchronous work through one worker.
 */
export async function loadAllSkillsAsync(
  cwd: string,
  projectTrusted = true,
): Promise<Skill[]> {
  const workerAdapter = createPiSkillLoaderWorkerAdapter();
  try {
    const resolvedCwd = resolve(cwd);
    const skillBudget = createSkillCatalogBudget();
    const ancestorsSkills = projectTrusted
      ? await loadAncestorAgentsSkillsAsync(resolvedCwd, workerAdapter.run, skillBudget)
      : [];
    const homeAgentsDir = join(homedir(), ".agents", "skills");
    const homeAgentsSkills = filterRootMdFiles(
      await loadSkillsFromDirCachedAsync(homeAgentsDir, "agents", workerAdapter.run, skillBudget),
      homeAgentsDir,
    );
    const defaultsSkills = await loadPiDefaultSkillsCachedAsync(
      resolvedCwd,
      getAgentDir(),
      projectTrusted,
      workerAdapter.run,
      skillBudget,
    );

    return await mergeSkillsAsync([...ancestorsSkills, ...homeAgentsSkills, ...defaultsSkills]);
  } finally {
    await workerAdapter.close();
  }
}

function assertSkillCatalogSize(count: number): void {
  if (count > MAX_SKILLS_TOTAL) {
    throw new Error(`Skill catalog exceeds the maximum of ${MAX_SKILLS_TOTAL} skills`);
  }
}

function mergeSkills(skills: Skill[]): Skill[] {
  assertSkillCatalogSize(skills.length);
  const nameSet = new Set<string>();
  const realPathSet = new Set<string>();
  const result: Skill[] = [];

  for (const skill of skills) {
    const realPath = canonicalizePath(skill.filePath);
    if (realPathSet.has(realPath) || nameSet.has(skill.name)) continue;
    nameSet.add(skill.name);
    realPathSet.add(realPath);
    result.push(cloneSkill(skill));
  }
  return result;
}

async function mergeSkillsAsync(skills: Skill[]): Promise<Skill[]> {
  assertSkillCatalogSize(skills.length);
  const canonicalPaths = await Promise.all(skills.map((skill) => canonicalizePathAsync(skill.filePath)));
  const nameSet = new Set<string>();
  const realPathSet = new Set<string>();
  const result: Skill[] = [];

  for (const [index, skill] of skills.entries()) {
    const realPath = canonicalPaths[index]!;
    if (realPathSet.has(realPath) || nameSet.has(skill.name)) continue;
    nameSet.add(skill.name);
    realPathSet.add(realPath);
    result.push(cloneSkill(skill));
  }
  return result;
}

function loadAncestorAgentsSkills(resolvedCwd: string): Skill[] {
  const result: Skill[] = [];
  let dir = resolvedCwd;

  for (let index = 0; index < MAX_ANCESTOR_SKILL_ROOTS; index++) {
    const agentsSkillsDir = join(dir, ".agents", "skills");
    result.push(...filterRootMdFiles(
      loadSkillsFromDirCached(agentsSkillsDir, "agents"),
      agentsSkillsDir,
    ));
    // Match Pi's stop-at-git-root behavior, but do not search ancestors
    // without a hard bound when a caller is outside a repository.
    if (directoryContainsGitSync(dir)) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return result;
}

async function loadAncestorAgentsSkillsAsync(
  resolvedCwd: string,
  runPiSkillLoader: PiSkillLoaderRunner,
  skillBudget: SkillCatalogBudget,
): Promise<Skill[]> {
  const result: Skill[] = [];
  let dir = resolvedCwd;

  for (let index = 0; index < MAX_ANCESTOR_SKILL_ROOTS; index++) {
    const agentsSkillsDir = join(dir, ".agents", "skills");
    result.push(...filterRootMdFiles(
      await loadSkillsFromDirCachedAsync(agentsSkillsDir, "agents", runPiSkillLoader, skillBudget),
      agentsSkillsDir,
    ));
    if (await directoryContainsGitAsync(dir)) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return result;
}

/** .agents/skills uses subdirectory skills, not root Markdown files. */
export function filterRootMdFiles(skills: Skill[], skillsRoot: string): Skill[] {
  const normalizedRoot = resolve(skillsRoot);
  return skills.filter((skill) => resolve(skill.filePath, "..") !== normalizedRoot);
}

function directoryContainsGitSync(directoryPath: string): boolean {
  let directory: ReturnType<typeof opendirSync> | undefined;
  let entries = 0;
  try {
    directory = opendirSync(directoryPath);
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries++;
      // A git marker found early is enough; otherwise stop at the same hard
      // directory-entry bound used by skill fingerprints.
      if (entry.name === ".git") return true;
      if (entries >= MAX_RESOURCE_FINGERPRINT_ENTRIES) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      directory?.closeSync();
    } catch (error) {
      if (!isDirectoryAlreadyClosed(error)) { /* inaccessible ancestor */ }
    }
  }
}

async function directoryContainsGitAsync(directoryPath: string): Promise<boolean> {
  let directory: Awaited<ReturnType<typeof fsPromises.opendir>> | undefined;
  let entries = 0;
  try {
    directory = await fsPromises.opendir(directoryPath);
    for await (const entry of directory) {
      entries++;
      if (entry.name === ".git") return true;
      if (entries >= MAX_RESOURCE_FINGERPRINT_ENTRIES) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      await directory?.close();
    } catch (error) {
      if (!isDirectoryAlreadyClosed(error)) { /* inaccessible ancestor */ }
    }
  }
}

function canonicalizePath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

async function canonicalizePathAsync(filePath: string): Promise<string> {
  try {
    return await fsPromises.realpath(filePath);
  } catch {
    return filePath;
  }
}
