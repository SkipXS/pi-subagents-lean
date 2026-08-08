/**
 * Skill catalog composition: trusted project ancestors, global user skills,
 * and Pi defaults merged with stable precedence and canonical deduplication.
 */

import { promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, type Skill } from "@earendil-works/pi-coding-agent";
import {
  cloneSkill,
  createSkillCatalogBudget,
  loadPiDefaultSkillsCachedAsync,
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

interface SkillCatalogSnapshot {
  resolvedCwd: string;
  agentDir: string;
  resolvedAgentDir: string;
  homeAgentsDir: string;
  projectTrusted: boolean;
}

const inFlightSkillCatalogLoads = new Map<string, Promise<Skill[]>>();

function isDirectoryAlreadyClosed(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ERR_DIR_CLOSED";
}

/**
 * Async catalog path. It composes the trusted ancestor, global, and Pi source
 * roots with promise-based traversal and one detached worker for Pi loading.
 */
export async function loadAllSkillsAsync(
  cwd: string,
  projectTrusted = true,
): Promise<Skill[]> {
  const snapshot = captureSkillCatalogSnapshot(cwd, projectTrusted);
  const key = skillCatalogSnapshotKey(snapshot);
  const existing = inFlightSkillCatalogLoads.get(key);
  if (existing) return existing.then(cloneSkills);

  const loading = loadAllSkillsAsyncUncached(snapshot);
  inFlightSkillCatalogLoads.set(key, loading);
  const clearIfCurrent = (): void => {
    if (inFlightSkillCatalogLoads.get(key) === loading) inFlightSkillCatalogLoads.delete(key);
  };
  void loading.then(clearIfCurrent, clearIfCurrent);
  return loading.then(cloneSkills);
}

function captureSkillCatalogSnapshot(cwd: string, projectTrusted: boolean): SkillCatalogSnapshot {
  const agentDir = getAgentDir();
  return {
    resolvedCwd: resolve(cwd),
    agentDir,
    resolvedAgentDir: resolve(agentDir),
    homeAgentsDir: resolve(join(homedir(), ".agents", "skills")),
    projectTrusted,
  };
}

function skillCatalogSnapshotKey(snapshot: SkillCatalogSnapshot): string {
  return JSON.stringify([
    snapshot.resolvedCwd,
    snapshot.agentDir,
    snapshot.resolvedAgentDir,
    snapshot.homeAgentsDir,
    snapshot.projectTrusted,
  ]);
}

function cloneSkills(skills: readonly Skill[]): Skill[] {
  return skills.map(cloneSkill);
}

async function loadAllSkillsAsyncUncached(snapshot: SkillCatalogSnapshot): Promise<Skill[]> {
  const workerAdapter = createPiSkillLoaderWorkerAdapter();
  try {
    const skillBudget = createSkillCatalogBudget();
    const ancestorsSkills = snapshot.projectTrusted
      ? await loadAncestorAgentsSkillsAsync(snapshot.resolvedCwd, workerAdapter.run, skillBudget)
      : [];
    const homeAgentsSkills = filterRootMdFiles(
      await loadSkillsFromDirCachedAsync(snapshot.homeAgentsDir, "agents", workerAdapter.run, skillBudget),
      snapshot.homeAgentsDir,
    );
    const defaultsSkills = await loadPiDefaultSkillsCachedAsync(
      snapshot.resolvedCwd,
      snapshot.agentDir,
      snapshot.projectTrusted,
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

async function canonicalizePathAsync(filePath: string): Promise<string> {
  try {
    return await fsPromises.realpath(filePath);
  } catch {
    return filePath;
  }
}
