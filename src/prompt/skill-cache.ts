/**
 * Bounded, detached skill-source caches used by the async catalog.
 *
 * A cache entry is reusable only when its complete resource-tree fingerprint is
 * stable. Stored Skill objects are cloned both on insertion and on return so a
 * caller cannot mutate a later warm lookup.
 */

import type { Skill } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import {
  fingerprintResourceTreeAsync,
  ResourceFingerprintLimitError,
  type ResourceFingerprint,
} from "./skill-fingerprint.js";
import { assertBoundedSkillResult, MAX_SKILLS_TOTAL } from "./skill-limits.js";
import type { PiSkillLoaderRunner } from "./skill-loader-worker.js";

/** Shared catalog budget used to bound the aggregate result across roots. */
export interface SkillCatalogBudget {
  remaining: number;
}

export function createSkillCatalogBudget(): SkillCatalogBudget {
  return { remaining: MAX_SKILLS_TOTAL };
}

function assertSkillBudgetAvailable(
  budget: SkillCatalogBudget | undefined,
  candidateCount: number,
  root: string,
): void {
  if (candidateCount > MAX_SKILLS_TOTAL) {
    throw new Error(`Skill catalog exceeds the maximum of ${MAX_SKILLS_TOTAL} skills for root "${root}"`);
  }
  if (budget && candidateCount > budget.remaining) {
    throw new Error(`Skill catalog exceeds the maximum of ${MAX_SKILLS_TOTAL} skills`);
  }
}

function reserveSkillBudget(
  budget: SkillCatalogBudget | undefined,
  candidateCount: number,
  root: string,
): void {
  assertSkillBudgetAvailable(budget, candidateCount, root);
  if (budget) budget.remaining -= candidateCount;
}

function assertPostLoadFingerprint(
  root: string,
  before: ResourceFingerprint,
  after: ResourceFingerprint,
): void {
  // An unstable pre-snapshot is intentionally not cached (matching the
  // existing broken-descendant behavior). A previously stable snapshot that
  // changes while Pi is reading is a race and must never be published.
  if (before.stable && (!after.stable || after.value !== before.value)) {
    throw new Error(`Skill source changed during Pi discovery: ${root}`);
  }
}

function sourceFingerprintOptions(source: string): {
  allowRootMarkdown: boolean;
  countRootMarkdown: boolean;
} {
  // Pi's `.agents/skills` source is intentionally filtered to nested skills.
  // Pi still reads direct root Markdown while discovering that source, so those
  // files participate in the per-file and aggregate byte limits even though
  // they do not consume the published catalog skill quota.
  return { allowRootMarkdown: true, countRootMarkdown: source !== "agents" };
}

function catalogSkillCount(skills: readonly Skill[], source: string, root: string): number {
  if (source !== "agents") return skills.length;
  const normalizedRoot = resolve(root);
  return skills.reduce((count, skill) => {
    const isDirectMarkdown = resolve(skill.filePath, "..") === normalizedRoot
      && skill.filePath.endsWith(".md");
    return count + (isDirectMarkdown ? 0 : 1);
  }, 0);
}

export interface CachedSkills {
  fingerprint: string;
  skills: Skill[];
}

export const MAX_SKILL_DIRECTORY_CACHE_ENTRIES = 128;
export const MAX_PI_DEFAULT_SKILL_CACHE_ENTRIES = 128;

const skillDirectoryCache = new Map<string, CachedSkills>();
const piDefaultSkillCache = new Map<string, CachedSkills>();

export function cloneSkill(skill: Skill): Skill {
  // Retain only the public Skill metadata that crosses the worker/cache
  // boundary. This keeps host-added enumerable fields from bypassing the
  // validated payload budget or being duplicated into every warm cache hit.
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    sourceInfo: { ...skill.sourceInfo },
    disableModelInvocation: skill.disableModelInvocation,
  };
}

