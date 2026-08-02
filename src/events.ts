import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAgents, getAvailableAgents, setAgentScanDirs, scanAndMerge } from "./agents/agent-types.js";
import { AgentManager } from "./agents/agent-manager.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { toolCallListener } from "./agents/tool-execution.js";
import { getOrchestrationPromptUpdate } from "./prompt/orchestration.js";
import {
  getCoordinator,
  getManager,
  getStore,
  setSessionCtx,
  setManager,
  setCoordinator,
} from "./shell.js";

// ============================================================================
// Config loader — session_start handler logic
// ============================================================================

/**
 * Ensure the root manager and coordinator singletons exist.
 * Idempotent — safe to call on every session_start.
 */
export function ensureManagerAndCoordinator(): void {
  let manager = getManager();

  if (!manager) {
    manager = new AgentManager(
      undefined,
      getStore().concurrency as unknown as ConstructorParameters<typeof AgentManager>[1],
      undefined,
      getStore().agent.outputThinkingBufferSize,
    );
    setManager(manager);
    getStore().setDeps({ manager });
  }

  if (!getCoordinator()) {
    const coordinator = new SpawnCoordinator(manager);
    setCoordinator(coordinator);
    manager.setOnComplete((record, execution) => coordinator.onAgentComplete(record, execution));
    manager.setOnRecordEvicted?.((record) => coordinator.onRecordEvicted(record));
  }
}

/**
 * Scan agent files from user, shared, and project directories, merge with defaults,
 * and register into the type registry.
 */
export async function scanAndRegisterAgents(
  ctx: ExtensionContext,
  shouldRegister: () => boolean = () => true,
): Promise<void> {
  const userAgentDir = path.join(getAgentDir(), "agents");
  // Agent descriptions become parent system instructions, so never discover
  // project-controlled definitions unless Pi has established project trust.
  const projectTrusted = ctx.isProjectTrusted();
  const sharedAgentDir = projectTrusted ? path.join(ctx.cwd, ".agents", "agents") : "";
  const projectAgentDir = projectTrusted ? path.join(ctx.cwd, ".pi", "agents") : "";

  // Store scan dirs for on-demand discovery (agents added during the session)
  setAgentScanDirs(userAgentDir, projectAgentDir, sharedAgentDir);

  const disableDefaults = getStore().agent.disableDefaultAgents;
  const merged = await scanAndMerge({ disableDefaultAgents: disableDefaults });

  // A session can be shut down while its scan is pending. The catalog is a
  // shared registry, so a stale scan must not overwrite a newer session's
  // published definitions after it eventually resolves.
  if (shouldRegister()) {
    registerAgents(merged, { disableDefaultAgents: disableDefaults });
  }
}

export async function loadConfigAndRegisterAgents(
  ctx: ExtensionContext,
  shouldRegister?: () => boolean,
): Promise<void> {
  getStore().reload();
  ensureManagerAndCoordinator();
  await scanAndRegisterAgents(ctx, shouldRegister);
}

// ============================================================================
// Event listener setup
// ============================================================================

/** Register the root lifecycle and catalog listeners. */
export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("tool_call", toolCallListener);

  // Refresh only configured global/current-project directories before every
  // parent turn. This picks up edits/removals without changing the fixed tool.
  pi.on("before_agent_start", async (event, ctx) => {
    await scanAndRegisterAgents(ctx);
    const systemPrompt = getOrchestrationPromptUpdate(
      event.systemPrompt,
      getStore().agent.orchestrationPrompt,
      getAvailableAgents(),
    );
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });

  // session_start — load config, scan agents, and initialise the parent runtime.
  // Invalidates an in-flight startup before its asynchronous scan can publish
  // session-visible state after shutdown.
  let sessionEpoch = 0;
  let cleanupPromise: Promise<void> | undefined;
  let globalCleanupPromise: Promise<void> | undefined;

  /**
   * Tear down every per-session collaborator, including partially initialized
   * ones. This is shared by normal shutdown and failed startup so a retry never
   * inherits stale manager, coordinator, or store references.
   */
  const cleanupSessionRuntime = async (cleanupEpoch: number): Promise<void> => {
    let cleanupError: unknown;
    const attempt = async (work: () => void | Promise<void>) => {
      try {
        await work();
      } catch (err) {
        cleanupError ??= err;
      }
    };

    // Claim the coordinator before awaiting its disposal. A second shutdown
    // can clean the remaining global collaborators while this one is blocked.
    const coordinator = getCoordinator();
    setCoordinator(null);
    if (coordinator) await attempt(() => coordinator.dispose());

    // ConfigStore, AgentManager, and session context are global. Serialize
    // this part independently so a newer session waits for older global
    // cleanup before mutating the shared runtime.
    const previousGlobalCleanup = globalCleanupPromise;
    const globalCleanup = (async () => {
      if (previousGlobalCleanup) {
        try {
          await previousGlobalCleanup;
        } catch {
          // Each shutdown reports its own first disposal error.
        }
      }
      if (sessionEpoch !== cleanupEpoch) return;

      await attempt(() => getStore().dispose());
      if (sessionEpoch !== cleanupEpoch) return;

      const manager = getManager();
      setManager(null);
      if (manager) await attempt(() => manager.dispose());
      if (sessionEpoch === cleanupEpoch) setSessionCtx(null);
    })();
    // Preserve this handler's rejection for its caller while allowing a newer
    // generation to wait for completion before mutating global state itself.
    globalCleanupPromise = globalCleanup.catch(() => undefined);
    await globalCleanup;
    if (cleanupError !== undefined) throw cleanupError;
  };

  const beginCleanup = (): Promise<void> => {
    const cleanup = cleanupSessionRuntime(sessionEpoch);
    // Future starts wait for the most recent cleanup even if shutdown reports a
    // disposal error; every claimed collaborator was attempted.
    cleanupPromise = cleanup.catch(() => undefined);
    return cleanup;
  };

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (cleanupPromise) await cleanupPromise;
    const startupEpoch = ++sessionEpoch;
    setSessionCtx(ctx);
    try {
      await loadConfigAndRegisterAgents(ctx, () => sessionEpoch === startupEpoch);
      // session_shutdown may have run while scanAndMerge() was pending. Its
      // cleanup owns the runtime, so this stale startup must not publish state
      // after the next session has started.
      if (sessionEpoch !== startupEpoch) return;
    } catch (err) {
      // Preserve the startup error even if disposal itself encounters a fault.
      if (sessionEpoch !== startupEpoch) return;
      try {
        await beginCleanup();
      } catch {
        // The initialization failure is the actionable error for callers.
      }
      if (sessionEpoch !== startupEpoch) return;
      throw err;
    }
  });

  // session_shutdown — abort all root executions and dispose the manager.
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    ++sessionEpoch;

    // A standard host notification is retained for diagnostics; no custom TUI
    // state or terminal input is involved.
    const currentManager = getManager();
    if (currentManager) {
      const records = currentManager.listAgents();
      const active = records.filter(r => r.lifecycle.status === "running" || r.lifecycle.status === "queued");
      if (active.length > 0 && ctx.hasUI && ctx.ui?.notify) {
        ctx.ui.notify(`${active.length} agent(s) killed by reload`, "warning");
      }
    }
    await beginCleanup();
  });
}
