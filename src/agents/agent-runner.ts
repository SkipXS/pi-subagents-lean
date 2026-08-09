/**
 * Agent-runner orchestration facade.
 *
 * Resource policy lives in agent-runner-policy.ts and child-session/turn
 * lifecycle lives in agent-session-runtime.ts. This module keeps the
 * accepted-spawn, trust, worktree, prompt, and ALS ordering visible.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  buildAgentSystemPrompt,
  resolveAgentConfig,
} from "./agent-runner-policy.js";
import {
  createAndConfigureSession,
  createResourceLoader,
  executeAgentTurn,
  subscribeToSessionEvents,
} from "./agent-session-runtime.js";
import type { AgentTurnOptions, SessionRuntimeOptions } from "./agent-session-runtime.js";
import type { PromptExtras } from "../prompt/prompts.js";
import { GIT_EXEC_TIMEOUT_MS } from "../utils.js";
import type { EnvInfo } from "../types.js";
import type { SubagentType } from "./types.js";
import { createSubagentRuntimeContext, getSubagentRuntimeContext, runWithSubagentRuntime } from "../shell.js";
import { revalidateWorktreePath } from "../spawn/worktree-validator.js";
import { loadBoundedContextFiles } from "./context-file-loader.js";

// Preserve the established runner exports for internal consumers while tests
// and new code can import helpers from their owning modules.
export { buildExtOverride, buildSkillsOverride } from "./agent-runner-policy.js";
export { executeAgentTurn, subscribeToSessionEvents };
export type { AgentTurnOptions };

export interface RunOptions extends SessionRuntimeOptions {
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
}

interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True when execution was aborted through its AbortSignal. */
  aborted: boolean;
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

/** Detect environment info using pi.exec() for git detection. */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo ? (await execGit(pi, ["branch", "--show-current"], cwd)) : null;
  return { isGitRepo, branch, platform: process.platform };
}

/** Load bounded context files, respecting the immutable trust snapshot. */
async function resolvePromptExtras(
  cwd: string,
  projectTrusted: boolean,
  agentDir: string,
  onWarning?: (warning: string) => void,
): Promise<Pick<PromptExtras, "contextFiles">> {
  try {
    const contextFiles = await loadBoundedContextFiles({
      cwd,
      agentDir,
      projectTrusted,
      onWarning,
    });
    // Keep Pi's trusted shape (including an empty array) while avoiding a
    // project-derived result entirely for untrusted preflight snapshots.
    return projectTrusted || contextFiles.length > 0 ? { contextFiles } : {};
  } catch {
    // Non-fatal: context files are supplementary and never block a run.
    return {};
  }
}

/**
 * Execute an accepted spawn. The accepted contract is authoritative: no
 * registry, settings, model, or prompt fallback is performed here.
 */
export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  // Every child session enters a fresh ALS context before resource and
  // extension loading. Nested child execution remains unavailable.
  if (getSubagentRuntimeContext()) {
    throw new Error("Nested agent execution is unavailable from a child runtime");
  }
  const acceptedSpawn = options.acceptedSpawn;
  if (!acceptedSpawn) throw new Error("Accepted spawn is required");
  const childContext = createSubagentRuntimeContext();
  return runWithSubagentRuntime(
    childContext,
    () => runAgentImpl(
      ctx,
      acceptedSpawn.type,
      acceptedSpawn.prompt,
      options,
    ),
  );
}

async function runAgentImpl(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  if (options.signal?.aborted) {
    const error = new Error("Agent run aborted before setup");
    error.name = "AbortError";
    throw error;
  }

  const acceptedSpawn = options.acceptedSpawn;
  const projectTrusted = acceptedSpawn.projectTrusted === true;
  const agentConfig = acceptedSpawn.agentConfig;
  const config = resolveAgentConfig(agentConfig);

  // Buffer diagnostics until after the turn so they cannot corrupt the
  // tool_use/tool_result ordering in the session tree.
  const warnings: string[] = [];
  const bufferNotify = (msg: string) => { warnings.push(msg); };

  // Revalidate a queued worktree immediately before loading child resources.
  let effectiveCwd = acceptedSpawn.worktreePath ?? ctx.cwd;
  if (acceptedSpawn.worktreePath) {
    const validation = await revalidateWorktreePath(
      options.pi,
      acceptedSpawn.worktreeSelectionPath ?? acceptedSpawn.worktreePath,
      acceptedSpawn.worktreeParentCwd ?? ctx.cwd,
      acceptedSpawn.worktreePath,
    );
    if (!validation.ok || !validation.resolvedPath) {
      throw new Error(validation.ok ? "worktree_path validation failed" : validation.error);
    }
    effectiveCwd = validation.resolvedPath;
  }

  const agentDir = getAgentDir();
  // The trust snapshot governs both resource discovery and session creation.
  const settingsManager = SettingsManager.create(effectiveCwd, agentDir, { projectTrusted });
  const env = await detectEnv(options.pi, effectiveCwd);
  // Context loading is asynchronous and bounded; complete it before any
  // system-prompt construction so no Pi synchronous helper can walk the
  // project behind the trust snapshot.
  const promptExtras = await resolvePromptExtras(
    effectiveCwd,
    projectTrusted,
    agentDir,
    bufferNotify,
  );

  const builtPrompt = buildAgentSystemPrompt(
    type,
    agentConfig,
    config,
    effectiveCwd,
    env,
    promptExtras,
    projectTrusted,
  );
  // Skill-enabled modes use the bounded async catalog; `skills:false` remains
  // synchronous and does not touch the catalog.
  const systemPrompt = builtPrompt instanceof Promise ? await builtPrompt : builtPrompt;
  const { loader, reloadAndMap } = createResourceLoader(
    config,
    agentConfig,
    effectiveCwd,
    agentDir,
    systemPrompt,
    settingsManager,
    bufferNotify,
  );
  const { extToolMap } = await reloadAndMap();
  const session = await createAndConfigureSession(
    ctx,
    options,
    agentConfig,
    effectiveCwd,
    agentDir,
    loader,
    settingsManager,
    extToolMap,
    bufferNotify,
  );

  // Setup is asynchronous, so shutdown may have aborted while the session was
  // being created. Never publish or prompt a late session.
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

  // Flush setup warnings only after the turn has completed.
  for (const msg of warnings) {
    if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lean] ${msg}`, "warning");
    else console.warn(`[pi-subagents-lean] ${msg}`);
  }

  return { responseText, session, aborted };
}