function getSkillCacheEntry(
  cache: Map<string, CachedSkills>,
  key: string,
): CachedSkills | undefined {
  const entry = cache.get(key);
  if (entry !== undefined) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

function setSkillCacheEntry(
  cache: Map<string, CachedSkills>,
  key: string,
  value: CachedSkills,
  limit: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function loadSkillsFromDirCachedAsync(
  dir: string,
  source: string,
  runPiSkillLoader: PiSkillLoaderRunner,
  skillBudget?: SkillCatalogBudget,
): Promise<Skill[]> {
  const resolvedDir = resolve(dir);
  const key = `${source}\0${resolvedDir}`;
  const fingerprintOptions = sourceFingerprintOptions(source);
  let fingerprint: Awaited<ReturnType<typeof fingerprintResourceTreeAsync>>;
  try {
    fingerprint = await fingerprintResourceTreeAsync(resolvedDir, fingerprintOptions);
  } catch (error) {
    if (error instanceof ResourceFingerprintLimitError) skillDirectoryCache.delete(key);
    throw error;
  }
  // The fingerprint is a pre-worker upper-bound check. Consume the shared
  // catalog budget only after the actual detached result is known, otherwise
  // a loader that returns fewer entries would permanently over-reserve it.
  assertSkillBudgetAvailable(skillBudget, fingerprint.skillCount, resolvedDir);
  const cached = getSkillCacheEntry(skillDirectoryCache, key);
  if (fingerprint.stable && cached?.fingerprint === fingerprint.value) {
    reserveSkillBudget(
      skillBudget,
      catalogSkillCount(cached.skills, source, resolvedDir),
      resolvedDir,
    );
    return cached.skills.map(cloneSkill);
  }

  let skills: Skill[];
  try {
    const loaded = await runPiSkillLoader("loadSkillsFromDir", {
      dir: resolvedDir,
      source,
    });
    assertBoundedSkillResult(loaded);
    const after = await fingerprintResourceTreeAsync(resolvedDir, fingerprintOptions);
    assertPostLoadFingerprint(resolvedDir, fingerprint, after);
    if (loaded.length > MAX_SKILLS_TOTAL) {
      throw new Error(`Skill catalog exceeds the maximum of ${MAX_SKILLS_TOTAL} skills`);
    }
    reserveSkillBudget(
      skillBudget,
      catalogSkillCount(loaded, source, resolvedDir),
      resolvedDir,
    );
    skills = loaded.map(cloneSkill);
  } catch (error) {
    skillDirectoryCache.delete(key);
    throw error;
  }
  if (fingerprint.stable) {
    setSkillCacheEntry(skillDirectoryCache, key, {
      fingerprint: fingerprint.value,
      skills: skills.map(cloneSkill),
    }, MAX_SKILL_DIRECTORY_CACHE_ENTRIES);
  } else {
    skillDirectoryCache.delete(key);
  }
  return skills.map(cloneSkill);
}

export async function loadPiDefaultSkillsCachedAsync(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
  runPiSkillLoader: PiSkillLoaderRunner,
  skillBudget?: SkillCatalogBudget,
): Promise<Skill[]> {
  const resolvedCwd = resolve(cwd);
  const resolvedAgentDir = resolve(agentDir);
  const sourceRoots = projectTrusted
    ? [join(agentDir, "skills"), join(resolvedCwd, ".pi", "skills")]
    : [join(agentDir, "skills")];
  const key = `${resolvedAgentDir}\0${resolvedCwd}\0${projectTrusted ? "trusted" : "untrusted"}`;
  let rootFingerprints: Awaited<ReturnType<typeof fingerprintResourceTreeAsync>>[];
  try {
    rootFingerprints = await Promise.all(
      sourceRoots.map((root) => fingerprintResourceTreeAsync(root, { allowRootMarkdown: true })),
    );
  } catch (error) {
    if (error instanceof ResourceFingerprintLimitError) piDefaultSkillCache.delete(key);
    throw error;
  }
  const fingerprint = JSON.stringify([
    resolvedCwd,
    resolvedAgentDir,
    projectTrusted,
    ...rootFingerprints.map((entry) => entry.value),
  ]);
  const fingerprintSkillCount = rootFingerprints.reduce((sum, entry) => sum + entry.skillCount, 0);
  assertSkillBudgetAvailable(skillBudget, fingerprintSkillCount, resolvedCwd);
  const cached = getSkillCacheEntry(piDefaultSkillCache, key);
  if (rootFingerprints.every((entry) => entry.stable) && cached?.fingerprint === fingerprint) {
    reserveSkillBudget(skillBudget, cached.skills.length, resolvedCwd);
    return cached.skills.map(cloneSkill);
  }

  let skills: Skill[];
  try {
    if (projectTrusted) {
      const loaded = await runPiSkillLoader("loadSkills", {
        cwd: resolvedCwd,
        // Preserve Pi's path verbatim. Resolving a Windows-style configured
        // path on POSIX would incorrectly prefix the current working directory.
        agentDir,
        skillPaths: [],
        includeDefaults: true,
      });
      assertBoundedSkillResult(loaded);
      reserveSkillBudget(skillBudget, loaded.length, resolvedCwd);
      const after = await Promise.all(
        sourceRoots.map((root) => fingerprintResourceTreeAsync(root, { allowRootMarkdown: true })),
      );
      rootFingerprints.forEach((before, index) => assertPostLoadFingerprint(sourceRoots[index]!, before, after[index]!));
      skills = loaded.map(cloneSkill);
    } else {
      skills = await loadSkillsFromDirCachedAsync(
        join(agentDir, "skills"),
        "user",
        runPiSkillLoader,
        skillBudget,
      );
    }
  } catch (error) {
    piDefaultSkillCache.delete(key);
    throw error;
  }
  if (rootFingerprints.every((entry) => entry.stable)) {
    setSkillCacheEntry(piDefaultSkillCache, key, {
      fingerprint,
      skills: skills.map(cloneSkill),
    }, MAX_PI_DEFAULT_SKILL_CACHE_ENTRIES);
  } else {
    piDefaultSkillCache.delete(key);
  }
  return skills.map(cloneSkill);
}
