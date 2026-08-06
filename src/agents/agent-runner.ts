/**
 * Core execution engine: creates sessions, runs agents, collects results.
 *
 * Tool visibility policy is owned by agent-types.ts (resolveVisibleTools).
 */

import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ResourceDiagnostic,
  type Skill,
  getAgentDir,
  loadProjectContextFiles,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getConfig,
  resolveAgentConfig,
  resolveSessionAllowedTools,
  resolveVisibleTools,
} from "./agent-types.js";
import { extractText } from "../prompt/context.js";
import type { AgentUsage } from "./usage.js";
import { GIT_EXEC_TIMEOUT_MS } from "../utils.js";
import { resolveAgentTunables } from "../models/agent-resolution.js";
import { buildAgentPrompt, type PromptExtras } from "../prompt/prompts.js";
import { loadSkillMeta } from "../prompt/skill-loader.js";
import { type CompactionInfo, type EnvInfo, type RunCallbacks, type RunTunables, SHORT_ID_LENGTH } from "../types.js";
import { type AgentConfig, type SubagentType } from "./types.js";
import { createSubagentRuntimeContext, getStore, getSubagentRuntimeContext, runWithSubagentRuntime } from "../shell.js";
import type { SubagentRuntimeSettings } from "../config/config-store.js";
import { revalidateWorktreePath } from "../spawn/worktree-validator.js";
import type { AcceptedSpawn } from "../spawn/spawn-contract.js";

// Cache: extension path → unscoped package name (lowercased), or undefined if not found
const packageNameCache = new Map<string, string | undefined>();

/** Memoized wrapper around resolvePackageShortName. */
function extensionPackageName(extPath: string): string | undefined {
  // Presence check distinguishes a cached undefined (not-found) from a miss,
  // so each path's package.json is read at most once per process.
  if (packageNameCache.has(extPath)) return packageNameCache.get(extPath);
  const result = resolvePackageShortName(extPath);
  packageNameCache.set(extPath, result);
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
 * package.json (whether or not it declares the entry) so a loose extension
 * is never misattributed to a co-located project's name.
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
      entries.some((e) => typeof e === "string" && path.resolve(dir, e) === entry)
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
 * Internal usage channel for billable work that is not an assistant turn.
 * These usages must not affect assistant-only input-delta metrics.
 */
interface SupplementalUsageCallbacks {
  onSupplementalUsage?: (usage: AgentUsage) => void;
}

export interface RunOptions extends RunTunables, RunCallbacks, SupplementalUsageCallbacks {
  /** Detached definition captured before queueing; never re-resolve at start. */
  agentConfig?: AgentConfig;
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `explorer#a1b2c3d4`). */
  agentId?: string;
  /** Override working directory (resolved worktree path). */
  cwd?: string;
  /** Parent repo cwd retained for execution-boundary worktree revalidation. */
  worktreeParentCwd?: string;
  /** Original selected path, used to detect a retarget after queueing. */
  worktreeSelectionPath?: string;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Detached at the accepted spawn boundary; never read from the root in ALS. */
  runtimeSettings?: SubagentRuntimeSettings;
  /** Parent trust snapshot for direct/legacy calls; accepted contracts are authoritative. */
  projectTrusted?: boolean;
  /** Immutable preflight contract from the regular Agent tool path. */
  acceptedSpawn?: AcceptedSpawn;
}

interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True when the execution was aborted through its AbortSignal. */
  aborted: boolean;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(
  session: AgentSession,
  onTextDelta?: (delta: string, fullText: string) => void,
) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
      onTextDelta?.(event.assistantMessageEvent.delta, text);
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  // addEventListener does not replay an abort that happened before wiring.
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Extract a LifetimeUsage from a runtime assistant message_end event.
 * pi-ai attaches `usage: { input, output, cacheWrite, cost: { total } }` to
 * assistant messages at runtime, but this shape isn't reflected in the
 * AgentSessionEvent public types.
 */
function usageFromAssistantMessage(msg: Record<string, unknown>): AgentUsage | undefined {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    input: (usage.input as number) ?? 0,
    output: (usage.output as number) ?? 0,
    cacheWrite: (usage.cacheWrite as number) ?? 0,
    cacheRead: (usage.cacheRead as number) ?? 0,
    cost: ((usage.cost as Record<string, unknown>)?.total as number) ?? 0,
  };
}

/** Convert typed upstream usage from compaction or tool results to local accounting. */
function usageFromTypedUsage(usage: Usage): AgentUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheWrite: usage.cacheWrite,
    cacheRead: usage.cacheRead,
    cost: usage.cost.total,
  };
}

