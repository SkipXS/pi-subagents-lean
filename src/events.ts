import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverNewAgents, getAvailableAgents, setAgentScanDirs } from "./agents/agent-types.js";
import { AgentManager } from "./agents/agent-manager.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import {
  createAgentRenderMetadataBridge,
  type AgentRenderMetadataBridge,
} from "./agents/agent-render-bridge.js";
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
  const store = getStore();
  let manager = getManager();

  if (!manager) {
    manager = new AgentManager(store.concurrency);
    setManager(manager);
  } else {
    manager.setConcurrency(store.concurrency);
  }

  if (!getCoordinator()) {
    const coordinator = new SpawnCoordinator(manager);
    setCoordinator(coordinator);
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
  // Missing legacy host trust APIs are conservative: project catalogs stay closed.
  const projectTrusted = ctx.isProjectTrusted?.() === true;
  const sharedAgentDir = projectTrusted ? path.join(ctx.cwd, ".agents", "agents") : "";
  const projectAgentDir = projectTrusted ? path.join(ctx.cwd, ".pi", "agents") : "";

  // Store scan dirs for on-demand discovery (agents added during the session).
  // This also invalidates scans that were started with the previous session's
  // directory snapshot.
  setAgentScanDirs(userAgentDir, projectAgentDir, sharedAgentDir);

  const disableDefaults = getStore().agent.disableDefaultAgents;
  // Do not even start a stale startup refresh. If shutdown happens after this
  // check, discoverNewAgents() still rejects publication using its scan token.
  if (shouldRegister()) {
    await discoverNewAgents({ disableDefaultAgents: disableDefaults });
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
export function setupEventListeners(
  pi: ExtensionAPI,
  renderBridge: AgentRenderMetadataBridge = createAgentRenderMetadataBridge(),
): void {
  pi.on("tool_execution_start", (event) => {
    renderBridge.start(event.toolCallId, event.toolName);
  });
  pi.on("tool_execution_update", (event) => {
    renderBridge.updateFromPartial(event.toolCallId, event.toolName, event.partialResult);
  });
  pi.on("tool_result", (event) => renderBridge.onToolResult(event));
  pi.on("message_end", (event) => renderBridge.onMessageEnd(event) as any);

  // Refresh only configured global/current-project directories before every
  // parent turn. This picks up edits/removals without changing the fixed tool.
  pi.on("before_agent_start", async (event, ctx) => {
    await scanAndRegisterAgents(ctx);
    const systemPrompt = getOrchestrationPromptUpdate(
      event.systemPrompt,
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
    renderBridge.clear();
    let cleanupError: unknown;
    const attempt = async (work: () => void | Promise<void>) => {
      try {
        await work();
      } catch (err) {
        cleanupError ??= err;
      }
    };

    // Clear the stateless coordinator before awaiting global cleanup. A second
    // shutdown can clean the remaining collaborators while this one is blocked.
    setCoordinator(null);

    // The ConfigStore remains a read-only process-wide snapshot. Serialize
    // manager and session cleanup independently so a newer session waits for
    // older global cleanup before changing the shared runtime.
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

      const manager = getManager();
      if (manager) {
        await attempt(() => manager.dispose());
        setManager(null);
      }
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
    // session_start also covers Pi reload/session replacement.
    if (cleanupPromise) await cleanupPromise;
    renderBridge.startSession();
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
    // Invalidate pending parent scans before asynchronous cleanup. Worktree
    // catalogs are invocation-local and do not need to be cleared here.
    setAgentScanDirs("", "", "");

    // A standard host notification is retained for diagnostics; no custom
    // presentation state or terminal input is involved.
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
