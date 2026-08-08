/**
 * shell.ts — Composition root shell.
 *
 * Per ADR 0004, the shell is the process-local mutable container for the
 * long-lived ConfigStore and current per-session state. The manager and
 * coordinator are mounted at session_start and disposed/cleared at
 * session_shutdown. The ConfigStore is a read-only normalized snapshot that
 * reloads at session_start. Handler modules read from shell via getter
 * functions — no separate module-level mutable globals.
 *
 * index.ts sets the PI instance at init and lifecycle handlers populate/clear
 * session fields; handler modules import getManager() / getCoordinator() / etc.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.js";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { ConfigStore } from "./config/config-store.js";

// ============================================================================
// Shell type
// ============================================================================

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext | null;
  manager: AgentManager | null;
  store: ConfigStore;
  coordinator: SpawnCoordinator | null;
}

// ============================================================================
// Mutable module-level shell (PI is set at init; session state at session_start)
// ============================================================================

const shell: Shell = {
  pi: null!,
  sessionCtx: null!,
  manager: null,
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
export function getSessionCtx(): ExtensionContext | null {
  if (subagentRuntime.getStore()) denyRootAccess("Root session context");
  return shell.sessionCtx;
}

/** The current AgentManager, or null if unavailable. Child runtimes cannot obtain root controls. */
export function getManager(): AgentManager | null {
  return subagentRuntime.getStore() ? null : shell.manager;
}

/** The read-only ConfigStore snapshot (lives for the extension lifetime). */
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

export function setSessionCtx(ctx: ExtensionContext | null): void {
  if (subagentRuntime.getStore()) denyRootAccess("Root session context setter");
  shell.sessionCtx = ctx;
}

export function setManager(m: AgentManager | null): void {
  if (subagentRuntime.getStore()) denyRootAccess("Root manager setter");
  shell.manager = m;
}

export function setCoordinator(c: SpawnCoordinator | null): void {
  if (subagentRuntime.getStore()) denyRootAccess("Root coordinator setter");
  shell.coordinator = c;
}

// ============================================================================
// Subagent runtime context
// ============================================================================

/**
 * Opaque marker for a session created by an agent run. It is used solely to
 * keep this extension's root tools and shell state out of that session.
 */
const subagentRuntimeContextBrand = Symbol("subagent runtime context");

export interface SubagentRuntimeContext {
  readonly isChildRuntime: true;
  readonly [subagentRuntimeContextBrand]: true;
}

const subagentRuntime = new AsyncLocalStorage<SubagentRuntimeContext>();
const registeredSubagentRuntimes = new WeakSet<object>();

/** Create the only kind of context permitted in child AsyncLocalStorage. */
export function createSubagentRuntimeContext(): SubagentRuntimeContext {
  const context: SubagentRuntimeContext = Object.freeze({
    isChildRuntime: true,
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