/**
 * Subscribe to shared session events (tool activity, usage, compaction)
 * used by runAgent. Returns an unsubscribe function.
 */
export function subscribeToSessionEvents(
  session: Pick<AgentSession, "subscribe">,
  options: Pick<RunOptions, "onToolActivity" | "onAssistantUsage" | "onSupplementalUsage" | "onCompaction">,
): () => void {
  if (!options.onToolActivity && !options.onAssistantUsage && !options.onSupplementalUsage && !options.onCompaction) {
    return () => {};
  }
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message as unknown as Record<string, unknown>;
      const usage = usageFromAssistantMessage(msg);
      if (usage) {
        options.onAssistantUsage?.(usage);
      }
    }
    if (event.type === "message_end" && event.message.role === "toolResult" && event.message.usage) {
      options.onSupplementalUsage?.(usageFromTypedUsage(event.message.usage));
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      if (event.result.usage) {
        options.onSupplementalUsage?.(usageFromTypedUsage(event.result.usage));
      }
      const info: CompactionInfo = { reason: event.reason, tokensBefore: event.result.tokensBefore };
      if (event.result.summary !== undefined) info.summary = event.result.summary;
      if (event.result.firstKeptEntryId !== undefined) info.firstKeptEntryId = event.result.firstKeptEntryId;
      options.onCompaction?.(info);
    }
  });
}

/**
 * Extract the extension name from an extension's file path.
 *
 * Handles all distribution methods:
 *  - git packages: `.../git/github.com/<user>/<pkg>/...` → "<pkg>"
 *  - npm packages: `.../node_modules/[...]pkg/...` → "pkg"
 *  - local extensions: `~/.pi/agent/extensions/<name>/...` → "<name>"
 *  - direct files: `extensions/<name>.ts` → "<name>"
 *
 * Does NOT depend on internal directory structure (dist/, lib/, src/, etc).
 * Only cares about the package root, which is determined by distribution method.
 */
function extractExtensionName(extPath: string): string {
  const parts = extPath.split(path.sep);

  // 1. Git package: .../git/github.com/<user>/<pkg>/...
  //    Package name is 3 dirs after 'git' (github.com/user/pkg)
  const gitIdx = parts.indexOf("git");
  if (gitIdx !== -1 && gitIdx + 3 < parts.length) {
    return parts[gitIdx + 3];
  }

  // 2. npm package: .../node_modules/[...]pkg/...
  const nmIdx = parts.lastIndexOf("node_modules");
  if (nmIdx !== -1 && nmIdx + 1 < parts.length) {
    const next = parts[nmIdx + 1];
    if (next.startsWith("@") && nmIdx + 2 < parts.length) {
      return parts[nmIdx + 2]; // @scope/pkg → pkg
    }
    return next;
  }

  // 3. Local extension: .../extensions/<name>/... or .../extensions/<name>.ts
  const extIdx = parts.lastIndexOf("extensions");
  if (extIdx !== -1 && extIdx + 1 < parts.length) {
    const afterExt = parts[extIdx + 1];
    // Subdirectory: extensions/tavily/index.ts → tavily
    if (afterExt && !afterExt.includes(".")) {
      return afterExt;
    }
    // Direct file: extensions/review.ts → review
    const file = parts[parts.length - 1];
    return path.basename(file, path.extname(file));
  }

  // Fallback: parent dir name
  return path.basename(path.dirname(extPath));
}

/** Run a git command via pi.exec, returning stdout on success or null on failure. */
async function execGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Detect environment info using pi.exec() for git detection.
 * Inline replacement for upstream's detectEnv from env.ts.
 */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo ? (await execGit(pi, ["branch", "--show-current"], cwd)) : null;

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

// ── runAgent phases ────────────────────────────────────────────────

/** Context filenames recognized by Pi's project-context loader. */
const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** Load the user-global context file without walking the untrusted project. */
function loadUserContextFiles(agentDir: string): Array<{ path: string; content: string }> {
  const resolvedAgentDir = path.resolve(agentDir);
  for (const filename of CONTEXT_FILE_NAMES) {
    const filePath = path.join(resolvedAgentDir, filename);
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      return [{ path: filePath, content: fs.readFileSync(filePath, "utf-8") }];
    } catch {
      // A missing or unreadable supplementary file is non-fatal.
    }
  }
  return [];
}

