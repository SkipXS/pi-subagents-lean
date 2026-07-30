/**
 * shell.ts — Composition root shell.
 *
 * Per ADR 0004, the Shell is the single mutable container for all per-session
 * state. Created at session_start, disposed at session_shutdown. Handler
 * modules read from shell via the getter functions — no module-level mutable
 * globals.
 *
 * index.ts populates the shell at session_start; handler modules import
 * getManager() / getWidget() / etc.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.js";
import type { AgentWidget } from "./ui/agent-widget.js";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { ConfigStore, type SubagentRuntimeSettings } from "./config/config-store.js";

// ============================================================================
// Shell type
// ============================================================================

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext;
  manager: AgentManager | null;
  widget: AgentWidget | null;
  store: ConfigStore;
  coordinator: SpawnCoordinator | null;
}

// ============================================================================
// Mutable module-level shell (populated by index.ts at session_start)
// ============================================================================

const shell: Shell = {
  pi: null!,
  sessionCtx: null!,
  manager: null,
  widget: null,
  store: new ConfigStore(),
  coordinator: null,
};

// ============================================================================
// Getter functions (read current state at call time)
// ============================================================================

function denyRootAccess(operation: string): never {
  throw new Error(`${operation} is unavailable from a child subagent runtime`);
}

/** The PI extension API instance. Set at init time. */
export function getPiInstance(): ExtensionAPI {
  if (subagentRuntime.getStore()) denyRootAccess("Root ExtensionAPI");
  return shell.pi;
}

/** The current session context. Set at session_start. */
export function getSessionCtx(): ExtensionContext {
  if (subagentRuntime.getStore()) denyRootAccess("Root session context");
  return shell.sessionCtx;
}

/** The current AgentManager, or null if unavailable. Child runtimes cannot obtain root controls. */
export function getManager(): AgentManager | null {
  return subagentRuntime.getStore() ? null : shell.manager;
}

/** The current AgentWidget, or null if unavailable. It retains root manager state. */
export function getWidget(): AgentWidget | null {
  return subagentRuntime.getStore() ? null : shell.widget;
}

/** The ConfigStore (lives for the lifetime of the extension). */
export function getStore(): ConfigStore {
  if (subagentRuntime.getStore()) denyRootAccess("Root ConfigStore");
  return shell.store;
}

/** The current SpawnCoordinator, or null if unavailable. Child runtimes cannot obtain root controls. */
export function getCoordinator(): SpawnCoordinator | null {
  return subagentRuntime.getStore() ? null : shell.coordinator;
}

// ============================================================================
// Setter functions (called by index.ts to populate the shell)
// ============================================================================

export function setPiInstance(pi: ExtensionAPI): void {
  if (subagentRuntime.getStore()) denyRootAccess("Root ExtensionAPI setter");
  shell.pi = pi;
}

export function setSessionCtx(ctx: ExtensionContext): void {
  if (subagentRuntime.getStore()) denyRootAccess("Root session context setter");
  shell.sessionCtx = ctx;
}

export function setManager(m: AgentManager | null): void {
  if (subagentRuntime.getStore()) denyRootAccess("Root manager setter");
  shell.manager = m;
}

export function setWidget(w: AgentWidget | null): void {
  if (subagentRuntime.getStore()) denyRootAccess("Root widget setter");
  shell.widget = w;
}

export function setCoordinator(c: SpawnCoordinator | null): void {
  if (subagentRuntime.getStore()) denyRootAccess("Root coordinator setter");
  shell.coordinator = c;
}

// ============================================================================
// Subagent runtime context
// ============================================================================

/** The sole scoped operation available to code executing in a child runtime. */
export type NestedAgentExecutor = (
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) => Promise<unknown>;

/**
 * Async context visible to a child session. Root collaborators and parent
 * metadata intentionally remain inside the bound executor's closure.
 */
const subagentRuntimeContextBrand = Symbol("subagent runtime context");

/**
 * Opaque child context. The unexported symbol prevents structural construction
 * in TypeScript; runtime membership is enforced by the private WeakSet below.
 */
export interface SubagentRuntimeContext {
  readonly isChildRuntime: true;
  /**
   * Present only for a manager-accepted parent with a bound nested executor.
   * Executor-less child runs are deliberately inert leaves.
   */
  readonly executeNestedAgent?: NestedAgentExecutor;
  /** Detached immutable values and resolvers captured before entering ALS. */
  readonly settings: SubagentRuntimeSettings;
  readonly [subagentRuntimeContextBrand]: true;
}

/** A child runtime that was given the manager-bound nested Agent capability. */
export type NestedAgentRuntimeContext = SubagentRuntimeContext & {
  readonly executeNestedAgent: NestedAgentExecutor;
};

const subagentRuntime = new AsyncLocalStorage<SubagentRuntimeContext>();
const registeredSubagentRuntimes = new WeakSet<object>();

/**
 * Deprecated compatibility marker for integrations which guarded extension
 * registration before child AsyncLocalStorage contexts existed. It is only
 * consulted by index.ts to keep that registration inert; it is never an
 * authorization boundary for shell state.
 */
let legacySubagentSpawnDepth = 0;

/**
 * @deprecated Use a manager-created child runtime instead. This only marks
 * extension registration as inert for compatibility; it cannot isolate async
 * work or grant access to root shell controls. Pair with exit in finally.
 */
export function enterSubagentSpawn(): void {
  legacySubagentSpawnDepth++;
}

/**
 * @deprecated Use AsyncLocalStorage child runtimes instead. This cannot clear
 * or bypass an active child runtime's root shell guards.
 */
export function exitSubagentSpawn(): void {
  legacySubagentSpawnDepth = Math.max(0, legacySubagentSpawnDepth - 1);
}

/**
 * @deprecated Returns the legacy registration marker or an active ALS child
 * runtime. It is not an authorization capability; ALS remains authoritative.
 */
export function isInsideSubagentSpawn(): boolean {
  return legacySubagentSpawnDepth > 0 || subagentRuntime.getStore() !== undefined;
}

/** Create the only kind of context permitted in child AsyncLocalStorage. */
export function createSubagentRuntimeContext(
  executeNestedAgent: NestedAgentExecutor | undefined,
  settings: SubagentRuntimeSettings,
): SubagentRuntimeContext {
  if (executeNestedAgent !== undefined && typeof executeNestedAgent !== "function") {
    throw new TypeError("Child subagent runtime executor must be a function");
  }
  if (settings === null || typeof settings !== "object") {
    throw new TypeError("Child subagent runtime settings must be an object");
  }

  const context: SubagentRuntimeContext = Object.freeze({
    isChildRuntime: true,
    ...(executeNestedAgent ? { executeNestedAgent } : {}),
    settings,
    [subagentRuntimeContextBrand]: true as const,
  });
  registeredSubagentRuntimes.add(context);
  return context;
}

/** Run setup and execution in a registered isolated child-runtime context. */
export function runWithSubagentRuntime<T>(context: unknown, work: () => Promise<T>): Promise<T> {
  if (typeof context !== "object" || context === null || !registeredSubagentRuntimes.has(context)) {
    throw new TypeError("Invalid child subagent runtime context");
  }
  return subagentRuntime.run(context as SubagentRuntimeContext, work);
}

/** Present only while an extension is loading for an isolated subagent session. */
export function getSubagentRuntimeContext(): SubagentRuntimeContext | undefined {
  return subagentRuntime.getStore();
}
