/**
 * Agent resource policy: extension, tool, and skill selection.
 *
 * This module is deliberately independent of child-session lifecycle. It owns
 * the names used to select resources, the package-name lookup used for
 * extension matching, and the policy applied to discovered skills/tools.
 */

import fs from "node:fs";
import path from "node:path";
import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_TOOL_NAMES,
  resolveAgentConfig,
  resolveSessionAllowedTools,
  resolveVisibleTools,
} from "./agent-tool-policy.js";
import type { ResolvedAgentConfig } from "./agent-tool-policy.js";
import type { AgentConfig, SubagentType } from "./types.js";
import type { EnvInfo } from "../types.js";
import { buildAgentPrompt, type PromptExtras } from "../prompt/prompts.js";
import { loadSkillMetaAsync } from "../prompt/skill-loader.js";

export { resolveAgentConfig };
export type { ResolvedAgentConfig };

// Cache: extension path → unscoped package name (lowercased), or undefined if
// not found. Resource reloads can expose paths from many sessions, so retain
// only a small LRU rather than pinning every extension path for the process
// lifetime.
const packageNameCache = new Map<string, string | undefined>();
const MAX_PACKAGE_NAME_CACHE_ENTRIES = 256;

/** Memoized wrapper around resolvePackageShortName. */
function extensionPackageName(extPath: string): string | undefined {
  // Presence check distinguishes a cached undefined (not-found) from a miss,
  // so each path's package.json is read at most once while it is hot.
  if (packageNameCache.has(extPath)) {
    const result = packageNameCache.get(extPath);
    packageNameCache.delete(extPath);
    packageNameCache.set(extPath, result);
    return result;
  }
  const result = resolvePackageShortName(extPath);
  packageNameCache.set(extPath, result);
  while (packageNameCache.size > MAX_PACKAGE_NAME_CACHE_ENTRIES) {
    const oldest = packageNameCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    packageNameCache.delete(oldest);
  }
  return result;
}

/**
 * The unscoped, lowercased npm short name of the pi package that declares
 * `extPath` as an extension entry — or undefined if the entry doesn't belong
 * to such a package.
 *
 * Climbs from the entry's directory looking for package.json, stopping at
 * node_modules boundaries. The name is taken only when that package's
 * `pi.extensions` manifest actually lists this entry. Returns at the first
 * package.json (whether or not it declares the entry) so a loose extension is
 * never misattributed to a co-located project's name.
 */
function resolvePackageShortName(extPath: string): string | undefined {
  const entry = path.resolve(extPath);
  let dir = path.dirname(entry);

  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (path.basename(dir) === "node_modules") return undefined;

    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }

    // First package.json found — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((entryPath) => typeof entryPath === "string" && path.resolve(dir, entryPath) === entry)
    ) {
      const short = pkg.name.startsWith("@")
        ? pkg.name.slice(pkg.name.indexOf("/") + 1)
        : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * Extract the extension name from an extension's file path.
 *
 * Handles git packages, npm packages, local extensions, and direct files
 * without depending on internal dist/lib/src directory structure.
 */
function extractExtensionName(extPath: string): string {
  const parts = extPath.split(path.sep);

  // Git package: .../git/github.com/<user>/<pkg>/...
  const gitIdx = parts.indexOf("git");
  if (gitIdx !== -1 && gitIdx + 3 < parts.length) {
    return parts[gitIdx + 3];
  }

  // npm package: .../node_modules/[...]pkg/...
  const nmIdx = parts.lastIndexOf("node_modules");
  if (nmIdx !== -1 && nmIdx + 1 < parts.length) {
    const next = parts[nmIdx + 1];
    if (next.startsWith("@") && nmIdx + 2 < parts.length) {
      return parts[nmIdx + 2];
    }
    return next;
  }

  // Local extension: extensions/<name>/... or extensions/<name>.ts
  const extIdx = parts.lastIndexOf("extensions");
  if (extIdx !== -1 && extIdx + 1 < parts.length) {
    const afterExt = parts[extIdx + 1];
    if (afterExt && !afterExt.includes(".")) {
      return afterExt;
    }
    const file = parts[parts.length - 1];
    return path.basename(file, path.extname(file));
  }

  // Fallback: parent directory name.
  return path.basename(path.dirname(extPath));
}

/** Build extension name → tool names map from loaded extensions. */
export function buildExtensionToolMap(
  extensions: Array<{ path: string; tools: Map<string, unknown> }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const ext of extensions) {
    const name = extractExtensionName(ext.path);
    const tools = [...ext.tools.keys()];
    if (tools.length > 0) map.set(name, tools);
  }
  return map;
}

/**
 * Filter extensions by name, tracking which names matched.
 * @param names Set of names to match against (lowercased).
 * @param invert When true, removes matching extensions; otherwise keeps them.
 */
function filterExtensions(
  extensions: Array<{ path: string }>,
  names: Set<string>,
  invert: boolean,
): { filtered: Array<{ path: string }>; matched: Set<string> } {
  const matched = new Set<string>();
  const filtered = extensions.filter((ext) => {
    const pathName = extractExtensionName(ext.path).toLowerCase();
    const pkgName = extensionPackageName(ext.path);
    const hit = names.has(pathName) || (pkgName !== undefined && names.has(pkgName));
    if (hit) {
      matched.add(pathName);
      if (pkgName) matched.add(pkgName);
    }
    return hit !== invert;
  });
  return { filtered, matched };
}

