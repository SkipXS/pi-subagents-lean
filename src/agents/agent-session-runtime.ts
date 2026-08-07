/**
 * Child-session runtime: resource-loader/session construction and turn wiring.
 *
 * The runner facade supplies the already-accepted definition and trust
 * snapshot. This module does not resolve agents or mutable settings.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";
import type { AcceptedSpawn } from "../spawn/spawn-contract.js";
import { SHORT_ID_LENGTH, type CompactionInfo, type RunCallbacks } from "../types.js";
import type { AgentUsage } from "./usage.js";
import { extractText } from "../prompt/context.js";
import {
  buildExtOverride,
  buildExtensionToolMap,
  buildSkillsOverride,
  resolveSessionToolNames,
  resolveVisibleToolNames,
} from "./agent-runner-policy.js";
import type { ResolvedAgentConfig } from "./agent-runner-policy.js";

/** Callbacks and accepted state shared by setup and one-turn execution. */
export interface SessionRuntimeOptions extends RunCallbacks {
  /** Manager-assigned id used to disambiguate parallel session names. */
  agentId?: string;
  /** Manager-owned execution signal. */
  signal?: AbortSignal;
  /** Immutable contract accepted by AgentManager. */
  acceptedSpawn: AcceptedSpawn;
  /** Usage that belongs to tool/compaction work rather than assistant turns. */
  onSupplementalUsage?: (usage: AgentUsage) => void;
}

/** Resource loader plus the initial extension/tool catalog snapshot. */
export interface ResourceLoaderRuntime {
  loader: DefaultResourceLoader;
  reloadAndMap: () => Promise<{
    extResult: ReturnType<DefaultResourceLoader["getExtensions"]>;
    extToolMap: Map<string, string[]>;
  }>;
}

/**
 * Create a DefaultResourceLoader with the accepted resource policy.
 * Reloading and mapping happen in one helper so the session sees the same
 * extension snapshot that was used to expand its tool registry gate.
 */
export function createResourceLoader(
  config: ResolvedAgentConfig,
  agentConfig: AgentConfig,
  cwd: string,
  agentDir: string,
  systemPrompt: string,
  settingsManager: SettingsManager,
  notify?: (msg: string) => void,
): ResourceLoaderRuntime {
  const extensions = config.extensions;
  const excludeSkills = config.excludeSkills ?? agentConfig.excludeSkills;
  // Skill metadata was already obtained through the bounded catalog/worker
  // path. Pi must not perform a second unbounded default skill scan here.
  const noSkills = true;
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd,
    agentDir,
    settingsManager,
    noExtensions: extensions === false,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionsOverride: buildExtOverride(
      extensions,
      config.excludeExtensions ?? agentConfig.excludeExtensions,
      notify,
    ),
    skillsOverride: buildSkillsOverride(config.skills, excludeSkills),
  };
  const loader = new DefaultResourceLoader(loaderOpts);
  return {
    loader,
    reloadAndMap: async () => {
      await loader.reload();
      const extResult = loader.getExtensions();
      return { extResult, extToolMap: buildExtensionToolMap(extResult.extensions) };
    },
  };
}

/** Create and configure a child session from the accepted model/thinking data. */
export async function createAndConfigureSession(
  ctx: ExtensionContext,
  options: SessionRuntimeOptions,
  agentConfig: AgentConfig,
  cwd: string,
  agentDir: string,
  loader: DefaultResourceLoader,
  settingsManager: SettingsManager,
  extToolMap: Map<string, string[]>,
  notify: (msg: string) => void,
): Promise<AgentSession> {
  const model = options.acceptedSpawn.model ?? ctx.model;
  const thinkingLevel = options.acceptedSpawn.thinkingLevel ?? ctx.thinkingLevel;
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    model,
    tools: resolveSessionToolNames(agentConfig, extToolMap),
    resourceLoader: loader,
  };
  if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;

  const { session } = await createAgentSession(sessionOpts);
  try {
    const baseName = agentConfig.name;
    session.setSessionName(
      options.agentId ? `${baseName}#${options.agentId.slice(0, SHORT_ID_LENGTH)}` : baseName,
    );
    await session.bindExtensions({
      onError: (err) => options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      }),
    });

    const filteredTools = resolveVisibleToolNames(
      session.getActiveToolNames(),
      agentConfig,
      extToolMap,
      notify,
    );
    if (filteredTools) session.setActiveToolsByName(filteredTools);
    return session;
  } catch (error) {
    try { session.dispose(); } catch { /* Preserve the setup error. */ }
    throw error;
  }
}

/**
 * Extract a LifetimeUsage from a runtime assistant message_end event.
 * pi-ai attaches usage to assistant messages at runtime, but this shape is
 * not reflected in the AgentSessionEvent public types.
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
 * Subscribe to shared session events used by the runner and continuation
 * executions. Returns an unsubscribe function.
 */
export function subscribeToSessionEvents(
  session: Pick<AgentSession, "subscribe">,
  options: Pick<SessionRuntimeOptions, "onToolActivity" | "onAssistantUsage" | "onSupplementalUsage" | "onCompaction">,
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
      if (usage) options.onAssistantUsage?.(usage);
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

/** Subscribe to response text deltas and collect the current assistant turn. */
function collectResponseText(
  session: AgentSession,
  onTextDelta?: (delta: string, fullText: string) => void,
) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") text = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
      onTextDelta?.(event.assistantMessageEvent.delta, text);
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Wire an AbortSignal to abort a session and return its cleanup function. */
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

/** Options consumed by one turn on an already-created session. */
export type AgentTurnOptions = Pick<SessionRuntimeOptions,
  | "signal" | "onToolActivity" | "onAssistantUsage" | "onSupplementalUsage" | "onCompaction" | "onTextDelta"
> & {
  /** Initial runs may use history; continuations must not return old text. */
  fallbackToLastAssistantText?: boolean;
};

/** Get the last non-empty assistant text from completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/** Execute one prompt turn with event wiring and guaranteed cleanup. */
export async function executeAgentTurn(
  session: AgentSession,
  prompt: string,
  options: AgentTurnOptions,
): Promise<{ responseText: string; aborted: boolean }> {
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
  const text = collector.getText().trim();
  // The history fallback is opt-in (initial runs only): a continuation that
  // produces no output must return an empty result rather than prior text.
  const responseText = options.fallbackToLastAssistantText === true
    ? text || getLastAssistantText(session)
    : text;
  return { responseText, aborted: options.signal?.aborted === true };
}