/** Load context files when enabled, respecting the immutable trust snapshot. */
function resolvePromptExtras(
  cwd: string,
  settings: SubagentRuntimeSettings,
  projectTrusted: boolean,
  agentDir: string,
): Pick<PromptExtras, "contextFiles"> {
  if (!settings.agent.includeContextFiles) return {};
  try {
    if (projectTrusted) {
      // Keep the trusted Pi loader shape unchanged, including an empty array.
      return { contextFiles: loadProjectContextFiles({ cwd, agentDir }) };
    }
    const contextFiles = loadUserContextFiles(agentDir);
    return contextFiles.length > 0 ? { contextFiles } : {};
  } catch {
    // Non-fatal: context files are supplementary.
    return {};
  }
}

function buildPrompt(
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  config: ReturnType<typeof resolveAgentConfig>,
  cwd: string,
  env: EnvInfo,
  resolverExtras: Pick<PromptExtras, "contextFiles"> = {},
  projectTrusted = true,
): string {
  const extras: PromptExtras = { ...resolverExtras };
  const excludeSkills = config.excludeSkills ?? agentConfig?.excludeSkills;
  if (Array.isArray(config.skills)) {
    // Preserve the established trusted call shape; legacy/direct runs use the
    // explicit false argument so project skill discovery stays closed.
    extras.skillMetas = projectTrusted
      ? loadSkillMeta(config.skills, cwd, excludeSkills)
      : loadSkillMeta(config.skills, cwd, excludeSkills, false);
  }
  if (!agentConfig) throw new Error(`Unknown agent type: ${type}`);
  return buildAgentPrompt(agentConfig, cwd, env, extras);
}

/** Build extension name → tool names map from loaded extensions. */
function buildExtToolMap(extensions: Array<{ path: string; tools: Map<string, unknown> }>) {
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
 * @param names  Set of names to match against (lowercased).
 * @param invert  When true, removes matching extensions (blacklist). When false, keeps them (whitelist).
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

/** Build extension override for selection-minus-exclusion filtering. */
export function buildExtOverride(
  extensions: true | string[] | false | undefined,
  excludeExtensions?: string[],
  notify?: (msg: string) => void,
) {
  // Select the positive base first, then subtract exclusions. This keeps the
  // extension result (and therefore binding, hooks, and extension tools) in
  // one filtered resource-loader snapshot.
  const allowedNames = Array.isArray(extensions)
    ? new Set(extensions.map((ext) => {
      const slashIdx = ext.indexOf("/");
      return (slashIdx !== -1 ? ext.slice(0, slashIdx) : ext).toLowerCase();
    }))
    : undefined;
  const excludedNames = excludeExtensions && new Set(excludeExtensions.map((ext) => {
    const slashIdx = ext.indexOf("/");
    return (slashIdx !== -1 ? ext.slice(0, slashIdx) : ext).toLowerCase();
  }));

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
  skills: ReturnType<typeof resolveAgentConfig>["skills"],
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

/**
 * Phase 2: Build DefaultResourceLoader with extension filtering.
 * Returns the loader and a function that reloads it and builds the ext→tool map.
 */
function createResourceLoader(
  config: ReturnType<typeof resolveAgentConfig>,
  agentConfig: AgentConfig | undefined,
  cwd: string,
  agentDir: string,
  systemPrompt: string,
  settingsManager: SettingsManager,
  notify?: (msg: string) => void,
) {
  const extensions = config.extensions;
  const excludeSkills = config.excludeSkills ?? agentConfig?.excludeSkills;
  const noSkills = config.skills === false || Array.isArray(config.skills);
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd, agentDir, settingsManager,
    noExtensions: extensions === false, noSkills,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionsOverride: buildExtOverride(extensions, config.excludeExtensions ?? agentConfig?.excludeExtensions, notify),
    skillsOverride: buildSkillsOverride(config.skills, excludeSkills),
  };
  const loader = new DefaultResourceLoader(loaderOpts);
  return {
    loader,
    reloadAndMap: async () => {
      await loader.reload();
      const extResult = loader.getExtensions();
      return { extResult, extToolMap: buildExtToolMap(extResult.extensions) };
    },
  };
}

/** Create an agent session with the resolved model and thinking level. */
async function initSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: AgentConfig | undefined,
  type: SubagentType,
  cwd: string,
  agentDir: string,
  loader: DefaultResourceLoader,
  settingsManager: SettingsManager,
  extToolMap: Map<string, string[]>,
) {
  // The spawn boundary resolves Agent Markdown model/thinking values against
  // the parent. The runner consumes those already-resolved values and only
  // inherits from its parent defensively for direct callers.
  const model = options.model ?? ctx.model;
  const thinkingLevel = options.thinkingLevel ?? ctx.thinkingLevel;
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd, agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    model,
    tools: resolveSessionAllowedTools({
      registeredTools: agentConfig?.tools === undefined && agentConfig?.registeredTools?.length
        ? agentConfig.registeredTools
        : BUILTIN_TOOL_NAMES,
      tools: agentConfig?.tools,
      excludeTools: agentConfig?.excludeTools,
      extToolMap,
    }),
    resourceLoader: loader,
  };
  if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;
  const result = await createAgentSession(sessionOpts);

  return result;
}

