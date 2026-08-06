/**
 * skill-loader.ts — Load skills using Pi's exported APIs.
 *
 * Aligns skill discovery with Pi so subagents see the same skills as the parent session.
 *
 * Roots, in precedence order (first match wins by name):
 *   1. Ancestor .agents/skills (cwd → git root, root .md files filtered out)
 *   2. ~/.agents/skills (root .md files filtered out)
 *   3. Pi's user agent directory skills (Pi's user default)
 *   4. <cwd>/.pi/skills (Pi's project default)
 *
 * Pi's loadSkills handles: .gitignore/.ignore/.fdignore, symlinks (follow +
 * canonical-path dedup), YAML frontmatter, name validation.
 *
 * loadSkillsFromDir handles the same for individual .agents/skills directories.
 * Root .md files from .agents/skills are filtered out because Pi's "agents"
 * mode (no root files) is not exported.
 */

import { lstatSync, realpathSync, readdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  getAgentDir,
  loadSkills,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
export interface SkillMeta {
  name: string;
  description: string;
  location: string;
  /** Whether the skill should be excluded from the <available_skills> prompt block. */
  disableModelInvocation: boolean;
}

interface ResourceFingerprint {
  value: string;
  stable: boolean;
}

interface CachedSkills {
  fingerprint: string;
  skills: Skill[];
}

/**
 * Cache each Pi discovery source independently. A source cache never exposes
 * its stored Skill objects directly; callers receive detached snapshots so a
 * worktree or prompt build cannot mutate a parent/source catalog.
 */
const skillDirectoryCache = new Map<string, CachedSkills>();
const piDefaultSkillCache = new Map<string, CachedSkills>();
const MAX_SKILL_DIRECTORY_CACHE_ENTRIES = 128;
const MAX_PI_DEFAULT_SKILL_CACHE_ENTRIES = 128;

/** Keep active source hits hot while bounding process-wide path retention. */
function getSkillCacheEntry(cache: Map<string, CachedSkills>, key: string): CachedSkills | undefined {
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

function cloneSkill(skill: Skill): Skill {
  return {
    ...skill,
    sourceInfo: { ...skill.sourceInfo },
  };
}

function statFingerprint(filePath: string, stats: Stats): string {
  const type = stats.isDirectory()
    ? "directory"
    : stats.isFile()
      ? "file"
      : stats.isSymbolicLink()
        ? "symlink"
        : "other";
  return JSON.stringify([
    resolve(filePath),
    type,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
    stats.mode,
    stats.ino,
  ]);
}

/**
 * Fingerprint a resource root without reading resource contents. The listing
 * is sorted and records path/type/size/mtime plus conservative replacement and
 * permission markers. Symlink targets are included because Pi follows them.
 * A missing root is stable (and therefore a cacheable negative result); races
 * or access failures are unstable and force a fresh Pi discovery next time.
 */
function fingerprintResourceTree(root: string): ResourceFingerprint {
  const resolvedRoot = resolve(root);
  const records: string[] = [];
  const visitedDirectories = new Set<string>();
  let stable = true;

  const missingRoot = (current: string, isRoot: boolean): void => {
    if (!isRoot) stable = false;
    records.push(JSON.stringify([resolve(current), "missing"]));
  };

  const visitDirectory = (current: string, relativeRoot: string): void => {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = realpathSync(current);
    } catch {
      stable = false;
      return;
    }
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    // Include the resolved directory as well as the requested path so a
    // retargeted cwd/worktree symlink cannot reuse an unrelated catalog with
    // identical child metadata.
    records.push(JSON.stringify([relativeRoot, "directory-target", canonicalDirectory]));

    let entries: Array<{ name: string }>;
    try {
      entries = readdirSync(current, { withFileTypes: true }) as Array<{ name: string }>;
    } catch {
      stable = false;
      return;
    }
    entries
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .forEach((name) => visit(join(current, name), `${relativeRoot}/${name}`));
  };

  const visit = (current: string, relativePath: string, isRoot = false): void => {
    let stats: Stats;
    try {
      stats = lstatSync(current) as Stats;
    } catch {
      missingRoot(current, isRoot);
      return;
    }

    records.push(statFingerprint(current, stats));
    if (stats.isSymbolicLink()) {
      let target: string;
      let targetStats: Stats;
      try {
        target = realpathSync(current);
        targetStats = statSync(current) as Stats;
      } catch {
        stable = false;
        return;
      }
      records.push(JSON.stringify([relativePath, "target", target, statFingerprint(target, targetStats)]));
      if (targetStats.isDirectory()) visitDirectory(current, relativePath);
      return;
    }
    if (stats.isDirectory()) visitDirectory(current, relativePath);
  };

  visit(resolvedRoot, ".", true);
  return { value: JSON.stringify([resolvedRoot, records]), stable };
}

function loadSkillsFromDirCached(dir: string, source: string): Skill[] {
  const resolvedDir = resolve(dir);
  const fingerprint = fingerprintResourceTree(resolvedDir);
  const key = `${source}\0${resolvedDir}`;
  const cached = getSkillCacheEntry(skillDirectoryCache, key);
  if (fingerprint.stable && cached?.fingerprint === fingerprint.value) {
    return cached.skills.map(cloneSkill);
  }

  const result = loadSkillsFromDir({ dir: resolvedDir, source });
  const skills = result.skills.map(cloneSkill);
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

function loadPiDefaultSkillsCached(cwd: string, agentDir: string): Skill[] {
  const resolvedCwd = resolve(cwd);
  const resolvedAgentDir = resolve(agentDir);
  const sourceRoots = [
    join(agentDir, "skills"),
    join(resolvedCwd, ".pi", "skills"),
  ];
  const rootFingerprints = sourceRoots.map(fingerprintResourceTree);
  const fingerprint = JSON.stringify([
    resolvedCwd,
    resolvedAgentDir,
    ...rootFingerprints.map((entry) => entry.value),
  ]);
  const key = `${resolvedAgentDir}\0${resolvedCwd}`;
  const cached = getSkillCacheEntry(piDefaultSkillCache, key);
  if (rootFingerprints.every((entry) => entry.stable) && cached?.fingerprint === fingerprint) {
    return cached.skills.map(cloneSkill);
  }

  const result = loadSkills({
    cwd: resolvedCwd,
    // Preserve Pi's path verbatim. Resolving a Windows-style mocked/configured
    // path on POSIX would incorrectly prefix the current working directory.
    agentDir,
    skillPaths: [],
    includeDefaults: true,
  });
  const skills = result.skills.map(cloneSkill);
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

/**
 * Load all skills in correct precedence order.
 *
 * Precedence (first match wins by name):
 *   1. Ancestor .agents/skills directories (cwd → git root)
 *   2. ~/.agents/skills
 *   3. Pi defaults: ~/.pi/agent/skills, <cwd>/.pi/skills
 *
 * Deduplication: by canonical path (symlink dedup) and by name (first match wins).
 */
export function loadAllSkills(cwd: string): Skill[] {
  const resolvedCwd = resolve(cwd);

  // Ancestor .agents/skills (highest precedence)
  const ancestorsSkills = loadAncestorAgentsSkills(resolvedCwd);

  // ~/.agents/skills
  const homeAgentsDir = join(homedir(), ".agents", "skills");
  const homeAgentsSkills = filterRootMdFiles(
    loadSkillsFromDirCached(homeAgentsDir, "agents"),
    homeAgentsDir,
  );

  // Pi defaults: Pi's user agent directory and <cwd>/.pi/skills. This cache
  // only memoizes the helper's metadata result; each child session still owns
  // and reloads its normal DefaultResourceLoader below the caller.
  const defaultsSkills = loadPiDefaultSkillsCached(resolvedCwd, getAgentDir());

  // Merge in precedence order: ancestors first, then home, then defaults.
  // First match wins by name and by canonical path.
  const nameSet = new Set<string>();
  const realPathSet = new Set<string>();
  const result: Skill[] = [];

  for (const skill of [...ancestorsSkills, ...homeAgentsSkills, ...defaultsSkills]) {
    const realPath = canonicalizePath(skill.filePath);
    if (realPathSet.has(realPath) || nameSet.has(skill.name)) continue;
    nameSet.add(skill.name);
    realPathSet.add(realPath);
    result.push(cloneSkill(skill));
  }

  return result;
}

/**
 * Walk from cwd up to git root, loading skills from each .agents/skills directory.
 * Filters out root .md files (Pi's exported API doesn't support "agents" mode).
 */
function loadAncestorAgentsSkills(resolvedCwd: string): Skill[] {
  const gitRoot = findGitRoot(resolvedCwd);
  const result: Skill[] = [];
  let dir = resolvedCwd;

  while (true) {
    const agentsSkillsDir = join(dir, ".agents", "skills");
    result.push(...filterRootMdFiles(
      loadSkillsFromDirCached(agentsSkillsDir, "agents"),
      agentsSkillsDir,
    ));

    if (dir === gitRoot) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return result;
}

/**
 * Filter out root .md files from .agents/skills directories.
 *
 * loadSkillsFromDir always includes root .md files (includeRootFiles: true),
 * but .agents/skills directories should only contain subdirectory skills.
 * A root .md skill has a filePath whose parent is the skills root itself.
 */
function filterRootMdFiles(skills: Skill[], skillsRoot: string): Skill[] {
  const normalizedRoot = resolve(skillsRoot);
  return skills.filter((skill) => {
    const parent = resolve(skill.filePath, "..");
    return parent !== normalizedRoot;
  });
}

/** Walk up from dir to find the git root (directory containing .git). */
function findGitRoot(dir: string): string {
  let current = resolve(dir);
  while (true) {
    try {
      const entries = readdirSync(current);
      if (entries.includes(".git")) return current;
    } catch { /* ignore */ }
    const parent = resolve(current, "..");
    if (parent === current) return current; // filesystem root
    current = parent;
  }
}

/** Resolve path to canonical form, following symlinks. Falls back to raw path. */
function canonicalizePath(filePath: string): string {
  try { return realpathSync(filePath); } catch { return filePath; }
}

/**
 * Load skill metadata only (name, description, location) without full content.
 * Used for the skills whitelist — agent can read full content on-demand.
 */
export function loadSkillMeta(
  skillNames: string[],
  cwd: string,
  excludeSkills?: string[],
): SkillMeta[] {
  const excluded = new Set(excludeSkills ?? []);
  const selectedNames = skillNames.filter((name) => !excluded.has(name));
  if (selectedNames.length === 0) return [];
  const skills = loadAllSkills(cwd);
  return selectedNames.map((name) => {
    const match = skills.find((s) => s.name === name);
    if (!match) {
      return { name, description: `(Skill "${name}" not found)`, location: "", disableModelInvocation: false };
    }
    return {
      name,
      description: match.description,
      location: match.filePath,
      disableModelInvocation: match.disableModelInvocation,
    };
  });
}


