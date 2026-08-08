/**
 * agent-tool-policy.ts — Tool, extension, skill, and resolved-config policy.
 *
 * This module is independent from the agent registry. Keeping AgentConfig as a
 * type-only dependency lets agent-types.ts expose this policy without a
 * runtime cycle.
 */

import type { AgentConfig } from "./types.js";
import { retainAgentDescription } from "./agent-string-limits.js";

/**
 * All tool names that Pi can provide to a session.
 *
 * Note: only `read`, `bash`, `edit`, `write` are active by default.
 * `find` and `grep` must be explicitly activated via setActiveToolsByName().
 * `ls` was removed — it's a thin wrapper over bash that adds ~180 tokens/turn
 * with no real benefit.
 */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep", "find"];

/** Root-session control tools are never registered in agent sessions. */
export const EXCLUDED_TOOL_NAMES = ["Agent", "AgentContinue"];

/** Resolve bare, ext/*, and ext/tool entries into concrete tool names. */
function resolveToolEntries(
  entries: string[],
  extToolMap: Map<string, string[]> | undefined,
  notify?: (msg: string) => void,
): Set<string> {
  const resolved = new Set<string>();

  for (const entry of entries) {
    const slashIdx = entry.indexOf("/");
    if (slashIdx !== -1) {
      const extName = entry.slice(0, slashIdx);
      const toolPart = entry.slice(slashIdx + 1);
      if (toolPart === "*") {
        const extTools = extToolMap?.get(extName);
        if (extTools && extTools.length > 0) {
          for (const toolName of extTools) resolved.add(toolName);
        } else {
          notify?.(`extension "${extName}" is not loaded, "${entry}" will have no effect`);
        }
      } else {
        resolved.add(toolPart);
      }
    } else {
      resolved.add(entry);
    }
  }

  return resolved;
}

/**
 * Resolve the visible tool set for an agent.
 * Selection is evaluated first, then exclusions and the unconditional root
 * control-tool exclusion are applied. A null result means no schema filter is necessary.
 */
export function resolveVisibleTools(opts: {
  activeTools: string[];
  tools?: true | string[] | false;
  excludeTools?: string[];
  extToolMap?: Map<string, string[]>;
  notify?: (msg: string) => void;
}): string[] | null {
  const { activeTools, tools, excludeTools, extToolMap, notify } = opts;
  const excludedToolNames = new Set(EXCLUDED_TOOL_NAMES);
  const selectedTools = tools === false
    ? new Set<string>()
    : Array.isArray(tools)
      ? resolveToolEntries(tools, extToolMap, notify)
      : undefined;
  const excludedTools = tools === false
    ? new Set<string>()
    : resolveToolEntries(excludeTools ?? [], extToolMap, notify);

  if (Array.isArray(tools)) {
    const allBuiltinSet = new Set(BUILTIN_TOOL_NAMES);

    for (const entry of tools) {
      const slashIdx = entry.indexOf("/");
      if (slashIdx === -1 && !allBuiltinSet.has(entry)) {
        let foundInExt = false;
        for (const [, extToolNames] of extToolMap ?? []) {
          if (extToolNames.includes(entry)) { foundInExt = true; break; }
        }
        if (!foundInExt) {
          notify?.(`tool "${entry}" not found in any loaded extension`);
        }
      }
    }

    // A selected extension may still have individual tools excluded, so only
    // the positive selection controls this diagnostic.
    if (extToolMap) {
      for (const [extName, extTools] of extToolMap) {
        const hasAny = extTools.some(toolName => selectedTools!.has(toolName));
        if (!hasAny) {
          notify?.(`extension "${extName}" is loaded but none of its tools are in tools: [${tools.join(", ")}]`);
        }
      }
    }
  }

  const visible = activeTools.filter((toolName) => {
    const selected = selectedTools === undefined || selectedTools.has(toolName);
    return selected && !excludedToolNames.has(toolName) && !excludedTools.has(toolName);
  });

  if (tools === false || Array.isArray(tools)) return visible;
  return visible.length === activeTools.length ? null : visible;
}

/**
 * Resolve the concrete tool names that may enter a child session registry.
 * Positive lists gate exactly their expansion; true/undefined seed registered
 * builtins plus all known extension tools. This is not final schema visibility.
 */
export function resolveSessionAllowedTools(opts: {
  registeredTools: string[];
  tools?: true | string[] | false;
  excludeTools?: string[];
  extToolMap?: Map<string, string[]>;
}): string[] {
  const excludedToolNames = new Set(EXCLUDED_TOOL_NAMES);
  if (opts.tools === false) return [];

  const selected = Array.isArray(opts.tools)
    ? resolveToolEntries(opts.tools, opts.extToolMap)
    : new Set([
      ...opts.registeredTools,
      ...(opts.extToolMap ? [...opts.extToolMap.values()].flat() : []),
    ]);
  const excluded = resolveToolEntries(opts.excludeTools ?? [], opts.extToolMap);

  return [...selected].filter((name) =>
    !excludedToolNames.has(name) && !excluded.has(name),
  );
}

/** Resolved config shape returned by getConfig. */
export interface ResolvedAgentConfig {
  /** Canonical role name used for resolution and rendering. */
  name: string;
  description: string;
  registeredTools: string[];
  /** Controls tool schema visibility. true/undefined = all, list = selected, false = none. */
  tools?: true | string[] | false;
  excludeTools?: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  excludeSkills?: string[];
}

/** Resolve an already-selected agent definition without consulting the registry. */
export function resolveAgentConfig(config: AgentConfig): ResolvedAgentConfig {
  return {
    name: config.name,
    description: retainAgentDescription(config.description),
    registeredTools: config.registeredTools ? [...config.registeredTools] : [...BUILTIN_TOOL_NAMES],
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    excludeTools: config.excludeTools && [...config.excludeTools],
    extensions: config.extensions ?? false,
    excludeExtensions: config.excludeExtensions && [...config.excludeExtensions],
    skills: config.skills ?? false,
    excludeSkills: config.excludeSkills && [...config.excludeSkills],
  };
}