/**
 * Phase 3: Create session, bind extensions, filter tools.
 */
async function createAndConfigureSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: AgentConfig | undefined,
  type: SubagentType,
  cwd: string,
  agentDir: string,
  loader: DefaultResourceLoader,
  settingsManager: SettingsManager,
  extToolMap: Map<string, string[]>,
  notify: (msg: string) => void,
): Promise<AgentSession> {
  const { session } = await initSession(ctx, options, agentConfig, type, cwd, agentDir, loader, settingsManager, extToolMap);
  try {
    const baseName = agentConfig?.name ?? type;
    session.setSessionName(
      options.agentId ? `${baseName}#${options.agentId.slice(0, SHORT_ID_LENGTH)}` : baseName,
    );
    await session.bindExtensions({
      onError: (err) => options.onToolActivity?.({
        type: "end", toolName: `extension-error:${err.extensionPath}`,
      }),
    });

    const filteredTools = resolveVisibleTools({
      activeTools: session.getActiveToolNames(),
      tools: agentConfig?.tools,
      excludeTools: agentConfig?.excludeTools,
      extToolMap,
      notify,
    });
    if (filteredTools) session.setActiveToolsByName(filteredTools);
    return session;
  } catch (error) {
    try { session.dispose(); } catch { /* Preserve the setup error. */ }
    throw error;
  }
}
/**
 * Execute the prompt with event wiring and cleanup.
 */
async function runTurnLoop(
  session: AgentSession,
  prompt: string,
  options: AgentTurnOptions,
) {
  const unsubEvents = subscribeToSessionEvents(session, options);
  const collector = collectResponseText(session, options.onTextDelta);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  try {
    await session.prompt(prompt);
  } finally {
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
  }
  return collector.getText().trim();
}

/**
 * Options consumed by one turn execution on an existing session (AgentContinue).
 * Narrower than RunOptions: continuation never re-creates the session, so no
 * pi/ctx/config/catalog inputs are needed.
 */
export type AgentTurnOptions = Pick<RunOptions,
  | "signal" | "onToolActivity" | "onAssistantUsage" | "onSupplementalUsage" | "onCompaction" | "onTextDelta"
> & {
  /**
   * When the current turn emits no text, fall back to the last non-empty
   * assistant message in session history. Initial runs keep this behavior;
   * continuations must never return prior-execution text as their own result.
   */
  fallbackToLastAssistantText?: boolean;
};

/**
 * Execute one prompt turn on an already-created session.
 *
 * Shared by the initial spawn (runAgent) and every AgentContinue execution so
 * event wiring and response collection behave identically on the same session.
 */
export async function executeAgentTurn(
  session: AgentSession,
  prompt: string,
  options: AgentTurnOptions,
): Promise<{ responseText: string; aborted: boolean }> {
  const text = await runTurnLoop(session, prompt, options);
  // The history fallback is opt-in (initial runs only): a continuation that
  // produces no output must return an empty result rather than the previous
  // execution's assistant text.
  const responseText = options.fallbackToLastAssistantText === true
    ? text || getLastAssistantText(session)
    : text;
  return { responseText, aborted: options.signal?.aborted === true };
}

// ── main entry ─────────────────────────────────────────────────────

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  // Every agent session is entered through a fresh ALS context before resource
  // and extension loading. The marker makes this extension's root tools inert
  // in the child session; it carries no delegation capability.
  if (getSubagentRuntimeContext()) {
    throw new Error("Nested agent execution is unavailable from a child runtime");
  }
  const settings = options.acceptedSpawn?.runtimeSettings
    ?? options.runtimeSettings
    ?? getStore().createSubagentRuntimeSettings();
  const childContext = createSubagentRuntimeContext();
  return runWithSubagentRuntime(
    childContext,
    () => runAgentImpl(
      ctx,
      options.acceptedSpawn?.type ?? type,
      options.acceptedSpawn?.prompt ?? prompt,
      options,
      settings,
    ),
  );
}