function resourceNameSet(names?: string[]): Set<string> | undefined {
  return names && new Set(names.map((name) => {
    const slashIdx = name.indexOf("/");
    return (slashIdx !== -1 ? name.slice(0, slashIdx) : name).toLowerCase();
  }));
}

/** Build extension override for selection-minus-exclusion filtering. */
export function buildExtOverride(
  extensions: true | string[] | false | undefined,
  excludeExtensions?: string[],
  notify?: (msg: string) => void,
) {
  // Select the positive base first, then subtract exclusions. This keeps the
  // extension result (and therefore binding, hooks, and extension tools) in
  // one filtered resource-loader snapshot.
  const allowedNames = resourceNameSet(Array.isArray(extensions) ? extensions : undefined);
  const excludedNames = resourceNameSet(excludeExtensions);

  if (!allowedNames && !excludedNames) return undefined;

  return (result: any) => {
    const selected = allowedNames
      ? filterExtensions(result.extensions, allowedNames, false)
      : { filtered: result.extensions, matched: new Set<string>() };
    const excluded = excludedNames
      ? filterExtensions(result.extensions, excludedNames, true)
      : { filtered: selected.filtered, matched: new Set<string>() };
    const filtered = excludedNames
      ? filterExtensions(selected.filtered, excludedNames, true).filtered
      : selected.filtered;

    // Match diagnostics against the original loaded set, not the already
    // selected subset. A name present in the loaded catalog but removed by the
    // positive selection is not a conflict or a missing exclusion.
    for (const name of allowedNames ?? []) {
      if (!selected.matched.has(name)) {
        notify?.(`extension "${name}" not found in loaded extensions`);
      }
    }
    for (const name of excludedNames ?? []) {
      if (!excluded.matched.has(name)) {
        notify?.(`extension "${name}" not found in loaded extensions`);
      }
    }

    return { ...result, extensions: filtered };
  };
}

type SkillResources = {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
};

/**
 * Build the complete skill metadata policy for DefaultResourceLoader.
 *
 * Pi applies this override both during reload and when an extension adds
 * resources through resources_discover, so the policy must not be reduced to
 * an exclusion-only filter.
 */
export function buildSkillsOverride(
  skills: ResolvedAgentConfig["skills"],
  excludeSkills?: string[],
): (result: SkillResources) => SkillResources {
  const allowedSkillNames = Array.isArray(skills) ? new Set(skills) : undefined;
  const excludedSkillNames = new Set(excludeSkills ?? []);
  const suppressMetadata = skills === false;

  return (result) => ({
    ...result,
    skills: result.skills.filter((skill) =>
      !suppressMetadata
      && (allowedSkillNames === undefined || allowedSkillNames.has(skill.name))
      && !excludedSkillNames.has(skill.name),
    ),
  });
}

/** Resolve the concrete tool names that may enter a child session registry. */
export function resolveSessionToolNames(
  agentConfig: AgentConfig,
  extToolMap: Map<string, string[]>,
): string[] {
  return resolveSessionAllowedTools({
    registeredTools: agentConfig.tools === undefined && agentConfig.registeredTools?.length
      ? agentConfig.registeredTools
      : BUILTIN_TOOL_NAMES,
    tools: agentConfig.tools,
    excludeTools: agentConfig.excludeTools,
    extToolMap,
  });
}

/** Resolve the visible tool schemas after extensions have been bound. */
export function resolveVisibleToolNames(
  activeTools: string[],
  agentConfig: AgentConfig,
  extToolMap: Map<string, string[]>,
  notify?: (msg: string) => void,
): string[] | null {
  return resolveVisibleTools({
    activeTools,
    tools: agentConfig.tools,
    excludeTools: agentConfig.excludeTools,
    extToolMap,
    notify,
  });
}

/**
 * Build the system prompt while resolving skill metadata through the bounded
 * catalog path. Explicit arrays and all-skills mode are both asynchronous;
 * `false` remains the no-metadata path.
 */
export function buildAgentSystemPrompt(
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  config: ResolvedAgentConfig,
  cwd: string,
  env: EnvInfo,
  resolverExtras: Pick<PromptExtras, "contextFiles"> = {},
  projectTrusted = true,
): string | Promise<string> {
  if (!agentConfig) throw new Error(`Unknown agent type: ${type}`);
  const extras: PromptExtras = { ...resolverExtras };
  if (config.skills === true || Array.isArray(config.skills)) {
    const skillSelection = config.skills === true ? true : config.skills;
    const skillMetas = Promise.resolve(projectTrusted
      ? loadSkillMetaAsync(skillSelection, cwd, config.excludeSkills)
      : loadSkillMetaAsync(skillSelection, cwd, config.excludeSkills, false));
    return skillMetas.then((metas) => buildAgentPrompt(
      agentConfig,
      cwd,
      env,
      { ...extras, skillMetas: metas },
    ));
  }
  return buildAgentPrompt(agentConfig, cwd, env, extras);
}