async function runAgentImpl(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
  settings: SubagentRuntimeSettings,
): Promise<RunResult> {
  if (options.signal?.aborted) {
    const error = new Error("Agent run aborted before setup");
    error.name = "AbortError";
    throw error;
  }

  // A queued run uses the definition selected at acceptance. The regular Agent
  // path carries an immutable contract and never performs a second registry or
  // tunable lookup here. Direct runner callers retain the old defensive adapter.
  const acceptedSpawn = options.acceptedSpawn;
  // An accepted contract is authoritative. Legacy/direct calls without a
  // snapshot are conservatively untrusted.
  const projectTrusted = acceptedSpawn
    ? acceptedSpawn.projectTrusted === true
    : options.projectTrusted === true;
  const agentConfig = acceptedSpawn?.agentConfig ?? options.agentConfig ?? getAgentConfig(type);
  if (!agentConfig) throw new Error(`Unknown agent type: ${type}`);

  if (acceptedSpawn) {
    options = {
      ...options,
      agentConfig: acceptedSpawn.agentConfig,
      model: acceptedSpawn.model,
      thinkingLevel: acceptedSpawn.thinkingLevel,
      runtimeSettings: acceptedSpawn.runtimeSettings,
      projectTrusted,
    };
  } else {
    // Direct runner callers may omit the already-resolved tunables. Resolve the
    // same settings > Markdown > parent chain defensively.
    const resolvedTunables = resolveAgentTunables({
      agentName: type,
      agentConfig,
      overrides: settings.agents,
      modelRegistry: ctx.modelRegistry,
      parentModel: ctx.model,
      parentThinking: ctx.thinkingLevel,
      baseModel: options.model,
      baseThinking: options.thinkingLevel,
    });
    options = {
      ...options,
      model: resolvedTunables.model,
      thinkingLevel: resolvedTunables.thinkingLevel,
    };
  }

  const config = options.agentConfig
    ? resolveAgentConfig(options.agentConfig)
    : getConfig(type);

  // Buffer setup diagnostics so they do not insert custom_message entries
  // between tool_use and tool_result in the session tree (Anthropic rejects
  // that ordering). Selection/exclusion is intentionally silent.
  const warnings: string[] = [];
  const bufferNotify = (msg: string) => { warnings.push(msg); };

  // A worktree can be deleted, replaced, or have its symlink target swapped
  // while an accepted spawn waits in the manager queue. Revalidate immediately
  // before any worktree-local runner resource is loaded or a session is made.
  let effectiveCwd = options.cwd ?? ctx.cwd;
  if (options.cwd) {
    const validation = await revalidateWorktreePath(
      options.pi,
      options.worktreeSelectionPath ?? options.cwd,
      options.worktreeParentCwd ?? ctx.cwd,
      options.cwd,
    );
    if (!validation.ok || !validation.resolvedPath) {
      throw new Error(validation.ok ? "worktree_path validation failed" : validation.error);
    }
    effectiveCwd = validation.resolvedPath;
  }
  const agentDir = getAgentDir();
  // The same Pi SettingsManager instance must govern both resource discovery
  // and session creation. Its trust bit is the immutable parent snapshot, not
  // a fresh lookup against the worktree or child session.
  const settingsManager = SettingsManager.create(effectiveCwd, agentDir, { projectTrusted });
  const env = await detectEnv(options.pi, effectiveCwd);

  // Resolve the replacement prompt's optional project context.
  const promptExtras = resolvePromptExtras(effectiveCwd, settings, projectTrusted, agentDir);

  const systemPrompt = buildPrompt(
    type, agentConfig, config, effectiveCwd, env, promptExtras, projectTrusted,
  );
  const { loader, reloadAndMap } = createResourceLoader(
    config, agentConfig, effectiveCwd, agentDir, systemPrompt, settingsManager, bufferNotify,
  );
  const { extToolMap } = await reloadAndMap();
  const session = await createAndConfigureSession(
    ctx, options, agentConfig, type, effectiveCwd, agentDir, loader, settingsManager, extToolMap, bufferNotify,
  );
  // Session setup is asynchronous, so shutdown may have aborted the run while
  // the session was being created. Never publish or prompt a late session.
  if (options.signal?.aborted) {
    session.dispose();
    const error = new Error("Agent run aborted during setup");
    error.name = "AbortError";
    throw error;
  }
  options.onSessionCreated?.(session);

  const { responseText, aborted } = await executeAgentTurn(session, prompt, {
    ...options,
    fallbackToLastAssistantText: true,
  });

  // Flush buffered warnings now that tool_result is in the session tree.
  for (const msg of warnings) {
    if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lean] ${msg}`, "warning");
    else console.warn(`[pi-subagents-lean] ${msg}`);
  }

  return { responseText, session, aborted };
}
